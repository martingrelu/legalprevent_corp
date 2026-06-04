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

drop policy if exists "Public web can create leads" on public.leads;
create policy "Public web can create leads"
on public.leads
for insert
to anon
with check (privacy_accepted = true and email <> '');

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
with check (email <> '');

drop policy if exists "Authenticated users can read diagnostics" on public.diagnostics;
create policy "Authenticated users can read diagnostics"
on public.diagnostics
for select
to authenticated
using (true);
