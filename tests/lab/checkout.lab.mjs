// Checkout público (PR1e) de extremo a extremo: gateway -> función del repo ->
// checkout_allow en la base migrada (contadores reales) -> Stripe simulado.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { ANON, AUTHENTICATED } from "./jwt.mjs";
import { GATEWAY, REST, psql, tally } from "./helpers.mjs";

const WEB = "http://127.0.0.1:8766";
const LIMITS = { global_per_minute: 10, global_per_hour: null, email_per_hour: 5 };

// Mismo cuerpo que envía supabase-bridge.js (web publicada y nueva).
const checkout = (body, origin = WEB) =>
  fetch(`${GATEWAY}/functions/v1/super-api`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON, Authorization: `Bearer ${ANON}`, ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify({ successUrl: `${WEB}/gracias/?origen=stripe&plan=starter`, cancelUrl: `${WEB}/#precios`, page: `${WEB}/`, ...body }),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const sessions = async () => (await (await fetch(`${GATEWAY}/__lab/stripe`)).json()).sessions;
const setLimits = (limits) => psql("lab", `update private.settings set value = '${JSON.stringify({ ...LIMITS, ...limits })}'::jsonb where key = 'checkout_limits';`);

// Al terminar se dejan los valores de la migración (los comprueba verify_pr1e).
after(() => psql("lab", `update private.settings set value = '{"global_per_minute": 30, "global_per_hour": null, "email_per_hour": 5}' where key = 'checkout_limits';`));

beforeEach(async () => {
  psql("lab", "delete from private.rate_counters where bucket like 'checkout:%'; truncate public.checkout_sessions cascade;");
  setLimits({});
  await fetch(`${GATEWAY}/__lab/reset`);
});

test("la web crea la sesión; las URL de retorno son siempre las de legalprevent.com y queda registrada", async () => {
  const r = await checkout({ plan: "starter", email: "ana@example.com", successUrl: "https://phishing.example/x", cancelUrl: "https://phishing.example/y" });
  assert.equal(r.status, 200);
  assert.match(r.body.url, /^https:\/\/checkout\.stripe\.com\//);
  const [session] = await sessions();
  assert.equal(session.success_url, "https://legalprevent.com/gracias/?origen=stripe&plan=starter");
  assert.equal(session.cancel_url, "https://legalprevent.com/#precios");
  assert.equal(psql("lab", "select plan || '|' || status || '|' || customer_email from public.checkout_sessions"), "starter|open|ana@example.com");
});

test("30 peticiones simultáneas con límite de 10 por minuto: exactamente 10 sesiones en Stripe", async () => {
  const out = await Promise.all(Array.from({ length: 30 }, () => checkout({ plan: "pyme" })));
  assert.deepEqual(tally(out.map((r) => r.status)), { 200: 10, 429: 20 });
  assert.equal((await sessions()).length, 10);
});

test("límite por email: el sexto intento en una hora con el mismo email se rechaza", async () => {
  setLimits({ global_per_minute: null, global_per_hour: null });
  const results = [];
  for (let i = 0; i < 6; i++) results.push((await checkout({ plan: "starter", email: i % 2 ? "Ana@Example.com" : "ana@example.com" })).status);
  assert.deepEqual(results, [200, 200, 200, 200, 200, 429]);
  assert.equal((await checkout({ plan: "starter", email: "otra@example.com" })).status, 200);
  // El contador guarda el email en hash, nunca en claro.
  assert.equal(psql("lab", "select count(*) from private.rate_counters where bucket like '%@%'"), "0");
});

test("interruptor: checkout_limits a 0 cierra el checkout", async () => {
  setLimits({ global_per_minute: 0 });
  assert.equal((await checkout({ plan: "starter" })).status, 429);
  assert.equal((await sessions()).length, 0);
});

test("una llamada directa sin Origin o con el Origin de la web (falsificable) sigue sujeta al límite", async () => {
  setLimits({ global_per_minute: 2 });
  const out = [];
  for (const origin of [null, WEB, null, WEB]) out.push((await checkout({ plan: "starter" }, origin)).status);
  assert.deepEqual(out, [200, 200, 429, 429]);
  assert.equal((await sessions()).length, 2);
});

test("otra web no puede usar el checkout desde el navegador", async () => {
  const r = await checkout({ plan: "starter" }, "https://evil.example");
  assert.equal(r.status, 403);
  assert.equal((await sessions()).length, 0);
});

test("solo la service role consulta los límites del checkout", async () => {
  for (const token of [ANON, AUTHENTICATED]) {
    const r = await fetch(`${REST}/rpc/checkout_allow`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ p_email: null }),
    });
    assert.match(await r.text(), /42501/);
  }
});
