// CRM (LP-CRM-002): sincronización, importación y clasificación de leads.
// Todo se prueba con fetch simulado; no hay conexión a Supabase.
import { test } from "node:test";
import assert from "node:assert/strict";
import { demoData } from "../crm/src/demoData.js?v=20261002-1";
import { filteredLeads } from "../crm/src/store.js?v=20261029-1";
import {
  buildRows,
  createSyncController,
  planImport,
  relationOf,
  SyncError,
  writeRows,
} from "../crm/src/sync.js?v=20261029-1";

const clone = (value) => JSON.parse(JSON.stringify(value));
const AUTH = { baseUrl: "https://example.supabase.co", anonKey: "anon-test", accessToken: "jwt-test" };

function stateWithManualRecords() {
  const state = clone(demoData);
  state.leads.push({ id: "lead-1700000000000-abc12", companyName: "Creada a mano", email: "a@b.es" });
  state.clients.push({ id: "client-manual-1", businessName: "Cliente real SL", plan: "Pyme" });
  state.tasks.push({ id: "task-manual-1", title: "Llamar", relatedType: "client", relatedId: "client-manual-1" });
  state.interactions.push({ id: "int-manual-1", relatedType: "lead", relatedId: "lead-1700000000000-abc12" });
  state.proposals.push({ id: "prop-manual-1", relatedClientId: "client-manual-1", plan: "Pyme", price: 99 });
  return state;
}

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, options });
    return handler(url, options, calls.length);
  };
  fn.calls = calls;
  return fn;
}

const ok = (body = "", status = 201) => ({
  ok: status < 400,
  status,
  json: async () => (body ? JSON.parse(body) : []),
  text: async () => body,
});

test("buildRows excluye todo registro demo y conserva los creados a mano con sus relaciones", () => {
  const { rows, skippedDemo } = buildRows(stateWithManualRecords(), undefined, "2026-10-29T00:00:00.000Z");
  const keys = rows.map((row) => `${row.kind}:${row.local_id}`);
  assert.ok(keys.includes("client:client-manual-1"));
  assert.ok(keys.includes("task:task-manual-1"));
  assert.ok(keys.includes("interaction:int-manual-1"));
  assert.ok(keys.includes("proposal:prop-manual-1"));
  assert.ok(!keys.some((key) => key.includes("client-1") && !key.includes("manual")), "no debe subir clientes demo");
  assert.ok(skippedDemo.client >= 1, "los clientes demo deben contarse como omitidos");
  const task = rows.find((row) => row.local_id === "task-manual-1");
  assert.equal(task.related_type, "client");
  assert.equal(task.related_id, "client-manual-1");
  assert.equal(task.payload.title, "Llamar", "el payload conserva el registro completo");
});

test("relationOf mantiene la referencia de propuestas a lead o cliente", () => {
  assert.deepEqual(relationOf("proposal", { relatedLeadId: "lead-9" }), { type: "lead", id: "lead-9" });
  assert.deepEqual(relationOf("proposal", { relatedClientId: "c-1" }), { type: "client", id: "c-1" });
  assert.deepEqual(relationOf("client", { id: "c-1" }), { type: null, id: null });
});

test("writeRows usa upsert por (kind, local_id) y nunca envía DELETE", async () => {
  const fetchImpl = fakeFetch(() => ok());
  const rows = buildRows(stateWithManualRecords()).rows;
  const result = await writeRows(rows, AUTH, { fetchImpl });
  assert.equal(result.written, rows.length);
  for (const call of fetchImpl.calls) {
    assert.equal(call.options.method, "POST");
    assert.match(call.url, /\/rest\/v1\/crm_records\?on_conflict=kind,local_id$/);
    assert.match(call.options.headers.Prefer, /resolution=merge-duplicates/);
    assert.equal(call.options.headers.Authorization, "Bearer jwt-test");
  }
});

test("writeRows parte las escrituras en lotes de 200", async () => {
  const fetchImpl = fakeFetch(() => ok());
  const rows = Array.from({ length: 450 }, (_, i) => ({ kind: "task", local_id: `t-${i}`, payload: {} }));
  await writeRows(rows, AUTH, { fetchImpl });
  assert.equal(fetchImpl.calls.length, 3);
  assert.equal(JSON.parse(fetchImpl.calls[2].options.body).length, 50);
});

test("un error del servidor se propaga como SyncError con mensaje comprensible", async () => {
  const fetchImpl = fakeFetch(() => ok("denied", 403));
  await assert.rejects(writeRows([{ kind: "task", local_id: "t", payload: {} }], AUTH, { fetchImpl }), (error) => {
    assert.ok(error instanceof SyncError);
    assert.equal(error.status, 403);
    assert.match(error.message, /administradora/);
    return true;
  });
});

test("la importación usa ignore-duplicates y cuenta lo que ya existía", async () => {
  const fetchImpl = fakeFetch(() => ok(JSON.stringify([{ kind: "task", local_id: "t-1" }]), 201));
  const rows = [{ kind: "task", local_id: "t-1", payload: {} }, { kind: "task", local_id: "t-2", payload: {} }];
  const result = await writeRows(rows, AUTH, { mode: "ignore", fetchImpl });
  assert.match(fetchImpl.calls[0].options.headers.Prefer, /ignore-duplicates/);
  assert.equal(result.inserted, 1);
  assert.equal(result.skipped, 1);
});

test("planImport detecta duplicados en el fichero, relaciones huérfanas y omite demo sin escribir", () => {
  const backup = { data: stateWithManualRecords() };
  backup.data.tasks.push({ id: "task-manual-1", title: "Repetida", relatedType: "client", relatedId: "client-manual-1" });
  backup.data.proposals.push({ id: "prop-huerfana", relatedClientId: "no-existe", plan: "Pyme", price: 1 });
  const plan = planImport(backup);
  assert.ok(plan.report.duplicatesInFile.includes("task:task-manual-1"));
  assert.ok(plan.report.danglingRelations.includes("proposal:prop-huerfana"));
  assert.ok(plan.report.skippedDemo.client >= 1);
  assert.equal(plan.blocking, false);
  assert.equal(plan.wouldWrite, plan.rows.length);
});

test("el controlador muestra 'pendiente' y solo 'sincronizado' tras confirmación del servidor", async () => {
  const timers = [];
  const statuses = [];
  let release;
  const write = () => new Promise((resolve) => { release = resolve; });
  const controller = createSyncController({
    getAuth: () => AUTH,
    write,
    onStatus: (s) => statuses.push(s.state),
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: () => {},
  });
  controller.changed(stateWithManualRecords());
  assert.equal(controller.status().state, "pending");
  const flush = timers.shift();
  const running = flush();
  assert.equal(controller.status().state, "pending", "mientras se envía no es 'sincronizado'");
  release();
  await running;
  assert.equal(controller.status().state, "synced");
});

test("un fallo de escritura deja el estado en error y nunca aparece como sincronizado", async () => {
  const timers = [];
  const controller = createSyncController({
    getAuth: () => AUTH,
    write: async () => { throw new SyncError(500, ""); },
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: () => {},
  });
  controller.changed(stateWithManualRecords());
  await timers.shift()();
  assert.equal(controller.status().state, "error");
  assert.match(controller.status().message, /Los datos siguen en este navegador/);
});

test("sin sesión de Supabase el estado es solo local y no se intenta escribir", async () => {
  let writes = 0;
  const timers = [];
  const controller = createSyncController({
    getAuth: () => null,
    write: async () => { writes += 1; },
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: () => {},
  });
  controller.changed(stateWithManualRecords());
  await timers.shift()();
  assert.equal(writes, 0);
  assert.equal(controller.status().state, "local");
});

test("sin conexión se indica como error recuperable y no se escribe", async () => {
  let writes = 0;
  const timers = [];
  const controller = createSyncController({
    getAuth: () => AUTH,
    isOnline: () => false,
    write: async () => { writes += 1; },
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: () => {},
  });
  controller.changed(stateWithManualRecords());
  await timers.shift()();
  assert.equal(writes, 0);
  assert.equal(controller.status().error, "offline");
});

test("un cambio durante el envío obliga a un nuevo envío antes de declarar sincronizado", async () => {
  // Simulador de temporizadores con cancelación real, como setTimeout/clearTimeout.
  const timers = new Map();
  let nextId = 1;
  const setTimer = (fn) => { const id = nextId++; timers.set(id, fn); return id; };
  const clearTimer = (id) => { timers.delete(id); };
  const fire = async () => {
    const [id, fn] = timers.entries().next().value || [];
    if (id === undefined) return false;
    timers.delete(id);
    await fn();
    return true;
  };
  const writes = [];
  let release;
  const controller = createSyncController({
    getAuth: () => AUTH,
    write: (rows) => {
      writes.push(rows.length);
      if (writes.length === 1) return new Promise((resolve) => { release = resolve; });
      return Promise.resolve();
    },
    setTimer,
    clearTimer,
  });
  controller.changed(stateWithManualRecords());
  const first = fire();
  controller.changed(stateWithManualRecords());
  release();
  await first;
  while (await fire()) { /* ejecuta los envíos programados */ }
  await controller.idle();
  assert.equal(writes.length, 2, "debe reenviar el estado nuevo");
  assert.equal(controller.status().state, "synced");
});

test("filteredLeads separa demo de reales creados a mano", () => {
  const state = stateWithManualRecords();
  const real = filteredLeads(state, { origin: "real" }).map((lead) => lead.id);
  const demo = filteredLeads(state, { origin: "demo" }).map((lead) => lead.id);
  assert.ok(real.includes("lead-1700000000000-abc12"), "el lead creado a mano es real");
  assert.ok(demo.includes("lead-1"), "el lead de demostración sigue siendo demo");
  assert.ok(!demo.includes("lead-1700000000000-abc12"));
});

// Servidor PostgREST simulado con la semántica de la clave única (kind, local_id).
function fakePostgrest({ failBatchAt = -1 } = {}) {
  const table = new Map();
  let batch = 0;
  const fetchImpl = async (url, options) => {
    const current = batch++;
    if (current === failBatchAt) throw new TypeError("Failed to fetch");
    const ignore = /ignore-duplicates/.test(options.headers.Prefer);
    const inserted = [];
    for (const row of JSON.parse(options.body)) {
      const key = `${row.kind}:${row.local_id}`;
      if (table.has(key) && ignore) continue;
      if (!table.has(key)) inserted.push(row);
      table.set(key, row);
    }
    return { ok: true, status: 201, json: async () => inserted, text: async () => "" };
  };
  return { fetchImpl, table };
}

test("importar la misma copia dos veces no duplica registros", async () => {
  const backup = { data: stateWithManualRecords() };
  const { rows } = planImport(backup);
  const remote = fakePostgrest();
  const first = await writeRows(rows, AUTH, { mode: "ignore", fetchImpl: remote.fetchImpl });
  const second = await writeRows(rows, AUTH, { mode: "ignore", fetchImpl: remote.fetchImpl });
  assert.equal(first.inserted, rows.length);
  assert.equal(second.inserted, 0, "la segunda importación no inserta nada");
  assert.equal(second.skipped, rows.length);
  assert.equal(remote.table.size, rows.length);
});

test("un fallo de red a mitad de envío no pierde nada y reintentar no duplica", async () => {
  const rows = Array.from({ length: 450 }, (_, i) => ({ kind: "task", local_id: `t-${i}`, payload: {} }));
  const remote = fakePostgrest({ failBatchAt: 1 });
  await assert.rejects(writeRows(rows, AUTH, { mode: "ignore", fetchImpl: remote.fetchImpl }), (error) => {
    assert.equal(error.status, 0);
    assert.match(error.message, /conexión/);
    return true;
  });
  assert.equal(remote.table.size, 200, "solo el primer lote quedó confirmado");
  // Reintento completo contra el mismo servidor, ya sin fallo: solo entran los 250 pendientes.
  const healthy = await writeRows(rows, AUTH, { mode: "ignore", fetchImpl: remote.fetchImpl });
  assert.equal(healthy.inserted, 250);
  assert.equal(healthy.skipped, 200);
  assert.equal(remote.table.size, 450);
});

test("un fallo de red al sincronizar deja el estado local intacto", async () => {
  const state = stateWithManualRecords();
  const snapshot = clone(state);
  const timers = [];
  const controller = createSyncController({
    getAuth: () => AUTH,
    write: async () => { throw Object.assign(new SyncError(0, ""), {}); },
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: () => {},
  });
  controller.changed(state);
  await timers.shift()();
  assert.equal(controller.status().state, "error");
  assert.match(controller.status().message, /Los datos siguen en este navegador/);
  assert.deepEqual(state, snapshot, "el estado local no se modifica");
});

test("planImport no modifica la copia que se le pasa", () => {
  const backup = { data: stateWithManualRecords() };
  const snapshot = clone(backup);
  planImport(backup);
  assert.deepEqual(backup, snapshot);
});
