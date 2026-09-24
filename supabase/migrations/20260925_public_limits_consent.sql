-- PR1a (2/2): límites persistentes de altas públicas, consentimiento con fecha
-- y versión, retirada de la compatibilidad temporal de PR0 y mínimo privilegio.
--
-- 1. Esquema `private` (no expuesto por la API REST) con la configuración, los
--    contadores de límites, las sales diarias y el registro de consentimientos.
-- 2. submit_lead / submit_diagnostic aplican límites por email, globales y,
--    cuando se configure una cabecera fiable, por IP. Al superarse devuelven
--    {"error":"rate_limited"} sin lanzar excepción: así los intentos
--    rechazados también quedan contados (útil para detectar abusos; una
--    excepción desharía su incremento) y la web recibe una respuesta clara.
-- 3. La aceptación de la privacidad y el consentimiento comercial se guardan
--    por separado con fecha (del servidor) y versión validada.
-- 4. Los leads anteriores sin prueba de consentimiento se marcan para revisión
--    jurídica (privacy_review_required). No se borra ni se modifica nada más.
-- 5. Se retira la compatibilidad temporal del diagnóstico publicado antes de
--    PR0 (0 usos desde el despliegue de PR0).
-- 6. Mínimo privilegio: anon sin permisos en las tablas de Stripe;
--    authenticated solo lee facturación y solo puede editar las columnas que
--    usa el CRM (no las de consentimiento ni las de avisos).
--
-- Idempotente y en una única transacción.
-- Rollback: supabase/rollback/20260925_public_limits_consent_down.sql
begin;

-- ---------------------------------------------------------------------------
-- 1. Esquema privado
-- ---------------------------------------------------------------------------
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.settings (
  key text primary key,
  value jsonb not null,
  description text,
  updated_at timestamptz not null default now()
);

insert into private.settings (key, value, description) values
  ('public_limits',
   '{"ip_per_hour": 5, "email_per_day": 3, "global_per_minute": 20, "global_per_hour": 200}',
   'Altas públicas. Por email y día se cuentan aparte leads y diagnósticos. null = sin límite; 0 = cerrado.'),
  ('client_ip_source', '"none"',
   'Origen de la IP del visitante: none | cf-connecting-ip | x-real-ip | x-forwarded-for-first | x-forwarded-for-last. Configurar solo tras verificar qué cabecera es fiable en Supabase.')
on conflict (key) do nothing;

create table if not exists private.rate_counters (
  bucket text not null,
  window_start timestamptz not null,
  hits integer not null default 0,
  primary key (bucket, window_start)
);

create table if not exists private.daily_salts (
  day date primary key,
  -- 32 bytes aleatorios a partir de gen_random_uuid() (generador seguro del núcleo).
  salt bytea not null default (uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid()))
);

create table if not exists private.consent_versions (
  kind text not null check (kind in ('privacy', 'commercial')),
  version text not null,
  active boolean not null default true,
  published_at date not null,
  description text,
  primary key (kind, version)
);

insert into private.consent_versions (kind, version, active, published_at, description) values
  ('privacy', '2026-06-04', true, '2026-06-04', 'Política de Privacidad (última actualización 04/06/2026)'),
  ('commercial', '2026-06-04', true, '2026-06-04', 'Casilla "Acepto recibir comunicaciones comerciales" de la web')
on conflict (kind, version) do nothing;

create table if not exists private.consent_events (
  id bigserial primary key,
  lead_id uuid references public.leads(id) on delete cascade,
  diagnostic_id uuid references public.diagnostics(id) on delete cascade,
  kind text not null check (kind in ('privacy', 'commercial')),
  action text not null check (action in ('granted', 'withdrawn')),
  version text not null,
  source text not null,
  occurred_at timestamptz not null default now(),
  check (lead_id is not null or diagnostic_id is not null)
);
create index if not exists consent_events_lead_idx on private.consent_events (lead_id);

revoke all on all tables in schema private from public, anon, authenticated;
revoke all on all sequences in schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Utilidades de límites
-- ---------------------------------------------------------------------------
-- Hash con sal diaria: permite contar por email o IP sin guardarlos en claro.
create or replace function private.salted_hash(p_value text)
returns text
language plpgsql
set search_path = private, pg_temp
as $$
declare
  v_salt bytea;
begin
  insert into private.daily_salts (day) values (current_date) on conflict (day) do nothing;
  select salt into v_salt from private.daily_salts where day = current_date;
  return encode(sha256(v_salt || convert_to(lower(trim(coalesce(p_value, ''))), 'UTF8')), 'hex');
end;
$$;

-- IP del visitante según la cabecera configurada (PostgREST expone las
-- cabeceras de la petición en request.headers). Devuelve null si no hay una
-- fuente configurada o el valor no es una IP válida.
create or replace function private.client_ip()
returns text
language plpgsql
stable
set search_path = private, pg_temp
as $$
declare
  v_source text;
  v_headers jsonb;
  v_raw text;
begin
  select value #>> '{}' into v_source from private.settings where key = 'client_ip_source';
  if v_source is null or v_source = 'none' then
    return null;
  end if;
  begin
    v_headers := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb;
  exception when others then
    return null;
  end;
  v_raw := case v_source
    when 'cf-connecting-ip' then v_headers ->> 'cf-connecting-ip'
    when 'x-real-ip' then v_headers ->> 'x-real-ip'
    when 'x-forwarded-for-first' then split_part(v_headers ->> 'x-forwarded-for', ',', 1)
    when 'x-forwarded-for-last' then reverse(split_part(reverse(v_headers ->> 'x-forwarded-for'), ',', 1))
    else null
  end;
  v_raw := nullif(trim(v_raw), '');
  if v_raw is null then
    return null;
  end if;
  begin
    return host(v_raw::inet);
  exception when others then
    return null;
  end;
end;
$$;

-- Suma un intento al contador de la ventana actual de forma atómica
-- (INSERT ... ON CONFLICT bloquea la fila) y dice si sigue dentro del límite.
-- p_limit null = sin límite; 0 = cerrado.
create or replace function private.rate_hit(p_bucket text, p_window interval, p_limit integer)
returns boolean
language plpgsql
set search_path = private, pg_temp
as $$
declare
  v_start timestamptz := date_bin(p_window, now(), timestamptz '2000-01-01 00:00:00+00');
  v_hits integer;
begin
  if p_limit is null then
    return true;
  end if;
  insert into private.rate_counters as c (bucket, window_start, hits)
  values (p_bucket, v_start, 1)
  on conflict (bucket, window_start) do update set hits = c.hits + 1
  returning c.hits into v_hits;
  return v_hits <= p_limit;
end;
$$;

-- true si el alta puede continuar. Cuenta el intento en todos los ámbitos
-- aplicables (global, email por tipo y, si hay IP fiable, IP).
create or replace function private.allow_public_submission(p_kind text, p_email text)
returns boolean
language plpgsql
set search_path = private, pg_temp
as $$
declare
  v_limits jsonb;
  v_ip text := private.client_ip();
  v_ok boolean := true;
begin
  select value into v_limits from private.settings where key = 'public_limits';
  v_ok := private.rate_hit('global:minute', interval '1 minute', (v_limits ->> 'global_per_minute')::integer) and v_ok;
  v_ok := private.rate_hit('global:hour', interval '1 hour', (v_limits ->> 'global_per_hour')::integer) and v_ok;
  v_ok := private.rate_hit('email:' || p_kind || ':' || private.salted_hash(p_email), interval '1 day',
                           (v_limits ->> 'email_per_day')::integer) and v_ok;
  if v_ip is not null then
    v_ok := private.rate_hit('ip:' || private.salted_hash(v_ip), interval '1 hour',
                             (v_limits ->> 'ip_per_hour')::integer) and v_ok;
  end if;
  -- Limpieza oportunista de ventanas antiguas.
  if random() < 0.02 then
    delete from private.rate_counters where window_start < now() - interval '2 days';
    delete from private.daily_salts where day < current_date - 2;
  end if;
  return v_ok;
end;
$$;

-- Versión de consentimiento: la indicada por el cliente si existe y está
-- activa, o la activa más reciente si no se indica.
create or replace function private.resolve_consent_version(p_kind text, p_requested text)
returns text
language plpgsql
stable
set search_path = private, pg_temp
as $$
declare
  v_version text;
begin
  if nullif(trim(p_requested), '') is null then
    select version into v_version from private.consent_versions
     where kind = p_kind and active order by published_at desc limit 1;
  else
    select version into v_version from private.consent_versions
     where kind = p_kind and active and version = trim(p_requested);
  end if;
  if v_version is null then
    raise exception 'consent_version_invalid';
  end if;
  return v_version;
end;
$$;

revoke all on all functions in schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Columnas de consentimiento
-- ---------------------------------------------------------------------------
alter table public.leads add column if not exists privacy_accepted_at timestamptz;
alter table public.leads add column if not exists privacy_policy_version text;
alter table public.leads add column if not exists commercial_consent_at timestamptz;
alter table public.leads add column if not exists commercial_consent_version text;
alter table public.leads add column if not exists privacy_review_required boolean not null default false;

alter table public.diagnostics add column if not exists privacy_accepted_at timestamptz;
alter table public.diagnostics add column if not exists privacy_policy_version text;

-- ---------------------------------------------------------------------------
-- 4. Altas públicas
-- ---------------------------------------------------------------------------
create or replace function public.submit_lead(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted_id uuid;
  v_email text := public.assert_public_submission(p_payload);
  v_commercial boolean := coalesce(
    jsonb_typeof(p_payload->'commercial_consent') = 'boolean'
      and (p_payload->>'commercial_consent')::boolean,
    false
  );
  v_privacy_version text;
  v_commercial_version text;
begin
  if not private.allow_public_submission('lead', v_email) then
    return jsonb_build_object('error', 'rate_limited');
  end if;

  v_privacy_version := private.resolve_consent_version('privacy', p_payload->>'privacy_policy_version');
  if v_commercial then
    v_commercial_version := private.resolve_consent_version('commercial', p_payload->>'commercial_consent_version');
  end if;

  insert into public.leads (
    source,
    stage,
    company_name,
    contact_name,
    email,
    phone,
    sector,
    employees,
    status,
    priority,
    score,
    risk_score,
    recommended_plan,
    commercial_consent,
    commercial_consent_at,
    commercial_consent_version,
    privacy_accepted,
    privacy_accepted_at,
    privacy_policy_version,
    page_url,
    payload
  )
  values (
    left(coalesce(nullif(p_payload->>'source', ''), 'web'), 80),
    left(coalesce(nullif(p_payload->>'stage', ''), 'new'), 80),
    left(nullif(p_payload->>'company_name', ''), 200),
    left(nullif(p_payload->>'contact_name', ''), 200),
    v_email,
    left(nullif(p_payload->>'phone', ''), 40),
    left(nullif(p_payload->>'sector', ''), 120),
    nullif(p_payload->>'employees', '')::integer,
    left(coalesce(nullif(p_payload->>'status', ''), 'Nuevo'), 40),
    left(coalesce(nullif(p_payload->>'priority', ''), 'Media'), 20),
    nullif(p_payload->>'score', '')::integer,
    nullif(p_payload->>'risk_score', '')::integer,
    left(nullif(p_payload->>'recommended_plan', ''), 40),
    v_commercial,
    case when v_commercial then now() end,
    v_commercial_version,
    true,
    now(),
    v_privacy_version,
    left(nullif(p_payload->>'page_url', ''), 500),
    coalesce(p_payload->'payload', p_payload)
  )
  returning id into inserted_id;

  insert into private.consent_events (lead_id, kind, action, version, source)
  values (inserted_id, 'privacy', 'granted', v_privacy_version, 'submit_lead');
  if v_commercial then
    insert into private.consent_events (lead_id, kind, action, version, source)
    values (inserted_id, 'commercial', 'granted', v_commercial_version, 'submit_lead');
  end if;

  return jsonb_build_object('id', inserted_id);
end;
$$;

-- Sin la compatibilidad temporal de PR0: exige privacy_accepted = true.
create or replace function public.submit_diagnostic(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted_id uuid;
  v_email text := public.assert_public_submission(p_payload);
  v_privacy_version text;
begin
  if not private.allow_public_submission('diagnostic', v_email) then
    return jsonb_build_object('error', 'rate_limited');
  end if;

  v_privacy_version := private.resolve_consent_version('privacy', p_payload->>'privacy_policy_version');

  insert into public.diagnostics (
    company_name,
    email,
    phone,
    sector,
    employees,
    score,
    classification,
    critical_areas,
    priorities,
    risks,
    privacy_accepted_at,
    privacy_policy_version,
    payload
  )
  values (
    left(nullif(p_payload->>'company_name', ''), 200),
    v_email,
    left(nullif(p_payload->>'phone', ''), 40),
    left(nullif(p_payload->>'sector', ''), 120),
    left(nullif(p_payload->>'employees', ''), 40),
    nullif(p_payload->>'score', '')::integer,
    left(nullif(p_payload->>'classification', ''), 80),
    coalesce(p_payload->'critical_areas', '[]'::jsonb),
    coalesce(p_payload->'priorities', '[]'::jsonb),
    coalesce(p_payload->'risks', '[]'::jsonb),
    now(),
    v_privacy_version,
    coalesce(p_payload->'payload', p_payload)
  )
  returning id into inserted_id;

  insert into private.consent_events (diagnostic_id, kind, action, version, source)
  values (inserted_id, 'privacy', 'granted', v_privacy_version, 'submit_diagnostic');

  return jsonb_build_object('id', inserted_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Datos existentes (sin borrar nada)
-- ---------------------------------------------------------------------------
-- Leads captados con PR0 (desde su despliegue, 2026-09-24 19:00 UTC): el
-- servidor ya exigía la privacidad con la política 2026-06-04.
update public.leads
   set privacy_accepted_at = created_at,
       privacy_policy_version = '2026-06-04'
 where privacy_accepted
   and privacy_accepted_at is null
   and created_at >= timestamptz '2026-09-24 19:00:00+00';
update public.leads
   set commercial_consent_at = created_at,
       commercial_consent_version = '2026-06-04'
 where commercial_consent
   and commercial_consent_at is null
   and created_at >= timestamptz '2026-09-24 19:00:00+00';
insert into private.consent_events (lead_id, kind, action, version, source, occurred_at)
select l.id, 'privacy', 'granted', '2026-06-04', 'backfill_pr0', l.created_at
  from public.leads l
 where l.privacy_accepted_at is not null
   and l.created_at >= timestamptz '2026-09-24 19:00:00+00'
   and not exists (select 1 from private.consent_events e where e.lead_id = l.id and e.kind = 'privacy');

-- Resto: sin prueba de fecha ni versión → revisión jurídica.
update public.leads
   set privacy_review_required = true
 where privacy_accepted_at is null
   and not privacy_review_required;

-- Vista para la revisión jurídica (aplica la RLS de leads: solo CRM admin).
create or replace view public.leads_privacy_review
with (security_invoker = true) as
select id, created_at, source, stage, status, privacy_accepted, commercial_consent
  from public.leads
 where privacy_review_required;

-- ---------------------------------------------------------------------------
-- 6. Mínimo privilegio
-- ---------------------------------------------------------------------------
-- Tablas de Stripe: solo la service role escribe (webhook y checkout); el CRM lee.
revoke all on public.checkout_sessions, public.subscriptions, public.payments from anon, authenticated;
grant select on public.checkout_sessions, public.subscriptions, public.payments to authenticated;

-- leads: el CRM lee, crea y edita solo sus columnas; nunca consentimiento ni avisos.
revoke all on public.leads from authenticated;
grant select, insert on public.leads to authenticated;
grant update (
  source, stage, company_name, contact_name, email, phone, sector, employees,
  status, priority, score, risk_score, recommended_plan, page_url, payload,
  lead_type, zone, demo_at, next_action_at, lost_reason
) on public.leads to authenticated;

-- diagnostics: el CRM solo lee.
revoke all on public.diagnostics from authenticated;
grant select on public.diagnostics to authenticated;

revoke all on public.leads_privacy_review from public, anon;
grant select on public.leads_privacy_review to authenticated;

-- Funciones auxiliares: fuera del alcance de anon.
revoke all on function public.is_crm_admin() from public, anon;
grant execute on function public.is_crm_admin() to authenticated, service_role;
revoke all on function public.set_updated_at() from public, anon;
grant execute on function public.set_updated_at() to authenticated, service_role;

revoke all on function public.submit_lead(jsonb) from public, anon, authenticated;
revoke all on function public.submit_diagnostic(jsonb) from public, anon, authenticated;
grant execute on function public.submit_lead(jsonb) to anon, authenticated;
grant execute on function public.submit_diagnostic(jsonb) to anon, authenticated;

commit;
