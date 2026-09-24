-- ROLLBACK de 20260924_lead_notification_claim.sql (PR0).
--
-- Úsalo SOLO si la migración provoca un fallo que no pueda corregirse hacia
-- delante. Restaura el comportamiento anterior de la base de datos:
--   * submit_lead / submit_diagnostic vuelven a su definición original
--     (sin exigir privacidad y devolviendo el registro completo).
--   * anon recupera el INSERT directo en leads y diagnostics con sus políticas.
--   * Se eliminan request_lead_demo, claim/release_lead_notification y
--     assert_public_submission.
-- Se CONSERVAN las columnas notified_at, demo_requested_at y demo_notified_at
-- (sin efecto en el flujo antiguo; evita perder datos). Tras el rollback, la
-- función nueva deja de enviar avisos (responde 500) pero sigue sin enviar
-- emails a direcciones externas; la web nueva degrada la demo al formulario.
--
-- Todo o nada: se ejecuta en una única transacción.
begin;

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

drop function if exists public.request_lead_demo(uuid);
drop function if exists public.claim_lead_notification(uuid, text, integer);
drop function if exists public.release_lead_notification(uuid, text, timestamptz);
drop function if exists public.assert_public_submission(jsonb);

grant insert on public.leads to anon;
grant insert on public.diagnostics to anon;

drop policy if exists "Public web can create leads" on public.leads;
create policy "Public web can create leads"
on public.leads
for insert
to anon
with check (true);

drop policy if exists "Public web can create diagnostics" on public.diagnostics;
create policy "Public web can create diagnostics"
on public.diagnostics
for insert
to anon
with check (true);

commit;
