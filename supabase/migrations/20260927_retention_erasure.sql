-- PR1c: conservación limitada, supresión a petición del interesado y
-- retirada del consentimiento comercial.
--
-- 1. Conservación de 12 meses para contactos NO convertidos, PENDIENTE DE
--    VALIDACIÓN JURÍDICA: llega desactivada (retention.enabled = false).
--    retention_preview() solo cuenta; retention_run() no borra nada mientras
--    esté desactivada. Nunca incluye clientes, contactos con pagos o
--    suscripciones, ni los leads pendientes de revisión jurídica.
-- 2. crm_erase_contact(): el CRM administrador borra a petición del interesado
--    todos sus leads y diagnósticos (y sus eventos de consentimiento). Queda
--    constancia con el email en hash (con un secreto del servidor), nunca en
--    claro.
-- 3. crm_withdraw_commercial_consent(): retira el consentimiento comercial y
--    registra el evento (el CRM no puede modificar esas columnas directamente).
--
-- Criterios conservadores mientras no haya validación jurídica: la prueba del
-- consentimiento se borra con el contacto, el plazo cuenta desde la última
-- actividad y no hay lista de "no contactar".
--
-- Idempotente y en una única transacción.
-- Rollback: supabase/rollback/20260927_retention_erasure_down.sql
begin;

-- ---------------------------------------------------------------------------
-- 1. Configuración y registros
-- ---------------------------------------------------------------------------
insert into private.settings (key, value, description) values
  ('retention', '{"enabled": false, "months": 12}',
   'Conservación de contactos no convertidos. PENDIENTE DE VALIDACIÓN JURÍDICA: no activar sin ella.'),
  ('erasure_pepper',
   to_jsonb(encode(uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid()), 'hex')),
   'Secreto para registrar las supresiones sin guardar el email en claro. No cambiar: invalidaría la comprobación de supresiones anteriores.')
on conflict (key) do nothing;

create table if not exists private.erasure_log (
  id bigserial primary key,
  email_hash text not null,
  reason text not null,
  leads_deleted integer not null,
  diagnostics_deleted integer not null,
  actor_sub text,
  created_at timestamptz not null default now()
);

create table if not exists private.retention_log (
  id bigserial primary key,
  enabled boolean not null,
  months integer,
  cutoff timestamptz,
  leads_deleted integer not null default 0,
  diagnostics_deleted integer not null default 0,
  run_at timestamptz not null default now()
);

alter table public.leads add column if not exists commercial_consent_withdrawn_at timestamptz;

revoke all on all tables in schema private from public, anon, authenticated;
revoke all on all sequences in schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Criterios de conservación
-- ---------------------------------------------------------------------------
-- Última actividad conocida de un lead.
create or replace function private.lead_last_activity(l public.leads)
returns timestamptz
language sql
stable
as $$
  select greatest(l.created_at, l.updated_at, l.next_action_at, l.demo_at, l.demo_requested_at)
$$;

-- Leads no convertidos sin actividad desde p_cutoff.
create or replace function private.retention_lead_candidates(p_cutoff timestamptz)
returns setof uuid
language sql
stable
set search_path = public, private, pg_temp
as $$
  select l.id
    from public.leads l
   where coalesce(l.status, '') <> 'Cliente ganado'
     and not l.privacy_review_required
     and private.lead_last_activity(l) < p_cutoff
     and not exists (select 1 from public.subscriptions s where s.lead_id = l.id)
     and not exists (select 1 from public.checkout_sessions c where lower(c.customer_email) = l.email)
$$;

-- Diagnósticos anteriores a p_cutoff sin ningún lead que se conserve con su email.
create or replace function private.retention_diagnostic_candidates(p_cutoff timestamptz)
returns setof uuid
language sql
stable
set search_path = public, private, pg_temp
as $$
  select d.id
    from public.diagnostics d
   where d.created_at < p_cutoff
     and not exists (
       select 1 from public.leads l
        where l.email = d.email
          and l.id not in (select private.retention_lead_candidates(p_cutoff))
     )
$$;

create or replace function private.retention_cutoff()
returns timestamptz
language sql
stable
set search_path = private, pg_temp
as $$
  select now() - make_interval(months => coalesce((value ->> 'months')::integer, 12))
    from private.settings where key = 'retention'
$$;

revoke all on all functions in schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. API
-- ---------------------------------------------------------------------------
-- Vista previa para el CRM administrador: solo recuentos, sin datos personales.
create or replace function public.retention_preview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_config jsonb;
  v_cutoff timestamptz := private.retention_cutoff();
begin
  if not public.is_crm_admin() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  select value into v_config from private.settings where key = 'retention';
  return jsonb_build_object(
    'enabled', coalesce((v_config ->> 'enabled')::boolean, false),
    'months', (v_config ->> 'months')::integer,
    'cutoff', v_cutoff,
    'leads', (select count(*) from private.retention_lead_candidates(v_cutoff)),
    'diagnostics', (select count(*) from private.retention_diagnostic_candidates(v_cutoff)),
    'privacy_review_pending', (select count(*) from public.leads where privacy_review_required)
  );
end;
$$;

-- Ejecución (para una tarea programada con la service role). No borra nada
-- mientras retention.enabled sea false; siempre deja registro.
create or replace function public.retention_run()
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_config jsonb;
  v_enabled boolean;
  v_cutoff timestamptz := private.retention_cutoff();
  v_leads integer := 0;
  v_diagnostics integer := 0;
begin
  perform pg_advisory_xact_lock(hashtext('legalprevent.retention'));
  select value into v_config from private.settings where key = 'retention';
  v_enabled := coalesce((v_config ->> 'enabled')::boolean, false);

  if v_enabled then
    -- Primero los diagnósticos (el criterio depende de los leads que quedan).
    with deleted as (
      delete from public.diagnostics
       where id in (select private.retention_diagnostic_candidates(v_cutoff))
      returning 1
    ) select count(*) into v_diagnostics from deleted;
    with deleted as (
      delete from public.leads
       where id in (select private.retention_lead_candidates(v_cutoff))
      returning 1
    ) select count(*) into v_leads from deleted;
  end if;

  insert into private.retention_log (enabled, months, cutoff, leads_deleted, diagnostics_deleted)
  values (v_enabled, (v_config ->> 'months')::integer, v_cutoff, v_leads, v_diagnostics);

  return jsonb_build_object('status', case when v_enabled then 'done' else 'disabled' end,
                            'leads_deleted', v_leads, 'diagnostics_deleted', v_diagnostics);
end;
$$;

-- Supresión a petición del interesado (solo CRM administrador).
create or replace function public.crm_erase_contact(p_email text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_reason text := trim(coalesce(p_reason, ''));
  v_pepper text;
  v_leads integer;
  v_diagnostics integer;
begin
  if not public.is_crm_admin() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'email_invalid';
  end if;
  if length(v_reason) < 3 or length(v_reason) > 200 or v_reason ~ '@' then
    raise exception 'reason_invalid';
  end if;

  with deleted as (delete from public.diagnostics where lower(email) = v_email returning 1)
  select count(*) into v_diagnostics from deleted;
  with deleted as (delete from public.leads where lower(email) = v_email returning 1)
  select count(*) into v_leads from deleted;

  select value #>> '{}' into v_pepper from private.settings where key = 'erasure_pepper';
  insert into private.erasure_log (email_hash, reason, leads_deleted, diagnostics_deleted, actor_sub)
  values (encode(sha256(convert_to(v_pepper || v_email, 'UTF8')), 'hex'), v_reason,
          v_leads, v_diagnostics, auth.jwt() ->> 'sub');

  return jsonb_build_object('leads_deleted', v_leads, 'diagnostics_deleted', v_diagnostics);
end;
$$;

-- Retirada del consentimiento comercial (solo CRM administrador).
create or replace function public.crm_withdraw_commercial_consent(p_lead_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_lead public.leads;
begin
  if not public.is_crm_admin() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  select * into v_lead from public.leads where id = p_lead_id for update;
  if v_lead.id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  if not v_lead.commercial_consent then
    return jsonb_build_object('status', 'not_consented');
  end if;

  update public.leads
     set commercial_consent = false, commercial_consent_withdrawn_at = now()
   where id = p_lead_id;
  insert into private.consent_events (lead_id, kind, action, version, source)
  values (p_lead_id, 'commercial', 'withdrawn',
          coalesce(v_lead.commercial_consent_version, private.resolve_consent_version('commercial', null)),
          'crm');
  return jsonb_build_object('status', 'withdrawn');
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Permisos
-- ---------------------------------------------------------------------------
revoke all on function public.retention_preview() from public, anon, authenticated;
revoke all on function public.retention_run() from public, anon, authenticated;
revoke all on function public.crm_erase_contact(text, text) from public, anon, authenticated;
revoke all on function public.crm_withdraw_commercial_consent(uuid) from public, anon, authenticated;

-- Las tres del CRM comprueban is_crm_admin() dentro.
grant execute on function public.retention_preview() to authenticated;
grant execute on function public.crm_erase_contact(text, text) to authenticated;
grant execute on function public.crm_withdraw_commercial_consent(uuid) to authenticated;
grant execute on function public.retention_run() to service_role;

commit;
