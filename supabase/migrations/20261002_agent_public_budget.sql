-- PR2e · Presupuesto público del agente comercial (25 €/mes).
--
-- Sustituye el cálculo heredado de PR1b (precios fijos de gpt-4.1-mini) por la
-- MISMA tabla de precios por modelo que usa el laboratorio de PR2
-- (agent.models + usd_eur, función private.agent_model_cost):
--   * reserva conservadora con el modelo público (default_model), sin caché y
--     con un margen (public_reserve_margin), ANTES de contactar con el proveedor;
--   * liquidación con el consumo real (entrada, caché y salida) y el modelo de
--     la reserva;
--   * el límite mensual nunca se supera con una reserva nueva (bloqueo global);
--   * tope global por minuto (public_max_calls_per_minute) además de los
--     límites por sesión y por día;
--   * alertas al 50, 80 y 100 % (una por umbral y mes) para el CRM y el email,
--     con reintento seguro; un fallo del email nunca afecta al bloqueo.
-- El presupuesto de pruebas de PR2 (agent_preview_*) no se toca.
-- Compatible con la Edge Function ya desplegada (PR2d): mismos nombres de
-- parámetros; p_cached_tokens es opcional.
-- Idempotente. Rollback: supabase/rollback/20261002_agent_public_budget_down.sql

begin;

-- ---------------------------------------------------------------------------
-- 1. Configuración (solo claves nuevas; no cambia presupuestos ni modelo)
-- ---------------------------------------------------------------------------
update private.settings
   set value = jsonb_build_object('public_max_calls_per_minute', 20, 'public_reserve_margin', 1.25) || value,
       updated_at = now()
 where key = 'agent';

-- ---------------------------------------------------------------------------
-- 2. Esquema
-- ---------------------------------------------------------------------------
alter table private.agent_reservations add column if not exists model text;

create table if not exists private.agent_budget_alerts (
  month date not null,
  threshold integer not null check (threshold in (50, 80, 100)),
  triggered_at timestamptz not null default now(),
  spent_eur numeric(12, 6) not null,
  budget_eur numeric(12, 6) not null,
  email_status text not null default 'pending' check (email_status in ('pending', 'sending', 'sent', 'failed')),
  email_attempts integer not null default 0,
  email_last_attempt_at timestamptz,
  email_sent_at timestamptz,
  email_error text,
  primary key (month, threshold)
);
alter table private.agent_budget_alerts enable row level security;
revoke all on private.agent_budget_alerts from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Utilidades internas
-- ---------------------------------------------------------------------------
-- Modelo del modo público: default_model si está en la lista; si no, null.
create or replace function private.agent_public_model(p_config jsonb)
returns text
language sql
immutable
as $$
  select case when p_config -> 'models' ? (p_config ->> 'default_model') then p_config ->> 'default_model' end
$$;

-- Registra (una sola vez por mes y umbral) las alertas alcanzadas.
-- p_exhausted: una reserva se ha rechazado por presupuesto → umbral 100.
create or replace function private.agent_raise_alerts(p_month date, p_spent numeric, p_budget numeric, p_config jsonb, p_exhausted boolean)
returns void
language plpgsql
set search_path = private, pg_temp
as $$
declare
  v_pct numeric := case when p_budget > 0 then p_spent / p_budget * 100 else 100 end;
  v_t integer;
begin
  for v_t in
    select (a.value)::integer from jsonb_array_elements_text(coalesce(p_config -> 'alert_thresholds_pct', '[50, 80, 100]')) a
  loop
    if v_t in (50, 80, 100) and (v_pct >= v_t or (p_exhausted and v_t = 100)) then
      insert into private.agent_budget_alerts (month, threshold, spent_eur, budget_eur)
      values (p_month, v_t, p_spent, p_budget)
      on conflict (month, threshold) do nothing;
    end if;
  end loop;
  -- Compatibilidad con el campo heredado de PR1b.
  update private.agent_budget_months b
     set alerts_sent = (select coalesce(array_agg(threshold order by threshold), '{}') from private.agent_budget_alerts where month = p_month)
   where b.month = p_month;
end;
$$;

create or replace function private.agent_alerts_pending()
returns boolean
language sql
stable
set search_path = private, pg_temp
as $$
  select exists (select 1 from private.agent_budget_alerts where email_status in ('pending', 'failed', 'sending') and email_attempts < 10)
$$;

revoke all on function private.agent_public_model(jsonb) from public, anon, authenticated;
revoke all on function private.agent_raise_alerts(date, numeric, numeric, jsonb, boolean) from public, anon, authenticated;
revoke all on function private.agent_alerts_pending() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. API de la Edge Function (solo service role)
-- ---------------------------------------------------------------------------
-- Reserva el coste MÁXIMO de una llamada pública. status:
--   reserved | disabled | rate_limited | session_limit | daily_limit | budget_exhausted
create or replace function public.agent_reserve(
  p_session_id text,
  p_max_input_tokens integer,
  p_max_output_tokens integer
)
returns jsonb
language plpgsql
security definer
set search_path = private, pg_temp
as $$
declare
  v_config jsonb;
  v_session text := private.agent_valid_session(p_session_id);
  v_month date := private.agent_month();
  v_model text;
  v_budget numeric;
  v_estimate numeric;
  v_row private.agent_budget_months;
  v_id uuid;
begin
  if coalesce(p_max_input_tokens, -1) < 0 or coalesce(p_max_output_tokens, -1) < 0
     or p_max_input_tokens > 200000 or p_max_output_tokens > 32000 then
    raise exception 'agent_tokens_invalid';
  end if;

  -- Serializa todo el presupuesto: comprobación y reserva son una sola operación.
  perform pg_advisory_xact_lock(hashtext('legalprevent.agent_budget'));

  v_config := private.agent_config();
  v_model := private.agent_public_model(v_config);
  if v_config is null or not coalesce((v_config ->> 'enabled')::boolean, false) or v_model is null then
    return jsonb_build_object('status', 'disabled');
  end if;

  perform private.agent_expire_reservations(v_config);

  -- Tope global por minuto (ráfagas), antes que cualquier otra cuenta.
  if not private.rate_hit('agent:public:minute', interval '1 minute',
                          coalesce((v_config ->> 'public_max_calls_per_minute')::integer, 20)) then
    return jsonb_build_object('status', 'rate_limited');
  end if;

  insert into private.agent_budget_months (month) values (v_month) on conflict (month) do nothing;
  select * into v_row from private.agent_budget_months where month = v_month;

  if (select count(*) from private.agent_reservations
       where session_id = v_session and status in ('reserved', 'settled')
         and created_at >= now() - interval '24 hours')
     >= (v_config ->> 'max_messages_per_session')::integer then
    return jsonb_build_object('status', 'session_limit');
  end if;

  if (select count(*) from private.agent_reservations
       where status in ('reserved', 'settled') and created_at >= private.agent_day_start())
     >= (v_config ->> 'max_calls_per_day')::integer then
    return jsonb_build_object('status', 'daily_limit');
  end if;

  -- Coste máximo: tabla por modelo, sin caché, con margen de seguridad.
  v_budget := (v_config ->> 'monthly_budget_eur')::numeric;
  v_estimate := round(private.agent_model_cost(v_model, p_max_input_tokens, 0, p_max_output_tokens, v_config)
                      * greatest(coalesce((v_config ->> 'public_reserve_margin')::numeric, 1.25), 1), 6);
  if v_row.spent_eur + v_row.reserved_eur + v_estimate > v_budget then
    perform private.agent_raise_alerts(v_month, v_row.spent_eur, v_budget, v_config, true);
    return jsonb_build_object('status', 'budget_exhausted', 'alerts_pending', private.agent_alerts_pending());
  end if;

  insert into private.agent_reservations (month, session_id, reserved_eur, model)
  values (v_month, v_session, v_estimate, v_model)
  returning id into v_id;
  update private.agent_budget_months
     set reserved_eur = reserved_eur + v_estimate, updated_at = now()
   where month = v_month;

  return jsonb_build_object('status', 'reserved', 'reservation_id', v_id, 'max_cost_eur', v_estimate, 'model', v_model);
end;
$$;

-- Liquida una reserva con el consumo real. Idempotente.
drop function if exists public.agent_settle(uuid, integer, integer, integer);
create or replace function public.agent_settle(
  p_reservation_id uuid,
  p_input_tokens integer,
  p_output_tokens integer,
  p_latency_ms integer default null,
  p_cached_tokens integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = private, pg_temp
as $$
declare
  v_config jsonb;
  v_res private.agent_reservations;
  v_cost numeric;
  v_row private.agent_budget_months;
  v_budget numeric;
begin
  if coalesce(p_input_tokens, -1) < 0 or coalesce(p_output_tokens, -1) < 0 or coalesce(p_cached_tokens, 0) < 0 then
    raise exception 'agent_tokens_invalid';
  end if;
  perform pg_advisory_xact_lock(hashtext('legalprevent.agent_budget'));
  v_config := private.agent_config();

  select * into v_res from private.agent_reservations where id = p_reservation_id for update;
  if v_res.id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_res.status in ('settled', 'released') then
    return jsonb_build_object('status', 'already_closed');
  end if;

  -- Modelo de la reserva (no el actual: no cambia a mitad de llamada). Las
  -- reservas anteriores a PR2e no tienen modelo: se cobra lo reservado.
  if v_res.model is not null and v_config -> 'models' ? v_res.model then
    v_cost := private.agent_model_cost(v_res.model, p_input_tokens, coalesce(p_cached_tokens, 0), p_output_tokens, v_config);
  else
    v_cost := v_res.reserved_eur;
  end if;

  update private.agent_budget_months
     set spent_eur = spent_eur + v_cost,
         -- Una reserva caducada ya devolvió su importe.
         reserved_eur = case when v_res.status = 'reserved'
                             then greatest(reserved_eur - v_res.reserved_eur, 0) else reserved_eur end,
         updated_at = now()
   where month = v_res.month
  returning * into v_row;

  update private.agent_reservations set status = 'settled', closed_at = now() where id = v_res.id;
  insert into private.agent_usage (reservation_id, session_id, model, input_tokens, output_tokens, cost_eur, latency_ms, outcome)
  values (v_res.id, v_res.session_id, coalesce(v_res.model, 'desconocido'),
          p_input_tokens, p_output_tokens, v_cost, p_latency_ms, 'ok');

  v_budget := (v_config ->> 'monthly_budget_eur')::numeric;
  perform private.agent_raise_alerts(v_res.month, v_row.spent_eur, v_budget, v_config, false);

  return jsonb_build_object('status', 'settled', 'cost_eur', v_cost, 'spent_eur', v_row.spent_eur,
                            'budget_eur', v_budget, 'alerts_pending', private.agent_alerts_pending());
end;
$$;

-- Devuelve la reserva si la llamada al proveedor falló. Idempotente.
create or replace function public.agent_release(p_reservation_id uuid, p_latency_ms integer default null)
returns jsonb
language plpgsql
security definer
set search_path = private, pg_temp
as $$
declare
  v_res private.agent_reservations;
begin
  perform pg_advisory_xact_lock(hashtext('legalprevent.agent_budget'));
  select * into v_res from private.agent_reservations where id = p_reservation_id for update;
  if v_res.id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_res.status <> 'reserved' then
    return jsonb_build_object('status', 'already_closed');
  end if;
  update private.agent_budget_months
     set reserved_eur = greatest(reserved_eur - v_res.reserved_eur, 0), updated_at = now()
   where month = v_res.month;
  update private.agent_reservations set status = 'released', closed_at = now() where id = v_res.id;
  insert into private.agent_usage (reservation_id, session_id, model, cost_eur, latency_ms, outcome)
  values (v_res.id, v_res.session_id, coalesce(v_res.model, 'desconocido'), 0, p_latency_ms, 'error');
  return jsonb_build_object('status', 'released');
end;
$$;

-- Alertas pendientes de email. Reclama hasta 5 con un "arrendamiento":
-- otra ejecución no las coge hasta que caduque (p_lease_seconds) y nunca se
-- reclama una ya enviada. Solo datos agregados.
create or replace function public.agent_alerts_claim(p_lease_seconds integer default 600)
returns setof jsonb
language plpgsql
security definer
set search_path = private, pg_temp
as $$
declare
  v_config jsonb := private.agent_config();
begin
  return query
  with candidates as (
    select a.month, a.threshold
      from private.agent_budget_alerts a
     where a.email_attempts < 10
       and (a.email_status in ('pending', 'failed')
            or (a.email_status = 'sending'
                and a.email_last_attempt_at < now() - make_interval(secs => greatest(coalesce(p_lease_seconds, 600), 60))))
     order by a.month, a.threshold
     limit 5
       for update skip locked
  ), claimed as (
    update private.agent_budget_alerts a
       set email_status = 'sending', email_attempts = a.email_attempts + 1, email_last_attempt_at = now()
      from candidates c
     where a.month = c.month and a.threshold = c.threshold
    returning a.*
  )
  select jsonb_build_object(
    'month', to_char(c.month, 'YYYY-MM'),
    'threshold', c.threshold,
    'budget_eur', coalesce((v_config ->> 'monthly_budget_eur')::numeric, c.budget_eur),
    'spent_eur', coalesce(b.spent_eur, c.spent_eur),
    'calls_today', (select count(*) from private.agent_reservations r
                     where r.status in ('reserved', 'settled') and r.created_at >= private.agent_day_start()),
    'projection_eur', case
      when c.month = private.agent_month() then round(coalesce(b.spent_eur, 0)
        / greatest(extract(epoch from now() - (c.month::timestamp at time zone 'Europe/Madrid')) / 86400, 1)
        * extract(day from (c.month + interval '1 month' - interval '1 day')), 2)
      end,
    'next_month', to_char(c.month + interval '1 month', 'YYYY-MM-DD'),
    'attempt', c.email_attempts)
  from claimed c
  left join private.agent_budget_months b on b.month = c.month;
end;
$$;

-- Resultado del envío del email de una alerta.
create or replace function public.agent_alert_result(p_month text, p_threshold integer, p_ok boolean, p_error text default null)
returns jsonb
language plpgsql
security definer
set search_path = private, pg_temp
as $$
begin
  update private.agent_budget_alerts
     set email_status = case when p_ok then 'sent' else 'failed' end,
         email_sent_at = case when p_ok then now() else email_sent_at end,
         email_error = case when p_ok then null else left(nullif(p_error, ''), 200) end
   where month = to_date(p_month, 'YYYY-MM') and threshold = p_threshold and email_status = 'sending';
  return jsonb_build_object('status', case when found then 'ok' else 'not_found' end);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. CRM: el resumen del laboratorio incluye el presupuesto público y sus
--    alertas (solo cifras agregadas)
-- ---------------------------------------------------------------------------
create or replace function public.agent_lab_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = private, public, pg_temp
as $$
declare
  v_config jsonb := private.agent_config();
  v_month date := private.agent_month();
begin
  if not public.is_crm_admin() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'budget', jsonb_build_object(
      'limit_eur', coalesce((v_config ->> 'preview_budget_eur')::numeric, 0),
      'spent_eur', (select coalesce(sum(spent_eur), 0) from private.agent_preview_ledger where status = 'settled'),
      'reserved_eur', (select coalesce(sum(reserved_eur), 0) from private.agent_preview_ledger where status = 'reserved')),
    'public_budget', jsonb_build_object(
      'month', to_char(v_month, 'YYYY-MM'),
      'next_month', to_char(v_month + interval '1 month', 'YYYY-MM-DD'),
      'limit_eur', coalesce((v_config ->> 'monthly_budget_eur')::numeric, 0),
      'spent_eur', (select coalesce(spent_eur, 0) from private.agent_budget_months where month = v_month),
      'reserved_eur', (select coalesce(reserved_eur, 0) from private.agent_budget_months where month = v_month),
      'calls_today', (select count(*) from private.agent_reservations
                       where status in ('reserved', 'settled') and created_at >= private.agent_day_start()),
      'model', private.agent_public_model(v_config),
      'alerts', (select coalesce(jsonb_agg(jsonb_build_object(
                    'threshold', threshold, 'triggered_at', triggered_at, 'email_status', email_status) order by threshold), '[]'::jsonb)
                   from private.agent_budget_alerts where month = v_month)),
    'public_enabled', coalesce((v_config ->> 'public_enabled')::boolean, false),
    'region', v_config ->> 'region',
    'models', (select coalesce(jsonb_agg(m order by m ->> 'model'), '[]'::jsonb) from (
      select jsonb_build_object(
        'model', model,
        'turns', count(*),
        'conversations', count(distinct conversation_id),
        'cost_eur', round(sum(cost_eur), 6),
        'cost_per_conversation_eur', round(sum(cost_eur) / nullif(count(distinct conversation_id), 0), 6),
        'latency_p50_ms', percentile_cont(0.5) within group (order by latency_ms),
        'latency_p95_ms', percentile_cont(0.95) within group (order by latency_ms),
        'fallback_rate', round(avg(case when fallback_reason is null then 0 else 1 end), 4),
        'rated', count(rating),
        'avg_rating', (select jsonb_object_agg(k, round(avg_v, 2)) from (
            select key as k, avg(value::numeric) as avg_v
              from private.agent_test_transcripts t2, jsonb_each_text(t2.rating)
             where t2.model = t.model and t2.expires_at >= now() and t2.rating is not null
             group by key) r)
      ) as m
        from private.agent_test_transcripts t
       where expires_at >= now()
       group by model) s));
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Permisos
-- ---------------------------------------------------------------------------
revoke all on function public.agent_reserve(text, integer, integer) from public, anon, authenticated;
revoke all on function public.agent_settle(uuid, integer, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.agent_release(uuid, integer) from public, anon, authenticated;
revoke all on function public.agent_alerts_claim(integer) from public, anon, authenticated;
revoke all on function public.agent_alert_result(text, integer, boolean, text) from public, anon, authenticated;
revoke all on function public.agent_lab_summary() from public, anon, authenticated;

grant execute on function public.agent_reserve(text, integer, integer) to service_role;
grant execute on function public.agent_settle(uuid, integer, integer, integer, integer) to service_role;
grant execute on function public.agent_release(uuid, integer) to service_role;
grant execute on function public.agent_alerts_claim(integer) to service_role;
grant execute on function public.agent_alert_result(text, integer, boolean, text) to service_role;
grant execute on function public.agent_lab_summary() to authenticated;

commit;
