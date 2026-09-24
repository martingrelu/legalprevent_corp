// El CRM (bridge nuevo y publicado) sigue funcionando sobre la base migrada,
// con el control de acceso real de producción (app_metadata.crm_role).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AUTHENTICATED, AUTHENTICATED_NO_ADMIN } from "./jwt.mjs";
import { ROOT, callFunction, loadBridge, newLead, psql, reset, rpc } from "./helpers.mjs";

const sources = {
  nuevo: `${ROOT}supabase-bridge.js`,
  publicado: `${process.env.LAB_PUBLISHED_DIR}/supabase-bridge.js`,
};

beforeEach(() => reset());

for (const [name, path] of Object.entries(sources)) {
  test(`CRM ${name}: sincroniza, edita un lead web sin tocar PR0 y crea un lead manual`, async () => {
    const id = await newLead(1, { source: "diagnostic_completed", commercial_consent: true, company_name: "CRM SL" });
    await callFunction({ leadId: id });
    await rpc("request_lead_demo", { p_lead_id: id });
    await callFunction({ leadId: id, kind: "demo_request" });

    const { api } = loadBridge(readFileSync(path, "utf8"), { session: AUTHENTICATED });
    const rows = await api.fetchLeads();
    assert.equal(rows.length, 1);
    const billing = await api.fetchBillingData();
    assert.deepEqual(Object.keys(billing).sort(), ["checkoutSessions", "payments", "subscriptions"]);

    await api.saveCrmLead({ supabaseId: id, companyName: "CRM SL", email: rows[0].email, status: "Contactado", notes: "Llamada", source: "intento de cambio" });
    assert.equal(
      psql("lab", `select status || '|' || source || '|' || privacy_accepted || '|' || commercial_consent || '|' || (notified_at is not null) || '|' || (demo_notified_at is not null) from public.leads where id = '${id}'`),
      "Contactado|diagnostic_completed|true|true|true|true",
    );
    assert.equal(
      psql("lab", `select (privacy_accepted_at is not null) || '|' || privacy_policy_version || '|' || commercial_consent_version || '|' || (demo_requested_at is not null) from public.leads where id = '${id}'`),
      "true|2026-06-04|2026-06-04|true",
      "editar desde el CRM no toca el consentimiento ni la demo",
    );

    const manual = await api.saveCrmLead({ companyName: "Manual SL", email: `manual-${name}@example.com`, status: "Nuevo" });
    assert.ok(manual.id);
    assert.equal(psql("lab", `select stage || '|' || (notified_at is null) from public.leads where id = '${manual.id}'`), "crm_manual|true");
  });
}

test("CRM: la fila sincronizada lleva la demo solicitada y el consentimiento", async () => {
  const id = await newLead(2, { source: "diagnostic_completed", company_name: "Demo SL" });
  await rpc("request_lead_demo", { p_lead_id: id });
  const { api } = loadBridge(readFileSync(sources.nuevo, "utf8"), { session: AUTHENTICATED });
  const [row] = await api.fetchLeads();
  assert.ok(row.demo_requested_at);
  assert.ok(row.privacy_accepted_at);
  assert.equal(row.privacy_policy_version, "2026-06-04");
  assert.equal(row.privacy_review_required, false);
});

test("usuario autenticado sin rol de administrador: no ve ni edita leads ni facturación", async () => {
  const id = await newLead(3);
  const { api } = loadBridge(readFileSync(sources.nuevo, "utf8"), { session: AUTHENTICATED_NO_ADMIN });
  assert.deepEqual(await api.fetchLeads(), []);
  const billing = await api.fetchBillingData();
  assert.deepEqual([billing.checkoutSessions, billing.subscriptions, billing.payments], [[], [], []]);
  await assert.rejects(api.saveCrmLead({ companyName: "Intruso", email: "intruso@example.com" }));
  assert.equal(psql("lab", "select count(*) from public.leads where email = 'intruso@example.com'"), "0");
  assert.equal(psql("lab", `select status from public.leads where id = '${id}'`), "Nuevo");
});
