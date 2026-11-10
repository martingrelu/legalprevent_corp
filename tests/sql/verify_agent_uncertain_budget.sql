-- Ejecutar en una base de pruebas recién migrada. Todos los datos se revierten.
begin;

do $$
declare
  session_id constant text := 'test-uncertain-budget-session';
  current_month date := private.agent_month();
  previous_month date := (current_month - interval '1 month')::date;
  cfg jsonb := private.agent_config();
  reservation jsonb;
  reservation_id uuid;
  held_eur numeric;
  ttl interval := make_interval(mins => coalesce((cfg ->> 'reservation_ttl_minutes')::integer, 10));
begin
  if (cfg ->> 'monthly_budget_eur')::numeric is distinct from 25
     or has_function_privilege('anon', 'public.agent_mark_dispatched(uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.agent_mark_dispatched(uuid)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.agent_mark_dispatched(uuid)', 'EXECUTE') then
    raise exception 'Presupuesto o permisos incorrectos';
  end if;
  update private.settings set value = jsonb_set(value, '{default_model}', '"gpt-5.4-mini"') where key = 'agent';

  reservation := public.agent_reserve(session_id, 10000, 400);
  reservation_id := (reservation ->> 'reservation_id')::uuid;
  if public.agent_release(reservation_id) ->> 'status' is distinct from 'released' then
    raise exception 'La reserva sin envío debe liberarse';
  end if;
  if public.agent_mark_dispatched(reservation_id) then
    raise exception 'Una reserva liberada no autoriza un envío';
  end if;

  reservation_id := (public.agent_reserve(session_id, 10000, 400) ->> 'reservation_id')::uuid;
  update private.agent_reservations set created_at = now() - ttl - interval '1 second' where id = reservation_id;
  if public.agent_mark_dispatched(reservation_id) then
    raise exception 'Una reserva vencida no autoriza un envío';
  end if;
  perform private.agent_expire_reservations(cfg);
  if (select status from private.agent_reservations where id = reservation_id) is distinct from 'expired' then
    raise exception 'La reserva vencida sin envío debe caducar';
  end if;

  reservation := public.agent_reserve(session_id, 10000, 400);
  reservation_id := (reservation ->> 'reservation_id')::uuid;
  held_eur := (reservation ->> 'max_cost_eur')::numeric;
  if not public.agent_mark_dispatched(reservation_id) then
    raise exception 'No se pudo registrar el primer envío';
  end if;
  if public.agent_mark_dispatched(reservation_id) then
    raise exception 'La misma reserva autorizó un segundo envío';
  end if;
  if public.agent_release(reservation_id) ->> 'status' is distinct from 'consumption_uncertain' then
    raise exception 'Una reserva enviada no se puede liberar';
  end if;
  update private.agent_reservations set created_at = now() - ttl - interval '1 second' where id = reservation_id;
  perform private.agent_expire_reservations(cfg);
  if (select status from private.agent_reservations where id = reservation_id) is distinct from 'reserved'
     or (select reserved_eur from private.agent_budget_months where month = current_month) is distinct from held_eur then
    raise exception 'La reserva incierta dejó de cubrir el presupuesto';
  end if;
  update private.agent_budget_months set spent_eur = 25 - held_eur where month = current_month;
  if public.agent_reserve(session_id, 10000, 400) ->> 'status' is distinct from 'budget_exhausted' then
    raise exception 'Se pudo volver a gastar el saldo de la reserva incierta';
  end if;

  -- Simula un cambio de mes conservando la reserva original en el libro anterior.
  insert into private.agent_budget_months (month, reserved_eur) values (previous_month, held_eur);
  update private.agent_reservations
     set month = previous_month, created_at = now() - interval '1 month'
   where id = reservation_id;
  update private.agent_budget_months set spent_eur = 0, reserved_eur = 0 where month = current_month;
  if public.agent_reserve(session_id, 10000, 400) ->> 'status' is distinct from 'reserved' then
    raise exception 'La reserva incierta bloqueó el presupuesto del mes siguiente';
  end if;
  reservation := public.agent_settle(reservation_id, 500, 30);
  if reservation ->> 'status' is distinct from 'settled'
     or (select reserved_eur from private.agent_budget_months where month = previous_month) is distinct from 0::numeric
     or (select spent_eur from private.agent_budget_months where month = previous_month) <= 0 then
    raise exception 'No se pudo conciliar con el consumo confirmado';
  end if;
  if public.agent_settle(reservation_id, 500, 30) ->> 'status' is distinct from 'already_closed' then
    raise exception 'La conciliación debe ser idempotente';
  end if;
end;
$$;

rollback;
