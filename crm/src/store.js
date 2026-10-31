import { demoData } from "./demoData.js?v=20261002-1";
import {
  CLIENT_STATUSES,
  LEAD_SOURCES,
  LEAD_STATUSES,
  LEAD_TYPES,
  LOST_REASONS,
  PIPELINE_COLUMNS,
  PLANS,
  PRIORITIES,
  PROPOSAL_STATUSES,
  ROLES,
  TASK_STATUSES,
} from "./models.js?v=20261002-1";

const STORAGE_KEY = "legalprevent-crm-v1";

const clone = (value) => JSON.parse(JSON.stringify(value));

// Si el estado local no se puede leer o no se puede copiar antes de reemplazarlo,
// la persistencia queda bloqueada: nunca se sobrescribe lo que no se ha conservado.
let persistenceBlocked = "";

const seedDemo = () => {
  const seeded = clone(demoData);
  seeded.meta = { seededAt: new Date().toISOString(), version: 1 };
  return seeded;
};

const defaultStorage = () => {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
};

// Copia el contenido bruto en una clave aparte antes de cualquier reemplazo.
// Devuelve la clave de la copia o null si no se pudo escribir.
export function backupRawState(storage, raw, reason) {
  if (!storage || typeof raw !== "string") return null;
  const key = `${STORAGE_KEY}-${reason}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try {
    storage.setItem(key, raw);
    return key;
  } catch {
    return null;
  }
}

export function loadState(storage = defaultStorage()) {
  let raw = null;
  try {
    raw = storage ? storage.getItem(STORAGE_KEY) : null;
  } catch (error) {
    persistenceBlocked = "No se puede acceder al almacenamiento local del navegador.";
    console.warn(persistenceBlocked, error);
    return seedDemo();
  }

  if (!raw) {
    const seeded = seedDemo();
    saveState(seeded, storage);
    return seeded;
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    const copyKey = backupRawState(storage, raw, "corrupto");
    if (!copyKey) {
      persistenceBlocked = "El estado local está dañado y no se ha podido copiar. No se sobrescribe.";
      console.warn(persistenceBlocked, error);
      return seedDemo();
    }
    console.warn(`Estado local ilegible. Copia conservada en ${copyKey}. Se cargan datos demo.`, error);
    const seeded = seedDemo();
    saveState(seeded, storage);
    return seeded;
  }
}

export function isPersistenceBlocked() {
  return persistenceBlocked;
}

// Oyentes: la sincronización con la nube y los avisos visibles se conectan aquí,
// así que cada guardado local pasa por el mismo punto.
let savedListener = null;
let saveErrorListener = null;
export function onStateSaved(listener) { savedListener = listener; }
export function onStateSaveError(listener) { saveErrorListener = listener; }

export function saveState(state, storage = defaultStorage()) {
  try {
    if (persistenceBlocked) {
      throw new Error(`Guardado bloqueado: ${persistenceBlocked}`);
    }
    if (!storage) throw new Error("No hay almacenamiento local disponible.");
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    saveErrorListener?.(error);
    throw error;
  }
  savedListener?.(state);
}

export function createBackup(state) {
  return {
    app: "LegalPrevent CRM",
    storageKey: STORAGE_KEY,
    exportedAt: new Date().toISOString(),
    schemaVersion: 1,
    data: clone(state),
  };
}

export function importBackup(backup) {
  const nextState = backup?.data || backup;
  validateBackupState(nextState);
  saveState(nextState);
  return nextState;
}

// Restaurar demo sustituye todo el estado local. Antes se guarda una copia del
// contenido actual; si la copia falla, la operación se cancela.
export function resetState(storage = defaultStorage()) {
  let currentRaw = null;
  try {
    currentRaw = storage ? storage.getItem(STORAGE_KEY) : null;
  } catch (error) {
    throw new Error("No se puede leer el estado actual; restauración cancelada.");
  }
  if (currentRaw) {
    const copyKey = backupRawState(storage, currentRaw, "antes-restaurar-demo");
    if (!copyKey) throw new Error("No se pudo crear la copia previa; restauración cancelada.");
  }
  persistenceBlocked = "";
  const seeded = seedDemo();
  saveState(seeded, storage);
  return seeded;
}

// ---- Eliminación segura de datos demo ----
// Un registro es demo solo si su id existe en demoData y no tiene vínculo real
// (Supabase o Stripe). Cualquier alta hecha a mano se considera real.
const DEMO_COLLECTIONS = ["leads", "clients", "tasks", "interactions", "proposals", "documents", "payments", "notes", "activityLog"];

export function demoRecordIds(source = demoData) {
  const ids = new Set();
  for (const key of DEMO_COLLECTIONS) {
    for (const item of source[key] || []) if (item?.id) ids.add(item.id);
  }
  return ids;
}

export function hasRealLink(record) {
  return Boolean(
    record?.dataOrigin === "supabase" || record?.externalSource === "supabase" || record?.supabaseId ||
    record?.dataOrigin === "stripe" || record?.stripeCustomerId || record?.stripeSubscriptionId
  );
}

export function isDemoRecord(record, demoIds = demoRecordIds()) {
  if (!record) return false;
  if (hasRealLink(record)) return false;
  if (record.isDemo === true) return true;
  return demoIds.has(record.id);
}

// Devuelve el estado sin registros demo y con sus dependientes. Un elemento
// dependiente se elimina solo si TODOS sus padres han sido eliminados, así que
// los registros reales y los huérfanos desconocidos se conservan.
export function removeDemoRecords(state) {
  const demoIds = demoRecordIds();
  const isDemo = (record) => isDemoRecord(record, demoIds);
  const removed = new Set();
  const removedCounts = {};
  const keepUnless = (list, parentsOf, key) => {
    const kept = [];
    let count = 0;
    for (const item of list || []) {
      const parents = parentsOf(item);
      const allParentsGone = parents.length > 0 && parents.every((ref) => removed.has(ref));
      if (allParentsGone) {
        count += 1;
      } else {
        kept.push(item);
      }
    }
    removedCounts[key] = count;
    return kept;
  };

  const demoLeads = (state.leads || []).filter(isDemo);
  const demoClients = (state.clients || []).filter(isDemo);
  for (const lead of demoLeads) removed.add(`lead:${lead.id}`);
  for (const client of demoClients) removed.add(`client:${client.id}`);

  const next = { ...state };
  next.leads = (state.leads || []).filter((lead) => !isDemo(lead));
  next.clients = (state.clients || []).filter((client) => !isDemo(client));
  removedCounts.leads = demoLeads.length;
  removedCounts.clients = demoClients.length;

  const relatedRef = (item, typeField, idField) => (item[typeField] && item[idField] ? [`${item[typeField]}:${item[idField]}`] : []);
  next.tasks = keepUnless(state.tasks, (t) => relatedRef(t, "relatedType", "relatedId"), "tasks");
  next.interactions = keepUnless(state.interactions, (i) => relatedRef(i, "relatedType", "relatedId"), "interactions");
  next.documents = keepUnless(state.documents, (d) => relatedRef(d, "relatedType", "relatedId"), "documents");
  next.activityLog = keepUnless(state.activityLog, (a) => relatedRef(a, "entityType", "entityId"), "activityLog");
  next.payments = keepUnless(state.payments, (p) => (p.clientId ? [`client:${p.clientId}`] : []), "payments");
  next.proposals = keepUnless(
    state.proposals,
    (p) => [p.relatedLeadId && `lead:${p.relatedLeadId}`, p.relatedClientId && `client:${p.relatedClientId}`].filter(Boolean),
    "proposals",
  );
  next.alerts = [];
  return { state: next, removed: removedCounts };
}

// Copia el estado actual antes de borrar datos demo. Si la copia falla, no se borra nada.
export function clearDemoRecordsSafely(state, storage = defaultStorage()) {
  const raw = JSON.stringify(state);
  const copyKey = backupRawState(storage, raw, "antes-eliminar-demo");
  if (!copyKey) throw new Error("No se pudo crear la copia previa; eliminación cancelada.");
  const result = removeDemoRecords(state);
  saveState(result.state, storage);
  return { ...result, backupKey: copyKey };
}

function validateBackupState(nextState) {
  const requiredCollections = ["users", "leads", "clients", "tasks", "interactions", "proposals", "documents", "payments", "activityLog"];
  if (!nextState || typeof nextState !== "object") {
    throw new Error("La copia no tiene un formato valido.");
  }

  requiredCollections.forEach((key) => {
    if (!Array.isArray(nextState[key])) {
      throw new Error(`La copia no incluye la seccion obligatoria: ${key}.`);
    }
  });

  if (!nextState.currentUserId) {
    throw new Error("La copia no incluye el usuario actual del CRM.");
  }
}

export function createId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function getCurrentUser(state) {
  return state.users.find((user) => user.id === state.currentUserId) || state.users[0];
}

export function canAccess(state, permission) {
  const user = getCurrentUser(state);
  const role = ROLES[user.role];
  return Boolean(role?.permissions.includes(permission));
}

export function sanitizeText(value) {
  return String(value ?? "")
    .replace(/[<>]/g, "")
    .trim();
}

export function sanitizeEmail(value) {
  return sanitizeText(value).toLowerCase();
}

export function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function formatDate(value, mode = "short") {
  if (!value) return "Sin fecha";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Sin fecha";

  return new Intl.DateTimeFormat("es-ES", {
    day: "2-digit",
    month: mode === "short" ? "short" : "long",
    year: "numeric",
  }).format(date);
}

// Fecha y hora de recepción en horario de España (cambia solo con el horario de verano).
// Sin fecha fiable devuelve "Fecha no disponible": nunca sustituye por la fecha actual.
export function formatReceivedAt(value) {
  if (!value) return "Fecha no disponible";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Fecha no disponible";

  const parts = new Intl.DateTimeFormat("es-ES", {
    timeZone: "Europe/Madrid",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type) => parts.find((p) => p.type === type)?.value || "";
  return `${part("day")}/${part("month")}/${part("year")} · ${part("hour")}:${part("minute")}`;
}

export function formatDateTime(value) {
  if (!value) return "Sin fecha";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Sin fecha";

  return new Intl.DateTimeFormat("es-ES", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatCurrency(value) {
  return new Intl.NumberFormat("es-ES", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(Number(value || 0));
}

export function daysBetween(dateA, dateB = new Date()) {
  const a = new Date(dateA);
  const b = new Date(dateB);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
  return Math.floor((b - a) / (1000 * 60 * 60 * 24));
}

export function isOverdue(dateValue) {
  if (!dateValue) return false;
  const due = new Date(dateValue);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  due.setHours(0, 0, 0, 0);
  return due < today;
}

// Estado de la próxima acción de un lead abierto: "empty" (sin acción),
// "overdue" (fecha y hora ya pasadas) o "scheduled". Los leads cerrados
// (ganados o perdidos) devuelven "closed" y no se resaltan.
export function nextActionState(lead, now = new Date()) {
  if (["Cliente ganado", "Perdido"].includes(lead.status)) return "closed";
  if (!lead.nextActionAt) return "empty";
  const due = new Date(lead.nextActionAt);
  if (Number.isNaN(due.getTime())) return "empty";
  return due < now ? "overdue" : "scheduled";
}

function toIsoOrEmpty(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

export function applyAutomations(state) {
  const next = clone(state);
  const now = new Date().toISOString();
  const systemUser = getCurrentUser(next)?.id || "u-1";
  let changed = false;

  next.tasks = next.tasks.map((task) => {
    if (task.status !== "Completada" && isOverdue(task.dueDate) && task.status !== "Vencida") {
      changed = true;
      next.activityLog.push({
        id: createId("log"),
        entityType: "task",
        entityId: task.id,
        action: "task_overdue",
        detail: `Tarea marcada como vencida: ${task.title}`,
        createdAt: now,
        createdBy: systemUser,
      });
      return { ...task, status: "Vencida" };
    }
    return task;
  });

  next.alerts = buildAlerts(next);
  if (changed) saveState(next);
  return next;
}

export function buildAlerts(state) {
  const alerts = [];
  const activeLeads = state.leads.filter((lead) => !["Cliente ganado", "Perdido"].includes(lead.status));

  activeLeads.forEach((lead) => {
    if (daysBetween(lead.lastInteractionAt) > 7) {
      alerts.push({
        id: `stale-${lead.id}`,
        severity: "warning",
        title: "Lead sin seguimiento",
        message: `${lead.companyName} lleva mas de 7 dias sin interaccion.`,
        entityType: "lead",
        entityId: lead.id,
      });
    }

    const hasSentProposal = state.proposals.some(
      (proposal) => proposal.relatedLeadId === lead.id && ["Enviada", "Aceptada"].includes(proposal.status),
    );
    if (lead.status === "Demo realizada" && !hasSentProposal) {
      alerts.push({
        id: `demo-no-proposal-${lead.id}`,
        severity: "danger",
        title: "Demo sin propuesta",
        message: `${lead.companyName} ya tuvo demo y necesita propuesta.`,
        entityType: "lead",
        entityId: lead.id,
      });
    }
  });

  state.clients.forEach((client) => {
    if (client.plan === "Premium" && client.legalReviewPending) {
      alerts.push({
        id: `premium-review-${client.id}`,
        severity: "warning",
        title: "Revision legal pendiente",
        message: `${client.businessName} es Premium y tiene revision pendiente.`,
        entityType: "client",
        entityId: client.id,
      });
    }
  });

  state.payments
    .filter((payment) => payment.status !== "paid")
    .forEach((payment) => {
      const client = state.clients.find((item) => item.id === payment.clientId);
      if (client) {
        alerts.push({
          id: `payment-${payment.id}`,
          severity: payment.status === "failed" ? "danger" : "warning",
          title: "Pago pendiente",
          message: `${client.businessName} tiene ${formatCurrency(payment.amount)} pendiente.`,
          entityType: "client",
          entityId: client.id,
        });
      }
    });

  return alerts;
}

export function getEntityName(state, relatedType, relatedId) {
  if (relatedType === "lead") {
    return state.leads.find((lead) => lead.id === relatedId)?.companyName || "Lead no encontrado";
  }

  return state.clients.find((client) => client.id === relatedId)?.businessName || "Cliente no encontrado";
}

export function mapLeadStatusToPipeline(status) {
  if (status === "Cliente ganado") return "Ganado";
  // Un estado desconocido queda en "Nuevo" para que se revise, no se oculta en otra fase.
  return PIPELINE_COLUMNS.includes(status) ? status : "Nuevo";
}

export function mapPipelineToLeadStatus(column) {
  if (column === "Ganado") return "Cliente ganado";
  if (column === "Perdido") return "Perdido";
  return column;
}

export function leadScore(lead) {
  let score = 0;
  if (lead.priority === "Alta") score += 30;
  if (lead.priority === "Media") score += 15;
  if (["Demo agendada", "Demo realizada", "Propuesta enviada", "Negociacion"].includes(lead.status)) score += 30;
  if (lead.riskScore >= 75) score += 20;
  if (lead.revenueConfirmed === true && lead.estimatedMonthlyRevenue >= 149) score += 20;
  if (daysBetween(lead.lastInteractionAt) <= 3) score += 10;
  return Math.min(score, 100);
}

export function dashboardMetrics(state) {
  const totalLeads = state.leads.length;
  const wonLeads = state.leads.filter((lead) => lead.status === "Cliente ganado").length;
  const lostLeads = state.leads.filter((lead) => lead.status === "Perdido").length;
  const demosScheduled = state.leads.filter((lead) => lead.status === "Demo agendada").length;
  const demosDone = state.leads.filter((lead) => lead.status === "Demo realizada").length;
  // Solicitudes de demostración hechas desde la web tras el diagnóstico que
  // aún no se han cerrado ni atendido con una demo.
  const demosRequested = state.leads.filter(
    (lead) => lead.demoRequestedAt && !["Demo agendada", "Demo realizada", "Cliente ganado", "Perdido"].includes(lead.status)
  ).length;
  const newLeads = state.leads.filter((lead) => daysBetween(lead.createdAt) <= 7).length;
  const activeClients = state.clients.filter((client) => client.status === "Activo").length;
  const monthlyRevenue = state.clients
    .filter((client) => client.status !== "Cancelado")
    .reduce((sum, client) => sum + Number(client.monthlyPrice || 0), 0);
  const conversionRate = totalLeads ? Math.round((wonLeads / totalLeads) * 100) : 0;

  return {
    totalLeads,
    newLeads,
    demosScheduled,
    demosDone,
    demosRequested,
    activeClients,
    lostLeads,
    monthlyRevenue,
    conversionRate,
  };
}

export function trendData(state) {
  const labels = ["Hace 5 sem.", "Hace 4 sem.", "Hace 3 sem.", "Hace 2 sem.", "Semana pasada", "Esta semana"];
  const created = [2, 3, 4, 5, 7, state.leads.filter((lead) => daysBetween(lead.createdAt) <= 7).length];
  const won = [0, 1, 1, 2, 3, state.leads.filter((lead) => lead.status === "Cliente ganado").length];
  return labels.map((label, index) => ({ label, created: created[index], won: won[index] }));
}

export function updateLeadStatus(state, leadId, nextStatus) {
  if (!LEAD_STATUSES.includes(nextStatus)) return state;
  const next = clone(state);
  const user = getCurrentUser(next);
  const lead = next.leads.find((item) => item.id === leadId);
  if (!lead || lead.status === nextStatus) return state;

  validateDemoAppointment({ ...lead, status: nextStatus });
  const previous = lead.status;
  lead.status = nextStatus;
  lead.lastInteractionAt = new Date().toISOString();
  if (nextStatus === "Cliente ganado" && !lead.convertedClientId) {
    convertLeadToClient(next, leadId, { skipSave: true });
  }

  next.interactions.push({
    id: createId("int"),
    type: "Cambio de estado",
    relatedType: "lead",
    relatedId: leadId,
    date: new Date().toISOString(),
    description: `Estado actualizado de ${previous} a ${nextStatus}.`,
    createdBy: user.id,
  });
  logActivity(next, "lead", leadId, "status_update", `Estado actualizado de ${previous} a ${nextStatus}.`);
  saveState(next);
  return applyAutomations(next);
}

// Origen del lead en Supabase: "crm_manual" si se creó en el CRM, "web" si llegó
// desde la web (landing, diagnóstico...). Los leads solo locales no tienen origen.
// Convierte una fila de public.leads (Supabase) en un lead del CRM.
export function leadFromSupabaseRow(row, { existingId = "", defaultOwnerId = "", now = new Date().toISOString() } = {}) {
  // Las claves del CRM conviven con el payload original del lead (merge),
  // así que se leen sea cual sea su origen.
  const crmPayload = row.payload || {};
  return {
    id: existingId || `lead-${row.id}`,
    supabaseId: row.id,
    dataOrigin: "supabase",
    externalSource: "supabase",
    companyName: row.company_name || `Lead web - ${row.email}`,
    contactName: row.contact_name || row.company_name || "Pendiente de completar",
    email: row.email || "",
    phone: row.phone || "",
    sector: row.sector || "Pendiente",
    employees: row.employees || "",
    city: crmPayload.city || "",
    source: row.source || "Web",
    leadOrigin: leadOriginFromRow(row),
    status: row.status || "Nuevo",
    priority: row.priority || "Media",
    createdAt: row.created_at || now,
    // Fecha de recepción original: solo la fecha guardada en la nube. No se sustituye por la actual.
    receivedAt: row.created_at || null,
    lastInteractionAt: row.created_at || now,
    leadType: row.lead_type || "",
    zone: row.zone || "",
    demoAt: row.demo_at || "",
    // Solicitud de demo desde el diagnóstico o la portada, sin confirmar cita.
    demoRequestedAt: row.demo_requested_at || (row.source === "demo_requested" ? row.created_at || "" : ""),
    lostReason: row.lost_reason || "",
    // La columna manda; payload.nextActionAt es el dato antiguo. Sin fecha = "Sin acción".
    nextActionAt: row.next_action_at || crmPayload.nextActionAt || "",
    nextAction: crmPayload.nextAction || "Contactar lead captado desde la web.",
    notes: crmPayload.notes || `Lead sincronizado desde Supabase. Origen: ${row.source || "web"}.`,
    ownerId: crmPayload.ownerId || defaultOwnerId,
    recommendedPlan: row.recommended_plan || "",
    estimatedMonthlyRevenue: Number(crmPayload.estimatedMonthlyRevenue || 0),
    revenueConfirmed: Boolean(crmPayload.revenueConfirmed),
    riskScore: row.risk_score ?? null,
    convertedClientId: "",
    // Consentimiento (solo lectura en el CRM: lo registra el servidor). Si la
    // base aún no tiene estas columnas, no se muestran en la ficha.
    consentTracked: "privacy_accepted_at" in row,
    privacyAcceptedAt: row.privacy_accepted_at || "",
    privacyPolicyVersion: row.privacy_policy_version || "",
    commercialConsent: row.commercial_consent === true,
    commercialConsentAt: row.commercial_consent_at || "",
    commercialConsentVersion: row.commercial_consent_version || "",
    commercialConsentWithdrawnAt: row.commercial_consent_withdrawn_at || "",
    privacyReviewRequired: row.privacy_review_required === true,
  };
}

// Quita del estado local un lead suprimido (y cualquier otro lead con el mismo
// email) junto con lo que cuelga de él. Devuelve un estado nuevo.
export function removeLeadAndRelated(state, leadId) {
  const target = state.leads.find((lead) => lead.id === leadId);
  const email = String(target?.email || "").toLowerCase();
  const removed = new Set(
    state.leads.filter((lead) => lead.id === leadId || (email && String(lead.email || "").toLowerCase() === email)).map((lead) => lead.id)
  );
  const keep = (item) => !(item.relatedType === "lead" && removed.has(item.relatedId));
  return {
    ...state,
    leads: state.leads.filter((lead) => !removed.has(lead.id)),
    tasks: (state.tasks || []).filter(keep),
    interactions: (state.interactions || []).filter(keep),
    documents: (state.documents || []).filter(keep),
    notes: (state.notes || []).filter(keep),
    proposals: (state.proposals || []).filter((proposal) => !removed.has(proposal.relatedLeadId)),
  };
}

export function leadOriginFromRow(row) {
  return row?.payload?.origin === "crm_manual" || row?.stage === "crm_manual" ? "crm_manual" : "web";
}

// La fuente de un lead web es su canal de entrada: no se edita desde el CRM.
export function isSourceLocked(lead) {
  return lead?.leadOrigin === "web";
}

// Opciones de fuente: las del catálogo más cualquier valor real presente en los leads.
export function leadSourceOptions(state, current = "") {
  const extra = state.leads.map((lead) => lead.source).concat(current)
    .filter((value) => value && !LEAD_SOURCES.includes(value));
  return [...LEAD_SOURCES, ...[...new Set(extra)].sort((a, b) => a.localeCompare(b, "es"))];
}

export function upsertLead(state, formData, id = "") {
  const next = clone(state);
  const current = id ? next.leads.find((lead) => lead.id === id) : null;
  const payload = {
    companyName: sanitizeText(formData.get("companyName")),
    contactName: sanitizeText(formData.get("contactName")),
    email: sanitizeEmail(formData.get("email")),
    phone: sanitizeText(formData.get("phone")),
    sector: sanitizeText(formData.get("sector")),
    employees: Number(formData.get("employees") || 0),
    city: sanitizeText(formData.get("city")),
    source: isSourceLocked(current) || !formData.has("source") ? current?.source || "" : sanitizeText(formData.get("source")),
    status: sanitizeText(formData.get("status")),
    priority: sanitizeText(formData.get("priority")),
    nextActionAt: toIsoOrEmpty(formData.get("nextActionAt")),
    nextAction: sanitizeText(formData.get("nextAction")),
    notes: sanitizeText(formData.get("notes")),
    ownerId: sanitizeText(formData.get("ownerId")),
    recommendedPlan: sanitizeText(formData.get("recommendedPlan")),
    estimatedMonthlyRevenue: Number(formData.get("estimatedMonthlyRevenue") || 0),
    revenueConfirmed: Number(formData.get("estimatedMonthlyRevenue") || 0) > 0,
    riskScore: formData.get("riskScore") === "" || formData.get("riskScore") == null ? null : Number(formData.get("riskScore")),
  };

  // Campos de embudo: si el formulario no los trae (p. ej. importación CSV)
  // se conserva el valor actual en lugar de vaciarlo.
  const funnelFields = {
    leadType: (value) => sanitizeText(value),
    zone: (value) => sanitizeText(value),
    demoAt: (value) => toIsoOrEmpty(value),
    lostReason: (value) => sanitizeText(value),
  };
  Object.entries(funnelFields).forEach(([key, parse]) => {
    payload[key] = formData.has(key) ? parse(formData.get(key)) : current?.[key] || "";
  });

  validateLead(payload);

  const duplicate = next.leads.find(
    (lead) => lead.id !== id && String(lead.email || "").toLowerCase() === payload.email,
  );
  if (duplicate) {
    throw new Error(`Ya existe un lead con el email ${payload.email}. Abre su ficha para actualizarlo.`);
  }

  if (current) {
    Object.assign(current, payload, { lastInteractionAt: new Date().toISOString() });
    logActivity(next, "lead", current.id, "update", "Lead actualizado.");
  } else {
    next.leads.unshift({
      id: createId("lead"),
      ...payload,
      createdAt: new Date().toISOString(),
      lastInteractionAt: new Date().toISOString(),
    });
    logActivity(next, "lead", next.leads[0].id, "create", "Lead creado.");
  }

  saveState(next);
  return applyAutomations(next);
}

function validateDemoAppointment(lead) {
  if (lead.status === "Demo agendada" && (!lead.demoAt || !Number.isFinite(Date.parse(lead.demoAt)))) throw new Error("Confirma la fecha y hora de la cita antes de marcar Demo agendada.");
}

export function validateLead(lead) {
  if (!lead.companyName || !lead.contactName) throw new Error("Empresa y contacto son obligatorios.");
  if (!isValidEmail(lead.email)) throw new Error("El email del lead no tiene un formato valido.");
  if (!LEAD_STATUSES.includes(lead.status)) throw new Error("Estado de lead no valido.");
  validateDemoAppointment(lead);
  if (!PRIORITIES.includes(lead.priority)) throw new Error("Prioridad no valida.");
  if (lead.recommendedPlan && !PLANS.includes(lead.recommendedPlan)) throw new Error("Plan recomendado no valido.");
  if (lead.leadType && !LEAD_TYPES.some(([value]) => value === lead.leadType)) throw new Error("Tipo de lead no valido.");
  if (lead.lostReason && !LOST_REASONS.some(([value]) => value === lead.lostReason)) throw new Error("Motivo de perdida no valido.");
  if (lead.riskScore != null && (!Number.isFinite(lead.riskScore) || lead.riskScore < 0 || lead.riskScore > 100)) throw new Error("El riesgo debe estar entre 0 y 100.");
}

export function upsertTask(state, formData, id = "") {
  const next = clone(state);
  const current = id ? next.tasks.find((task) => task.id === id) : null;
  const payload = {
    title: sanitizeText(formData.get("title")),
    description: sanitizeText(formData.get("description")),
    relatedType: sanitizeText(formData.get("relatedType")),
    relatedId: sanitizeText(formData.get("relatedId")),
    dueDate: formData.get("dueDate") ? new Date(formData.get("dueDate")).toISOString() : "",
    priority: sanitizeText(formData.get("priority")),
    status: sanitizeText(formData.get("status")),
    ownerId: sanitizeText(formData.get("ownerId")),
  };

  validateTask(payload);

  if (current) {
    Object.assign(current, payload);
    logActivity(next, "task", current.id, "update", "Tarea actualizada.");
  } else {
    next.tasks.unshift({ id: createId("task"), ...payload });
    logActivity(next, "task", next.tasks[0].id, "create", "Tarea creada.");
  }

  saveState(next);
  return applyAutomations(next);
}

export function validateTask(task) {
  if (!task.title) throw new Error("El titulo de la tarea es obligatorio.");
  if (!["lead", "client"].includes(task.relatedType)) throw new Error("Relacion de tarea no valida.");
  if (!task.relatedId) throw new Error("Selecciona lead o cliente relacionado.");
  if (!task.dueDate) throw new Error("La fecha limite es obligatoria.");
  if (!PRIORITIES.includes(task.priority)) throw new Error("Prioridad no valida.");
  if (!TASK_STATUSES.includes(task.status)) throw new Error("Estado de tarea no valido.");
}

export function upsertProposal(state, formData, id = "") {
  const next = clone(state);
  const current = id ? next.proposals.find((proposal) => proposal.id === id) : null;
  const relatedType = sanitizeText(formData.get("relatedType"));
  const relatedId = sanitizeText(formData.get("relatedId"));
  const status = sanitizeText(formData.get("status"));
  const payload = {
    relatedLeadId: relatedType === "lead" ? relatedId : "",
    relatedClientId: relatedType === "client" ? relatedId : "",
    plan: sanitizeText(formData.get("plan")),
    price: Number(formData.get("price") || 0),
    discount: Number(formData.get("discount") || 0),
    status,
    sentAt: formData.get("sentAt") ? new Date(formData.get("sentAt")).toISOString() : "",
    expiresAt: formData.get("expiresAt") ? new Date(formData.get("expiresAt")).toISOString() : "",
    notes: sanitizeText(formData.get("notes")),
    ownerId: sanitizeText(formData.get("ownerId")),
  };

  validateProposal(payload);

  if (current) {
    Object.assign(current, payload);
    logActivity(next, "proposal", current.id, "update", "Propuesta actualizada.");
  } else {
    next.proposals.unshift({ id: createId("prop"), ...payload });
    logActivity(next, "proposal", next.proposals[0].id, "create", "Propuesta creada.");
  }

  if (status === "Aceptada" && payload.relatedLeadId) {
    const lead = next.leads.find((item) => item.id === payload.relatedLeadId);
    if (lead) lead.status = "Cliente ganado";
    convertLeadToClient(next, payload.relatedLeadId, { skipSave: true });
  }

  saveState(next);
  return applyAutomations(next);
}

export function validateProposal(proposal) {
  if (!proposal.relatedLeadId && !proposal.relatedClientId) throw new Error("Selecciona lead o cliente.");
  if (!PLANS.includes(proposal.plan)) throw new Error("Plan no valido.");
  if (!PROPOSAL_STATUSES.includes(proposal.status)) throw new Error("Estado de propuesta no valido.");
  if (proposal.price < 0) throw new Error("El precio no puede ser negativo.");
  if (proposal.discount < 0 || proposal.discount > 100) throw new Error("El descuento debe estar entre 0 y 100.");
  if (!proposal.expiresAt) throw new Error("La fecha de caducidad es obligatoria.");
}

export function addInteraction(state, formData) {
  const next = clone(state);
  const payload = {
    id: createId("int"),
    type: sanitizeText(formData.get("type")),
    relatedType: sanitizeText(formData.get("relatedType")),
    relatedId: sanitizeText(formData.get("relatedId")),
    date: formData.get("date") ? new Date(formData.get("date")).toISOString() : new Date().toISOString(),
    description: sanitizeText(formData.get("description")),
    createdBy: getCurrentUser(next).id,
  };

  if (!payload.description) throw new Error("La descripcion es obligatoria.");
  next.interactions.unshift(payload);

  if (payload.relatedType === "lead") {
    const lead = next.leads.find((item) => item.id === payload.relatedId);
    if (lead) lead.lastInteractionAt = payload.date;
  }

  logActivity(next, payload.relatedType, payload.relatedId, "interaction_create", `Interaccion registrada: ${payload.type}.`);
  saveState(next);
  return applyAutomations(next);
}

export function convertLeadToClient(state, leadId, options = {}) {
  const next = options.skipSave ? state : clone(state);
  const lead = next.leads.find((item) => item.id === leadId);
  if (!lead) return state;
  if (lead.convertedClientId && next.clients.some((client) => client.id === lead.convertedClientId)) return next;

  const id = createId("client");
  const signup = new Date();
  const renewal = new Date();
  renewal.setFullYear(renewal.getFullYear() + 1);

  next.clients.unshift({
    id,
    leadId,
    businessName: `${lead.companyName}${lead.companyName.endsWith("SL") ? "" : " SL"}`,
    taxId: "",
    address: lead.city,
    primaryContact: lead.contactName,
    billingEmail: lead.email,
    plan: lead.recommendedPlan || "Personalizado",
    monthlyPrice: lead.revenueConfirmed === true ? Number(lead.estimatedMonthlyRevenue || 0) : 0,
    signupDate: signup.toISOString(),
    renewalDate: renewal.toISOString(),
    status: "Activo",
    legalReviewPending: lead.recommendedPlan === "Premium",
    ownerId: lead.ownerId,
  });

  lead.status = "Cliente ganado";
  lead.convertedClientId = id;
  lead.lastInteractionAt = new Date().toISOString();
  next.interactions.unshift({
    id: createId("int"),
    type: "Cambio de estado",
    relatedType: "lead",
    relatedId: lead.id,
    date: new Date().toISOString(),
    description: "Lead convertido en cliente.",
    createdBy: getCurrentUser(next).id,
  });
  logActivity(next, "lead", lead.id, "convert", "Lead convertido en cliente.");

  if (!options.skipSave) {
    saveState(next);
    return applyAutomations(next);
  }
  return next;
}

export function updateClient(state, formData, id) {
  const next = clone(state);
  const client = next.clients.find((item) => item.id === id);
  if (!client) return state;

  const payload = {
    businessName: sanitizeText(formData.get("businessName")),
    taxId: sanitizeText(formData.get("taxId")),
    address: sanitizeText(formData.get("address")),
    primaryContact: sanitizeText(formData.get("primaryContact")),
    billingEmail: sanitizeEmail(formData.get("billingEmail")),
    plan: sanitizeText(formData.get("plan")),
    monthlyPrice: Number(formData.get("monthlyPrice") || 0),
    renewalDate: formData.get("renewalDate") ? new Date(formData.get("renewalDate")).toISOString() : "",
    status: sanitizeText(formData.get("status")),
    legalReviewPending: formData.get("legalReviewPending") === "on",
    ownerId: sanitizeText(formData.get("ownerId")),
  };

  if (!payload.businessName || !isValidEmail(payload.billingEmail)) {
    throw new Error("Razon social y email de facturacion valido son obligatorios.");
  }
  if (!PLANS.includes(payload.plan) || !CLIENT_STATUSES.includes(payload.status)) {
    throw new Error("Plan o estado de cliente no valido.");
  }

  Object.assign(client, payload);
  logActivity(next, "client", client.id, "update", "Cliente actualizado.");
  saveState(next);
  return applyAutomations(next);
}

export function logActivity(state, entityType, entityId, action, detail) {
  state.activityLog.unshift({
    id: createId("log"),
    entityType,
    entityId,
    action,
    detail,
    createdAt: new Date().toISOString(),
    createdBy: getCurrentUser(state).id,
  });
}

export function filteredLeads(state, filters) {
  return state.leads.filter((lead) => {
    const query = filters.query?.toLowerCase() || "";
    const isReal = !isDemoRecord(lead);
    const matchesQuery =
      !query ||
      lead.companyName.toLowerCase().includes(query) ||
      lead.contactName.toLowerCase().includes(query) ||
      lead.email.toLowerCase().includes(query);
    const matchesOrigin =
      !filters.origin ||
      (filters.origin === "real" && isReal) ||
      (filters.origin === "demo" && !isReal);
    const matchesStatus = !filters.status || lead.status === filters.status;
    const matchesSector = !filters.sector || lead.sector === filters.sector;
    const matchesSource = !filters.source || lead.source === filters.source;
    const matchesPriority = !filters.priority || lead.priority === filters.priority;
    const matchesOwner = !filters.ownerId || lead.ownerId === filters.ownerId;
    const matchesPlan = !filters.plan || lead.recommendedPlan === filters.plan;
    const matchesDemoRequest = !filters.demoRequested || Boolean(lead.demoRequestedAt);
    const matchesPrivacyReview = !filters.privacyReview || lead.privacyReviewRequired === true;
    return matchesQuery && matchesOrigin && matchesStatus && matchesSector && matchesSource && matchesPriority && matchesOwner && matchesPlan && matchesDemoRequest && matchesPrivacyReview;
  });
}

export function filteredClients(state, filters) {
  return state.clients.filter((client) => {
    const query = filters.query?.toLowerCase() || "";
    const matchesQuery =
      !query ||
      client.businessName.toLowerCase().includes(query) ||
      client.primaryContact.toLowerCase().includes(query) ||
      client.billingEmail.toLowerCase().includes(query) ||
      client.taxId.toLowerCase().includes(query);
    const matchesStatus = !filters.status || client.status === filters.status;
    const matchesPlan = !filters.plan || client.plan === filters.plan;
    const matchesOwner = !filters.ownerId || client.ownerId === filters.ownerId;
    return matchesQuery && matchesStatus && matchesPlan && matchesOwner;
  });
}

// Estados que Supabase devuelve cuando la retirada queda confirmada en la nube.
export const CONSENT_WITHDRAWAL_CONFIRMED = new Set(["withdrawn", "not_consented"]);

// Retirada local tras confirmación remota. Solo puede dejar el consentimiento en "retirado":
// nunca lo restaura, y si el lead ya estaba retirado no cambia la fecha original.
export function withdrawConsentLocally(state, leadId, at = new Date().toISOString()) {
  return {
    ...state,
    leads: state.leads.map((lead) =>
      lead.id === leadId
        ? { ...lead, commercialConsent: false, commercialConsentWithdrawnAt: lead.commercialConsentWithdrawnAt || at }
        : lead,
    ),
  };
}
