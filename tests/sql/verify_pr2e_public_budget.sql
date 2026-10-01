-- Verificación de la migración 20261002_agent_public_budget.sql (PR2e).
--
-- Transacción que termina en ROLLBACK: no deja reservas, alertas ni cambios de
-- configuración. Cualquier fallo aborta con "FALLO: ...". Si todo pasa, la
-- última consulta devuelve "OK: verificación PR2e superada".
-- La concurrencia real se prueba en tests/lab (budget.lab.mjs).

begin;

do $$
declare
  v jsonb;
  v_cfg jsonb;
  v_model text;
  v_expected numeric;
  v_id uuid;
  v_id2 uuid;
  v_month date := private.agent_month();
  v_prev date := (private.agent_month() - interval '1 month')::date;
  v_preview_before numeric;
  v_n integer;
  v_claims jsonb[];
  admin_claims constant text := '{"role":"authenticated","sub":"00000000-0000-4000-8000-00000000ad02","app_metadata":{"crm_role":"admin"}}';
  user_claims constant text := '{"role":"authenticated","app_metadata":{}}';
  s constant text := 'verificacion-pr2e-sesion';
begin
  -- Punto de partida limpio dentro de la transacción.
  delete from private.agent_usage; delete from private.agent_reservations;
  delete from private.agent_budget_months; delete from private.agent_budget_alerts;
  delete from private.rate_counters where bucket like 'agent:%';
  update private.settings set value = value || '{"enabled": true, "default_model": "gpt-6-luna", "monthly_budget_eur": 25,
      "max_messages_per_session": 1000, "max_calls_per_day": 100000, "public_max_calls_per_minute": 100000,
      "public_reserve_margin": 1.25, "alert_thresholds_pct": [50, 80, 100]}'::jsonb where key = 'agent';
  v_cfg := private.agent_config();

  -- 0. Configuración: claves nuevas presentes; presupuestos sin tocar.
  if v_cfg ->> 'public_max_calls_per_minute' is null or v_cfg ->> 'public_reserve_margin' is null then
    raise exception 'FALLO: faltan las claves nuevas de configuración';
  end if;
  if (v_cfg ->> 'preview_budget_eur')::numeric <> 5 then raise exception 'FALLO: se ha tocado el presupuesto de pruebas'; end if;

  -- 1. Permisos: solo la service role; el CRM solo ve el resumen como administrador.
  begin
    set local role anon;
    perform public.agent_reserve(s, 10, 10);
    raise exception 'FALLO: anon pudo reservar presupuesto público';
  exception when insufficient_privilege then reset role; end;
  begin
    set local role authenticated;
    perform set_config('request.jwt.claims', admin_claims, true);
    perform public.agent_alerts_claim(600);
    raise exception 'FALLO: el CRM pudo reclamar alertas de email';
  exception when insufficient_privilege then reset role; end;
  begin
    set local role authenticated;
    perform set_config('request.jwt.claims', user_claims, true);
    perform public.agent_lab_summary();
    raise exception 'FALLO: un usuario sin rol de administrador vio el presupuesto';
  exception when insufficient_privilege then reset role; end;

  -- 2. Coste por cada modelo permitido: reserva = tabla × usd_eur × margen, sin caché.
  for v_model in select jsonb_object_keys(v_cfg -> 'models') loop
    update private.settings set value = jsonb_set(value, '{default_model}', to_jsonb(v_model)) where key = 'agent';
    v := public.agent_reserve(s || '-' || replace(v_model, '.', ''), 10000, 400);
    v_expected := round(round(((10000 * ((v_cfg -> 'models' -> v_model ->> 'in')::numeric)
                         + 400 * ((v_cfg -> 'models' -> v_model ->> 'out')::numeric)) / 1000000)
                         * coalesce((v_cfg ->> 'usd_eur')::numeric, 1), 6) * 1.25, 6);
    if v ->> 'status' <> 'reserved' or (v ->> 'max_cost_eur')::numeric <> v_expected or v ->> 'model' <> v_model then
      raise exception 'FALLO: reserva mal calculada para % (% ≠ %)', v_model, v ->> 'max_cost_eur', v_expected;
    end if;
    perform public.agent_release((v ->> 'reservation_id')::uuid);
  end loop;
  update private.settings set value = jsonb_set(value, '{default_model}', '"gpt-6-luna"') where key = 'agent';

  -- 3. Sin modelo público válido → disabled, sin reservar.
  update private.settings set value = jsonb_set(value, '{default_model}', 'null') where key = 'agent';
  if public.agent_reserve(s, 10, 10) ->> 'status' <> 'disabled' then raise exception 'FALLO: reservó sin default_model'; end if;
  update private.settings set value = jsonb_set(value, '{default_model}', '"gpt-4o"') where key = 'agent';
  if public.agent_reserve(s, 10, 10) ->> 'status' <> 'disabled' then raise exception 'FALLO: reservó con un modelo fuera de la lista'; end if;
  update private.settings set value = jsonb_set(value, '{default_model}', '"gpt-6-luna"') where key = 'agent';

  -- 4. Liquidación por uso real (con caché) y con el modelo de la reserva.
  delete from private.agent_usage; delete from private.agent_reservations; delete from private.agent_budget_months;
  v := public.agent_reserve(s, 10000, 400);
  v_id := (v ->> 'reservation_id')::uuid;
  update private.settings set value = jsonb_set(value, '{default_model}', '"gpt-5.4-mini"') where key = 'agent';
  v := public.agent_settle(v_id, 2000, 100, 1500, 1500);
  v_expected := private.agent_model_cost('gpt-6-luna', 2000, 1500, 100, v_cfg);
  if v ->> 'status' <> 'settled' or (v ->> 'cost_eur')::numeric <> v_expected then
    raise exception 'FALLO: liquidación incorrecta (% ≠ %)', v ->> 'cost_eur', v_expected;
  end if;
  if (select model from private.agent_usage where reservation_id = v_id) <> 'gpt-6-luna' then
    raise exception 'FALLO: el uso no registra el modelo de la reserva';
  end if;
  if (select spent_eur || '|' || reserved_eur from private.agent_budget_months where month = v_month) <> v_expected || '|0.000000' then
    raise exception 'FALLO: el mes no refleja la liquidación';
  end if;
  if public.agent_settle(v_id, 2000, 100) ->> 'status' <> 'already_closed' then raise exception 'FALLO: liquidó dos veces'; end if;
  update private.settings set value = jsonb_set(value, '{default_model}', '"gpt-6-luna"') where key = 'agent';

  -- 5. Una reserva nueva nunca hace superar el límite; agotado → alerta del 100 %.
  delete from private.agent_usage; delete from private.agent_reservations;
  delete from private.agent_budget_months; delete from private.agent_budget_alerts;
  insert into private.agent_budget_months (month, spent_eur) values (v_month, 24.999);
  v := public.agent_reserve(s, 100000, 400);
  if v ->> 'status' <> 'budget_exhausted' then raise exception 'FALLO: reservó por encima de 25 €: %', v; end if;
  if (select reserved_eur from private.agent_budget_months where month = v_month) <> 0 then raise exception 'FALLO: quedó dinero reservado'; end if;
  if not exists (select 1 from private.agent_budget_alerts where month = v_month and threshold = 100) then
    raise exception 'FALLO: agotar el presupuesto no generó la alerta del 100 %%';
  end if;
  if not (v ->> 'alerts_pending')::boolean then raise exception 'FALLO: no avisó de alertas pendientes'; end if;

  -- 6. Alertas 50/80/100: una sola vez por umbral y mes.
  delete from private.agent_usage; delete from private.agent_reservations;
  delete from private.agent_budget_months; delete from private.agent_budget_alerts;
  insert into private.agent_budget_months (month, spent_eur) values (v_month, 12.6);
  v_id := (public.agent_reserve(s, 1000, 10) ->> 'reservation_id')::uuid;
  perform public.agent_settle(v_id, 1000, 10);
  v_id := (public.agent_reserve(s, 1000, 10) ->> 'reservation_id')::uuid;
  perform public.agent_settle(v_id, 1000, 10);
  if (select string_agg(threshold::text, ',' order by threshold) from private.agent_budget_alerts) <> '50' then
    raise exception 'FALLO: alertas incorrectas al 50 %%';
  end if;
  update private.agent_budget_months set spent_eur = 20.5 where month = v_month;
  v_id := (public.agent_reserve(s, 1000, 10) ->> 'reservation_id')::uuid;
  perform public.agent_settle(v_id, 1000, 10);
  update private.agent_budget_months set spent_eur = 25 where month = v_month;
  v_id := (public.agent_reserve(s, 0, 0) ->> 'reservation_id')::uuid;
  perform public.agent_settle(v_id, 0, 0);
  perform public.agent_reserve(s, 1000, 10);
  if (select string_agg(threshold::text, ',' order by threshold) || '/' || count(*) from private.agent_budget_alerts) <> '50,80,100/3' then
    raise exception 'FALLO: los umbrales no se registran una sola vez: %', (select string_agg(threshold::text, ',') from private.agent_budget_alerts);
  end if;
  if (select alerts_sent from private.agent_budget_months where month = v_month) <> '{50,80,100}' then
    raise exception 'FALLO: alerts_sent heredado no coincide';
  end if;

  -- 7. Email: reclamar, fallar, reintentar sin duplicar.
  select array_agg(c) into v_claims from public.agent_alerts_claim(600) c;
  if cardinality(v_claims) <> 3 then raise exception 'FALLO: no se reclamaron las 3 alertas'; end if;
  if (select count(*) from public.agent_alerts_claim(600)) <> 0 then raise exception 'FALLO: una alerta en envío se reclamó dos veces'; end if;
  if v_claims[1] ? 'session_id' or v_claims[1]::text ~* 'reply|user_text|message' then raise exception 'FALLO: la alerta lleva datos no agregados'; end if;
  perform public.agent_alert_result(v_claims[1] ->> 'month', (v_claims[1] ->> 'threshold')::integer, true, null);
  perform public.agent_alert_result(v_claims[2] ->> 'month', (v_claims[2] ->> 'threshold')::integer, false, 'http_500');
  -- Volver a superar los umbrales (otra liquidación) no reabre una alerta ya registrada.
  perform public.agent_settle((public.agent_reserve(s || '-repite', 0, 0) ->> 'reservation_id')::uuid, 0, 0);
  if (select count(*) from private.agent_budget_alerts where email_status = 'sent') <> 1 then
    raise exception 'FALLO: se volvió a reclamar una alerta ya enviada';
  end if;
  -- La 3.ª queda "enviándose" (corte): solo se reintenta cuando caduca el arrendamiento.
  select count(*) into v_n from public.agent_alerts_claim(600);
  if v_n <> 1 then raise exception 'FALLO: el reintento no cogió solo la fallida (%)', v_n; end if;
  update private.agent_budget_alerts set email_last_attempt_at = now() - interval '11 minutes' where email_status = 'sending';
  select count(*) into v_n from public.agent_alerts_claim(600);
  if v_n <> 2 then raise exception 'FALLO: no se reintentaron las que superaron el arrendamiento (%)', v_n; end if;
  if (select count(*) from private.agent_budget_alerts where email_status = 'sent') <> 1 then
    raise exception 'FALLO: se volvió a reclamar una alerta ya enviada';
  end if;
  update private.agent_budget_alerts set email_attempts = 10, email_status = 'failed' where email_status = 'sending';
  if (select count(*) from public.agent_alerts_claim(600)) <> 0 then raise exception 'FALLO: reintentó sin límite'; end if;

  -- 8. Cambio de mes: el mes anterior agotado no bloquea el actual; las alertas son por mes.
  delete from private.agent_usage; delete from private.agent_reservations;
  delete from private.agent_budget_months; delete from private.agent_budget_alerts;
  insert into private.agent_budget_months (month, spent_eur) values (v_prev, 25);
  insert into private.agent_budget_alerts (month, threshold, spent_eur, budget_eur) values (v_prev, 100, 25, 25);
  v := public.agent_reserve(s, 1000, 10);
  if v ->> 'status' <> 'reserved' then raise exception 'FALLO: el mes anterior bloquea el actual'; end if;
  perform public.agent_settle((v ->> 'reservation_id')::uuid, 1000, 10);
  if (select count(*) from private.agent_budget_alerts where month = v_month) <> 0 then raise exception 'FALLO: alertas heredadas del mes anterior'; end if;
  update private.agent_budget_months set spent_eur = 13 where month = v_month;
  perform public.agent_settle((public.agent_reserve(s, 10, 1) ->> 'reservation_id')::uuid, 10, 1);
  if not exists (select 1 from private.agent_budget_alerts where month = v_month and threshold = 50) then
    raise exception 'FALLO: el nuevo mes no genera sus propias alertas';
  end if;

  -- 9. Límites por minuto, sesión y día.
  delete from private.agent_usage; delete from private.agent_reservations; delete from private.agent_budget_months;
  delete from private.rate_counters where bucket like 'agent:%';
  update private.settings set value = value || '{"public_max_calls_per_minute": 2}'::jsonb where key = 'agent';
  perform public.agent_reserve(s || '-m1', 10, 1); perform public.agent_reserve(s || '-m2', 10, 1);
  if public.agent_reserve(s || '-m3', 10, 1) ->> 'status' <> 'rate_limited' then raise exception 'FALLO: no aplicó el tope por minuto'; end if;
  delete from private.rate_counters where bucket like 'agent:%';
  update private.settings set value = value || '{"public_max_calls_per_minute": 1000, "max_messages_per_session": 2}'::jsonb where key = 'agent';
  delete from private.agent_reservations;
  perform public.agent_reserve(s, 10, 1); perform public.agent_reserve(s, 10, 1);
  if public.agent_reserve(s, 10, 1) ->> 'status' <> 'session_limit' then raise exception 'FALLO: no aplicó el límite por sesión'; end if;
  update private.settings set value = value || '{"max_messages_per_session": 1000, "max_calls_per_day": 3}'::jsonb where key = 'agent';
  if public.agent_reserve(s || '-d1', 10, 1) ->> 'status' <> 'reserved' then raise exception 'FALLO: debería quedar 1 llamada hoy'; end if;
  if public.agent_reserve(s || '-d2', 10, 1) ->> 'status' <> 'daily_limit' then raise exception 'FALLO: no aplicó el límite diario'; end if;

  -- 10. Separación absoluta: lo público no toca el libro de pruebas y viceversa.
  select coalesce(sum(spent_eur + reserved_eur), 0) into v_preview_before from private.agent_preview_ledger;
  if (select coalesce(sum(spent_eur + reserved_eur), 0) from private.agent_preview_ledger) <> v_preview_before then
    raise exception 'FALLO: el presupuesto público tocó el de pruebas';
  end if;
  select coalesce(sum(spent_eur), 0) + coalesce(sum(reserved_eur), 0) into v_expected from private.agent_budget_months;
  update private.settings set value = value || '{"real_call_allowance": 1, "max_calls_per_minute": 1000}'::jsonb where key = 'agent';
  v := public.agent_preview_reserve('verificacion-pr2e-privada', 'gpt-6-luna', 100, 100, 'openai');
  perform public.agent_preview_settle((v ->> 'reservation_id')::uuid, 100, 0, 100);
  if (select coalesce(sum(spent_eur), 0) + coalesce(sum(reserved_eur), 0) from private.agent_budget_months) <> v_expected then
    raise exception 'FALLO: el laboratorio consumió presupuesto público';
  end if;

  -- 11. El CRM (administrador) ve el presupuesto público y sus alertas.
  set local role authenticated;
  perform set_config('request.jwt.claims', admin_claims, true);
  v := public.agent_lab_summary();
  reset role;
  if v -> 'public_budget' is null or (v -> 'public_budget' ->> 'limit_eur')::numeric <> 25 or v -> 'public_budget' -> 'alerts' is null then
    raise exception 'FALLO: el resumen del CRM no incluye el presupuesto público: %', v -> 'public_budget';
  end if;
  if (v -> 'budget' ->> 'limit_eur')::numeric <> 5 then raise exception 'FALLO: el resumen perdió el presupuesto de pruebas'; end if;

  raise notice 'OK: verificación PR2e superada';
end;
$$;

rollback;

-- Solo se llega aquí si todos los bloques han pasado.
select 'OK: verificación PR2e superada' as resultado;
