// Webhook de Stripe (PR1d) de extremo a extremo: gateway -> función del repo ->
// PostgREST -> stripe_record_event en la base migrada. Eventos en el formato
// de la API 2026-04-22 y firmados como los firma Stripe.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { ANON, AUTHENTICATED, AUTHENTICATED_NO_ADMIN } from "./jwt.mjs";
import { GATEWAY, REST, psql, tally } from "./helpers.mjs";

const SECRET = "whsec_lab_no_real";
const nowSeconds = () => Math.floor(Date.now() / 1000);

function deliver(event, { secret = SECRET, t = nowSeconds() } = {}) {
  const payload = JSON.stringify(event);
  const signature = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  return fetch(`${GATEWAY}/functions/v1/stripe-webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "stripe-signature": `t=${t},v1=${signature}` },
    body: payload,
  }).then(async (r) => ({ status: r.status, body: await r.text() }));
}

let seq = 0;
const event = (type, object, created) => ({
  id: `evt_lab${Date.now()}${seq++}`,
  object: "event",
  api_version: "2026-04-22.dahlia",
  created,
  livemode: false,
  type,
  data: { object },
});
const T0 = 1_789_000_000;
const subscription = (status, extra = {}) => ({
  id: "sub_lab1",
  object: "subscription",
  customer: "cus_lab1",
  status,
  cancel_at_period_end: false,
  metadata: { plan: "pyme" },
  items: { data: [{ id: "si_1", current_period_start: T0, current_period_end: T0 + 2_592_000 }] },
  ...extra,
});
const invoice = (status, amountPaid) => ({
  id: "in_lab1",
  object: "invoice",
  customer: "cus_lab1",
  amount_paid: amountPaid,
  currency: "eur",
  status,
  hosted_invoice_url: "https://invoice.stripe.com/i/lab",
  parent: { type: "subscription_details", subscription_details: { subscription: "sub_lab1" } },
});
const outcomes = () => psql("lab", "select string_agg(type || ':' || outcome, ',' order by event_created, received_at) from private.stripe_events");

beforeEach(() => psql("lab", "truncate public.checkout_sessions, public.subscriptions, public.payments cascade; truncate private.stripe_events;"));

test("alta completa con eventos de la API 2026-04-22: sesión, suscripción, cobro fallido y pagado", async () => {
  const events = [
    event("customer.created", { id: "cus_lab1", object: "customer", email: "ana@example.com" }, T0),
    event("checkout.session.completed", { id: "cs_lab1", object: "checkout.session", customer: "cus_lab1", subscription: "sub_lab1", status: "complete", payment_status: "paid", customer_details: { email: "Ana@Example.com" }, metadata: { plan: "pyme" } }, T0 + 1),
    event("customer.subscription.created", subscription("active"), T0 + 2),
    event("invoice.payment_failed", invoice("open", 0), T0 + 3),
    event("invoice.paid", invoice("paid", 3509), T0 + 4),
    event("invoice_payment.paid", { id: "inpay_1", object: "invoice_payment", invoice: "in_lab1" }, T0 + 4),
  ];
  for (const e of events) assert.equal((await deliver(e)).status, 200, e.type);

  assert.equal(psql("lab", "select customer_email || '|' || plan || '|' || payment_status || '|' || stripe_subscription_id from public.checkout_sessions"), "ana@example.com|pyme|paid|sub_lab1");
  assert.equal(psql("lab", `select status || '|' || plan || '|' || current_period_start || '|' || current_period_end from public.subscriptions`),
    `active|pyme|${psql("lab", `select to_timestamp(${T0})`)}|${psql("lab", `select to_timestamp(${T0 + 2_592_000})`)}`);
  assert.equal(psql("lab", "select status || '|' || amount_paid || '|' || stripe_subscription_id from public.payments"), "paid|3509|sub_lab1");
  assert.equal(outcomes(), "customer.created:ignored,checkout.session.completed:applied,customer.subscription.created:applied,invoice.payment_failed:applied,invoice.paid:applied,invoice_payment.paid:ignored");
  // El registro de eventos no guarda datos personales.
  assert.doesNotMatch(psql("lab", "select string_agg(t::text, ' ') from private.stripe_events t"), /@/);
});

test("eventos desordenados: uno antiguo no pisa uno más reciente", async () => {
  assert.equal((await deliver(event("customer.subscription.deleted", subscription("canceled"), T0 + 100))).status, 200);
  assert.equal((await deliver(event("customer.subscription.updated", subscription("active"), T0 + 50))).status, 200);
  assert.equal(psql("lab", "select status from public.subscriptions"), "canceled");

  assert.equal((await deliver(event("invoice.paid", invoice("paid", 3509), T0 + 100))).status, 200);
  assert.equal((await deliver(event("invoice.payment_failed", invoice("open", 0), T0 + 50))).status, 200);
  assert.equal(psql("lab", "select status || '|' || amount_paid from public.payments"), "paid|3509");
  assert.match(outcomes(), /customer\.subscription\.updated:stale.*invoice\.payment_failed:stale/);
});

test("sin la comprobación de antigüedad, un evento viejo reactivaría una suscripción cancelada (la comprobación es necesaria)", async () => {
  const sig = "public.stripe_record_event(text,text,timestamptz,text,jsonb)";
  psql("lab", `create table _lab_stripe_bak as select pg_get_functiondef('${sig}'::regprocedure) body;
    do $m$ declare v text; begin
      select replace(body, 'where t.stripe_event_created is null or t.stripe_event_created <= excluded.stripe_event_created;', ';') into v from _lab_stripe_bak;
      if v = (select body from _lab_stripe_bak) then raise exception 'mutación no aplicada'; end if;
      execute v; end $m$;`);
  try {
    await deliver(event("customer.subscription.deleted", subscription("canceled"), T0 + 100));
    await deliver(event("customer.subscription.updated", subscription("active"), T0 + 50));
    assert.equal(psql("lab", "select status from public.subscriptions"), "active");
  } finally {
    psql("lab", `do $m$ declare v text; begin select body into v from _lab_stripe_bak; execute v; end $m$; drop table _lab_stripe_bak;`);
  }
});

test("Stripe entrega el mismo evento 20 veces a la vez: se aplica una sola vez", async () => {
  const e = event("invoice.paid", invoice("paid", 3509), T0);
  const results = await Promise.all(Array.from({ length: 20 }, () => deliver(e)));
  assert.deepEqual(tally(results.map((r) => r.status)), { 200: 20 });
  assert.equal(psql("lab", "select count(*) || '|' || max(outcome) from private.stripe_events"), "1|applied");
  assert.equal(psql("lab", "select count(*) from public.payments"), "1");
});

test("si la base falla, responde 500 y no marca el evento: el reintento de Stripe lo guarda", async () => {
  const e = event("customer.subscription.created", subscription("active"), T0);
  psql("lab", "revoke execute on function public.stripe_record_event(text,text,timestamptz,text,jsonb) from service_role;");
  try {
    const failed = await deliver(e);
    assert.equal(failed.status, 500);
    assert.doesNotMatch(failed.body, /permission|42501|stripe_record_event/);
    assert.equal(psql("lab", "select count(*) from private.stripe_events"), "0");
  } finally {
    psql("lab", "grant execute on function public.stripe_record_event(text,text,timestamptz,text,jsonb) to service_role;");
  }
  assert.equal((await deliver(e)).status, 200);
  assert.equal(psql("lab", "select status from public.subscriptions"), "active");
});

test("firma con otro secreto o de hace más de 5 minutos: 400 y nada guardado", async () => {
  const e = event("invoice.paid", invoice("paid", 3509), T0);
  assert.equal((await deliver(e, { secret: "whsec_otro" })).status, 400);
  assert.equal((await deliver(e, { t: nowSeconds() - 301 })).status, 400);
  assert.equal(psql("lab", "select count(*) from private.stripe_events"), "0");
  assert.equal(psql("lab", "select count(*) from public.payments"), "0");
});

test("solo la service role puede registrar eventos", async () => {
  const args = { p_event_id: "evt_intruso", p_type: "invoice.paid", p_created: "2026-09-25T00:00:00Z", p_kind: "payment", p_row: { stripe_invoice_id: "in_x", status: "paid" } };
  for (const token of [ANON, AUTHENTICATED, AUTHENTICATED_NO_ADMIN]) {
    const r = await fetch(`${REST}/rpc/stripe_record_event`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(args),
    });
    assert.match(await r.text(), /42501/);
  }
  assert.equal(psql("lab", "select count(*) from public.payments"), "0");
});
