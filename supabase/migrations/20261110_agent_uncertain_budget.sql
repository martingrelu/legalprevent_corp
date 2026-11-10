-- Una generación enviada solo devuelve presupuesto al liquidar consumo confirmado.
-- Las reservas inciertas siguen imputadas a su mes original y no consumen el del siguiente.
-- Aplicar antes de desplegar la Edge Function que usa agent_mark_dispatched.
begin;

alter table private.agent_reservations add column if not exists dispatched_at timestamptz;

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
       and dispatched_at is null
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

create or replace function public.agent_mark_dispatched(p_reservation_id uuid)
returns boolean
language plpgsql
security definer
set search_path = private, pg_temp
as $$
begin
  perform pg_advisory_xact_lock(hashtext('legalprevent.agent_budget'));

  update private.agent_reservations
     set dispatched_at = now()
   where id = p_reservation_id
     and status = 'reserved'
     and dispatched_at is null
     and created_at >= now() - make_interval(mins => coalesce((private.agent_config() ->> 'reservation_ttl_minutes')::integer, 10));
  return found;
end;
$$;

revoke all on function public.agent_mark_dispatched(uuid) from public, anon, authenticated;
grant execute on function public.agent_mark_dispatched(uuid) to service_role;

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
  if v_res.dispatched_at is not null then
    return jsonb_build_object('status', 'consumption_uncertain');
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

commit;
