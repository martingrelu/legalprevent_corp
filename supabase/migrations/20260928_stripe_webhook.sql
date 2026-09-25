-- PR1d: registro fiable de los eventos de Stripe.
--
-- El webhook (Edge Function `stripe-webhook`) ya no escribe en las tablas con
-- upserts sueltos: llama a stripe_record_event(), que en una sola transacción
-- 1. ignora los eventos ya procesados (Stripe reintenta y puede duplicar);
-- 2. no deja que un evento más antiguo pise datos de uno más reciente (Stripe
--    no garantiza el orden de entrega): cada fila guarda la fecha del evento
--    que la escribió (stripe_event_created) y solo se actualiza con otro igual
--    o posterior;
-- 3. deja constancia del evento (id, tipo y fecha; sin datos personales).
-- Si algo falla, la transacción no deja nada y el webhook responde 500 para
-- que Stripe reintente.
--
-- Solo la service role (el webhook) puede usarla.
-- Idempotente y en una única transacción.
-- Rollback: supabase/rollback/20260928_stripe_webhook_down.sql
begin;

alter table public.checkout_sessions add column if not exists stripe_event_created timestamptz;
alter table public.subscriptions add column if not exists stripe_event_created timestamptz;
alter table public.payments add column if not exists stripe_event_created timestamptz;
alter table public.payments add column if not exists updated_at timestamptz not null default now();

create table if not exists private.stripe_events (
  event_id text primary key,
  type text not null,
  event_created timestamptz not null,
  kind text not null,
  outcome text not null,
  received_at timestamptz not null default now()
);

revoke all on all tables in schema private from public, anon, authenticated;

-- p_kind: 'checkout_session' | 'subscription' | 'payment' | 'ignored'
-- p_row: campos ya extraídos por el webhook (ver supabase/functions/stripe-webhook).
create or replace function public.stripe_record_event(
  p_event_id text,
  p_type text,
  p_created timestamptz,
  p_kind text,
  p_row jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_payload jsonb := coalesce(p_row -> 'payload', '{}'::jsonb);
  v_rows integer := 0;
  v_outcome text;
begin
  if p_event_id is null or p_event_id !~ '^evt_[A-Za-z0-9]+$' then
    raise exception 'stripe_event_invalid';
  end if;
  if p_kind not in ('checkout_session', 'subscription', 'payment', 'ignored') then
    raise exception 'stripe_kind_invalid';
  end if;
  if p_created is null then
    raise exception 'stripe_event_invalid';
  end if;

  insert into private.stripe_events (event_id, type, event_created, kind, outcome)
  values (p_event_id, coalesce(p_type, ''), p_created, p_kind, 'pending')
  on conflict (event_id) do nothing;
  if not found then
    return jsonb_build_object('status', 'duplicate');
  end if;

  if p_kind = 'checkout_session' then
    if coalesce(p_row ->> 'stripe_session_id', '') = '' then raise exception 'stripe_row_invalid'; end if;
    insert into public.checkout_sessions as t
      (stripe_session_id, stripe_customer_id, stripe_subscription_id, plan, status,
       payment_status, customer_email, payload, stripe_event_created)
    values
      (p_row ->> 'stripe_session_id', p_row ->> 'stripe_customer_id', p_row ->> 'stripe_subscription_id',
       p_row ->> 'plan', p_row ->> 'status', p_row ->> 'payment_status',
       lower(nullif(p_row ->> 'customer_email', '')), v_payload, p_created)
    on conflict (stripe_session_id) do update set
      stripe_customer_id = coalesce(excluded.stripe_customer_id, t.stripe_customer_id),
      stripe_subscription_id = coalesce(excluded.stripe_subscription_id, t.stripe_subscription_id),
      plan = coalesce(excluded.plan, t.plan),
      status = excluded.status,
      payment_status = excluded.payment_status,
      customer_email = coalesce(excluded.customer_email, t.customer_email),
      payload = excluded.payload,
      stripe_event_created = excluded.stripe_event_created
    where t.stripe_event_created is null or t.stripe_event_created <= excluded.stripe_event_created;
    get diagnostics v_rows = row_count;

  elsif p_kind = 'subscription' then
    if coalesce(p_row ->> 'stripe_subscription_id', '') = '' then raise exception 'stripe_row_invalid'; end if;
    insert into public.subscriptions as t
      (stripe_subscription_id, stripe_customer_id, plan, status, current_period_start,
       current_period_end, cancel_at_period_end, payload, stripe_event_created)
    values
      (p_row ->> 'stripe_subscription_id', p_row ->> 'stripe_customer_id', p_row ->> 'plan',
       p_row ->> 'status', (p_row ->> 'current_period_start')::timestamptz,
       (p_row ->> 'current_period_end')::timestamptz,
       coalesce((p_row ->> 'cancel_at_period_end')::boolean, false), v_payload, p_created)
    on conflict (stripe_subscription_id) do update set
      stripe_customer_id = coalesce(excluded.stripe_customer_id, t.stripe_customer_id),
      plan = coalesce(excluded.plan, t.plan),
      status = excluded.status,
      current_period_start = coalesce(excluded.current_period_start, t.current_period_start),
      current_period_end = coalesce(excluded.current_period_end, t.current_period_end),
      cancel_at_period_end = excluded.cancel_at_period_end,
      payload = excluded.payload,
      stripe_event_created = excluded.stripe_event_created
    where t.stripe_event_created is null or t.stripe_event_created <= excluded.stripe_event_created;
    get diagnostics v_rows = row_count;

  elsif p_kind = 'payment' then
    if coalesce(p_row ->> 'stripe_invoice_id', '') = '' then raise exception 'stripe_row_invalid'; end if;
    insert into public.payments as t
      (stripe_invoice_id, stripe_customer_id, stripe_subscription_id, amount_paid, currency,
       status, hosted_invoice_url, payload, stripe_event_created)
    values
      (p_row ->> 'stripe_invoice_id', p_row ->> 'stripe_customer_id', p_row ->> 'stripe_subscription_id',
       coalesce((p_row ->> 'amount_paid')::integer, 0), coalesce(nullif(p_row ->> 'currency', ''), 'eur'),
       p_row ->> 'status', p_row ->> 'hosted_invoice_url', v_payload, p_created)
    on conflict (stripe_invoice_id) do update set
      stripe_customer_id = coalesce(excluded.stripe_customer_id, t.stripe_customer_id),
      stripe_subscription_id = coalesce(excluded.stripe_subscription_id, t.stripe_subscription_id),
      amount_paid = excluded.amount_paid,
      currency = excluded.currency,
      status = excluded.status,
      hosted_invoice_url = coalesce(excluded.hosted_invoice_url, t.hosted_invoice_url),
      payload = excluded.payload,
      stripe_event_created = excluded.stripe_event_created,
      updated_at = now()
    where t.stripe_event_created is null or t.stripe_event_created <= excluded.stripe_event_created;
    get diagnostics v_rows = row_count;
  end if;

  v_outcome := case
    when p_kind = 'ignored' then 'ignored'
    when v_rows = 0 then 'stale'
    else 'applied'
  end;
  update private.stripe_events set outcome = v_outcome where event_id = p_event_id;
  return jsonb_build_object('status', v_outcome);
end;
$$;

revoke all on function public.stripe_record_event(text, text, timestamptz, text, jsonb) from public, anon, authenticated;
grant execute on function public.stripe_record_event(text, text, timestamptz, text, jsonb) to service_role;

commit;
