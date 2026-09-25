-- Verificación de la migración 20260928_stripe_webhook.sql (PR1d).
--
-- Se ejecuta entera dentro de una transacción que termina en ROLLBACK: no
-- deja datos. Usa identificadores de Stripe inventados (sufijo _verificacion).
-- Cualquier fallo aborta con "FALLO: ...". Si todo pasa, la última consulta
-- devuelve "OK: verificación PR1d superada".

begin;

do $$
declare
  v jsonb;
  t0 constant timestamptz := '2026-09-01 10:00:00+00';
  sub_row constant jsonb := '{"stripe_subscription_id": "sub_verificacion", "stripe_customer_id": "cus_verificacion", "plan": "pyme", "status": "active", "current_period_start": "2026-09-01T10:00:00Z", "current_period_end": "2026-10-01T10:00:00Z", "cancel_at_period_end": false, "payload": {}}';
begin
  -- 0. Estructura.
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'subscriptions' and column_name = 'stripe_event_created')
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'payments' and column_name = 'stripe_event_created')
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'checkout_sessions' and column_name = 'stripe_event_created')
     or to_regclass('private.stripe_events') is null then
    raise exception 'FALLO: faltan columnas o la tabla de eventos';
  end if;

  -- 1. Permisos: ni anon ni el CRM pueden registrar eventos.
  begin
    set local role anon;
    perform public.stripe_record_event('evt_verificacion0', 'invoice.paid', t0, 'ignored', '{}');
    raise exception 'FALLO: anon pudo registrar eventos';
  exception when insufficient_privilege then reset role; end;
  begin
    set local role authenticated;
    perform set_config('request.jwt.claims', '{"role":"authenticated","app_metadata":{"crm_role":"admin"}}', true);
    perform public.stripe_record_event('evt_verificacion0', 'invoice.paid', t0, 'ignored', '{}');
    raise exception 'FALLO: el CRM pudo registrar eventos';
  exception when insufficient_privilege then reset role; end;

  -- 2. Alta, evento antiguo, duplicado y evento más reciente.
  set local role service_role;
  v := public.stripe_record_event('evt_verificacion1', 'customer.subscription.created', t0 + interval '1 minute', 'subscription', sub_row);
  if v->>'status' <> 'applied' then raise exception 'FALLO: no aplicó el alta: %', v; end if;
  v := public.stripe_record_event('evt_verificacion2', 'customer.subscription.updated', t0, 'subscription', sub_row || '{"status": "past_due"}');
  if v->>'status' <> 'stale' then raise exception 'FALLO: un evento antiguo no se marcó como antiguo: %', v; end if;
  v := public.stripe_record_event('evt_verificacion1', 'customer.subscription.created', t0 + interval '1 minute', 'subscription', sub_row);
  if v->>'status' <> 'duplicate' then raise exception 'FALLO: no detectó el duplicado: %', v; end if;
  v := public.stripe_record_event('evt_verificacion3', 'customer.subscription.deleted', t0 + interval '2 minutes', 'subscription', sub_row || '{"status": "canceled"}');
  if v->>'status' <> 'applied' then raise exception 'FALLO: no aplicó la baja: %', v; end if;
  v := public.stripe_record_event('evt_verificacion4', 'invoice.paid', t0, 'payment',
    '{"stripe_invoice_id": "in_verificacion", "stripe_subscription_id": "sub_verificacion", "amount_paid": 3509, "currency": "eur", "status": "paid", "payload": {}}');
  if v->>'status' <> 'applied' then raise exception 'FALLO: no aplicó el pago: %', v; end if;
  v := public.stripe_record_event('evt_verificacion5', 'customer.created', t0, 'ignored', '{}');
  if v->>'status' <> 'ignored' then raise exception 'FALLO: no ignoró el evento sin tabla: %', v; end if;
  reset role;

  if (select status from public.subscriptions where stripe_subscription_id = 'sub_verificacion') <> 'canceled' then
    raise exception 'FALLO: la suscripción no refleja el último evento';
  end if;
  if (select amount_paid from public.payments where stripe_invoice_id = 'in_verificacion') <> 3509 then
    raise exception 'FALLO: el pago no se guardó';
  end if;
  if (select count(*) from private.stripe_events where event_id like 'evt_verificacion%') <> 5 then
    raise exception 'FALLO: el registro de eventos no cuadra';
  end if;

  -- 3. Datos inválidos: se rechazan sin dejar nada.
  begin
    set local role service_role;
    perform public.stripe_record_event('no-es-un-evento', 'invoice.paid', t0, 'payment', '{}');
    raise exception 'FALLO: aceptó un id de evento no válido';
  exception when others then reset role; if sqlerrm like 'FALLO:%' then raise; end if; end;

  raise notice 'OK: verificación PR1d superada';
end;
$$;

rollback;

-- Solo se llega aquí si todos los bloques han pasado.
select 'OK: verificación PR1d superada' as resultado;
