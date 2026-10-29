// CRM (LP-CRM-002): retirada de consentimiento y eliminación de contactos.
// Funciones puras: la confirmación remota se simula con el estado que devuelve Supabase.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CONSENT_WITHDRAWAL_CONFIRMED, removeLeadAndRelated, withdrawConsentLocally } from "../crm/src/store.js?v=20261029-1";

const base = () => ({
  leads: [
    { id: "lead-a", email: "ana@cliente.test", commercialConsent: true },
    { id: "lead-b", email: "otro@cliente.test", commercialConsent: true },
  ],
  tasks: [{ id: "t-a", relatedType: "lead", relatedId: "lead-a" }],
  interactions: [],
  documents: [],
  notes: [],
  proposals: [{ id: "p-a", relatedLeadId: "lead-a" }],
  clients: [],
});

test("la retirada solo puede dejar el consentimiento en retirado", () => {
  const next = withdrawConsentLocally(base(), "lead-a", "2026-10-29T10:00:00.000Z");
  const lead = next.leads.find((item) => item.id === "lead-a");
  assert.equal(lead.commercialConsent, false);
  assert.equal(lead.commercialConsentWithdrawnAt, "2026-10-29T10:00:00.000Z");
  assert.equal(next.leads.find((item) => item.id === "lead-b").commercialConsent, true, "otros leads no cambian");
});

test("reintentar la retirada es idempotente y conserva la fecha original", () => {
  const once = withdrawConsentLocally(base(), "lead-a", "2026-10-29T10:00:00.000Z");
  const twice = withdrawConsentLocally(once, "lead-a", "2026-11-01T00:00:00.000Z");
  assert.deepEqual(twice, once);
  assert.equal(twice.leads[0].commercialConsentWithdrawnAt, "2026-10-29T10:00:00.000Z");
});

test("ninguna operación de retirada restaura un consentimiento", () => {
  const withdrawn = withdrawConsentLocally(base(), "lead-a");
  const again = withdrawConsentLocally(withdrawn, "lead-a");
  assert.equal(again.leads[0].commercialConsent, false);
});

test("solo 'withdrawn' y 'not_consented' se consideran confirmados por Supabase", () => {
  assert.ok(CONSENT_WITHDRAWAL_CONFIRMED.has("withdrawn"));
  assert.ok(CONSENT_WITHDRAWAL_CONFIRMED.has("not_consented"));
  assert.ok(!CONSENT_WITHDRAWAL_CONFIRMED.has("not_found"));
  assert.ok(!CONSENT_WITHDRAWAL_CONFIRMED.has(undefined));
});

test("eliminar el contacto retira sus relaciones y repetirlo no cambia nada", () => {
  const once = removeLeadAndRelated(base(), "lead-a");
  assert.equal(once.leads.some((lead) => lead.id === "lead-a"), false);
  assert.equal(once.tasks.length, 0);
  assert.equal(once.proposals.length, 0);
  assert.equal(once.leads.some((lead) => lead.id === "lead-b"), true, "otros contactos se conservan");
  const twice = removeLeadAndRelated(once, "lead-a");
  assert.deepEqual(twice, once);
});

test("el estado de partida no se modifica al retirar o eliminar", () => {
  const original = base();
  const snapshot = JSON.parse(JSON.stringify(original));
  withdrawConsentLocally(original, "lead-a");
  removeLeadAndRelated(original, "lead-a");
  assert.deepEqual(original, snapshot);
});
