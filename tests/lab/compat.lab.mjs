// Compatibilidad con la web PUBLICADA (git ref extraído por run.sh en
// LAB_PUBLISHED_DIR; hoy, la versión de PR0) contra la base con las
// migraciones de la rama, y rollback de PR1a.
//
// Los payloads reproducen lo que envían script.js y diagnostico.js
// publicados; el flujo de pantalla completo se valida a mano (ver README).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AUTHENTICATED } from "./jwt.mjs";
import { ROOT, VERIFY_PR1A, emails, loadBridge, mode, psql, psqlFile, reset, setLimits } from "./helpers.mjs";

const PUBLISHED = process.env.LAB_PUBLISHED_DIR;
const publishedBridge = () =>
  loadBridge(readFileSync(`${PUBLISHED}/supabase-bridge.js`, "utf8"), { origin: "http://127.0.0.1:8767" });
const newBridge = () => loadBridge(readFileSync(`${ROOT}supabase-bridge.js`, "utf8"));

const ROLLBACK = `${ROOT}supabase/rollback/20260925_public_limits_consent_down.sql`;
const MIGRATION = `${ROOT}supabase/migrations/20260925_public_limits_consent.sql`;

// Lo que envía script.js publicado (PR0) desde el formulario de demo.
const publishedDemo = (email, form = {}) => ({
  eventType: "demo_requested",
  leadStage: "demo_requested_from_landing",
  lead: { companyName: "Lead web - Empresa", contactName: "Pendiente de completar", email, status: "Demo agendada", priority: "Alta", recommendedPlan: "Pro", riskScore: 65 },
  form: { email, privacy: "on", ...form },
  page: "http://127.0.0.1:8767/",
});
// Lo que envía diagnostico.js publicado (PR0) al completar el diagnóstico.
const publishedDiagnostic = (email) => ({
  eventType: "diagnostic_completed",
  leadStage: "qualified_diagnostic_completed",
  payload: { company: { company: "Publicada SL", email, privacy: "on" }, result: { globalScore: 55 } },
  lead: { companyName: "Publicada SL", email },
  privacyAccepted: true,
  commercialConsent: false,
  page: "http://127.0.0.1:8767/diagnostico/",
});

beforeEach(() => reset());

test("web publicada: la demo se guarda con fecha y versión por defecto y avisa al buzón interno", async () => {
  const result = await publishedBridge().api.createLead(publishedDemo("pub@example.com", { commercial: "on" }));
  assert.equal(result.ok, true);
  assert.equal(
    psql("lab", `select privacy_policy_version || '|' || (privacy_accepted_at is not null) || '|' || commercial_consent_version || '|' || (commercial_consent_at is not null)
      from public.leads where email = 'pub@example.com'`),
    "2026-06-04|true|2026-06-04|true",
  );
  const { delivered } = await emails();
  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0].to, ["interno@lab.invalid"]);
});

test("web publicada: el diagnóstico (que ya envía privacy_accepted) funciona sin la compatibilidad temporal", async () => {
  const { api } = publishedBridge();
  const input = publishedDiagnostic("pubdiag@example.com");
  assert.equal((await api.createLead(input)).ok, true);
  assert.equal((await api.createDiagnostic(input)).ok, true);
  assert.equal(psql("lab", "select count(*) from public.diagnostics where privacy_policy_version = '2026-06-04'"), "1");
});

test("web publicada con el límite superado: no guarda nada ni avisa (aunque su interfaz no lo distinga)", async () => {
  setLimits({ global_per_minute: 0 });
  const result = await publishedBridge().api.createLead(publishedDemo("limitado@example.com"));
  // El bridge de PR0 no conoce {"error":"rate_limited"}: devuelve ok sin id.
  assert.equal(result.record?.id, undefined);
  assert.equal(psql("lab", "select count(*) from public.leads"), "0");
  assert.equal((await emails()).attempts.length, 0);
});

test("web nueva con el límite superado: lo detecta y no pide aviso", async () => {
  setLimits({ global_per_minute: 0 });
  const result = await newBridge().api.createLead(publishedDemo("limitado@example.com"));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "rate_limited");
  assert.equal((await emails()).attempts.length, 0);
});

test("rollback de PR1a: la web publicada funciona como hoy y la migración se puede reaplicar", async () => {
  psql("lab", "insert into public.leads (email) values ('conservar@example.com');");
  try {
    psqlFile("lab", ROLLBACK);
    assert.equal(psql("lab", "select has_table_privilege('anon','public.payments','SELECT')"), "t", "permisos anteriores restaurados");
    assert.equal(psql("lab", "select count(*) from public.leads where email = 'conservar@example.com'"), "1");
    assert.equal(psql("lab", "select to_regclass('private.consent_events') is not null"), "t", "el registro de consentimientos se conserva");
    const result = await publishedBridge().api.createLead(publishedDemo("tras-rollback@example.com"));
    assert.equal(result.ok, true);
    assert.equal((await emails()).delivered.length, 1);
  } finally {
    psqlFile("lab", MIGRATION);
  }
  assert.match(psqlFile("lab", VERIFY_PR1A, { allowError: true }), /OK: verificación PR1a superada/);
});

test("web nueva sobre la base sin PR1a (orden recomendado: web primero): todo funciona", async () => {
  psql("lab_old", "truncate public.leads, public.diagnostics cascade;");
  await mode({ db: "old" });
  try {
    const { api } = newBridge();
    const lead = await api.createLead({
      eventType: "diagnostic_completed",
      lead: { email: "webprimero@example.com", companyName: "Web Primero SL" },
      privacyAccepted: true,
      commercialConsent: true,
    });
    assert.equal(lead.ok, true, "submit_lead de PR0 ignora las versiones que envía la web nueva");
    assert.equal((await api.createDiagnostic({ payload: { company: { email: "webprimero@example.com" } }, privacyAccepted: true })).ok, true);
    assert.equal((await api.requestLeadDemo(lead.record.id)).ok, true);
    assert.deepEqual((await emails()).delivered.map((m) => m.subject.split(":")[0]), ["Nuevo lead Legal Prevent", "Demo solicitada"]);
    // El CRM nuevo lee la base sin PR1a: sin columnas de consentimiento no marca revisión.
    const crm = loadBridge(readFileSync(`${ROOT}supabase-bridge.js`, "utf8"), { session: AUTHENTICATED });
    const [row] = await crm.api.fetchLeads();
    assert.ok(row.demo_requested_at);
    assert.equal(row.privacy_review_required, undefined);
  } finally {
    await mode({ db: "new" });
  }
});
