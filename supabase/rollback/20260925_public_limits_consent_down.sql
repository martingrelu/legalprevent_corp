-- ROLLBACK de 20260925_public_limits_consent.sql (PR1a).
--
-- Vuelve al estado de producción tras PR0:
--   * submit_lead / submit_diagnostic de PR0 (sin límites y con la
--     compatibilidad temporal del diagnóstico antiguo).
--   * Permisos anteriores: anon y authenticated con todos los privilegios en
--     las tablas de Stripe (limitados por RLS), authenticated con todos en
--     leads y diagnostics, e is_crm_admin/set_updated_at ejecutables por todos.
-- CONSERVA: el esquema private (configuración, contadores y registro de
-- consentimientos), las columnas de consentimiento y la marca de revisión
-- jurídica, y la vista leads_privacy_review. Son datos con valor probatorio y
-- no afectan al flujo de PR0.
--
-- Todo o nada: una única transacción.
begin;

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

grant all on public.checkout_sessions, public.subscriptions, public.payments to anon, authenticated;
grant all on public.leads to authenticated;
grant all on public.diagnostics to authenticated;
grant execute on function public.is_crm_admin() to public;
grant execute on function public.set_updated_at() to public;

revoke all on function public.submit_lead(jsonb) from public, anon, authenticated;
revoke all on function public.submit_diagnostic(jsonb) from public, anon, authenticated;
grant execute on function public.submit_lead(jsonb) to anon, authenticated;
grant execute on function public.submit_diagnostic(jsonb) to anon, authenticated;

commit;
