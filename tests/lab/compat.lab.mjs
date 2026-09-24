// Compatibilidad con la web y la función PUBLICADAS (git ref extraído por
// run.sh en LAB_PUBLISHED_DIR) en cada orden de despliegue, y rollback.
// Los payloads reproducen exactamente lo que envían script.js y
// diagnostico.js publicados (el flujo de pantalla completo se validó a mano
// en el navegador; ver README).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MIGRATION, ROLLBACK, VERIFY, callFunction, emails, loadBridge, mode, psql, psqlFile, reset } from "./helpers.mjs";

const PUBLISHED = process.env.LAB_PUBLISHED_DIR;
const publishedBridge = () => loadBridge(readFileSync(`${PUBLISHED}/supabase-bridge.js`, "utf8"), { origin: "http://127.0.0.1:8767" });

// Lo que envía script.js publicado desde el formulario de demo.
const publishedDemo = (email) => ({
  eventType: "demo_requested",
  leadStage: "demo_requested_from_landing",
  lead: { companyName: "Lead web - Empresa", contactName: "Pendiente de completar", email, phone: "", sector: "Pendiente", employees: "", status: "Demo agendada", priority: "Alta", recommendedPlan: "Pro", riskScore: 65 },
  form: { email, privacy: "on", formType: "demo", source: "landing_demo_cta" },
  page: "http://127.0.0.1:8767/",
});
// Lo que envía diagnostico.js publicado al completar el diagnóstico.
const publishedDiagnosticPayload = (email) => ({
  company: { company: "Publicada SL", email, phone: "600000000", employees: "1-10", sector: "Comercio", privacy: "on" },
  answers: [],
  result: { globalScore: 55, classification: { label: "Media" }, criticalAreas: [], priorities: [], risks: [] },
});

beforeEach(async () => {
  await reset();
  psql("lab_old", "truncate public.leads, public.diagnostics cascade;");
});

test("línea base (producción actual): la función publicada envía emails a cualquier dirección", async () => {
  await mode({ fn: "published", db: "old" });
  const attack = await callFunction({ lead: { email: "victima@example.com", company_name: "X" } }, null);
  assert.equal(attack.status, 200);
  const { delivered } = await emails();
  assert.ok(delivered.some((m) => m.to.includes("victima@example.com")), "vulnerabilidad reproducida");
});

test("paso 1 (función nueva, base sin migrar): vulnerabilidad cerrada; los leads se siguen guardando", async () => {
  await mode({ fn: "new", db: "old" });
  assert.equal((await callFunction({ lead: { email: "victima@example.com" } }, null)).status, 400);
  const result = await publishedBridge().api.createLead(publishedDemo("pub.demo@example.com"));
  assert.equal(result.ok, true);
  assert.equal(psql("lab_old", "select count(*) from public.leads"), "1");
  const { attempts } = await emails();
  assert.equal(attempts.length, 0, "avisos en pausa hasta la migración; ningún email al visitante");
});

test("paso 2 (función nueva, base migrada) con la web publicada: demo OK y solo aviso interno", async () => {
  const bridge = publishedBridge();
  const result = await bridge.api.createLead(publishedDemo("pub.demo@example.com"));
  assert.equal(result.ok, true);
  assert.equal(psql("lab", "select privacy_accepted::text || '/' || commercial_consent::text from public.leads"), "true/false");
  const { delivered } = await emails();
  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0].to, ["interno@lab.invalid"]);
});

test("paso 2 con el diagnóstico publicado: se guarda en diagnostics como hoy (compatibilidad temporal)", async () => {
  const bridge = publishedBridge();
  const payload = publishedDiagnosticPayload("pub.diag@example.com");
  const lead = await bridge.api.createLead({ eventType: "diagnostic_completed", leadStage: "qualified_diagnostic_completed", payload, crmLead: {}, page: "x" });
  const diagnostic = await bridge.api.createDiagnostic({ eventType: "diagnostic_completed", payload, crmLead: {}, page: "x" });
  assert.equal(lead.ok, false, "igual que hoy: el diagnóstico publicado no crea lead (error previo de clave)");
  assert.equal(diagnostic.ok, true);
  assert.equal(psql("lab", "select count(*) from public.diagnostics"), "1");
});

test("paso 2: el diagnóstico publicado sin la casilla de privacidad no se guarda", async () => {
  const payload = publishedDiagnosticPayload("pub.diag@example.com");
  delete payload.company.privacy;
  const diagnostic = await publishedBridge().api.createDiagnostic({ eventType: "diagnostic_completed", payload, page: "x" });
  assert.equal(diagnostic.ok, false);
});

test("rollback: restaura el comportamiento anterior y la migración se puede reaplicar", async () => {
  try {
    psqlFile("lab", ROLLBACK);
    assert.equal(psql("lab", "select has_table_privilege('anon','public.leads','INSERT')"), "t");
    assert.equal(psql("lab", "select count(*) from pg_proc where proname in ('claim_lead_notification','request_lead_demo')"), "0");
    // La web publicada funciona como hoy sobre la base restaurada.
    const bridge = publishedBridge();
    assert.equal((await bridge.api.createLead(publishedDemo("rb@example.com"))).ok, true);
    const payload = publishedDiagnosticPayload("rb@example.com");
    delete payload.company.privacy;
    assert.equal((await bridge.api.createDiagnostic({ payload })).ok, true, "sin validación, como antes de PR0");
    // La función nueva no envía nada a terceros tras el rollback.
    const { attempts } = await emails();
    assert.equal(attempts.length, 0);
  } finally {
    psqlFile("lab", MIGRATION);
  }
  const verify = psqlFile("lab", VERIFY, { allowError: true });
  assert.match(verify, /OK: verificación PR0 superada/);
});
