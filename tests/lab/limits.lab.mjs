// Límites persistentes de altas públicas (PR1a) con peticiones concurrentes
// reales a través de PostgREST (pool de conexiones independientes).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { psql, reset, rpcWithHeaders, setLimits, tally } from "./helpers.mjs";

beforeEach(() => reset());

const lead = (email, headers) =>
  rpcWithHeaders("submit_lead", { p_payload: { email, privacy_accepted: true } }, headers);
const outcome = (r) => (r.status === 200 && r.body?.id ? "ok" : r.body?.error || `http${r.status}`);
const countLeads = (where = "true") => Number(psql("lab", `select count(*) from public.leads where ${where}`));

test("100 altas simultáneas con el mismo email y límite 3/día: exactamente 3", async () => {
  setLimits({ email_per_day: 3 });
  const results = await Promise.all(Array.from({ length: 100 }, () => lead("spam@example.com")));
  assert.deepEqual(tally(results.map(outcome)), { ok: 3, rate_limited: 97 });
  assert.equal(countLeads("email = 'spam@example.com'"), 3);
  assert.equal(psql("lab", "select sum(hits) from private.rate_counters where bucket like 'email:lead:%'"), "100",
    "los intentos rechazados quedan contados");
});

test("60 altas simultáneas con emails distintos y límite global 20/min: exactamente 20", async () => {
  setLimits({ global_per_minute: 20 });
  const results = await Promise.all(Array.from({ length: 60 }, (_, i) => lead(`g${i}@example.com`)));
  assert.deepEqual(tally(results.map(outcome)), { ok: 20, rate_limited: 40 });
  assert.equal(countLeads(), 20);
});

test("cierre de emergencia: límite global 0 rechaza todo", async () => {
  setLimits({ global_per_hour: 0 });
  const results = await Promise.all(Array.from({ length: 5 }, (_, i) => lead(`c${i}@example.com`)));
  assert.deepEqual(tally(results.map(outcome)), { rate_limited: 5 });
});

test("límite por IP con la IP que añade el proxy: la cabecera falseada no lo elude", async () => {
  setLimits({ ip_per_hour: 5 }, { ipSource: "x-forwarded-for-last" });
  // Mismo cliente real (203.0.113.7) que envía una X-Forwarded-For distinta en cada petición.
  const same = await Promise.all(Array.from({ length: 30 }, (_, i) =>
    lead(`ip${i}@example.com`, { "X-Forwarded-For": `10.0.0.${i}, 203.0.113.7` })));
  assert.deepEqual(tally(same.map(outcome)), { ok: 5, rate_limited: 25 });
  // Otro cliente real no se ve afectado.
  assert.equal(outcome(await lead("otro@example.com", { "X-Forwarded-For": "198.51.100.9" })), "ok");
  assert.equal(psql("lab", "select count(*) from private.rate_counters where bucket like '%203.0.113.7%'"), "0",
    "la IP no se guarda en claro");
});

test("sin fuente de IP configurada (valor por defecto) la IP no se usa", async () => {
  setLimits({ ip_per_hour: 1 });
  const results = await Promise.all(Array.from({ length: 5 }, (_, i) =>
    lead(`n${i}@example.com`, { "X-Forwarded-For": "203.0.113.7" })));
  assert.deepEqual(tally(results.map(outcome)), { ok: 5 });
});

test("cabecera ausente o no válida con fuente configurada: se aplica el resto de límites", async () => {
  setLimits({ ip_per_hour: 1 }, { ipSource: "cf-connecting-ip" });
  const results = await Promise.all([
    lead("h1@example.com"),
    lead("h2@example.com", { "cf-connecting-ip": "no-es-una-ip" }),
    lead("h3@example.com", { "cf-connecting-ip": "2001:db8::1" }),
    lead("h4@example.com", { "cf-connecting-ip": "2001:db8::1" }),
  ]);
  const [missing, invalid, ...sameIpv6] = results.map(outcome);
  assert.equal(missing, "ok", "sin cabecera: no hay límite por IP");
  assert.equal(invalid, "ok", "cabecera no válida: no hay límite por IP");
  // Mismas IPv6 en paralelo: una pasa y la otra no, sea cual sea el orden.
  assert.deepEqual(sameIpv6.sort(), ["ok", "rate_limited"]);
});

test("leads y diagnósticos se cuentan por separado por email", async () => {
  setLimits({ email_per_day: 1 });
  assert.equal(outcome(await lead("mixto@example.com")), "ok");
  const diagnostic = await rpcWithHeaders("submit_diagnostic", { p_payload: { email: "mixto@example.com", privacy_accepted: true } });
  assert.equal(outcome(diagnostic), "ok");
  assert.equal(outcome(await lead("mixto@example.com")), "rate_limited");
});

test("un alta rechazada por el límite no deja lead ni diagnóstico ni consentimiento", async () => {
  setLimits({ global_per_minute: 0 });
  await lead("nada@example.com");
  await rpcWithHeaders("submit_diagnostic", { p_payload: { email: "nada@example.com", privacy_accepted: true } });
  assert.equal(countLeads(), 0);
  assert.equal(psql("lab", "select count(*) from public.diagnostics"), "0");
  assert.equal(psql("lab", "select count(*) from private.consent_events"), "0");
});
