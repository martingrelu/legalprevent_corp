// Sincronización del CRM con la tabla crm_records de Supabase (LP-CRM-002).
//
// Principios:
// - Solo escribe registros reales: los datos demo nunca salen del navegador.
// - Nunca borra en remoto: las eliminaciones locales no se propagan (conservar es lo seguro).
// - Upsert por (kind, local_id): reintentar no duplica.
// - Un guardado solo se muestra como "sincronizado" si el servidor confirmó la escritura.
// - La importación de copias usa ignore-duplicates: nunca sobrescribe lo que ya existe en la nube.

import { demoRecordIds, isDemoRecord } from "./store.js?v=20261029-crm2";

export const CRM_COLLECTIONS = {
  clients: "client",
  tasks: "task",
  interactions: "interaction",
  proposals: "proposal",
};

const TABLE_PATH = "/rest/v1/crm_records";
const BATCH_SIZE = 200;
export const LOCAL_ONLY_MESSAGE = "Guardado en este navegador. Conecta Supabase como administrador para sincronizarlo.";

export class SyncError extends Error {
  constructor(status, detail) {
    super(syncErrorMessage(status, detail));
    this.name = "SyncError";
    this.status = status;
  }
}

export function syncErrorMessage(status, detail = "") {
  if (status === 0) return "No hay conexión con la nube.";
  if (status === 401 || status === 403) return "Sin permiso para escribir en la nube. Revisa que la cuenta sea administradora del CRM.";
  if (status === 404) return "La tabla crm_records no existe en esta base de datos. Falta aplicar la migración.";
  if (status === 409) return "Conflicto al escribir en la nube. Reintenta la sincronización.";
  if (status >= 500) return "El servidor de la nube no responde correctamente. Reintenta más tarde.";
  return `La nube rechazó la escritura (${status})${detail ? `: ${String(detail).slice(0, 160)}` : ""}.`;
}

// Relación con el registro padre. Se conserva tal cual para poder reconstruir el CRM.
export function relationOf(kind, item) {
  if (kind === "client") return { type: null, id: null };
  if (kind === "proposal") {
    if (item.relatedLeadId) return { type: "lead", id: String(item.relatedLeadId) };
    if (item.relatedClientId) return { type: "client", id: String(item.relatedClientId) };
    return { type: null, id: null };
  }
  return { type: item.relatedType || null, id: item.relatedId ? String(item.relatedId) : null };
}

export function rowFor(kind, item, updatedAt = new Date().toISOString()) {
  const rel = relationOf(kind, item);
  return {
    kind,
    local_id: String(item.id),
    related_type: rel.type,
    related_id: rel.id,
    payload: item,
    updated_at: updatedAt,
  };
}

// Filas para subir: solo registros reales. Devuelve también cuántos demo se han omitido.
export function buildRows(state, demoIds = demoRecordIds(), updatedAt = new Date().toISOString()) {
  const rows = [];
  const skippedDemo = {};
  for (const [collection, kind] of Object.entries(CRM_COLLECTIONS)) {
    for (const item of state?.[collection] || []) {
      if (!item?.id) continue;
      if (isDemoRecord(item, demoIds)) {
        skippedDemo[kind] = (skippedDemo[kind] || 0) + 1;
        continue;
      }
      rows.push(rowFor(kind, item, updatedAt));
    }
  }
  return { rows, skippedDemo };
}

// Escritura por lotes. mode "merge" actualiza; mode "ignore" no toca lo existente.
export async function writeRows(rows, auth, { mode = "merge", fetchImpl = globalThis.fetch } = {}) {
  const result = { written: 0, inserted: 0, skipped: 0 };
  if (!rows.length) return result;
  if (!auth?.accessToken || !auth?.baseUrl || !auth?.anonKey) throw new Error("No hay sesión de Supabase activa.");
  const resolution = mode === "ignore" ? "ignore-duplicates" : "merge-duplicates";
  const prefer = mode === "ignore" ? `resolution=${resolution},return=representation` : `resolution=${resolution},return=minimal`;

  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const chunk = rows.slice(offset, offset + BATCH_SIZE);
    let response;
    try {
      response = await fetchImpl(`${auth.baseUrl}${TABLE_PATH}?on_conflict=kind,local_id`, {
        method: "POST",
        headers: {
          apikey: auth.anonKey,
          Authorization: `Bearer ${auth.accessToken}`,
          "Content-Type": "application/json",
          Prefer: prefer,
        },
        body: JSON.stringify(chunk),
      });
    } catch {
      // Fallo de red: la petición no llegó a confirmarse. Los lotes ya confirmados no se revierten,
      // y repetir la escritura no duplica (upsert por kind+local_id).
      throw new SyncError(0, "");
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new SyncError(response.status, detail);
    }
    result.written += chunk.length;
    if (mode === "ignore") {
      const returned = await response.json().catch(() => []);
      const inserted = Array.isArray(returned) ? returned.length : 0;
      result.inserted += inserted;
      result.skipped += chunk.length - inserted;
    }
  }
  return result;
}

// Simulación de importación de una copia exportada. No escribe nada.
export function planImport(backup, demoIds = demoRecordIds()) {
  const data = backup?.data || backup || {};
  const report = { totals: {}, duplicatesInFile: [], missingIds: [], danglingRelations: [], skippedDemo: {} };
  const leadIds = new Set((data.leads || []).map((lead) => lead.id));
  const clientIds = new Set((data.clients || []).map((client) => client.id));
  const rows = [];
  const seen = new Set();

  for (const [collection, kind] of Object.entries(CRM_COLLECTIONS)) {
    const items = data[collection] || [];
    report.totals[kind] = items.length;
    for (const item of items) {
      if (!item?.id) {
        report.missingIds.push(kind);
        continue;
      }
      const key = `${kind}:${item.id}`;
      if (seen.has(key)) {
        report.duplicatesInFile.push(key);
        continue;
      }
      seen.add(key);
      if (isDemoRecord(item, demoIds)) {
        report.skippedDemo[kind] = (report.skippedDemo[kind] || 0) + 1;
        continue;
      }
      const rel = relationOf(kind, item);
      if (rel.type && rel.id) {
        const known = rel.type === "lead" ? leadIds.has(item.relatedLeadId ?? item.relatedId) : clientIds.has(item.relatedClientId ?? item.relatedId);
        if (!known) report.danglingRelations.push(key);
      }
      rows.push(rowFor(kind, item));
    }
  }
  return { rows, report, wouldWrite: rows.length, blocking: report.missingIds.length > 0 };
}

// Controlador de sincronización con estado visible. Las dependencias son inyectables para probarlo.
export function createSyncController({
  getAuth = () => null,
  write = writeRows,
  buildRowsFn = buildRows,
  isOnline = () => true,
  onStatus = () => {},
  delayMs = 800,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = () => Date.now(),
} = {}) {
  let status = { state: "local", message: LOCAL_ONLY_MESSAGE, error: "", lastSyncedAt: null };
  let latest = null;
  let version = 0;
  let timer = null;
  let inFlight = null;

  const set = (patch) => {
    status = { ...status, ...patch };
    onStatus(status);
  };

  const schedule = (ms = delayMs) => {
    clearTimer(timer);
    timer = setTimer(run, ms);
  };

  async function run() {
    timer = null;
    if (inFlight) return inFlight;
    const auth = getAuth();
    if (!auth) {
      set({ state: "local", message: LOCAL_ONLY_MESSAGE, error: "" });
      return;
    }
    if (!isOnline()) {
      set({ state: "error", error: "offline", message: "Sin conexión. Los cambios siguen en este navegador y se sincronizarán al recuperarla." });
      return;
    }
    if (!latest) return;

    const pushedVersion = version;
    const snapshot = latest;
    inFlight = (async () => {
      try {
        const { rows } = buildRowsFn(snapshot);
        await write(rows, auth, { mode: "merge" });
        if (pushedVersion === version) {
          set({ state: "synced", error: "", lastSyncedAt: new Date(now()).toISOString(), message: `Sincronizado con la nube (${rows.length} registros).` });
        }
      } catch (error) {
        set({ state: "error", error: error.message || String(error), message: `No se ha sincronizado. ${error.message || "Error desconocido."} Los datos siguen en este navegador.` });
      } finally {
        inFlight = null;
      }
    })();
    await inFlight;
    if (pushedVersion !== version) schedule(0);
  }

  return {
    changed(state) {
      latest = state;
      version += 1;
      set({ state: "pending", message: "Cambios guardados en este navegador. Sincronizando…", error: "" });
      schedule();
    },
    retry() {
      schedule(0);
    },
    status: () => status,
    // Espera a que termine el envío en curso (útil en pruebas).
    idle: () => inFlight || Promise.resolve(),
  };
}
