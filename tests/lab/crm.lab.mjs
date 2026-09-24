// El CRM (bridge nuevo y publicado) sigue funcionando sobre la base migrada.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AUTHENTICATED } from "./jwt.mjs";
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

    const manual = await api.saveCrmLead({ companyName: "Manual SL", email: `manual-${name}@example.com`, status: "Nuevo" });
    assert.ok(manual.id);
    assert.equal(psql("lab", `select stage || '|' || (notified_at is null) from public.leads where id = '${manual.id}'`), "crm_manual|true");
  });
}
