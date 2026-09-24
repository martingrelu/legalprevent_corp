-- Verificación de las migraciones de PR1a:
--   20260925_crm_admin_policies.sql y 20260925_public_limits_consent.sql
--
-- Se ejecuta entera dentro de una transacción que termina en ROLLBACK: no
-- deja datos ni cambia la configuración. Cualquier fallo aborta con
-- "FALLO: ...". Si todo pasa, la última consulta devuelve
-- "OK: verificación PR1a superada".
--
-- La concurrencia real de los límites se prueba en tests/lab (sesiones
-- independientes); aquí se comprueba la lógica.

begin;

do $$
declare
  v jsonb;
  v_id uuid;
  v_ip_ok boolean;
  admin_claims constant text := '{"role":"authenticated","app_metadata":{"crm_role":"admin"}}';
  user_claims constant text := '{"role":"authenticated","app_metadata":{}}';
begin
  -- Límites holgados para el resto de bloques (se restauran con el ROLLBACK).
  update private.settings
     set value = '{"ip_per_hour": null, "email_per_day": null, "global_per_minute": null, "global_per_hour": null}'
   where key = 'public_limits';

  -- 1. anon no accede al esquema privado.
  begin
    set local role anon;
    perform 1 from private.settings;
    raise exception 'FALLO: anon pudo leer private.settings';
  exception when insufficient_privilege then
    reset role;
  end;
  begin
    set local role anon;
    perform private.rate_hit('x', interval '1 minute', 1);
    raise exception 'FALLO: anon pudo ejecutar private.rate_hit';
  exception when insufficient_privilege then
    reset role;
  end;

  -- 2. anon sin permisos en las tablas de Stripe; authenticated solo lee.
  begin
    set local role anon;
    perform 1 from public.payments;
    raise exception 'FALLO: anon pudo leer payments';
  exception when insufficient_privilege then
    reset role;
  end;
  begin
    set local role authenticated;
    perform set_config('request.jwt.claims', admin_claims, true);
    insert into public.payments (stripe_invoice_id) values ('in_verificacion');
    raise exception 'FALLO: authenticated pudo insertar en payments';
  exception when insufficient_privilege then
    reset role;
  end;

  -- 3. Consentimiento con fecha y versión, por separado.
  set local role anon;
  v := public.submit_lead('{"email":"v1@example.com","privacy_accepted":true}');
  reset role;
  v_id := (v->>'id')::uuid;
  perform 1 from public.leads
   where id = v_id and privacy_accepted and privacy_accepted_at is not null
     and privacy_policy_version = '2026-06-04'
     and not commercial_consent and commercial_consent_at is null and commercial_consent_version is null
     and not privacy_review_required;
  if not found then raise exception 'FALLO: consentimiento sin comunicaciones comerciales mal registrado'; end if;
  if (select count(*) from private.consent_events where lead_id = v_id) <> 1 then
    raise exception 'FALLO: eventos de consentimiento incorrectos (sin comerciales)';
  end if;

  set local role anon;
  v := public.submit_lead('{"email":"v2@example.com","privacy_accepted":true,"commercial_consent":true,"commercial_consent_version":"2026-06-04"}');
  reset role;
  v_id := (v->>'id')::uuid;
  perform 1 from public.leads
   where id = v_id and commercial_consent and commercial_consent_at is not null
     and commercial_consent_version = '2026-06-04' and privacy_policy_version = '2026-06-04';
  if not found then raise exception 'FALLO: consentimiento comercial mal registrado'; end if;
  if (select count(*) from private.consent_events where lead_id = v_id) <> 2 then
    raise exception 'FALLO: eventos de consentimiento incorrectos (con comerciales)';
  end if;

  -- 4. Versión de consentimiento desconocida: rechazada.
  begin
    set local role anon;
    perform public.submit_lead('{"email":"v3@example.com","privacy_accepted":true,"privacy_policy_version":"1999-01-01"}');
    raise exception 'FALLO: aceptó una versión de privacidad inexistente';
  exception when others then
    reset role;
    if sqlerrm like 'FALLO:%' then raise; end if;
  end;

  -- 5. Compatibilidad temporal de PR0 retirada.
  begin
    set local role anon;
    perform public.submit_diagnostic('{"email":"legado@example.com","payload":{"payload":{"company":{"privacy":"on"}}}}');
    raise exception 'FALLO: sigue activa la compatibilidad temporal del diagnóstico';
  exception when others then
    reset role;
    if sqlerrm like 'FALLO:%' then raise; end if;
  end;
  set local role anon;
  v := public.submit_diagnostic('{"email":"diag@example.com","privacy_accepted":true}');
  reset role;
  perform 1 from public.diagnostics
   where id = (v->>'id')::uuid and privacy_accepted_at is not null and privacy_policy_version = '2026-06-04';
  if not found then raise exception 'FALLO: diagnóstico sin fecha o versión de privacidad'; end if;

  -- 6. Límite por email: el intento que lo supera no inserta y queda contado.
  update private.settings set value = jsonb_set(value, '{email_per_day}', '2') where key = 'public_limits';
  set local role anon;
  perform public.submit_lead('{"email":"limite@example.com","privacy_accepted":true}');
  perform public.submit_lead('{"email":"limite@example.com","privacy_accepted":true}');
  v := public.submit_lead('{"email":"LIMITE@example.com","privacy_accepted":true}');
  reset role;
  if v->>'error' is distinct from 'rate_limited' then raise exception 'FALLO: el límite por email no se aplicó: %', v; end if;
  if (select count(*) from public.leads where email = 'limite@example.com') <> 2 then
    raise exception 'FALLO: se insertó un lead por encima del límite';
  end if;
  if not exists (select 1 from private.rate_counters where bucket like 'email:lead:%' and hits = 3) then
    raise exception 'FALLO: el intento rechazado no quedó contado';
  end if;
  if exists (select 1 from private.rate_counters where bucket like '%limite@example.com%') then
    raise exception 'FALLO: el email aparece en claro en los contadores';
  end if;
  -- Leads y diagnósticos cuentan por separado.
  set local role anon;
  v := public.submit_diagnostic('{"email":"limite@example.com","privacy_accepted":true}');
  reset role;
  if v->>'error' is not null then raise exception 'FALLO: el límite de leads bloqueó un diagnóstico'; end if;

  -- 7. Cierre global (0) y límite global.
  update private.settings set value = jsonb_set(value, '{global_per_minute}', '0') where key = 'public_limits';
  set local role anon;
  v := public.submit_lead('{"email":"cerrado@example.com","privacy_accepted":true}');
  reset role;
  if v->>'error' is distinct from 'rate_limited' then raise exception 'FALLO: el cierre global no se aplicó'; end if;
  update private.settings set value = jsonb_set(value, '{global_per_minute}', 'null') where key = 'public_limits';

  -- 8. Límite por IP: sin fuente configurada no se usa; con fuente, la IP que
  --    añade el proxy (última de X-Forwarded-For) no se puede falsear.
  perform set_config('request.headers', '{"x-forwarded-for":"9.9.9.9, 203.0.113.7"}', true);
  if private.client_ip() is not null then raise exception 'FALLO: se usó la IP sin fuente configurada'; end if;
  update private.settings set value = '"x-forwarded-for-last"' where key = 'client_ip_source';
  if private.client_ip() is distinct from '203.0.113.7' then raise exception 'FALLO: IP mal extraída: %', private.client_ip(); end if;
  update private.settings set value = jsonb_set(value, '{ip_per_hour}', '1') where key = 'public_limits';
  set local role anon;
  v := public.submit_lead('{"email":"ip1@example.com","privacy_accepted":true}');
  reset role;
  if v->>'error' is not null then raise exception 'FALLO: primera alta por IP rechazada'; end if;
  perform set_config('request.headers', '{"x-forwarded-for":"1.1.1.1, 203.0.113.7"}', true);
  set local role anon;
  v := public.submit_lead('{"email":"ip2@example.com","privacy_accepted":true}');
  reset role;
  if v->>'error' is distinct from 'rate_limited' then raise exception 'FALLO: una cabecera falseada eludió el límite por IP'; end if;
  perform set_config('request.headers', '{"x-forwarded-for":"no-es-una-ip"}', true);
  if private.client_ip() is not null then raise exception 'FALLO: aceptó una IP no válida'; end if;
  perform set_config('request.headers', '', true);

  -- 9. El CRM no puede tocar consentimiento ni avisos, pero sí sus columnas.
  set local role authenticated;
  perform set_config('request.jwt.claims', admin_claims, true);
  update public.leads set status = 'Contactado' where id = v_id;
  begin
    update public.leads set privacy_accepted_at = now() where id = v_id;
    raise exception 'FALLO: el CRM pudo modificar privacy_accepted_at';
  exception when insufficient_privilege then
    null;
  end;
  begin
    update public.leads set notified_at = null where id = v_id;
    raise exception 'FALLO: el CRM pudo modificar notified_at';
  exception when insufficient_privilege then
    null;
  end;
  reset role;
  if (select status from public.leads where id = v_id) <> 'Contactado' then
    raise exception 'FALLO: el CRM no pudo editar el estado';
  end if;

  -- 10. Revisión jurídica: ningún lead sin prueba de consentimiento queda sin
  --     marcar, y solo un administrador del CRM ve la lista.
  if exists (select 1 from public.leads where privacy_accepted_at is null and not privacy_review_required) then
    raise exception 'FALLO: hay leads sin prueba de consentimiento sin marcar para revisión';
  end if;
  insert into public.leads (email, privacy_review_required) values ('revision@example.com', true);
  set local role authenticated;
  perform set_config('request.jwt.claims', user_claims, true);
  if (select count(*) from public.leads_privacy_review) <> 0 then
    raise exception 'FALLO: un usuario sin rol de administrador ve la revisión jurídica';
  end if;
  perform set_config('request.jwt.claims', admin_claims, true);
  if (select count(*) from public.leads_privacy_review) < 1 then
    raise exception 'FALLO: el administrador del CRM no ve la revisión jurídica';
  end if;
  reset role;

  raise notice 'OK: verificación PR1a superada';
end;
$$;

rollback;

-- Solo se llega aquí si todos los bloques han pasado.
select 'OK: verificación PR1a superada' as resultado;
