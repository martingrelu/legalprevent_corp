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

create index if not exists leads_created_at_idx on public.leads (created_at desc);
create index if not exists leads_email_idx on public.leads (lower(email));
create index if not exists diagnostics_created_at_idx on public.diagnostics (created_at desc);
create index if not exists diagnostics_email_idx on public.diagnostics (lower(email));

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

alter table public.leads enable row level security;
alter table public.diagnostics enable row level security;

grant usage on schema public to anon, authenticated;
grant insert on public.leads to anon;
grant insert on public.diagnostics to anon;
grant select, update on public.leads to authenticated;
grant select on public.diagnostics to authenticated;

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
