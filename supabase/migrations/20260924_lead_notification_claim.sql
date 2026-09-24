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
