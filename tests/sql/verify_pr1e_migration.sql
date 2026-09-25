-- Verificación de la migración 20260929_checkout_limits.sql (PR1e).
--
-- Se ejecuta entera dentro de una transacción que termina en ROLLBACK: no
-- deja contadores ni cambia la configuración. Cualquier fallo aborta con
-- "FALLO: ...". Si todo pasa, la última consulta devuelve
-- "OK: verificación PR1e superada".

begin;

do $$
declare
  v_allowed integer := 0;
begin
  -- 0. Configuración por defecto: cortafuegos de 30 por minuto, sin ventana por
  --    hora (un ataque no puede bloquear el checkout durante una hora). Si más
  --    adelante se ajustan los límites, este bloque fallará a propósito.
  if (select value from private.settings where key = 'checkout_limits')
     is distinct from '{"global_per_minute": 30, "global_per_hour": null, "email_per_hour": 5}'::jsonb then
    raise exception 'FALLO: checkout_limits no tiene los valores por defecto';
  end if;

  -- 1. Permisos: ni anon ni el CRM consultan (ni consumen) los límites.
  begin
    set local role anon;
    perform public.checkout_allow(null);
    raise exception 'FALLO: anon pudo usar checkout_allow';
  exception when insufficient_privilege then reset role; end;
  begin
    set local role authenticated;
    perform set_config('request.jwt.claims', '{"role":"authenticated","app_metadata":{"crm_role":"admin"}}', true);
    perform public.checkout_allow(null);
    raise exception 'FALLO: el CRM pudo usar checkout_allow';
  exception when insufficient_privilege then reset role; end;

  -- 2. Límite global: con 3 por minuto, solo pasan 3 de 5 (contadores de esta transacción).
  update private.settings set value = '{"global_per_minute": 3, "global_per_hour": 100, "email_per_hour": 100}' where key = 'checkout_limits';
  delete from private.rate_counters where bucket like 'checkout:%';
  set local role service_role;
  for i in 1..5 loop
    if public.checkout_allow(null) then v_allowed := v_allowed + 1; end if;
  end loop;
  reset role;
  if v_allowed <> 3 then raise exception 'FALLO: el límite global dejó pasar % de 5 (esperado 3)', v_allowed; end if;

  -- 3. Límite por email, sin guardar el email en claro.
  update private.settings set value = '{"global_per_minute": null, "global_per_hour": null, "email_per_hour": 2}' where key = 'checkout_limits';
  set local role service_role;
  if not public.checkout_allow('verificacion@example.com') or not public.checkout_allow('VERIFICACION@example.com') then
    raise exception 'FALLO: bloqueó los dos primeros intentos del email';
  end if;
  if public.checkout_allow('verificacion@example.com') then raise exception 'FALLO: no aplicó el límite por email'; end if;
  if not public.checkout_allow('otra-verificacion@example.com') then raise exception 'FALLO: el límite de un email afectó a otro'; end if;
  reset role;
  if exists (select 1 from private.rate_counters where bucket like '%@%') then
    raise exception 'FALLO: el contador guarda el email en claro';
  end if;

  -- 4. Interruptor: 0 cierra el checkout.
  update private.settings set value = '{"global_per_minute": 0, "global_per_hour": null, "email_per_hour": null}' where key = 'checkout_limits';
  set local role service_role;
  if public.checkout_allow(null) then raise exception 'FALLO: con límite 0 el checkout sigue abierto'; end if;
  reset role;

  raise notice 'OK: verificación PR1e superada';
end;
$$;

rollback;

-- Solo se llega aquí si todos los bloques han pasado.
select 'OK: verificación PR1e superada' as resultado;
