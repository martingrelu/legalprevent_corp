-- Verificación de la migración 20260927_retention_erasure.sql (PR1c).
--
-- Se ejecuta entera dentro de una transacción que termina en ROLLBACK: no
-- deja datos ni cambia la configuración (la conservación sigue desactivada).
-- Los datos de prueba usan emails @example.com y fechas simuladas. Cualquier
-- fallo aborta con "FALLO: ...". Si todo pasa, la última consulta devuelve
-- "OK: verificación PR1c superada".

begin;

do $$
declare
  v jsonb;
  v_old constant timestamptz := now() - interval '2 years';
  v_candidate uuid;
  v_keep_client uuid;
  v_keep_review uuid;
  v_keep_sub uuid;
  v_keep_checkout uuid;
  v_keep_recent uuid;
  v_keep_demo uuid;
  v_consent_lead uuid;
  admin_claims constant text := '{"role":"authenticated","sub":"00000000-0000-4000-8000-00000000ad01","app_metadata":{"crm_role":"admin"}}';
  user_claims constant text := '{"role":"authenticated","app_metadata":{}}';
begin
  -- 0. Tras la migración, la conservación llega desactivada con 12 meses.
  if (select value from private.settings where key = 'retention') <> '{"enabled": false, "months": 12}'::jsonb then
    raise exception 'FALLO: la conservación no llega desactivada con 12 meses';
  end if;

  -- 1. Permisos: anon nada; un usuario sin rol de administrador tampoco.
  begin
    set local role anon;
    perform public.retention_preview();
    raise exception 'FALLO: anon vio la conservación';
  exception when insufficient_privilege then reset role; end;
  begin
    set local role anon;
    perform public.crm_erase_contact('a@example.com', 'prueba');
    raise exception 'FALLO: anon pudo suprimir contactos';
  exception when insufficient_privilege then reset role; end;
  begin
    set local role authenticated;
    perform set_config('request.jwt.claims', user_claims, true);
    perform public.crm_erase_contact('a@example.com', 'prueba');
    raise exception 'FALLO: un usuario sin rol de administrador pudo suprimir contactos';
  exception when insufficient_privilege then reset role; end;
  begin
    set local role authenticated;
    perform set_config('request.jwt.claims', admin_claims, true);
    perform public.retention_run();
    raise exception 'FALLO: el CRM pudo ejecutar la conservación';
  exception when insufficient_privilege then reset role; end;

  -- 2. Datos de prueba con fechas simuladas (inserción directa: el trigger de
  --    updated_at solo actúa en las actualizaciones).
  insert into public.leads (email, status, created_at, updated_at) values ('ret-candidato@example.com', 'Contactado', v_old, v_old) returning id into v_candidate;
  insert into public.leads (email, status, created_at, updated_at) values ('ret-cliente@example.com', 'Cliente ganado', v_old, v_old) returning id into v_keep_client;
  insert into public.leads (email, status, created_at, updated_at, privacy_review_required) values ('ret-revision@example.com', 'Contactado', v_old, v_old, true) returning id into v_keep_review;
  insert into public.leads (email, status, created_at, updated_at) values ('ret-suscripcion@example.com', 'Contactado', v_old, v_old) returning id into v_keep_sub;
  insert into public.subscriptions (stripe_subscription_id, lead_id, status, payload) values ('sub_verificacion', v_keep_sub, 'active', '{}');
  insert into public.leads (email, status, created_at, updated_at) values ('ret-checkout@example.com', 'Contactado', v_old, v_old) returning id into v_keep_checkout;
  insert into public.checkout_sessions (stripe_session_id, customer_email, status, payload) values ('cs_verificacion', 'RET-CHECKOUT@example.com', 'complete', '{}');
  insert into public.leads (email, status) values ('ret-reciente@example.com', 'Contactado') returning id into v_keep_recent;
  insert into public.leads (email, status, created_at, updated_at, demo_requested_at) values ('ret-demo@example.com', 'Contactado', v_old, v_old, now()) returning id into v_keep_demo;
  insert into public.diagnostics (email, created_at) values ('ret-candidato@example.com', v_old), ('ret-cliente@example.com', v_old), ('ret-huerfano@example.com', v_old);
  insert into private.consent_events (lead_id, kind, action, version, source) values (v_candidate, 'privacy', 'granted', '2026-06-04', 'verificacion');

  -- 3. Vista previa: solo cuenta (candidato + diagnóstico suyo + diagnóstico sin lead).
  set local role authenticated;
  perform set_config('request.jwt.claims', admin_claims, true);
  v := public.retention_preview();
  reset role;
  if (v->>'enabled')::boolean or (v->>'months')::integer <> 12 then raise exception 'FALLO: vista previa con configuración incorrecta: %', v; end if;
  if (v->>'leads')::integer < 1 or (v->>'diagnostics')::integer < 2 then raise exception 'FALLO: vista previa sin los candidatos de prueba: %', v; end if;
  if v::text ~ '@' then raise exception 'FALLO: la vista previa devuelve datos personales'; end if;

  -- 4. Desactivada: no borra nada y deja registro.
  set local role service_role;
  v := public.retention_run();
  reset role;
  if v->>'status' <> 'disabled' or not exists (select 1 from public.leads where id = v_candidate) then
    raise exception 'FALLO: la conservación desactivada borró datos';
  end if;
  if not exists (select 1 from private.retention_log where not enabled) then raise exception 'FALLO: no quedó registro de la ejecución'; end if;

  -- 5. Activada (solo dentro de esta transacción): borra exactamente los candidatos.
  update private.settings set value = '{"enabled": true, "months": 12}' where key = 'retention';
  set local role service_role;
  v := public.retention_run();
  reset role;
  if v->>'status' <> 'done' then raise exception 'FALLO: la conservación activada no se ejecutó: %', v; end if;
  if exists (select 1 from public.leads where id = v_candidate) then raise exception 'FALLO: no borró el lead candidato'; end if;
  if exists (select 1 from public.diagnostics where email in ('ret-candidato@example.com', 'ret-huerfano@example.com')) then
    raise exception 'FALLO: no borró los diagnósticos candidatos';
  end if;
  if (select count(*) from public.leads where id in (v_keep_client, v_keep_review, v_keep_sub, v_keep_checkout, v_keep_recent, v_keep_demo)) <> 6 then
    raise exception 'FALLO: borró un cliente, un lead en revisión, con pago, reciente o con demo reciente';
  end if;
  if not exists (select 1 from public.diagnostics where email = 'ret-cliente@example.com') then
    raise exception 'FALLO: borró el diagnóstico de un cliente';
  end if;
  if exists (select 1 from private.consent_events where lead_id = v_candidate) then
    raise exception 'FALLO: quedaron eventos de consentimiento del contacto borrado';
  end if;
  update private.settings set value = '{"enabled": false, "months": 12}' where key = 'retention';

  -- 6. Supresión a petición del interesado.
  insert into public.leads (email, status) values ('suprimir@example.com', 'Nuevo'), ('Suprimir@Example.com', 'Contactado');
  insert into public.diagnostics (email) values ('suprimir@example.com');
  set local role authenticated;
  perform set_config('request.jwt.claims', admin_claims, true);
  v := public.crm_erase_contact('  SUPRIMIR@example.com ', 'Solicitud por email del 25/09');
  reset role;
  if v <> '{"leads_deleted": 2, "diagnostics_deleted": 1}'::jsonb then raise exception 'FALLO: supresión incompleta: %', v; end if;
  if exists (select 1 from public.leads where lower(email) = 'suprimir@example.com')
     or exists (select 1 from public.diagnostics where lower(email) = 'suprimir@example.com') then
    raise exception 'FALLO: quedaron datos del contacto suprimido';
  end if;
  if exists (select 1 from private.erasure_log where email_hash ~ '@' or reason ~ '@') then
    raise exception 'FALLO: el registro de supresión contiene un email';
  end if;
  if not exists (select 1 from private.erasure_log
                  where email_hash = encode(sha256(convert_to((select value #>> '{}' from private.settings where key = 'erasure_pepper') || 'suprimir@example.com', 'UTF8')), 'hex')
                    and actor_sub = '00000000-0000-4000-8000-00000000ad01') then
    raise exception 'FALLO: la supresión no quedó registrada de forma verificable';
  end if;
  begin
    set local role authenticated;
    perform set_config('request.jwt.claims', admin_claims, true);
    perform public.crm_erase_contact('no-es-un-email', 'motivo');
    raise exception 'FALLO: aceptó un email no válido';
  exception when others then reset role; if sqlerrm like 'FALLO:%' then raise; end if; end;
  begin
    set local role authenticated;
    perform set_config('request.jwt.claims', admin_claims, true);
    perform public.crm_erase_contact('x@example.com', 'contactar a ana@empresa.es');
    raise exception 'FALLO: aceptó un email en el motivo';
  exception when others then reset role; if sqlerrm like 'FALLO:%' then raise; end if; end;

  -- 7. Retirada del consentimiento comercial.
  insert into public.leads (email, status, commercial_consent, commercial_consent_at, commercial_consent_version)
  values ('consentimiento@example.com', 'Nuevo', true, now(), '2026-06-04') returning id into v_consent_lead;
  set local role authenticated;
  perform set_config('request.jwt.claims', admin_claims, true);
  if (public.crm_withdraw_commercial_consent(v_consent_lead))->>'status' <> 'withdrawn' then raise exception 'FALLO: no retiró el consentimiento'; end if;
  if (public.crm_withdraw_commercial_consent(v_consent_lead))->>'status' <> 'not_consented' then raise exception 'FALLO: la retirada no es idempotente'; end if;
  begin
    update public.leads set commercial_consent = true where id = v_consent_lead;
    raise exception 'FALLO: el CRM pudo volver a marcar el consentimiento directamente';
  exception when insufficient_privilege then null; end;
  reset role;
  if not exists (select 1 from public.leads where id = v_consent_lead and not commercial_consent and commercial_consent_withdrawn_at is not null) then
    raise exception 'FALLO: el lead no refleja la retirada';
  end if;
  if not exists (select 1 from private.consent_events where lead_id = v_consent_lead and kind = 'commercial' and action = 'withdrawn') then
    raise exception 'FALLO: la retirada no quedó registrada';
  end if;
  begin
    set local role authenticated;
    perform set_config('request.jwt.claims', user_claims, true);
    perform public.crm_withdraw_commercial_consent(v_consent_lead);
    raise exception 'FALLO: un usuario sin rol de administrador retiró un consentimiento';
  exception when insufficient_privilege then reset role; end;

  raise notice 'OK: verificación PR1c superada';
end;
$$;

rollback;

-- Solo se llega aquí si todos los bloques han pasado.
select 'OK: verificación PR1c superada' as resultado;
