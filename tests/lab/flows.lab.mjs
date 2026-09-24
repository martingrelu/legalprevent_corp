// Flujos de la web NUEVA contra la base migrada y la función nueva.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ROOT, emails, loadBridge, psql, reset } from "./helpers.mjs";

const bridge = () => loadBridge(readFileSync(`${ROOT}supabase-bridge.js`, "utf8"));
const row = (email) =>
  psql("lab", `select source || '|' || privacy_accepted || '|' || commercial_consent || '|' || (notified_at is not null)
    || '|' || (demo_requested_at is not null) || '|' || (demo_notified_at is not null) from public.leads where email = '${email}'`);

beforeEach(() => reset());

test("demo de la portada: con y sin comunicaciones comerciales", async () => {
  const api = bridge().api;
  for (const [email, form] of [["sin@example.com", { privacy: "on" }], ["con@example.com", { privacy: "on", commercial: "on" }]]) {
    const r = await api.createLead({ eventType: "demo_requested", leadStage: "demo_requested_from_landing", lead: { email }, form: { email, ...form } });
    assert.equal(r.ok, true);
  }
  assert.equal(row("sin@example.com"), "demo_requested|true|false|true|false|false");
  assert.equal(row("con@example.com"), "demo_requested|true|true|true|false|false");
});

test("diagnóstico y demo posterior: un lead, dos avisos internos, consentimiento intacto", async () => {
  const api = bridge().api;
  const lead = await api.createLead({ eventType: "diagnostic_completed", leadStage: "qualified_diagnostic_completed", lead: { email: "diag@example.com", companyName: "Diag SL" }, privacyAccepted: true, commercialConsent: false });
  assert.equal(lead.ok, true);
  const demo = await api.requestLeadDemo(lead.record.id);
  const again = await api.requestLeadDemo(lead.record.id);
  assert.equal(demo.ok, true);
  assert.equal(again.ok, false, "la demo solo se registra una vez");
  assert.equal(psql("lab", "select count(*) from public.leads"), "1");
  assert.equal(row("diag@example.com"), "diagnostic_completed|true|false|true|true|true");
  const { delivered } = await emails();
  assert.deepEqual(delivered.map((m) => m.subject.split(":")[0]), ["Nuevo lead Legal Prevent", "Demo solicitada"]);
  assert.ok(delivered.every((m) => m.to.length === 1 && m.to[0] === "interno@lab.invalid"));
});

test("sin aceptar la privacidad no se envía ni se guarda nada", async () => {
  const api = bridge().api;
  const r = await api.createLead({ eventType: "demo_requested", lead: { email: "x@example.com" }, form: { email: "x@example.com", commercial: "on" } });
  assert.equal(r.reason, "privacy_required");
  assert.equal(psql("lab", "select count(*) from public.leads"), "0");
});

test("ningún flujo escribe datos en el almacenamiento del navegador", async () => {
  const { api, localStorage } = bridge();
  await api.createLead({ eventType: "demo_requested", lead: { email: "y@example.com" }, form: { email: "y@example.com", privacy: "on" } });
  await api.createDiagnostic({ payload: { company: { email: "y@example.com" } }, privacyAccepted: true });
  assert.deepEqual(localStorage.keys(), []);
});
