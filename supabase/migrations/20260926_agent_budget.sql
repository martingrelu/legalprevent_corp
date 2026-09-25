-- PR1b: contabilidad del agente comercial de IA (consumo, presupuesto y
-- eventos anónimos). No cambia nada visible: prepara lo que usará la Edge
-- Function del agente (PR2).
--
-- 1. Configuración en private.settings (clave `agent`): presupuesto mensual
--    (25 €), umbrales de alerta, precios por millón de tokens, límites por
--    sesión y por día e interruptor de apagado.
-- 2. Presupuesto con reserva atómica: antes de cada llamada a OpenAI se
--    reserva el coste máximo y, después, se liquida el real. Todas las
--    operaciones se serializan con un advisory lock, así que peticiones
--    simultáneas no pueden superar el presupuesto. El mes se cuenta en
--    horario de Madrid.
-- 3. Consumo por llamada (tokens, coste, latencia, resultado) y eventos
--    anónimos: sin texto de las conversaciones, sin email, sin IP.
-- 4. Solo la service role (la Edge Function) usa estas funciones; el CRM
--    administrador consulta métricas agregadas.
--
-- Idempotente y en una única transacción.
-- Rollback: supabase/rollback/20260926_agent_budget_down.sql
begin;

-- ---------------------------------------------------------------------------
-- 1. Configuración
-- ---------------------------------------------------------------------------
insert into private.settings (key, value, description) values
  ('agent',
   '{
      "enabled": true,
      "monthly_budget_eur": 25,
      "alert_thresholds_pct": [50, 80, 100],
      "model": "gpt-4.1-mini",
      "price_input_eur_per_mtok": 0.37,
      "price_output_eur_per_mtok": 1.48,
      "max_messages_per_session": 12,
      "max_calls_per_day": 600,
      "reservation_ttl_minutes": 10
    }',
   'Agente comercial. Precios PENDIENTES de confirmar con el proyecto de OpenAI antes de PR2. enabled=false o presupuesto agotado → respuestas fijas sin IA.')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Tablas
-- ---------------------------------------------------------------------------
create table if not exists private.agent_budget_months (
  month date primary key,                       -- primer día del mes (Europe/Madrid)
  spent_eur numeric(12, 6) not null default 0 check (spent_eur >= 0),
  reserved_eur numeric(12, 6) not null default 0 check (reserved_eur >= 0),
  alerts_sent integer[] not null default '{}',
  updated_at timestamptz not null default now()
);

create table if not exists private.agent_reservations (
  id uuid primary key default gen_random_uuid(),
  month date not null references private.agent_budget_months(month),
  session_id text not null,
  reserved_eur numeric(12, 6) not null check (reserved_eur >= 0),
  status text not null default 'reserved' check (status in ('reserved', 'settled', 'released', 'expired')),
  created_at timestamptz not null default now(),
  closed_at timestamptz
);
create index if not exists agent_reservations_open_idx on private.agent_reservations (created_at) where status = 'reserved';
create index if not exists agent_reservations_session_idx on private.agent_reservations (session_id, created_at);

create table if not exists private.agent_usage (
  id bigserial primary key,
  reservation_id uuid references private.agent_reservations(id),
  session_id text not null,
  model text not null,
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  cost_eur numeric(12, 6) not null default 0 check (cost_eur >= 0),
  latency_ms integer,
  outcome text not null check (outcome in ('ok', 'error')),
  created_at timestamptz not null default now()
);
create index if not exists agent_usage_created_idx on private.agent_usage (created_at);

create table if not exists private.agent_events (
  id bigserial primary key,
  event_type text not null check (event_type in (
    'conversation_started', 'suggested_question', 'message', 'link_click',
    'diagnostic_click', 'demo_click', 'contact_request', 'human_handoff', 'ai_fallback'
  )),
  session_id text not null,
  page_path text,
  target text,
  intent text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  created_at timestamptz not null default now()
);
create index if not exists agent_events_created_idx on private.agent_events (created_at);

revoke all on all tables in schema private from public, anon, authenticated;
revoke all on all sequences in schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Utilidades internas
-- ---------------------------------------------------------------------------
create or replace function private.agent_config()
returns jsonb
language sql
stable
set search_path = private, pg_temp
as $$
  select value from private.settings where key = 'agent'
$$;

-- Mes y día naturales en Madrid.
create or replace function private.agent_month(p_at timestamptz default now())
returns date
language sql
stable
as $$
  select date_trunc('month', p_at at time zone 'Europe/Madrid')::date
$$;

create or replace function private.agent_day_start(p_at timestamptz default now())
returns timestamptz
language sql
stable
as $$
  select date_trunc('day', p_at at time zone 'Europe/Madrid') at time zone 'Europe/Madrid'
$$;

create or replace function private.agent_cost(p_input integer, p_output integer, p_config jsonb)
returns numeric
language sql
immutable
as $$
  select round(
    (greatest(coalesce(p_input, 0), 0) * (p_config ->> 'price_input_eur_per_mtok')::numeric
     + greatest(coalesce(p_output, 0), 0) * (p_config ->> 'price_output_eur_per_mtok')::numeric) / 1000000,
    6)
$$;

-- Identificador de sesión del navegador: aleatorio, sin datos personales.
create or replace function private.agent_valid_session(p_session_id text)
returns text
language plpgsql
immutable
as $$
begin
  if p_session_id is null or p_session_id !~ '^[A-Za-z0-9_-]{16,64}$' then
    raise exception 'agent_session_invalid';
  end if;
  return p_session_id;
end;
$$;

-- Caducan las reservas abiertas demasiado tiempo (llamada que nunca se
-- liquidó): devuelven su importe al presupuesto. Requiere el advisory lock.
create or replace function private.agent_expire_reservations(p_config jsonb)
returns void
language plpgsql
set search_path = private, pg_temp
as $$
begin
  with expired as (
    update private.agent_reservations
       set status = 'expired', closed_at = now()
     where status = 'reserved'
       and created_at < now() - make_interval(mins => coalesce((p_config ->> 'reservation_ttl_minutes')::integer, 10))
    returning month, reserved_eur
  ), totals as (
    select month, sum(reserved_eur) as amount from expired group by month
  )
  update private.agent_budget_months b
     set reserved_eur = greatest(b.reserved_eur - t.amount, 0), updated_at = now()
    from totals t
   where b.month = t.month;
end;
$$;

revoke all on all functions in schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. API para la Edge Function del agente (solo service role)
-- ---------------------------------------------------------------------------
-- Reserva el coste máximo de una llamada. Devuelve status:
--   reserved | disabled | budget_exhausted | session_limit | daily_limit
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
  if v_config is null or not coalesce((v_config ->> 'enabled')::boolean, false) then
    return jsonb_build_object('status', 'disabled');
  end if;

  perform private.agent_expire_reservations(v_config);

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

  v_budget := (v_config ->> 'monthly_budget_eur')::numeric;
  v_estimate := private.agent_cost(p_max_input_tokens, p_max_output_tokens, v_config);
  if v_row.spent_eur + v_row.reserved_eur + v_estimate > v_budget then
    return jsonb_build_object('status', 'budget_exhausted');
  end if;

  insert into private.agent_reservations (month, session_id, reserved_eur)
  values (v_month, v_session, v_estimate)
  returning id into v_id;
  update private.agent_budget_months
     set reserved_eur = reserved_eur + v_estimate, updated_at = now()
   where month = v_month;

  return jsonb_build_object('status', 'reserved', 'reservation_id', v_id,
                            'max_cost_eur', v_estimate, 'model', v_config ->> 'model');
end;
$$;

-- Liquida una reserva con los tokens reales. Idempotente. Devuelve los
-- umbrales de alerta alcanzados por primera vez este mes (para avisar una
-- sola vez de cada uno).
create or replace function public.agent_settle(
  p_reservation_id uuid,
  p_input_tokens integer,
  p_output_tokens integer,
  p_latency_ms integer default null
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
  v_pct numeric;
  v_new_alerts integer[];
begin
  if coalesce(p_input_tokens, -1) < 0 or coalesce(p_output_tokens, -1) < 0 then
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

  v_cost := private.agent_cost(p_input_tokens, p_output_tokens, v_config);
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
  values (v_res.id, v_res.session_id, coalesce(v_config ->> 'model', 'desconocido'),
          p_input_tokens, p_output_tokens, v_cost, p_latency_ms, 'ok');

  v_budget := (v_config ->> 'monthly_budget_eur')::numeric;
  v_pct := case when v_budget > 0 then v_row.spent_eur / v_budget * 100 else 100 end;
  select coalesce(array_agg(t order by t), '{}') into v_new_alerts
    from jsonb_array_elements_text(v_config -> 'alert_thresholds_pct') as a(t_text)
   cross join lateral (select a.t_text::integer as t) x
   where x.t <= v_pct and not (x.t = any (v_row.alerts_sent));
  if cardinality(v_new_alerts) > 0 then
    update private.agent_budget_months
       set alerts_sent = alerts_sent || v_new_alerts
     where month = v_res.month;
  end if;

  return jsonb_build_object('status', 'settled', 'cost_eur', v_cost, 'spent_eur', v_row.spent_eur,
                            'budget_eur', v_budget, 'new_alerts_pct', to_jsonb(v_new_alerts));
end;
$$;

-- Devuelve la reserva si la llamada a OpenAI falló. Idempotente.
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
  values (v_res.id, v_res.session_id, coalesce(private.agent_config() ->> 'model', 'desconocido'), 0, p_latency_ms, 'error');
  return jsonb_build_object('status', 'released');
end;
$$;

-- Registra un evento anónimo. Rechaza cualquier campo que parezca contener
-- datos personales o texto libre.
create or replace function public.agent_track_event(p_event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = private, pg_temp
as $$
declare
  v_session text := private.agent_valid_session(p_event ->> 'session_id');
  v_page text := nullif(p_event ->> 'page_path', '');
  v_field text;
begin
  if v_page is not null and v_page !~ '^/[A-Za-z0-9/_-]{0,120}$' then
    raise exception 'agent_event_invalid: page_path';
  end if;
  foreach v_field in array array['target', 'intent'] loop
    if nullif(p_event ->> v_field, '') is not null and (p_event ->> v_field) !~ '^[a-z0-9_-]{1,40}$' then
      raise exception 'agent_event_invalid: %', v_field;
    end if;
  end loop;
  foreach v_field in array array['utm_source', 'utm_medium', 'utm_campaign'] loop
    if nullif(p_event ->> v_field, '') is not null and (p_event ->> v_field) !~ '^[A-Za-z0-9_.-]{1,80}$' then
      raise exception 'agent_event_invalid: %', v_field;
    end if;
  end loop;

  insert into private.agent_events (event_type, session_id, page_path, target, intent, utm_source, utm_medium, utm_campaign)
  values (p_event ->> 'event_type', v_session, v_page,
          nullif(p_event ->> 'target', ''), nullif(p_event ->> 'intent', ''),
          nullif(p_event ->> 'utm_source', ''), nullif(p_event ->> 'utm_medium', ''), nullif(p_event ->> 'utm_campaign', ''));
  return jsonb_build_object('ok', true);
exception when check_violation then
  raise exception 'agent_event_invalid: event_type';
end;
$$;

-- Métricas agregadas por día para el CRM administrador (sin datos personales).
create or replace function public.agent_metrics(p_days integer default 30)
returns table (
  day date,
  conversations bigint,
  messages bigint,
  link_clicks bigint,
  diagnostic_clicks bigint,
  demo_clicks bigint,
  contact_requests bigint,
  human_handoffs bigint,
  ai_fallbacks bigint,
  cost_eur numeric
)
language plpgsql
stable
security definer
set search_path = private, public, pg_temp
as $$
#variable_conflict use_column
begin
  if not public.is_crm_admin() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  return query
  with days as (
    select generate_series(
      (now() at time zone 'Europe/Madrid')::date - (least(greatest(coalesce(p_days, 30), 1), 366) - 1),
      (now() at time zone 'Europe/Madrid')::date, interval '1 day')::date as day
  ), ev as (
    select (e.created_at at time zone 'Europe/Madrid')::date as day, e.event_type, count(*) as n
      from private.agent_events e
     where e.created_at >= now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 366) + 1)
     group by 1, 2
  ), co as (
    select (u.created_at at time zone 'Europe/Madrid')::date as day, sum(u.cost_eur) as cost
      from private.agent_usage u
     where u.created_at >= now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 366) + 1)
     group by 1
  )
  select d.day,
    coalesce(sum(ev.n) filter (where ev.event_type = 'conversation_started'), 0)::bigint,
    coalesce(sum(ev.n) filter (where ev.event_type = 'message'), 0)::bigint,
    coalesce(sum(ev.n) filter (where ev.event_type = 'link_click'), 0)::bigint,
    coalesce(sum(ev.n) filter (where ev.event_type = 'diagnostic_click'), 0)::bigint,
    coalesce(sum(ev.n) filter (where ev.event_type = 'demo_click'), 0)::bigint,
    coalesce(sum(ev.n) filter (where ev.event_type = 'contact_request'), 0)::bigint,
    coalesce(sum(ev.n) filter (where ev.event_type = 'human_handoff'), 0)::bigint,
    coalesce(sum(ev.n) filter (where ev.event_type = 'ai_fallback'), 0)::bigint,
    coalesce(max(co.cost), 0)::numeric
  from days d
  left join ev on ev.day = d.day
  left join co on co.day = d.day
  group by d.day
  order by d.day;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Permisos
-- ---------------------------------------------------------------------------
revoke all on function public.agent_reserve(text, integer, integer) from public, anon, authenticated;
revoke all on function public.agent_settle(uuid, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.agent_release(uuid, integer) from public, anon, authenticated;
revoke all on function public.agent_track_event(jsonb) from public, anon, authenticated;
revoke all on function public.agent_metrics(integer) from public, anon, authenticated;

grant execute on function public.agent_reserve(text, integer, integer) to service_role;
grant execute on function public.agent_settle(uuid, integer, integer, integer) to service_role;
grant execute on function public.agent_release(uuid, integer) to service_role;
grant execute on function public.agent_track_event(jsonb) to service_role;
grant execute on function public.agent_metrics(integer) to authenticated, service_role;

commit;
