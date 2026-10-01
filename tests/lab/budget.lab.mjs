// Contabilidad del presupuesto PÚBLICO del agente (PR1b, recalculada por
// modelo en PR2e) con peticiones concurrentes reales a través de PostgREST
// (pool de conexiones independientes), como las hará la Edge Function.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { ANON, AUTHENTICATED, AUTHENTICATED_NO_ADMIN } from "./jwt.mjs";
import { psql, rpc, service, tally } from "./helpers.mjs";

// 1 € al mes; modelo de laboratorio a 10 €/Mtok de entrada y 20 €/Mtok de
// salida (usd_eur 1, margen 1): una reserva de 10.000 tokens de entrada cuesta
// exactamente 0,10 €. Desde PR2e el coste sale de la tabla por modelo.
const LAB_MODEL = { "lab-10-20": { in: 10, cached_in: 1, out: 20, eu: null } };
const BASE_CONFIG = {
  enabled: true,
  monthly_budget_eur: 1,
  alert_thresholds_pct: [50, 80, 100],
  default_model: "lab-10-20",
  usd_eur: 1,
  public_reserve_margin: 1,
  public_max_calls_per_minute: 100000,
  public_max_calls_per_hour: 100000,
  max_messages_per_session: 1000,
  max_calls_per_day: 100000,
  reservation_ttl_minutes: 10,
};

function configure(overrides = {}) {
  psql("lab", `update private.settings set value = value || '${JSON.stringify({ ...BASE_CONFIG, ...overrides })}'::jsonb
    || jsonb_build_object('models', (value -> 'models') || '${JSON.stringify(LAB_MODEL)}'::jsonb) where key = 'agent';`);
}
const month = () => psql("lab", "select spent_eur || '|' || reserved_eur from private.agent_budget_months where month = private.agent_month()");
const session = (i) => `lab-sesion-${String(i).padStart(6, "0")}`;
const reserve = (s, input = 10000, output = 0) =>
  service("agent_reserve", { p_session_id: s, p_max_input_tokens: input, p_max_output_tokens: output });

// Al terminar se restauran los valores de las migraciones (los comprueban los
// verificadores posteriores): sin modelo de laboratorio ni modelo público.
after(() => psql("lab", `update private.settings set value = (value || '${JSON.stringify({
  enabled: true, monthly_budget_eur: 25, alert_thresholds_pct: [50, 80, 100], default_model: null, usd_eur: 0.9,
  public_reserve_margin: 1.25, public_max_calls_per_minute: 20, public_max_calls_per_hour: 100,
  max_messages_per_session: 12, max_calls_per_day: 600, reservation_ttl_minutes: 10,
})}'::jsonb) || jsonb_build_object('models', (value -> 'models') - 'lab-10-20') where key = 'agent';
  delete from private.agent_budget_alerts; delete from private.rate_counters where bucket like 'agent:%';`));

beforeEach(() => {
  psql("lab", `delete from private.agent_usage; delete from private.agent_reservations;
    delete from private.agent_budget_months; delete from private.agent_events; delete from private.agent_budget_alerts;
    delete from private.rate_counters where bucket like 'agent:%';`);
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
      -- Desde PR2e el contador por minuto (una fila) también serializa: se quitan ambos.
      select replace(replace(body, $f$perform pg_advisory_xact_lock(hashtext('legalprevent.agent_budget'));$f$, 'perform pg_sleep(0.05);'),
                     $f$if not private.rate_hit('agent:public:minute'$f$, $f$if false and not private.rate_hit('agent:public:minute'$f$) into v from _lab_budget_bak;
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
  assert.ok(results.every((r) => r.status === "settled"));
  assert.equal(psql("lab", "select string_agg(threshold || ':' || email_status, ',' order by threshold) from private.agent_budget_alerts"),
    "50:pending,80:pending,100:pending");
  assert.equal(month(), "1.000000|0.000000");
  // Agotado: la siguiente reserva se rechaza y no se duplica la alerta del 100 %.
  assert.equal((await reserve(session(99))).status, "budget_exhausted");
  assert.equal(psql("lab", "select count(*) from private.agent_budget_alerts"), "3");
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

test("PR2e · coste por modelo: reserva conservadora (sin caché, con margen) y liquidación con el uso real", async () => {
  configure({ public_reserve_margin: 1.5 });
  const r = await reserve(session(1), 10000, 1000);
  // (10.000 × 10 + 1.000 × 20) / 1e6 = 0,12 € × 1,5 = 0,18 €
  assert.equal(r.status, "reserved");
  assert.equal(Number(r.max_cost_eur), 0.18);
  assert.equal(r.model, "lab-10-20");
  const settled = await service("agent_settle", { p_reservation_id: r.reservation_id, p_input_tokens: 8000, p_output_tokens: 500, p_cached_tokens: 6000 });
  // (2.000 × 10 + 6.000 × 1 + 500 × 20) / 1e6 = 0,036 €
  assert.equal(Number(settled.cost_eur), 0.036);
  assert.equal(month(), "0.036000|0.000000");
});

test("PR2e · tope global por minuto con 60 peticiones simultáneas de sesiones distintas: exactamente 15", async () => {
  configure({ public_max_calls_per_minute: 15 });
  const out = await Promise.all(Array.from({ length: 60 }, (_, i) => reserve(session(i), 10, 10)));
  assert.deepEqual(tally(out.map((r) => r.status)), { reserved: 15, rate_limited: 45 });
});

test("PR2e · concurrencia cerca del límite: nunca se reserva por encima de 25 € (escala real)", async () => {
  configure({ monthly_budget_eur: 25 });
  psql("lab", "insert into private.agent_budget_months (month, spent_eur) values (private.agent_month(), 24.5)");
  // Cada reserva: 10.000 tokens → 0,10 €; caben exactamente 5.
  const out = await Promise.all(Array.from({ length: 100 }, (_, i) => reserve(session(i))));
  assert.deepEqual(tally(out.map((r) => r.status)), { reserved: 5, budget_exhausted: 95 });
  assert.equal(month(), "24.500000|0.500000");
  assert.equal(psql("lab", "select count(*) from private.agent_budget_alerts where threshold = 100"), "1");
});

test("PR2e · sin modelo público válido no se reserva nada", async () => {
  configure({ default_model: null });
  assert.equal((await reserve(session(1))).status, "disabled");
  configure({ default_model: "gpt-4o" });
  assert.equal((await reserve(session(1))).status, "disabled");
  assert.equal(psql("lab", "select count(*) from private.agent_reservations"), "0");
});

const status = (out) => tally(out.map((r) => r.status));
const monthTotal = () => Number(psql("lab", "select spent_eur + reserved_eur from private.agent_budget_months where month = private.agent_month()"));

test("PR2e · límite por hora con 150 peticiones simultáneas: exactamente 100; la 101 se rechaza", async () => {
  configure({ public_max_calls_per_hour: 100 });
  const out = await Promise.all(Array.from({ length: 150 }, (_, i) => reserve(session(i), 10, 10)));
  assert.deepEqual(status(out), { reserved: 100, hourly_limit: 50 });
  assert.equal((await reserve(session(500), 10, 10)).status, "hourly_limit", "la 101 se rechaza");
});

test("PR2e · límite por hora: se reinicia en la hora siguiente y es independiente del diario y del mensual", async () => {
  configure({ public_max_calls_per_hour: 100 });
  await Promise.all(Array.from({ length: 100 }, (_, i) => reserve(session(i), 10, 10)));
  assert.equal((await reserve(session(200), 10, 10)).status, "hourly_limit");
  // Cambio de hora: las 100 pasan a la hora anterior.
  // (Se marcan liquidadas, como en uso real: una reserva abierta más de 10 min caduca y no cuenta.)
  psql("lab", "update private.agent_reservations set created_at = private.agent_hour_start() - interval '1 minute', status = 'settled'");
  const next = await Promise.all(Array.from({ length: 30 }, (_, i) => reserve(session(300 + i), 10, 10)));
  assert.deepEqual(status(next), { reserved: 30 }, "la hora nueva empieza de cero");
  // El diario sigue mandando aunque la hora tenga hueco (si la hora anterior es del mismo día).
  if (psql("lab", "select (private.agent_hour_start() > private.agent_day_start())::text") === "true") {
    configure({ public_max_calls_per_hour: 100, max_calls_per_day: 140 });
    const day = await Promise.all(Array.from({ length: 30 }, (_, i) => reserve(session(400 + i), 10, 10)));
    assert.deepEqual(status(day), { reserved: 10, daily_limit: 20 });
  }
  // Y el mensual también: con el presupuesto agotado manda budget_exhausted.
  configure({ public_max_calls_per_hour: 100000, max_calls_per_day: 100000 });
  psql("lab", "update private.agent_budget_months set spent_eur = 1 where month = private.agent_month()");
  assert.equal((await reserve(session(600), 10, 10)).status, "budget_exhausted");
});

test("PR2e · garantía estricta con concurrencia: a céntimos del límite, uso real > estimación, spent + reserved ≤ 25 €", async () => {
  configure({ monthly_budget_eur: 25 });
  psql("lab", "insert into private.agent_budget_months (month, spent_eur) values (private.agent_month(), 24.99)");
  // Cota declarada por llamada: 100 tokens de entrada y 10 de salida → (100×10 + 10×20)/1e6 = 0,0012 €.
  const out = await Promise.all(Array.from({ length: 40 }, (_, i) => reserve(session(i), 100, 10)));
  const ids = out.filter((r) => r.status === "reserved").map((r) => r.reservation_id);
  assert.equal(ids.length, 8, "caben exactamente 8 en 0,01 €");
  assert.ok(monthTotal() <= 25);
  // Todas se liquidan a la vez con el MÁXIMO declarado (muy por encima de la estimación orientativa).
  const settled = await Promise.all(ids.map((id) =>
    service("agent_settle", { p_reservation_id: id, p_input_tokens: 100, p_output_tokens: 10, p_cached_tokens: 0 })));
  assert.deepEqual(status(settled), { settled: 8 });
  assert.equal(month(), "24.999600|0.000000");
  assert.ok(monthTotal() <= 25);
  // Ya no cabe otra.
  assert.equal((await reserve(session(99), 100, 10)).status, "budget_exhausted");
});

test("PR2e · si el proveedor incumpliera la cota: coste real registrado, 'overrun' y mes bloqueado (no se sigue gastando)", async () => {
  configure({ monthly_budget_eur: 25 });
  const r = await reserve(session(1), 100, 10);
  const s1 = await service("agent_settle", { p_reservation_id: r.reservation_id, p_input_tokens: 5000, p_output_tokens: 10 });
  assert.equal(s1.status, "settled_overrun");
  assert.equal(psql("lab", "select outcome from private.agent_usage"), "overrun");
  assert.equal(psql("lab", "select blocked::text from private.agent_budget_months where month = private.agent_month()"), "true");
  const after = await Promise.all(Array.from({ length: 10 }, (_, i) => reserve(session(10 + i), 1, 1)));
  assert.deepEqual(status(after), { budget_exhausted: 10 });
});
