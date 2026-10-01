-- Rollback de PR2e (20261002_agent_public_budget.sql).
--
-- Vuelve a las funciones del presupuesto público de PR1b (copiadas literalmente
-- de 20260926_agent_budget.sql) y al resumen del laboratorio de PR2. Conserva
-- los datos: reservas, uso, meses y alertas (private.agent_budget_alerts) y la
-- columnas nuevas (agent_reservations.model/max_*_tokens, agent_budget_months.blocked)
-- y el valor 'overrun' permitido en agent_usage.outcome, que el código de PR1b ignora.
-- Ojo: las funciones de PR1b vuelven a calcular con los precios heredados
-- (price_input/output_eur_per_mtok).

begin;

drop function if exists public.agent_alerts_claim(integer);
drop function if exists public.agent_alert_result(text, integer, boolean, text);
drop function if exists public.agent_settle(uuid, integer, integer, integer, integer);
drop function if exists private.agent_raise_alerts(date, numeric, numeric, jsonb, boolean);
drop function if exists private.agent_alerts_pending();
drop function if exists private.agent_public_model(jsonb);
drop function if exists private.agent_hour_start(timestamptz);

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

create or replace function public.agent_lab_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = private, public, pg_temp
as $$
declare
  v_config jsonb := private.agent_config();
begin
  if not public.is_crm_admin() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'budget', jsonb_build_object(
      'limit_eur', coalesce((v_config ->> 'preview_budget_eur')::numeric, 0),
      'spent_eur', (select coalesce(sum(spent_eur), 0) from private.agent_preview_ledger where status = 'settled'),
      'reserved_eur', (select coalesce(sum(reserved_eur), 0) from private.agent_preview_ledger where status = 'reserved')),
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

update private.settings
   set value = value - 'public_max_calls_per_minute' - 'public_max_calls_per_hour' - 'public_reserve_margin', updated_at = now()
 where key = 'agent';

revoke all on function public.agent_reserve(text, integer, integer) from public, anon, authenticated;
revoke all on function public.agent_settle(uuid, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.agent_release(uuid, integer) from public, anon, authenticated;
revoke all on function public.agent_lab_summary() from public, anon, authenticated;
grant execute on function public.agent_reserve(text, integer, integer) to service_role;
grant execute on function public.agent_settle(uuid, integer, integer, integer) to service_role;
grant execute on function public.agent_release(uuid, integer) to service_role;
grant execute on function public.agent_lab_summary() to authenticated;

commit;
