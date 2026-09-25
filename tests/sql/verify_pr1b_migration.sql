-- Verificación de la migración 20260926_agent_budget.sql (PR1b).
--
-- Se ejecuta entera dentro de una transacción que termina en ROLLBACK: no
-- deja datos ni cambia la configuración. Cualquier fallo aborta con
-- "FALLO: ...". Si todo pasa, la última consulta devuelve
-- "OK: verificación PR1b superada".
--
-- La concurrencia real (reservas simultáneas) se prueba en tests/lab.

begin;

do $$
declare
  v jsonb;
  v_res uuid;
  v_res2 uuid;
  v_month date := private.agent_month();
  s1 constant text := 'verificacion-sesion-0001';
  s2 constant text := 'verificacion-sesion-0002';
  admin_claims constant text := '{"role":"authenticated","app_metadata":{"crm_role":"admin"}}';
  user_claims constant text := '{"role":"authenticated","app_metadata":{}}';
begin
  -- Configuración de prueba: 1 € al mes, 10 € por millón de tokens de entrada
  -- y 20 € por millón de salida (costes exactos y fáciles de comprobar).
  update private.settings
     set value = value || '{"enabled": true, "monthly_budget_eur": 1, "price_input_eur_per_mtok": 10,
                            "price_output_eur_per_mtok": 20, "max_messages_per_session": 2,
                            "max_calls_per_day": 1000, "alert_thresholds_pct": [50, 80, 100],
                            "reservation_ttl_minutes": 10}'::jsonb
   where key = 'agent';
  delete from private.agent_usage;
  delete from private.agent_reservations;
  delete from private.agent_budget_months;

  -- 1. Solo la service role puede usar la contabilidad del agente.
  begin
    set local role anon;
    perform public.agent_reserve(s1, 1000, 100);
    raise exception 'FALLO: anon pudo reservar presupuesto';
  exception when insufficient_privilege then reset role; end;
  begin
    set local role authenticated;
    perform set_config('request.jwt.claims', admin_claims, true);
    perform public.agent_track_event(jsonb_build_object('event_type', 'message', 'session_id', s1));
    raise exception 'FALLO: el CRM pudo registrar eventos del agente';
  exception when insufficient_privilege then reset role; end;
  begin
    set local role anon;
    perform 1 from private.agent_budget_months;
    raise exception 'FALLO: anon pudo leer el presupuesto';
  exception when insufficient_privilege then reset role; end;

  -- 2. Reserva y liquidación: el coste reservado y el real cuadran.
  set local role service_role;
  v := public.agent_reserve(s1, 10000, 5000);            -- 0,1 + 0,1 = 0,2 €
  if v->>'status' <> 'reserved' or (v->>'max_cost_eur')::numeric <> 0.2 then
    raise exception 'FALLO: reserva incorrecta: %', v;
  end if;
  v_res := (v->>'reservation_id')::uuid;
  reset role;
  if (select reserved_eur from private.agent_budget_months where month = v_month) <> 0.2 then
    raise exception 'FALLO: el importe reservado no se apartó';
  end if;
  set local role service_role;
  v := public.agent_settle(v_res, 4000, 1000, 1200);    -- 0,04 + 0,02 = 0,06 €
  if v->>'status' <> 'settled' or (v->>'cost_eur')::numeric <> 0.06 then
    raise exception 'FALLO: liquidación incorrecta: %', v;
  end if;
  reset role;
  if (select spent_eur || '|' || reserved_eur from private.agent_budget_months where month = v_month) <> '0.060000|0.000000' then
    raise exception 'FALLO: el presupuesto no cuadra tras liquidar';
  end if;
  set local role service_role;
  if (public.agent_settle(v_res, 4000, 1000))->>'status' <> 'already_closed' then
    raise exception 'FALLO: una reserva se liquidó dos veces';
  end if;

  -- 3. Liberación tras un fallo de OpenAI: devuelve el importe.
  v_res := (public.agent_reserve(s2, 10000, 5000)->>'reservation_id')::uuid;
  if (public.agent_release(v_res))->>'status' <> 'released' then raise exception 'FALLO: no liberó la reserva'; end if;
  reset role;
  if (select reserved_eur from private.agent_budget_months where month = v_month) <> 0 then
    raise exception 'FALLO: la liberación no devolvió el importe';
  end if;
  set local role service_role;
  if (public.agent_release(v_res))->>'status' <> 'already_closed' then raise exception 'FALLO: liberó dos veces'; end if;

  -- 4. Alertas: cada umbral una sola vez al mes.
  v_res := (public.agent_reserve(s2, 45000, 0)->>'reservation_id')::uuid;    -- 0,45 €
  v := public.agent_settle(v_res, 45000, 0);                                 -- gastado 0,51 € → 51 %
  if v->'new_alerts_pct' <> '[50]'::jsonb then raise exception 'FALLO: alerta del 50 %% incorrecta: %', v; end if;
  v_res := (public.agent_reserve(s2, 1000, 0)->>'reservation_id')::uuid;
  v := public.agent_settle(v_res, 1000, 0);                                  -- 52 %
  if v->'new_alerts_pct' <> '[]'::jsonb then raise exception 'FALLO: alerta repetida: %', v; end if;

  -- 5. Presupuesto agotado: no se reserva lo que no cabe.
  v := public.agent_reserve(s1, 50000, 0);    -- 0,5 € > 1 − 0,52 (s1 aún no ha llegado a su límite)
  if v->>'status' <> 'budget_exhausted' then raise exception 'FALLO: reservó por encima del presupuesto: %', v; end if;

  -- 6. Límite por sesión (2 mensajes; s2 ya lleva 2 liquidadas; la liberada no cuenta).
  v := public.agent_reserve(s2, 1, 1);
  if v->>'status' <> 'session_limit' then raise exception 'FALLO: límite por sesión no aplicado: %', v; end if;

  -- 7. Reservas caducadas: devuelven el importe y se pueden liquidar sin
  --    descontarlo dos veces.
  v_res2 := (public.agent_reserve('verificacion-sesion-0003', 10000, 0)->>'reservation_id')::uuid;   -- 0,1 €
  reset role;
  update private.agent_reservations set created_at = now() - interval '1 hour' where id = v_res2;
  set local role service_role;
  perform public.agent_reserve('verificacion-sesion-0004', 1, 1);  -- dispara la caducidad
  reset role;
  if (select status from private.agent_reservations where id = v_res2) <> 'expired' then
    raise exception 'FALLO: la reserva abandonada no caducó';
  end if;
  set local role service_role;
  v := public.agent_settle(v_res2, 10000, 0);
  reset role;
  if (select reserved_eur >= 0 from private.agent_budget_months where month = v_month) is not true then
    raise exception 'FALLO: reservado negativo tras liquidar una reserva caducada';
  end if;
  set local role service_role;

  -- 8. Interruptor de apagado y límite diario.
  reset role;
  update private.settings set value = value || '{"enabled": false}'::jsonb where key = 'agent';
  set local role service_role;
  if (public.agent_reserve('verificacion-sesion-0005', 1, 1))->>'status' <> 'disabled' then
    raise exception 'FALLO: el interruptor de apagado no funciona';
  end if;
  reset role;
  update private.settings set value = value || '{"enabled": true, "max_calls_per_day": 1}'::jsonb where key = 'agent';
  set local role service_role;
  if (public.agent_reserve('verificacion-sesion-0006', 1, 1))->>'status' <> 'daily_limit' then
    raise exception 'FALLO: el límite diario no se aplicó';
  end if;

  -- 9. Eventos: tipos cerrados y sin datos personales.
  perform public.agent_track_event(jsonb_build_object('event_type', 'link_click', 'session_id', s1,
    'page_path', '/precios', 'target', 'plan_pyme', 'utm_source', 'linkedin', 'utm_campaign', 'lanzamiento-2026'));
  begin
    perform public.agent_track_event(jsonb_build_object('event_type', 'link_click', 'session_id', s1, 'target', 'ana@empresa.es'));
    raise exception 'FALLO: aceptó un email en un evento';
  exception when others then if sqlerrm like 'FALLO:%' then raise; end if; end;
  begin
    perform public.agent_track_event(jsonb_build_object('event_type', 'link_click', 'session_id', s1, 'page_path', '/gracias?email=ana@empresa.es'));
    raise exception 'FALLO: aceptó datos en la ruta de la página';
  exception when others then if sqlerrm like 'FALLO:%' then raise; end if; end;
  begin
    perform public.agent_track_event(jsonb_build_object('event_type', 'texto_libre', 'session_id', s1));
    raise exception 'FALLO: aceptó un tipo de evento desconocido';
  exception when others then if sqlerrm like 'FALLO:%' then raise; end if; end;
  begin
    perform public.agent_track_event(jsonb_build_object('event_type', 'message', 'session_id', 'ana@empresa.es'));
    raise exception 'FALLO: aceptó un identificador de sesión no válido';
  exception when others then if sqlerrm like 'FALLO:%' then raise; end if; end;
  reset role;

  -- 10. Métricas: solo el CRM administrador; mes contado en horario de Madrid.
  begin
    set local role authenticated;
    perform set_config('request.jwt.claims', user_claims, true);
    perform * from public.agent_metrics(7);
    raise exception 'FALLO: un usuario sin rol de administrador vio las métricas';
  exception when insufficient_privilege then reset role; end;
  set local role authenticated;
  perform set_config('request.jwt.claims', admin_claims, true);
  if (select sum(link_clicks) from public.agent_metrics(7)) <> 1 then
    raise exception 'FALLO: métricas incorrectas';
  end if;
  reset role;
  if private.agent_month(timestamptz '2026-09-30 22:30:00+00') <> date '2026-10-01' then
    raise exception 'FALLO: el mes no se cuenta en horario de Madrid';
  end if;

  raise notice 'OK: verificación PR1b superada';
end;
$$;

rollback;

-- Solo se llega aquí si todos los bloques han pasado.
select 'OK: verificación PR1b superada' as resultado;
