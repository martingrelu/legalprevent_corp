import { demoData } from "./demoData.js";
import {
  CLIENT_STATUSES,
  LEAD_STATUSES,
  PIPELINE_COLUMNS,
  PLANS,
  PRIORITIES,
  PROPOSAL_STATUSES,
  ROLES,
  TASK_STATUSES,
} from "./models.js";

const STORAGE_KEY = "legalprevent-crm-v1";

const clone = (value) => JSON.parse(JSON.stringify(value));

export function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    const seeded = clone(demoData);
    seeded.meta = {
      seededAt: new Date().toISOString(),
      version: 1,
    };
    saveState(seeded);
    return seeded;
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    console.warn("No se pudo leer el estado local. Se restauran datos demo.", error);
    const seeded = clone(demoData);
    saveState(seeded);
    return seeded;
  }
}

export function saveState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
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

export function resetState() {
  const seeded = clone(demoData);
  seeded.meta = {
    seededAt: new Date().toISOString(),
    version: 1,
  };
  saveState(seeded);
  return seeded;
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
  if (status === "Negociacion") return "Negociacion";
  return PIPELINE_COLUMNS.includes(status) ? status : "Contactado";
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
  if (lead.estimatedMonthlyRevenue >= 590) score += 20;
  if (daysBetween(lead.lastInteractionAt) <= 3) score += 10;
  return Math.min(score, 100);
}

export function dashboardMetrics(state) {
  const totalLeads = state.leads.length;
  const wonLeads = state.leads.filter((lead) => lead.status === "Cliente ganado").length;
  const lostLeads = state.leads.filter((lead) => lead.status === "Perdido").length;
  const demosScheduled = state.leads.filter((lead) => lead.status === "Demo agendada").length;
  const demosDone = state.leads.filter((lead) => lead.status === "Demo realizada").length;
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
    source: sanitizeText(formData.get("source")),
    status: sanitizeText(formData.get("status")),
    priority: sanitizeText(formData.get("priority")),
    nextActionAt: formData.get("nextActionAt") ? new Date(formData.get("nextActionAt")).toISOString() : "",
    nextAction: sanitizeText(formData.get("nextAction")),
    notes: sanitizeText(formData.get("notes")),
    ownerId: sanitizeText(formData.get("ownerId")),
    recommendedPlan: sanitizeText(formData.get("recommendedPlan")),
    estimatedMonthlyRevenue: Number(formData.get("estimatedMonthlyRevenue") || 0),
    riskScore: Number(formData.get("riskScore") || 0),
  };

  validateLead(payload);

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

export function validateLead(lead) {
  if (!lead.companyName || !lead.contactName) throw new Error("Empresa y contacto son obligatorios.");
  if (!isValidEmail(lead.email)) throw new Error("El email del lead no tiene un formato valido.");
  if (!LEAD_STATUSES.includes(lead.status)) throw new Error("Estado de lead no valido.");
  if (!PRIORITIES.includes(lead.priority)) throw new Error("Prioridad no valida.");
  if (!PLANS.includes(lead.recommendedPlan)) throw new Error("Plan recomendado no valido.");
  if (lead.riskScore < 0 || lead.riskScore > 100) throw new Error("El riesgo debe estar entre 0 y 100.");
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

  const priceByPlan = {
    Starter: 290,
    Pro: 590,
    Premium: 990,
    Personalizado: lead.estimatedMonthlyRevenue || 1200,
  };
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
    plan: lead.recommendedPlan,
    monthlyPrice: priceByPlan[lead.recommendedPlan] || lead.estimatedMonthlyRevenue || 590,
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
    const matchesQuery =
      !query ||
      lead.companyName.toLowerCase().includes(query) ||
      lead.contactName.toLowerCase().includes(query) ||
      lead.email.toLowerCase().includes(query);
    const matchesStatus = !filters.status || lead.status === filters.status;
    const matchesSector = !filters.sector || lead.sector === filters.sector;
    const matchesSource = !filters.source || lead.source === filters.source;
    const matchesPriority = !filters.priority || lead.priority === filters.priority;
    const matchesOwner = !filters.ownerId || lead.ownerId === filters.ownerId;
    const matchesPlan = !filters.plan || lead.recommendedPlan === filters.plan;
    return matchesQuery && matchesStatus && matchesSector && matchesSource && matchesPriority && matchesOwner && matchesPlan;
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
