// Pruebas del webhook de Stripe (PR1d) con eventos en el formato de la API
// 2026-04-22 (la que usa la cuenta) y firmas generadas como las de Stripe.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { handleRequest, mapEvent, TOLERANCE_SECONDS } from "../supabase/functions/stripe-webhook/index.ts";

const SECRET = "whsec_prueba";
const NOW = 1_790_000_000;

const env: Record<string, string> = {
  STRIPE_WEBHOOK_SECRET: SECRET,
  SUPABASE_URL: "https://proyecto.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-secreta",
};

const sign = (payload: string, secret = SECRET, t = NOW) =>
  `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`;

const subscriptionCreated = {
  id: "evt_1SubCreated",
  object: "event",
  api_version: "2026-04-22.dahlia",
  created: NOW - 60,
  type: "customer.subscription.created",
  data: {
    object: {
      id: "sub_123",
      object: "subscription",
      customer: "cus_123",
      status: "active",
      cancel_at_period_end: false,
      metadata: { plan: "pyme" },
      items: { data: [{ id: "si_1", current_period_start: 1_789_000_000, current_period_end: 1_791_592_000, price: { id: "price_1" } }] },
    },
  },
};

const invoicePaid = {
  id: "evt_1InvoicePaid",
  object: "event",
  api_version: "2026-04-22.dahlia",
  created: NOW - 30,
  type: "invoice.paid",
  data: {
    object: {
      id: "in_123",
      object: "invoice",
      customer: "cus_123",
      amount_paid: 3509,
      currency: "eur",
      status: "paid",
      hosted_invoice_url: "https://invoice.stripe.com/i/x",
      parent: { type: "subscription_details", subscription_details: { subscription: "sub_123", metadata: {} } },
    },
  },
};

type Call = { url: string; body: any };
function setup({ status = 200, throws = false } = {}) {
  const calls: Call[] = [];
  const fakeFetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    if (throws) throw new Error("red caída");
    return new Response(status === 200 ? '{"status":"applied"}' : '{"message":"detalle interno"}', { status });
  }) as typeof fetch;
  return { calls, deps: { env: (k: string) => env[k], fetch: fakeFetch, now: () => NOW * 1000 } };
}

const post = (payload: string, signature: string | null) =>
  new Request("https://proyecto.supabase.co/functions/v1/stripe-webhook", {
    method: "POST",
    headers: signature === null ? {} : { "stripe-signature": signature },
    body: payload,
  });

test("evento firmado y reciente: se registra con una sola RPC y responde 200", async () => {
  const { calls, deps } = setup();
  const payload = JSON.stringify(subscriptionCreated);
  const response = await handleRequest(post(payload, sign(payload)), deps);
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://proyecto.supabase.co/rest/v1/rpc/stripe_record_event");
  assert.equal(calls[0].body.p_event_id, "evt_1SubCreated");
  assert.equal(calls[0].body.p_kind, "subscription");
  assert.equal(calls[0].body.p_created, new Date((NOW - 60) * 1000).toISOString());
});

test("firma ausente, incorrecta, con otro secreto o alterada: 400 sin tocar la base", async () => {
  const payload = JSON.stringify(invoicePaid);
  for (const signature of [null, "", "t=abc,v1=zz", sign(payload, "whsec_otro"), sign(payload.replace("3509", "1"))]) {
    const { calls, deps } = setup();
    const response = await handleRequest(post(payload, signature), deps);
    assert.equal(response.status, 400, String(signature));
    assert.equal(calls.length, 0);
  }
  // Cuerpo alterado con la firma original.
  const { calls, deps } = setup();
  const response = await handleRequest(post(payload.replace("3509", "1"), sign(payload)), deps);
  assert.equal(response.status, 400);
  assert.equal(calls.length, 0);
});

test("firma fuera de la tolerancia de 5 minutos (reenvío de un mensaje capturado): 400", async () => {
  const payload = JSON.stringify(invoicePaid);
  for (const t of [NOW - TOLERANCE_SECONDS - 1, NOW + TOLERANCE_SECONDS + 1]) {
    const { calls, deps } = setup();
    assert.equal((await handleRequest(post(payload, sign(payload, SECRET, t)), deps)).status, 400);
    assert.equal(calls.length, 0);
  }
  const { deps } = setup();
  assert.equal((await handleRequest(post(payload, sign(payload, SECRET, NOW - TOLERANCE_SECONDS)), deps)).status, 200);
});

test("rotación del secreto: basta con que una de las firmas v1 sea válida", async () => {
  const payload = JSON.stringify(invoicePaid);
  const good = sign(payload).split(",")[1];
  const bad = sign(payload, "whsec_antiguo").split(",")[1];
  for (const header of [`t=${NOW},${bad},${good}`, `t=${NOW},${good},${bad}`]) {
    const { deps } = setup();
    assert.equal((await handleRequest(post(payload, header), deps)).status, 200, header);
  }
});

test("si la base falla o no responde: 500 genérico para que Stripe reintente", async () => {
  const payload = JSON.stringify(invoicePaid);
  for (const options of [{ status: 500 }, { status: 404 }, { throws: true }]) {
    const { deps } = setup(options);
    const response = await handleRequest(post(payload, sign(payload)), deps);
    assert.equal(response.status, 500);
    assert.doesNotMatch(await response.text(), /detalle interno|red caída/);
  }
});

test("sin secreto configurado: 500 y no se procesa nada", async () => {
  const { calls, deps } = setup();
  const payload = JSON.stringify(invoicePaid);
  const response = await handleRequest(post(payload, sign(payload)), { ...deps, env: (k: string) => (k === "STRIPE_WEBHOOK_SECRET" ? undefined : env[k]) });
  assert.equal(response.status, 500);
  assert.equal(calls.length, 0);
});

test("método distinto de POST o evento firmado pero mal formado", async () => {
  const { deps } = setup();
  assert.equal((await handleRequest(new Request("https://x/functions/v1/stripe-webhook"), deps)).status, 405);
  for (const payload of ["no es json", JSON.stringify({ id: "evt_1", type: "invoice.paid" })]) {
    assert.equal((await handleRequest(post(payload, sign(payload)), deps)).status, 400, payload);
  }
});

test("API 2026-04-22: periodo de la suscripción desde sus items y suscripción de la factura desde parent", () => {
  const sub = mapEvent(subscriptionCreated);
  assert.equal(sub.kind, "subscription");
  assert.deepEqual({ ...sub.row, payload: undefined }, {
    stripe_subscription_id: "sub_123",
    stripe_customer_id: "cus_123",
    plan: "pyme",
    status: "active",
    current_period_start: new Date(1_789_000_000 * 1000).toISOString(),
    current_period_end: new Date(1_791_592_000 * 1000).toISOString(),
    cancel_at_period_end: false,
    payload: undefined,
  });
  const invoice = mapEvent(invoicePaid);
  assert.equal(invoice.kind, "payment");
  assert.equal(invoice.row.stripe_subscription_id, "sub_123");
  assert.equal(invoice.row.amount_paid, 3509);
});

test("formato antiguo (API anterior a 2025-03-31) sigue funcionando", () => {
  const sub = mapEvent({ type: "customer.subscription.updated", data: { object: { id: "sub_1", current_period_start: 100, current_period_end: 200, items: { data: [] } } } });
  assert.equal(sub.row.current_period_start, new Date(100_000).toISOString());
  const invoice = mapEvent({ type: "invoice.payment_failed", data: { object: { id: "in_1", subscription: "sub_1", amount_paid: 0 } } });
  assert.equal(invoice.row.stripe_subscription_id, "sub_1");
});

test("checkout completado guarda el email del cliente; otros eventos se registran como ignorados", () => {
  const checkout = mapEvent({
    type: "checkout.session.completed",
    data: { object: { id: "cs_1", customer: "cus_1", subscription: "sub_1", status: "complete", payment_status: "paid", customer_details: { email: "Ana@Empresa.es" }, metadata: { plan: "starter" } } },
  });
  assert.equal(checkout.kind, "checkout_session");
  assert.equal(checkout.row.customer_email, "Ana@Empresa.es");
  for (const type of ["customer.created", "invoice_payment.paid", "charge.succeeded"]) {
    assert.deepEqual(mapEvent({ type, data: { object: { id: "x" } } }), { kind: "ignored", row: {} });
  }
});
