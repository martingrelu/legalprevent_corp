-- Verificación de la migración 20261001_agent_private_lab.sql (PR2).
--
-- Transacción que termina en ROLLBACK: no deja reservas, conversaciones ni
-- cambios de configuración. Cualquier fallo aborta con "FALLO: ...". Si todo
-- pasa, la última consulta devuelve "OK: verificación PR2 superada".

begin;

do $$
declare
  v jsonb;
  v_config jsonb;
  v_public_before numeric;
  v_id bigint;
  admin_claims constant text := '{"role":"authenticated","sub":"00000000-0000-4000-8000-00000000ad02","app_metadata":{"crm_role":"admin"}}';
  user_claims constant text := '{"role":"authenticated","app_metadata":{}}';
  conv constant text := 'verificacion-pr2-conv01';
begin
  -- 0. Configuración: modo público apagado, laboratorio y presupuesto de pruebas.
  v_config := (select value from private.settings where key = 'agent');
  if coalesce((v_config ->> 'public_enabled')::boolean, true) then raise exception 'FALLO: el modo público no está apagado'; end if;
  if (v_config ->> 'preview_budget_eur')::numeric <> 5 then raise exception 'FALLO: el presupuesto de pruebas no es 5 €'; end if;
  if (v_config ->> 'monthly_budget_eur')::numeric <> 25 then raise exception 'FALLO: se ha tocado el presupuesto público'; end if;
  if (select count(*) from jsonb_object_keys(v_config -> 'models')) <> 3
     or v_config -> 'models' -> 'gpt-5.4-mini' is null or v_config -> 'models' -> 'gpt-5.6-luna' is null or v_config -> 'models' -> 'gpt-6-luna' is null then
    raise exception 'FALLO: no están los tres modelos candidatos';
  end if;
  if v_config ->> 'region' <> 'eu' then raise exception 'FALLO: la región por defecto no es la UE'; end if;

  -- 1. Permisos: ni anon ni el CRM usan la contabilidad; anon no usa el laboratorio.
  begin
    set local role anon;
    perform public.agent_preview_reserve(conv, 'gpt-6-luna', 100, 100);
    raise exception 'FALLO: anon pudo reservar presupuesto de pruebas';
  exception when insufficient_privilege then reset role; end;
  begin
    set local role authenticated;
    perform set_config('request.jwt.claims', admin_claims, true);
    perform public.agent_preview_reserve(conv, 'gpt-6-luna', 100, 100);
    raise exception 'FALLO: el CRM pudo reservar presupuesto directamente';
  exception when insufficient_privilege then reset role; end;
  begin
    set local role anon;
    perform public.agent_lab_summary();
    raise exception 'FALLO: anon pudo ver el laboratorio';
  exception when insufficient_privilege then reset role; end;
  begin
    set local role authenticated;
    perform set_config('request.jwt.claims', user_claims, true);
    perform public.agent_lab_summary();
    raise exception 'FALLO: un usuario sin rol de administrador vio el laboratorio';
  exception when insufficient_privilege then reset role; end;
  begin
    set local role anon;
    perform public.agent_runtime_config();
    raise exception 'FALLO: anon pudo leer la configuración del agente';
  exception when insufficient_privilege then reset role; end;

  -- 2. Coste por modelo (USD/Mtok × 0,90): 1.000 entrada (400 en caché) + 1.000 salida en gpt-5.4-mini.
  if private.agent_model_cost('gpt-5.4-mini', 1000, 400, 1000, v_config) <> round((600 * 0.75 + 400 * 0.075 + 1000 * 4.50) / 1000000 * 0.90, 6) then
    raise exception 'FALLO: coste mal calculado';
  end if;

  -- 3. Reserva, liquidación y separación del presupuesto público.
  select coalesce(sum(spent_eur + reserved_eur), 0) into v_public_before from private.agent_budget_months;
  set local role service_role;
  v := public.agent_preview_reserve(conv, 'gpt-5.4-mini', 1000, 400);
  if v ->> 'status' <> 'reserved' then raise exception 'FALLO: no reservó: %', v; end if;
  v := public.agent_preview_settle((v ->> 'reservation_id')::uuid, 800, 300, 120);
  if v ->> 'status' <> 'settled' then raise exception 'FALLO: no liquidó: %', v; end if;
  v := public.agent_preview_reserve(conv, 'gpt-4o', 10, 10);
  if v ->> 'status' <> 'model_invalid' then raise exception 'FALLO: aceptó un modelo no autorizado'; end if;
  reset role;
  if (select coalesce(sum(spent_eur + reserved_eur), 0) from private.agent_budget_months) <> v_public_before then
    raise exception 'FALLO: las pruebas consumieron presupuesto público';
  end if;

  -- 4. Presupuesto de pruebas agotado: nunca se supera.
  update private.settings set value = value || '{"preview_budget_eur": 0.002}' where key = 'agent';
  set local role service_role;
  v := public.agent_preview_reserve(conv, 'gpt-5.4-mini', 1000, 400);
  if v ->> 'status' <> 'budget_exhausted' then raise exception 'FALLO: superó el presupuesto de pruebas: %', v; end if;
  reset role;
  update private.settings set value = value || '{"preview_budget_eur": 5}' where key = 'agent';

  -- 5. Conversaciones de prueba: nunca con emails; caducan a los 30 días.
  begin
    set local role service_role;
    perform public.agent_preview_log_turn(jsonb_build_object('conversation_id', conv, 'turn', 0, 'model', 'gpt-6-luna', 'user_text', 'soy ana@empresa.es', 'reply', 'x'));
    raise exception 'FALLO: guardó un email sin redactar';
  exception when others then reset role; if sqlerrm like 'FALLO:%' then raise; end if; end;
  insert into private.agent_test_transcripts (conversation_id, turn, model, user_text, reply, expires_at)
  values ('verificacion-pr2-caducada', 0, 'gpt-6-luna', 'viejo', 'viejo', now() - interval '1 second');
  set local role service_role;
  v_id := public.agent_preview_log_turn(jsonb_build_object('conversation_id', conv, 'turn', 0, 'model', 'gpt-6-luna', 'user_text', 'Mi email es [email]', 'reply', 'Hola'));
  reset role;
  if exists (select 1 from private.agent_test_transcripts where conversation_id = 'verificacion-pr2-caducada') then
    raise exception 'FALLO: no purgó las conversaciones caducadas';
  end if;
  if (select expires_at from private.agent_test_transcripts where id = v_id) not between now() + interval '29 days' and now() + interval '31 days' then
    raise exception 'FALLO: la caducidad no es de 30 días';
  end if;

  -- 6. Valoración: solo administrador y solo criterios/valores válidos.
  set local role authenticated;
  perform set_config('request.jwt.claims', admin_claims, true);
  v := public.agent_lab_rate(v_id, '{"precision": 5, "tono": 4}', 'bien');
  if v ->> 'status' <> 'rated' then raise exception 'FALLO: no valoró: %', v; end if;
  begin
    perform public.agent_lab_rate(v_id, '{"precision": 9}', '');
    raise exception 'FALLO: aceptó una nota fuera de 1-5';
  exception when others then if sqlerrm like 'FALLO:%' then raise; end if; end;
  if (public.agent_lab_summary() -> 'budget' ->> 'limit_eur')::numeric <> 5 then raise exception 'FALLO: el resumen no muestra el presupuesto'; end if;
  if not (public.agent_lab_whoami() ->> 'admin')::boolean then raise exception 'FALLO: whoami no reconoce al administrador'; end if;
  reset role;

  raise notice 'OK: verificación PR2 superada';
end;
$$;

rollback;

-- Solo se llega aquí si todos los bloques han pasado.
select 'OK: verificación PR2 superada' as resultado;
