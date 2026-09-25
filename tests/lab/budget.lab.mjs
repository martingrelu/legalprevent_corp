// Contabilidad del agente (PR1b) con peticiones concurrentes reales a través
// de PostgREST (pool de conexiones independientes), como las hará la Edge
// Function del agente con la service role.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ANON, AUTHENTICATED, AUTHENTICATED_NO_ADMIN } from "./jwt.mjs";
import { psql, rpc, service, tally } from "./helpers.mjs";

// 1 € al mes; 10 €/Mtok de entrada y 20 €/Mtok de salida: una reserva de
// 10.000 tokens de entrada cuesta exactamente 0,10 €.
const BASE_CONFIG = {
  enabled: true,
  monthly_budget_eur: 1,
  alert_thresholds_pct: [50, 80, 100],
  price_input_eur_per_mtok: 10,
  price_output_eur_per_mtok: 20,
  max_messages_per_session: 1000,
  max_calls_per_day: 100000,
  reservation_ttl_minutes: 10,
};

function configure(overrides = {}) {
  psql("lab", `update private.settings set value = value || '${JSON.stringify({ ...BASE_CONFIG, ...overrides })}'::jsonb where key = 'agent';`);
}
const month = () => psql("lab", "select spent_eur || '|' || reserved_eur from private.agent_budget_months where month = private.agent_month()");
const session = (i) => `lab-sesion-${String(i).padStart(6, "0")}`;
const reserve = (s, input = 10000, output = 0) =>
  service("agent_reserve", { p_session_id: s, p_max_input_tokens: input, p_max_output_tokens: output });

beforeEach(() => {
  psql("lab", `delete from private.agent_usage; delete from private.agent_reservations;
    delete from private.agent_budget_months; delete from private.agent_events;`);
  configure();
});

test("200 reservas simultáneas con 1 € de presupuesto: exactamente 10 de 0,10 €", async () => {
  const out = await Promise.all(Array.from({ length: 200 }, (_, i) => reserve(session(i))));
  assert.deepEqual(tally(out.map((r) => r.status)), { reserved: 10, budget_exhausted: 190 });
  assert.equal(month(), "0.000000|1.000000");
});

test("sin el advisory lock el presupuesto se supera (el bloqueo es necesario)", async () => {
  const sig = "public.agent_reserve(text,integer,integer)";
  psql("lab", `create table _lab_budget_bak as select pg_get_functiondef('${sig}'::regprocedure) body;
    do $m$ declare v text; begin
      select replace(body, $f$perform pg_advisory_xact_lock(hashtext('legalprevent.agent_budget'));$f$, 'perform pg_sleep(0.05);') into v from _lab_budget_bak;
      if v = (select body from _lab_budget_bak) then raise exception 'mutación no aplicada'; end if;
      execute v; end $m$;`);
  try {
    const out = await Promise.all(Array.from({ length: 200 }, (_, i) => reserve(session(i))));
    const reserved = out.filter((r) => r.status === "reserved").length;
    assert.ok(reserved > 10, `sin bloqueo se esperaba superar el presupuesto y se reservaron ${reserved}`);
  } finally {
    psql("lab", `do $m$ declare v text; begin select body into v from _lab_budget_bak; execute v; end $m$; drop table _lab_budget_bak;`);
  }
});

test("liquidaciones y liberaciones simultáneas: el presupuesto cuadra al céntimo", async () => {
  const reservations = await Promise.all(Array.from({ length: 10 }, (_, i) => reserve(session(i))));
  const ids = reservations.map((r) => r.reservation_id);
  const results = await Promise.all(ids.map((id, i) =>
    i % 2 === 0
      ? service("agent_settle", { p_reservation_id: id, p_input_tokens: 5000, p_output_tokens: 0 })
      : service("agent_release", { p_reservation_id: id })));
  assert.deepEqual(tally(results.map((r) => r.status)), { settled: 5, released: 5 });
  assert.equal(month(), "0.250000|0.000000");
  // Repetir liquidaciones y liberaciones no altera nada.
  const again = await Promise.all(ids.map((id) => service("agent_settle", { p_reservation_id: id, p_input_tokens: 5000, p_output_tokens: 0 })));
  assert.deepEqual(tally(again.map((r) => r.status)), { already_closed: 10 });
  assert.equal(month(), "0.250000|0.000000");
});

test("alertas de consumo: cada umbral se avisa una sola vez aunque las liquidaciones sean simultáneas", async () => {
  const ids = (await Promise.all(Array.from({ length: 10 }, (_, i) => reserve(session(i))))).map((r) => r.reservation_id);
  const results = await Promise.all(ids.map((id) =>
    service("agent_settle", { p_reservation_id: id, p_input_tokens: 10000, p_output_tokens: 0 })));
  const alerts = results.flatMap((r) => r.new_alerts_pct).sort((a, b) => a - b);
  assert.deepEqual(alerts, [50, 80, 100]);
  assert.equal(month(), "1.000000|0.000000");
});

test("límite por sesión con 50 peticiones simultáneas de la misma sesión: exactamente 12", async () => {
  configure({ max_messages_per_session: 12 });
  const out = await Promise.all(Array.from({ length: 50 }, () => reserve("lab-sesion-unica-0001", 10, 10)));
  assert.deepEqual(tally(out.map((r) => r.status)), { reserved: 12, session_limit: 38 });
});

test("límite diario con 100 sesiones simultáneas: exactamente 30", async () => {
  configure({ max_calls_per_day: 30 });
  const out = await Promise.all(Array.from({ length: 100 }, (_, i) => reserve(session(i), 10, 10)));
  assert.deepEqual(tally(out.map((r) => r.status)), { reserved: 30, daily_limit: 70 });
});

test("interruptor de apagado", async () => {
  configure({ enabled: false });
  assert.equal((await reserve(session(1))).status, "disabled");
});

test("solo la service role usa la contabilidad; el CRM administrador solo ve métricas", async () => {
  const args = { p_session_id: session(1), p_max_input_tokens: 10, p_max_output_tokens: 10 };
  for (const token of [ANON, AUTHENTICATED, AUTHENTICATED_NO_ADMIN]) {
    const out = await rpc("agent_reserve", args, token);
    assert.equal(out.code, "42501", JSON.stringify(out));
  }
  assert.equal((await rpc("agent_metrics", { p_days: 7 }, ANON)).code, "42501");
  assert.equal((await rpc("agent_metrics", { p_days: 7 }, AUTHENTICATED_NO_ADMIN)).code, "42501");
  await service("agent_track_event", { p_event: { event_type: "conversation_started", session_id: session(1), utm_source: "linkedin" } });
  const metrics = await rpc("agent_metrics", { p_days: 7 }, AUTHENTICATED);
  assert.equal(metrics.length, 7);
  assert.equal(metrics.reduce((sum, d) => sum + Number(d.conversations), 0), 1);
});

test("los eventos rechazan datos personales y texto libre", async () => {
  const bad = [
    { event_type: "link_click", session_id: session(1), target: "ana@empresa.es" },
    { event_type: "link_click", session_id: session(1), page_path: "/gracias?email=ana@empresa.es" },
    { event_type: "message", session_id: session(1), utm_campaign: "hola soy Ana 600000000" },
    { event_type: "texto libre", session_id: session(1) },
    { event_type: "message", session_id: "ana@empresa.es" },
  ];
  for (const event of bad) {
    const out = await service("agent_track_event", { p_event: event });
    assert.ok(out.code || out.message, `debía rechazarse: ${JSON.stringify(event)}`);
  }
  assert.equal(psql("lab", "select count(*) from private.agent_events"), "0");
});
