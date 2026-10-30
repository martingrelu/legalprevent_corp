-- LP-CRM-002 · instalación mínima SOLO para el proyecto de staging ubyopnnfmajmrqhkapjk.
-- No ejecutar en ningún otro proyecto. Generado por tools/crm-staging-bundle.sh.
begin;

-- Protección: el paquete solo se instala en un proyecto de staging VACÍO.
do $guard$
declare
  r record;
  n bigint;
  busy text[] := '{}';
begin
  for r in select schemaname, tablename from pg_tables where schemaname in ('public', 'private') loop
    continue when r.schemaname = 'private' and r.tablename in ('settings', 'consent_versions');
    execute format('select count(*) from %I.%I', r.schemaname, r.tablename) into n;
    if n > 0 then
      busy := busy || format('%I.%I (%s filas)', r.schemaname, r.tablename, n);
    end if;
  end loop;
  if array_length(busy, 1) > 0 then
    raise exception 'Protección: la base contiene datos existentes (%). Este paquete solo se instala en un proyecto de staging vacío.', array_to_string(busy, ', ');
  end if;
end
$guard$;

-- ===== supabase/schema.sql =====
create extension if not exists pgcrypto;

create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'web',
  stage text not null default 'new',
  company_name text,
  contact_name text,
  email text not null,
  phone text,
  sector text,
  employees integer,
  status text not null default 'Nuevo',
  priority text not null default 'Media',
  score integer,
  risk_score integer,
  recommended_plan text,
  commercial_consent boolean not null default false,
  privacy_accepted boolean not null default false,
  page_url text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.diagnostics (
  id uuid primary key default gen_random_uuid(),
  company_name text,
  email text not null,
  phone text,
  sector text,
  employees text,
  score integer,
  classification text,
  critical_areas jsonb not null default '[]'::jsonb,
  priorities jsonb not null default '[]'::jsonb,
  risks jsonb not null default '[]'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.checkout_sessions (
  id uuid primary key default gen_random_uuid(),
  stripe_session_id text not null unique,
  stripe_customer_id text,
  stripe_subscription_id text,
  plan text,
  price_id text,
  status text,
  payment_status text,
  customer_email text,
  checkout_url text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  stripe_subscription_id text not null unique,
  stripe_customer_id text,
  lead_id uuid references public.leads(id) on delete set null,
  plan text,
  status text,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  stripe_invoice_id text not null unique,
  stripe_customer_id text,
  stripe_subscription_id text,
  amount_paid integer not null default 0,
  currency text not null default 'eur',
  status text,
  hosted_invoice_url text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists leads_created_at_idx on public.leads (created_at desc);
create index if not exists leads_email_idx on public.leads (lower(email));
create index if not exists diagnostics_created_at_idx on public.diagnostics (created_at desc);
create index if not exists diagnostics_email_idx on public.diagnostics (lower(email));
create index if not exists checkout_sessions_created_at_idx on public.checkout_sessions (created_at desc);
create index if not exists checkout_sessions_email_idx on public.checkout_sessions (lower(customer_email));
create index if not exists subscriptions_status_idx on public.subscriptions (status);
create index if not exists payments_created_at_idx on public.payments (created_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists leads_set_updated_at on public.leads;
create trigger leads_set_updated_at
before update on public.leads
for each row execute function public.set_updated_at();

drop trigger if exists checkout_sessions_set_updated_at on public.checkout_sessions;
create trigger checkout_sessions_set_updated_at
before update on public.checkout_sessions
for each row execute function public.set_updated_at();

drop trigger if exists subscriptions_set_updated_at on public.subscriptions;
create trigger subscriptions_set_updated_at
before update on public.subscriptions
for each row execute function public.set_updated_at();

alter table public.leads enable row level security;
alter table public.diagnostics enable row level security;
alter table public.checkout_sessions enable row level security;
alter table public.subscriptions enable row level security;
alter table public.payments enable row level security;

grant usage on schema public to anon, authenticated;
grant insert on public.leads to anon;
grant insert on public.diagnostics to anon;
grant select, insert, update on public.leads to authenticated;
grant select on public.diagnostics to authenticated;
grant select on public.checkout_sessions to authenticated;
grant select on public.subscriptions to authenticated;
grant select on public.payments to authenticated;

drop policy if exists "Public web can create leads" on public.leads;
create policy "Public web can create leads"
on public.leads
for insert
to anon
with check (true);

drop policy if exists "Authenticated users can read leads" on public.leads;
create policy "Authenticated users can read leads"
on public.leads
for select
to authenticated
using (true);

drop policy if exists "Authenticated users can update leads" on public.leads;
create policy "Authenticated users can update leads"
on public.leads
for update
to authenticated
using (true)
with check (true);

drop policy if exists "Authenticated users can create CRM leads" on public.leads;
create policy "Authenticated users can create CRM leads"
on public.leads
for insert
to authenticated
with check (true);

drop policy if exists "Public web can create diagnostics" on public.diagnostics;
create policy "Public web can create diagnostics"
on public.diagnostics
for insert
to anon
with check (true);

drop policy if exists "Authenticated users can read diagnostics" on public.diagnostics;
create policy "Authenticated users can read diagnostics"
on public.diagnostics
for select
to authenticated
using (true);

drop policy if exists "Authenticated users can read checkout sessions" on public.checkout_sessions;
create policy "Authenticated users can read checkout sessions"
on public.checkout_sessions
for select
to authenticated
using (true);

drop policy if exists "Authenticated users can read subscriptions" on public.subscriptions;
create policy "Authenticated users can read subscriptions"
on public.subscriptions
for select
to authenticated
using (true);

drop policy if exists "Authenticated users can read payments" on public.payments;
create policy "Authenticated users can read payments"
on public.payments
for select
to authenticated
using (true);

create or replace function public.submit_lead(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted public.leads;
begin
  if coalesce(p_payload->>'email', '') = '' then
    raise exception 'Email obligatorio';
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
    privacy_accepted,
    page_url,
    payload
  )
  values (
    coalesce(p_payload->>'source', 'web'),
    coalesce(p_payload->>'stage', 'new'),
    nullif(p_payload->>'company_name', ''),
    nullif(p_payload->>'contact_name', ''),
    lower(p_payload->>'email'),
    nullif(p_payload->>'phone', ''),
    nullif(p_payload->>'sector', ''),
    nullif(p_payload->>'employees', '')::integer,
    coalesce(p_payload->>'status', 'Nuevo'),
    coalesce(p_payload->>'priority', 'Media'),
    nullif(p_payload->>'score', '')::integer,
    nullif(p_payload->>'risk_score', '')::integer,
    nullif(p_payload->>'recommended_plan', ''),
    coalesce((p_payload->>'commercial_consent')::boolean, false),
    coalesce((p_payload->>'privacy_accepted')::boolean, false),
    nullif(p_payload->>'page_url', ''),
    coalesce(p_payload->'payload', p_payload)
  )
  returning * into inserted;

  return to_jsonb(inserted);
end;
$$;

create or replace function public.submit_diagnostic(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted public.diagnostics;
begin
  if coalesce(p_payload->>'email', '') = '' then
    raise exception 'Email obligatorio';
  end if;

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
    payload
  )
  values (
    nullif(p_payload->>'company_name', ''),
    lower(p_payload->>'email'),
    nullif(p_payload->>'phone', ''),
    nullif(p_payload->>'sector', ''),
    nullif(p_payload->>'employees', ''),
    nullif(p_payload->>'score', '')::integer,
    nullif(p_payload->>'classification', ''),
    coalesce(p_payload->'critical_areas', '[]'::jsonb),
    coalesce(p_payload->'priorities', '[]'::jsonb),
    coalesce(p_payload->'risks', '[]'::jsonb),
    coalesce(p_payload->'payload', p_payload)
  )
  returning * into inserted;

  return to_jsonb(inserted);
end;
$$;

grant execute on function public.submit_lead(jsonb) to anon, authenticated;
grant execute on function public.submit_diagnostic(jsonb) to anon, authenticated;
  

-- ===== supabase/migrations/20260815_enable_crm_manual_leads.sql =====
-- Permite que usuarios autenticados del CRM creen leads manuales.
grant insert on public.leads to authenticated;

drop policy if exists "Authenticated users can create CRM leads" on public.leads;
create policy "Authenticated users can create CRM leads"
on public.leads
for insert
to authenticated
with check (true);
  

-- ===== supabase/migrations/20260923_add_lead_funnel_fields.sql =====
-- Campos de embudo comercial en leads, editables desde el CRM.
-- Las columnas ya existen en la base de producción: esta migración deja
-- constancia en el repo y es idempotente (no altera columnas existentes).
--
-- Valores esperados (validados en el CRM, crm/src/models.js):
--   lead_type:   pyme | gestoria | despacho | grupo | autonomo
--   lost_reason: precio | ya_tiene_asesor | no_lo_necesita | sin_tiempo | no_responde | otro
alter table public.leads add column if not exists lead_type text;
alter table public.leads add column if not exists zone text;
alter table public.leads add column if not exists demo_at timestamptz;
alter table public.leads add column if not exists next_action_at timestamptz;
alter table public.leads add column if not exists lost_reason text;

-- ===== supabase/migrations/20260924_lead_notification_claim.sql =====
-- PR0: captación segura de leads y avisos internos.
--
-- 1. Cierra el alta directa de `anon` en `leads` y `diagnostics`: la web solo
--    puede crear registros mediante `submit_lead` / `submit_diagnostic`, que
--    validan los datos y exigen la aceptación de la política de privacidad.
-- 2. Diferencia la solicitud de demostración tras un diagnóstico
--    (`demo_requested_at`) sin crear un segundo lead.
-- 3. Reclamación atómica de avisos internos con tope horario global,
--    serializada con un advisory lock para que peticiones concurrentes no
--    puedan superarlo. Solo la service role (Edge Function) puede usarla.
--
-- Idempotente: se puede ejecutar varias veces sin efectos adicionales.
-- Todo o nada: se ejecuta en una única transacción (si algo falla, no se
-- aplica ningún cambio). Rollback: supabase/rollback/20260924_lead_notification_claim_down.sql
begin;

-- ---------------------------------------------------------------------------
-- Columnas
-- ---------------------------------------------------------------------------
alter table public.leads add column if not exists notified_at timestamptz;
alter table public.leads add column if not exists demo_requested_at timestamptz;
alter table public.leads add column if not exists demo_notified_at timestamptz;

create index if not exists leads_notified_at_idx
  on public.leads (notified_at)
  where notified_at is not null;
create index if not exists leads_demo_notified_at_idx
  on public.leads (demo_notified_at)
  where demo_notified_at is not null;

-- ---------------------------------------------------------------------------
-- Sin altas directas desde la web anónima
-- ---------------------------------------------------------------------------
drop policy if exists "Public web can create leads" on public.leads;
drop policy if exists "Public web can create diagnostics" on public.diagnostics;
revoke all on public.leads from anon;
revoke all on public.diagnostics from anon;

-- ---------------------------------------------------------------------------
-- Validación común de las altas públicas
-- ---------------------------------------------------------------------------
create or replace function public.assert_public_submission(p_payload jsonb)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v_email text := lower(trim(coalesce(p_payload->>'email', '')));
begin
  if pg_column_size(p_payload) > 65536 then
    raise exception 'payload_too_large';
  end if;
  if v_email = '' then
    raise exception 'Email obligatorio';
  end if;
  if length(v_email) > 254 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'email_invalid';
  end if;
  -- Sin aceptación expresa (booleano true) de la política de privacidad no se
  -- guardan datos. Es independiente del consentimiento comercial, opcional.
  if jsonb_typeof(p_payload->'privacy_accepted') is distinct from 'boolean'
     or (p_payload->>'privacy_accepted')::boolean is not true then
    raise exception 'privacy_required';
  end if;
  return v_email;
end;
$$;

-- ---------------------------------------------------------------------------
-- Alta de lead desde la web
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
begin
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
    privacy_accepted,
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
    -- Solo un booleano `true` explícito cuenta como consentimiento comercial.
    coalesce(
      jsonb_typeof(p_payload->'commercial_consent') = 'boolean'
        and (p_payload->>'commercial_consent')::boolean,
      false
    ),
    true,
    left(nullif(p_payload->>'page_url', ''), 500),
    coalesce(p_payload->'payload', p_payload)
  )
  returning id into inserted_id;

  -- Solo se devuelve el id: el visitante no necesita el resto del registro.
  return jsonb_build_object('id', inserted_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Alta de diagnóstico desde la web
-- ---------------------------------------------------------------------------
create or replace function public.submit_diagnostic(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted_id uuid;
  v_payload jsonb := p_payload;
  v_email text;
begin
  -- Compatibilidad TEMPORAL con la web publicada antes de PR0 (páginas en
  -- caché o migración aplicada antes de publicar la web): su diagnóstico no
  -- envía `privacy_accepted`, pero su paso 1 exige la casilla de privacidad
  -- junto al enlace a la política y el valor viaja en el payload
  -- (company.privacy = "on"). Solo se usa si falta `privacy_accepted`: un
  -- cliente nuevo que envíe false nunca pasa por aquí. Retirar en PR1.
  if not (p_payload ? 'privacy_accepted')
     and p_payload #>> '{payload,payload,company,privacy}' = 'on' then
    v_payload := p_payload || '{"privacy_accepted": true}'::jsonb;
  end if;
  v_email := public.assert_public_submission(v_payload);

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
    coalesce(p_payload->'payload', p_payload)
  )
  returning id into inserted_id;

  return jsonb_build_object('id', inserted_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Solicitud de demostración tras completar el diagnóstico
-- ---------------------------------------------------------------------------
-- Marca el lead del diagnóstico en lugar de crear otro. Solo sobre un lead de
-- diagnóstico reciente y una única vez. No toca el consentimiento comercial
-- ni el estado del CRM.
create or replace function public.request_lead_demo(p_lead_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.leads
     set demo_requested_at = now()
   where id = p_lead_id
     and source = 'diagnostic_completed'
     and demo_requested_at is null
     and created_at >= now() - interval '2 hours';
  return found;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reclamación de avisos internos (solo service role)
-- ---------------------------------------------------------------------------
create or replace function public.claim_lead_notification(
  p_lead_id uuid,
  p_kind text,
  p_hourly_cap integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  recent integer;
  claimed public.leads;
begin
  if p_kind is null or p_kind not in ('new_lead', 'demo_request') then
    raise exception 'invalid_kind';
  end if;

  -- Serializa todas las reclamaciones: recuento y marca son una sola
  -- operación, así que peticiones concurrentes no pueden superar el tope.
  perform pg_advisory_xact_lock(hashtext('legalprevent.lead_notification'));

  select
    (select count(*) from public.leads where notified_at >= now() - interval '1 hour')
    + (select count(*) from public.leads where demo_notified_at >= now() - interval '1 hour')
    into recent;

  if recent >= greatest(coalesce(p_hourly_cap, 0), 0) then
    return jsonb_build_object('status', 'throttled');
  end if;

  if p_kind = 'new_lead' then
    update public.leads
       set notified_at = now()
     where id = p_lead_id
       and notified_at is null
       and created_at >= now() - interval '15 minutes'
    returning * into claimed;
  else
    update public.leads
       set demo_notified_at = now()
     where id = p_lead_id
       and demo_notified_at is null
       and demo_requested_at >= now() - interval '15 minutes'
    returning * into claimed;
  end if;

  if claimed.id is null then
    return jsonb_build_object('status', 'not_eligible');
  end if;

  return jsonb_build_object(
    'status', 'claimed',
    'claimed_at', case when p_kind = 'new_lead' then claimed.notified_at else claimed.demo_notified_at end,
    'lead', jsonb_build_object(
      'id', claimed.id,
      'company_name', claimed.company_name,
      'contact_name', claimed.contact_name,
      'email', claimed.email,
      'phone', claimed.phone,
      'sector', claimed.sector,
      'employees', claimed.employees,
      'source', claimed.source,
      'page_url', claimed.page_url,
      'score', claimed.score,
      'commercial_consent', claimed.commercial_consent
    )
  );
end;
$$;

-- Libera una reclamación si el envío falló, solo si sigue siendo la misma.
create or replace function public.release_lead_notification(
  p_lead_id uuid,
  p_kind text,
  p_claimed_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_kind = 'new_lead' then
    update public.leads set notified_at = null
     where id = p_lead_id and notified_at = p_claimed_at;
  elsif p_kind = 'demo_request' then
    update public.leads set demo_notified_at = null
     where id = p_lead_id and demo_notified_at = p_claimed_at;
  else
    raise exception 'invalid_kind';
  end if;
  return found;
end;
$$;

-- ---------------------------------------------------------------------------
-- Permisos de ejecución
-- ---------------------------------------------------------------------------
-- Supabase concede EXECUTE por defecto a anon/authenticated en funciones
-- nuevas: se retira explícitamente y se concede solo lo necesario.
revoke all on function public.assert_public_submission(jsonb) from public, anon, authenticated;
revoke all on function public.submit_lead(jsonb) from public, anon, authenticated;
revoke all on function public.submit_diagnostic(jsonb) from public, anon, authenticated;
revoke all on function public.request_lead_demo(uuid) from public, anon, authenticated;
revoke all on function public.claim_lead_notification(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.release_lead_notification(uuid, text, timestamptz) from public, anon, authenticated;

grant execute on function public.submit_lead(jsonb) to anon, authenticated;
grant execute on function public.submit_diagnostic(jsonb) to anon, authenticated;
grant execute on function public.request_lead_demo(uuid) to anon, authenticated;
grant execute on function public.claim_lead_notification(uuid, text, integer) to service_role;
grant execute on function public.release_lead_notification(uuid, text, timestamptz) to service_role;

commit;

-- ===== supabase/migrations/20260925_crm_admin_policies.sql =====
-- PR1a (1/2): incorpora al repositorio el control de acceso del CRM que ya
-- existe en producción (inventario del 2026-09-24) y que schema.sql no refleja.
--
-- Solo los usuarios autenticados con `app_metadata.crm_role = 'admin'` en su
-- JWT pueden leer y editar leads, diagnósticos y datos de facturación. El rol
-- se asigna desde el dashboard de Supabase (Authentication → Users → raw app
-- metadata) y el usuario no puede modificarlo.
--
-- En producción no cambia nada: recrea las mismas políticas con la misma
-- condición y elimina las antiguas de schema.sql, que allí no existen.
-- Idempotente y en una única transacción.
begin;

create or replace function public.is_crm_admin()
returns boolean
language sql
stable
as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'crm_role') = 'admin', false)
$$;

-- Políticas antiguas de schema.sql (cualquier usuario autenticado).
drop policy if exists "Authenticated users can read leads" on public.leads;
drop policy if exists "Authenticated users can update leads" on public.leads;
drop policy if exists "Authenticated users can create CRM leads" on public.leads;
drop policy if exists "Authenticated users can read diagnostics" on public.diagnostics;
drop policy if exists "Authenticated users can read checkout sessions" on public.checkout_sessions;
drop policy if exists "Authenticated users can read subscriptions" on public.subscriptions;
drop policy if exists "Authenticated users can read payments" on public.payments;

-- Políticas vigentes en producción.
drop policy if exists "CRM admin read leads" on public.leads;
create policy "CRM admin read leads" on public.leads
  for select to authenticated using (public.is_crm_admin());

drop policy if exists "CRM admin update leads" on public.leads;
create policy "CRM admin update leads" on public.leads
  for update to authenticated using (public.is_crm_admin()) with check (public.is_crm_admin());

drop policy if exists "CRM admin create leads" on public.leads;
create policy "CRM admin create leads" on public.leads
  for insert to authenticated with check (public.is_crm_admin());

drop policy if exists "CRM admin read diagnostics" on public.diagnostics;
create policy "CRM admin read diagnostics" on public.diagnostics
  for select to authenticated using (public.is_crm_admin());

drop policy if exists "CRM admin read checkout sessions" on public.checkout_sessions;
create policy "CRM admin read checkout sessions" on public.checkout_sessions
  for select to authenticated using (public.is_crm_admin());

drop policy if exists "CRM admin read subscriptions" on public.subscriptions;
create policy "CRM admin read subscriptions" on public.subscriptions
  for select to authenticated using (public.is_crm_admin());

drop policy if exists "CRM admin read payments" on public.payments;
create policy "CRM admin read payments" on public.payments
  for select to authenticated using (public.is_crm_admin());

commit;

-- ===== supabase/migrations/20260925_public_limits_consent.sql =====
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

-- Backfill de datos históricos omitido en el paquete de staging.

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

-- ===== supabase/migrations/20260927_retention_erasure.sql =====
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
  select greatest((l).created_at, (l).updated_at, (l).next_action_at, (l).demo_at, (l).demo_requested_at)
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

-- ===== supabase/migrations/20261029_crm_operativa_preparada.sql =====
-- LP-CRM-002: persistencia de tareas, interacciones, propuestas y clientes del CRM.
--
-- ESTADO: PREPARADA, NO EJECUTADA. No aplicar en producción sin autorización expresa
-- y sin haber pasado antes la simulación de docs/crm-migracion-operativa.md.
--
-- Diseño:
-- - Una sola tabla con el registro completo en `payload`. Los identificadores locales
--   (`local_id`) se conservan tal cual, así que las relaciones existentes no cambian.
-- - `unique (kind, local_id)` impide duplicados al reimportar.
-- - Solo administradores del CRM (JWT con app_metadata.crm_role = 'admin') leen o escriben.
--   Depende de public.is_crm_admin(), creada en 20260925_crm_admin_policies.sql.
-- - Es aditiva: no modifica ni borra tablas existentes.

begin;

create table if not exists public.crm_records (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('client', 'task', 'interaction', 'proposal')),
  local_id text not null,
  related_type text,
  related_id text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_records_kind_local_id_key unique (kind, local_id)
);

create index if not exists crm_records_related_idx on public.crm_records (related_type, related_id);

alter table public.crm_records enable row level security;

revoke all on public.crm_records from anon;

drop policy if exists "crm admin acceso completo" on public.crm_records;
create policy "crm admin acceso completo"
  on public.crm_records
  for all
  to authenticated
  using (public.is_crm_admin())
  with check (public.is_crm_admin());

commit;

commit;
