// CRM (LP-CRM-002): salvaguardas de datos demo y estado local.
// Usa un almacenamiento simulado; no toca localStorage real ni Supabase.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  backupRawState,
  clearDemoRecordsSafely,
  isPersistenceBlocked,
  loadState,
  removeDemoRecords,
  resetState,
  saveState,
} from "../crm/src/store.js?v=20261029-1";
import { demoData } from "../crm/src/demoData.js?v=20261002-1";

const KEY = "legalprevent-crm-v1";

class MemoryStorage {
  constructor(initial = {}) { this.map = new Map(Object.entries(initial)); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  get keys() { return [...this.map.keys()]; }
}

class BrokenStorage {
  getItem() { throw new Error("SecurityError: storage disabled"); }
  setItem() { throw new Error("QuotaExceededError"); }
}

const clone = (value) => JSON.parse(JSON.stringify(value));

// Estado de prueba: un lead demo, un lead y un cliente creados a mano, y dependientes de cada uno.
function sampleState() {
  const base = clone(demoData);
  base.leads.push({ id: "lead-manual-1", companyName: "Cliente real a mano", dataOrigin: undefined });
  base.clients.push({ id: "client-manual-1", businessName: "Cliente real a mano SL", plan: "Pyme" });
  base.tasks.push({ id: "task-real-1", relatedType: "client", relatedId: "client-manual-1" });
  base.interactions.push({ id: "int-real-1", relatedType: "lead", relatedId: "lead-manual-1" });
  base.proposals.push({ id: "prop-real-1", relatedClientId: "client-manual-1" });
  return base;
}

test("removeDemoRecords conserva los registros creados a mano y elimina los demo", () => {
  const state = sampleState();
  const { state: next, removed } = removeDemoRecords(state);
  const leadIds = next.leads.map((l) => l.id);
  const clientIds = next.clients.map((c) => c.id);

  assert.ok(leadIds.includes("lead-manual-1"), "el lead creado a mano debe conservarse");
  assert.ok(clientIds.includes("client-manual-1"), "el cliente creado a mano debe conservarse");
  assert.ok(!leadIds.includes("lead-1"), "el lead demo debe eliminarse");
  assert.ok(!clientIds.includes("client-1"), "el cliente demo debe eliminarse");
  assert.ok(next.tasks.some((t) => t.id === "task-real-1"), "la tarea del cliente real se conserva");
  assert.ok(next.interactions.some((i) => i.id === "int-real-1"), "la interacción del lead real se conserva");
  assert.ok(next.proposals.some((p) => p.id === "prop-real-1"), "la propuesta del cliente real se conserva");
  assert.ok(removed.leads >= 1 && removed.clients >= 1);
});

test("un registro con vínculo Supabase o Stripe nunca se trata como demo aunque tenga un id demo", () => {
  const state = clone(demoData);
  state.leads[0].supabaseId = "3f2b9c1e-8a4d-4f6b-9c2e-1a2b3c4d5e6f";
  state.clients[0].stripeCustomerId = "cus_test_placeholder";
  const { state: next } = removeDemoRecords(state);
  assert.ok(next.leads.some((l) => l.id === state.leads[0].id));
  assert.ok(next.clients.some((c) => c.id === state.clients[0].id));
});

test("una propuesta con un padre real y otro demo se conserva", () => {
  const state = clone(demoData);
  state.proposals.push({ id: "prop-mixta", relatedLeadId: "lead-1", relatedClientId: "client-manual-1" });
  state.clients.push({ id: "client-manual-1", businessName: "Real" });
  const { state: next } = removeDemoRecords(state);
  assert.ok(next.proposals.some((p) => p.id === "prop-mixta"));
});

test("loadState conserva el contenido de un estado dañado antes de reemplazarlo", () => {
  const storage = new MemoryStorage({ [KEY]: "{no-es-json" });
  const state = loadState(storage);
  assert.ok(state.leads.length > 0, "se cargan datos demo en memoria");
  const copyKey = storage.keys.find((k) => k.startsWith(`${KEY}-corrupto-`));
  assert.ok(copyKey, "debe existir una copia del contenido dañado");
  assert.equal(storage.getItem(copyKey), "{no-es-json");
});

test("si no se puede copiar el estado dañado, no se sobrescribe y el guardado queda bloqueado", () => {
  const storage = new MemoryStorage({ [KEY]: "{no-es-json" });
  storage.setItem = () => { throw new Error("QuotaExceededError"); };
  loadState(storage);
  assert.ok(isPersistenceBlocked(), "la persistencia debe quedar bloqueada");
  assert.equal(storage.getItem(KEY), "{no-es-json", "el contenido original no debe tocarse");
  assert.throws(() => saveState({}, storage), /Guardado bloqueado/);
  resetState(new MemoryStorage()); // limpia el bloqueo para el resto de pruebas
});

test("si el almacenamiento no es accesible, la app arranca sin escribir", () => {
  const state = loadState(new BrokenStorage());
  assert.ok(state.leads.length > 0);
  assert.ok(isPersistenceBlocked());
  resetState(new MemoryStorage());
});

test("resetState cancela si no puede copiar el estado actual", () => {
  const storage = new MemoryStorage({ [KEY]: JSON.stringify(sampleState()) });
  storage.setItem = () => { throw new Error("QuotaExceededError"); };
  assert.throws(() => resetState(storage), /restauración cancelada/);
  assert.ok(storage.getItem(KEY).includes("Cliente real a mano"), "el estado actual debe seguir intacto");
});

test("resetState guarda una copia del estado anterior antes de restaurar la demo", () => {
  const storage = new MemoryStorage({ [KEY]: JSON.stringify(sampleState()) });
  resetState(storage);
  const copyKey = storage.keys.find((k) => k.startsWith(`${KEY}-antes-restaurar-demo-`));
  assert.ok(copyKey, "debe existir la copia previa");
  assert.ok(storage.getItem(copyKey).includes("Cliente real a mano"));
});

test("clearDemoRecordsSafely no borra nada si no puede copiar", () => {
  const state = sampleState();
  const storage = new MemoryStorage();
  storage.setItem = () => { throw new Error("QuotaExceededError"); };
  assert.throws(() => clearDemoRecordsSafely(state, storage), /eliminación cancelada/);
  assert.ok(state.leads.some((l) => l.id === "lead-1"), "el estado en memoria no debe cambiar");
});

test("clearDemoRecordsSafely guarda copia y después elimina solo los demo", () => {
  const storage = new MemoryStorage();
  const result = clearDemoRecordsSafely(sampleState(), storage);
  assert.ok(result.backupKey.startsWith(`${KEY}-antes-eliminar-demo-`));
  assert.ok(storage.getItem(result.backupKey).includes("Cliente real a mano"));
  const saved = JSON.parse(storage.getItem(KEY));
  assert.ok(saved.leads.some((l) => l.id === "lead-manual-1"));
  assert.ok(!saved.leads.some((l) => l.id === "lead-1"));
});

test("backupRawState devuelve null si no hay almacenamiento", () => {
  assert.equal(backupRawState(null, "x", "test"), null);
});
