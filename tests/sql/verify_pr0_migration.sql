-- Verificación de la migración 20260924_lead_notification_claim.sql (PR0).
--
-- Se ejecuta entera dentro de una transacción que termina en ROLLBACK: no
-- deja datos. Pensada para una base de pruebas (rama de Supabase o Postgres
-- local con schema.sql + migraciones aplicadas). Cualquier fallo aborta con
-- un mensaje "FALLO: ...".
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/sql/verify_pr0_migration.sql
--
-- Limitación: la concurrencia real (dos sesiones a la vez) no se puede probar
-- desde un único script; el tope depende del advisory lock
-- `pg_advisory_xact_lock` de claim_lead_notification, que serializa todas las
-- reclamaciones.

begin;

do $$
declare
  v jsonb;
  v_id uuid;
  v_diag_id uuid;
  v_claim jsonb;
  ok boolean;
begin
  -- 1. anon no puede insertar directamente.
  begin
    set local role anon;
    insert into public.leads (email) values ('directo@example.com');
    raise exception 'FALLO: anon pudo insertar directamente en leads';
  exception when insufficient_privilege then
    reset role;
  end;
  begin
    set local role anon;
    insert into public.diagnostics (email) values ('directo@example.com');
    raise exception 'FALLO: anon pudo insertar directamente en diagnostics';
  exception when insufficient_privilege then
    reset role;
  end;

  -- 2. anon no puede reclamar ni liberar avisos.
  begin
    set local role anon;
    perform public.claim_lead_notification(gen_random_uuid(), 'new_lead', 100);
    raise exception 'FALLO: anon pudo ejecutar claim_lead_notification';
  exception when insufficient_privilege then
    reset role;
  end;

  -- 3. Sin privacidad aceptada (o con un valor que no es booleano) no hay alta.
  foreach v in array array[
    '{"email":"a@example.com"}'::jsonb,
    '{"email":"a@example.com","privacy_accepted":false}'::jsonb,
    '{"email":"a@example.com","privacy_accepted":"true"}'::jsonb,
    '{"email":"a@example.com","privacy_accepted":"on"}'::jsonb
  ] loop
    begin
      set local role anon;
      perform public.submit_lead(v);
      raise exception 'FALLO: submit_lead aceptó %', v;
    exception when others then
      reset role;
      if sqlerrm like 'FALLO:%' then raise; end if;
    end;
    begin
      set local role anon;
      perform public.submit_diagnostic(v);
      raise exception 'FALLO: submit_diagnostic aceptó %', v;
    exception when others then
      reset role;
      if sqlerrm like 'FALLO:%' then raise; end if;
    end;
  end loop;

  -- 4. Privacidad y comunicaciones comerciales se guardan por separado.
  set local role anon;
  v := public.submit_lead('{"email":"b@example.com","privacy_accepted":true,"commercial_consent":"true"}');
  reset role;
  if (v - 'id') <> '{}'::jsonb then raise exception 'FALLO: submit_lead devuelve más que el id: %', v; end if;
  select commercial_consent into ok from public.leads where id = (v->>'id')::uuid;
  if ok is distinct from false then raise exception 'FALLO: "true" (texto) contó como consentimiento comercial'; end if;

  set local role anon;
  v := public.submit_lead('{"email":"c@example.com","privacy_accepted":true,"commercial_consent":true,"source":"diagnostic_completed"}');
  reset role;
  v_diag_id := (v->>'id')::uuid;
  perform 1 from public.leads where id = v_diag_id and privacy_accepted and commercial_consent;
  if not found then raise exception 'FALLO: consentimientos no guardados como true/true'; end if;

  set local role anon;
  v := public.submit_lead('{"email":"d@example.com","privacy_accepted":true}');
  reset role;
  v_id := (v->>'id')::uuid;
  perform 1 from public.leads where id = v_id and privacy_accepted and not commercial_consent;
  if not found then raise exception 'FALLO: privacidad aceptada sin consentimiento comercial mal guardada'; end if;

  -- 5. Reclamación: una vez por lead y tipo.
  set local role service_role;
  v_claim := public.claim_lead_notification(v_id, 'new_lead', 1000);
  if v_claim->>'status' <> 'claimed' then raise exception 'FALLO: primera reclamación %', v_claim; end if;
  if (public.claim_lead_notification(v_id, 'new_lead', 1000))->>'status' <> 'not_eligible' then
    raise exception 'FALLO: segunda reclamación del mismo lead no rechazada';
  end if;

  -- 6. Liberación solo con la marca propia.
  if public.release_lead_notification(v_id, 'new_lead', now() - interval '1 day') then
    raise exception 'FALLO: liberó una reclamación ajena';
  end if;
  if not public.release_lead_notification(v_id, 'new_lead', (v_claim->>'claimed_at')::timestamptz) then
    raise exception 'FALLO: no liberó la reclamación propia';
  end if;
  reset role;

  -- 7. Tope horario: con tope = avisos ya enviados en la última hora, se rechaza.
  set local role service_role;
  v_claim := public.claim_lead_notification(v_id, 'new_lead', 1000);
  if (public.claim_lead_notification(v_diag_id, 'new_lead',
        (select count(*)::int from public.leads where notified_at >= now() - interval '1 hour')))->>'status' <> 'throttled' then
    raise exception 'FALLO: el tope horario no se aplicó';
  end if;
  reset role;

  -- 8. Demo: solo sobre leads de diagnóstico, una vez; no toca el consentimiento.
  set local role anon;
  if public.request_lead_demo(v_id) then raise exception 'FALLO: demo marcada sobre un lead que no es de diagnóstico'; end if;
  if not public.request_lead_demo(v_diag_id) then raise exception 'FALLO: demo no marcada sobre lead de diagnóstico'; end if;
  if public.request_lead_demo(v_diag_id) then raise exception 'FALLO: demo marcada dos veces'; end if;
  if public.request_lead_demo(gen_random_uuid()) then raise exception 'FALLO: demo marcada sobre id inexistente'; end if;
  reset role;

  set local role service_role;
  if (public.claim_lead_notification(v_diag_id, 'demo_request', 1000))->>'status' <> 'claimed' then
    raise exception 'FALLO: aviso de demo no reclamado';
  end if;
  if (public.claim_lead_notification(v_diag_id, 'demo_request', 1000))->>'status' <> 'not_eligible' then
    raise exception 'FALLO: aviso de demo reclamado dos veces';
  end if;
  reset role;

  -- 9. Un lead antiguo no se puede reclamar.
  update public.leads set created_at = now() - interval '1 hour', notified_at = null where id = v_id;
  set local role service_role;
  if (public.claim_lead_notification(v_id, 'new_lead', 1000))->>'status' <> 'not_eligible' then
    raise exception 'FALLO: se reclamó un lead de hace una hora';
  end if;
  reset role;

  -- 10. Compatibilidad temporal del diagnóstico publicado: solo si falta
  --     privacy_accepted y el formulario antiguo marcó la casilla.
  set local role anon;
  v := public.submit_diagnostic('{"email":"legado@example.com","payload":{"payload":{"company":{"privacy":"on"}}}}');
  if v->>'id' is null then raise exception 'FALLO: diagnóstico publicado con casilla marcada rechazado'; end if;
  reset role;
  foreach v in array array[
    '{"email":"legado@example.com","payload":{"payload":{"company":{}}}}'::jsonb,
    '{"email":"legado@example.com","payload":{"payload":{"company":{"privacy":"off"}}}}'::jsonb,
    '{"email":"legado@example.com","privacy_accepted":false,"payload":{"payload":{"company":{"privacy":"on"}}}}'::jsonb
  ] loop
    begin
      set local role anon;
      perform public.submit_diagnostic(v);
      raise exception 'FALLO: submit_diagnostic (compatibilidad) aceptó %', v;
    exception when others then
      reset role;
      if sqlerrm like 'FALLO:%' then raise; end if;
    end;
  end loop;
  -- La compatibilidad no se extiende a submit_lead.
  begin
    set local role anon;
    perform public.submit_lead('{"email":"legado@example.com","payload":{"payload":{"company":{"privacy":"on"}}}}');
    raise exception 'FALLO: submit_lead aceptó la compatibilidad del diagnóstico';
  exception when others then
    reset role;
    if sqlerrm like 'FALLO:%' then raise; end if;
  end;

  raise notice 'OK: verificación PR0 superada';
end;
$$;

rollback;

-- Resultado visible también en clientes que no muestran los NOTICE (SQL Editor
-- de Supabase): solo se llega aquí si los 10 bloques han pasado.
select 'OK: verificación PR0 superada' as resultado;
