// CRM: conversión de filas de Supabase, filtros y métricas (PR1a).
import { test } from "node:test";
import assert from "node:assert/strict";
import { dashboardMetrics, filteredLeads, leadFromSupabaseRow } from "../crm/src/store.js?v=20260925-1";

const row = (extra = {}) => ({
  id: "3f2b9c1e-8a4d-4f6b-9c2e-1a2b3c4d5e6f",
  email: "ana@empresa.es",
  company_name: "Empresa SL",
  source: "diagnostic_completed",
  status: "Nuevo",
  created_at: "2026-09-25T10:00:00Z",
  payload: {},
  ...extra,
});

test("la fila de Supabase lleva al CRM la demo solicitada y el consentimiento", () => {
  const lead = leadFromSupabaseRow(row({
    demo_requested_at: "2026-09-25T10:05:00Z",
    privacy_accepted_at: "2026-09-25T10:00:00Z",
    privacy_policy_version: "2026-06-04",
    commercial_consent: true,
    commercial_consent_at: "2026-09-25T10:00:00Z",
    commercial_consent_version: "2026-06-04",
  }), { defaultOwnerId: "u-1" });
  assert.equal(lead.demoRequestedAt, "2026-09-25T10:05:00Z");
  assert.equal(lead.privacyPolicyVersion, "2026-06-04");
  assert.equal(lead.commercialConsent, true);
  assert.equal(lead.privacyReviewRequired, false);
  assert.equal(lead.id, `lead-${row().id}`);
  assert.equal(lead.ownerId, "u-1");
});

test("la conversión conserva el id local existente y los datos del CRM guardados en el payload", () => {
  const lead = leadFromSupabaseRow(row({ payload: { ownerId: "u-2", notes: "Llamar", nextAction: "Demo" } }), { existingId: "lead-local", defaultOwnerId: "u-1" });
  assert.equal(lead.id, "lead-local");
  assert.equal(lead.ownerId, "u-2");
  assert.equal(lead.notes, "Llamar");
  assert.equal(lead.demoRequestedAt, "");
  assert.equal(lead.commercialConsent, false);
});

test("solo true cuenta como consentimiento comercial o revisión pendiente", () => {
  const lead = leadFromSupabaseRow(row({ commercial_consent: "true", privacy_review_required: "true" }));
  assert.equal(lead.commercialConsent, false);
  assert.equal(lead.privacyReviewRequired, false);
});

const state = (leads) => ({ leads, clients: [], tasks: [], users: [] });

test("filtros de demo solicitada y de revisión de privacidad", () => {
  const leads = [
    { ...leadFromSupabaseRow(row({ id: "a", email: "a@x.es", demo_requested_at: "2026-09-25T10:05:00Z" })) },
    { ...leadFromSupabaseRow(row({ id: "b", email: "b@x.es", privacy_review_required: true })) },
    { ...leadFromSupabaseRow(row({ id: "c", email: "c@x.es" })) },
  ];
  assert.deepEqual(filteredLeads(state(leads), { demoRequested: "1" }).map((l) => l.email), ["a@x.es"]);
  assert.deepEqual(filteredLeads(state(leads), { privacyReview: "1" }).map((l) => l.email), ["b@x.es"]);
  assert.equal(filteredLeads(state(leads), {}).length, 3);
});

test("métrica de demos solicitadas desde la web y aún sin atender", () => {
  const withDemo = (status) => leadFromSupabaseRow(row({ id: status, email: `${status}@x.es`, status, demo_requested_at: "2026-09-25T10:05:00Z" }));
  const leads = [withDemo("Nuevo"), withDemo("Contactado"), withDemo("Demo agendada"), withDemo("Perdido"), leadFromSupabaseRow(row({ id: "z" }))];
  assert.equal(dashboardMetrics(state(leads)).demosRequested, 2);
});

test("sin columnas de consentimiento en la base (antes de migrar) no se muestran datos de consentimiento", () => {
  assert.equal(leadFromSupabaseRow(row()).consentTracked, false);
  assert.equal(leadFromSupabaseRow(row({ privacy_accepted_at: null })).consentTracked, true);
});
