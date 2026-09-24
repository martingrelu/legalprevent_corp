// Tablas de Stripe tras PR1a: el webhook y el checkout (service role) siguen
// escribiendo, el CRM (administrador) lee y anon no tiene acceso.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ANON, AUTHENTICATED, AUTHENTICATED_NO_ADMIN, SERVICE } from "./jwt.mjs";
import { REST, psql } from "./helpers.mjs";

const request = (path, token, init = {}) =>
  fetch(`${REST}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  }).then(async (r) => ({ status: r.status, body: await r.text() }));

// Mismas llamadas que dynamic-endpoint / stripe-webhook (upsert con la service role).
const webhookUpsert = (table, conflict, body) =>
  request(`/${table}?on_conflict=${conflict}`, SERVICE, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(body),
  });

beforeEach(() => psql("lab", "truncate public.checkout_sessions, public.subscriptions, public.payments cascade;"));

test("el webhook (service role) sigue creando y actualizando sesiones, suscripciones y pagos", async () => {
  const ok = (r) => assert.ok([200, 201].includes(r.status), `${r.status} ${r.body}`);
  ok(await webhookUpsert("checkout_sessions", "stripe_session_id", { stripe_session_id: "cs_1", status: "open", payload: {} }));
  ok(await webhookUpsert("checkout_sessions", "stripe_session_id", { stripe_session_id: "cs_1", status: "complete", payload: {} }));
  ok(await webhookUpsert("subscriptions", "stripe_subscription_id", { stripe_subscription_id: "sub_1", status: "active", payload: {} }));
  ok(await webhookUpsert("payments", "stripe_invoice_id", { stripe_invoice_id: "in_1", status: "paid", amount_paid: 2900, payload: {} }));
  assert.equal(psql("lab", "select status from public.checkout_sessions where stripe_session_id = 'cs_1'"), "complete");
  assert.equal(psql("lab", "select count(*) from public.subscriptions"), "1");
  assert.equal(psql("lab", "select count(*) from public.payments"), "1");
});

test("anon no puede leer ni escribir en las tablas de Stripe", async () => {
  psql("lab", "insert into public.payments (stripe_invoice_id, status, payload) values ('in_2', 'paid', '{}')");
  for (const table of ["checkout_sessions", "subscriptions", "payments"]) {
    const read = await request(`/${table}?select=*`, ANON);
    assert.match(read.body, /42501/, `lectura de ${table}`);
    const write = await request(`/${table}`, ANON, { method: "POST", body: "{}" });
    assert.match(write.body, /42501/, `escritura en ${table}`);
  }
});

test("el CRM administrador lee la facturación pero no puede escribirla; sin rol no ve nada", async () => {
  psql("lab", "insert into public.payments (stripe_invoice_id, status, payload) values ('in_3', 'paid', '{}')");
  const admin = await request("/payments?select=stripe_invoice_id", AUTHENTICATED);
  assert.equal(admin.status, 200);
  assert.deepEqual(JSON.parse(admin.body), [{ stripe_invoice_id: "in_3" }]);
  const write = await request("/payments", AUTHENTICATED, { method: "POST", body: JSON.stringify({ stripe_invoice_id: "in_4" }) });
  assert.match(write.body, /42501/);
  const user = await request("/payments?select=stripe_invoice_id", AUTHENTICATED_NO_ADMIN);
  assert.deepEqual(JSON.parse(user.body), []);
});
