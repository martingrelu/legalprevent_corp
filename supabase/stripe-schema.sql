create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

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

create index if not exists checkout_sessions_created_at_idx on public.checkout_sessions (created_at desc);
create index if not exists checkout_sessions_email_idx on public.checkout_sessions (lower(customer_email));
create index if not exists subscriptions_status_idx on public.subscriptions (status);
create index if not exists payments_created_at_idx on public.payments (created_at desc);

drop trigger if exists checkout_sessions_set_updated_at on public.checkout_sessions;
create trigger checkout_sessions_set_updated_at
before update on public.checkout_sessions
for each row execute function public.set_updated_at();

drop trigger if exists subscriptions_set_updated_at on public.subscriptions;
create trigger subscriptions_set_updated_at
before update on public.subscriptions
for each row execute function public.set_updated_at();

alter table public.checkout_sessions enable row level security;
alter table public.subscriptions enable row level security;
alter table public.payments enable row level security;

grant select on public.checkout_sessions to authenticated;
grant select on public.subscriptions to authenticated;
grant select on public.payments to authenticated;

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
