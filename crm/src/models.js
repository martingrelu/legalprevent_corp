export const LEAD_STATUSES = [
  "Nuevo",
  "Contactado",
  "Interesado",
  "Demo agendada",
  "Demo realizada",
  "Propuesta enviada",
  "Negociacion",
  "Cliente ganado",
  "Perdido",
];

export const PIPELINE_COLUMNS = [
  "Nuevo",
  "Contactado",
  "Demo agendada",
  "Propuesta enviada",
  "Negociacion",
  "Ganado",
  "Perdido",
];

export const LEAD_SOURCES = [
  "LinkedIn",
  "WhatsApp",
  "Web",
  "Referido",
  "Campana",
  "Evento",
  "Otro",
];

export const PRIORITIES = ["Baja", "Media", "Alta"];
export const PLANS = ["Starter", "Pro", "Premium", "Personalizado"];
export const CLIENT_STATUSES = ["Activo", "Pendiente de pago", "En revision", "Cancelado"];
export const TASK_STATUSES = ["Pendiente", "En curso", "Completada", "Vencida"];
export const INTERACTION_TYPES = [
  "Llamada",
  "Email",
  "WhatsApp",
  "Reunion",
  "Demo",
  "Nota manual",
  "Propuesta enviada",
  "Cambio de estado",
];
export const PROPOSAL_STATUSES = ["Borrador", "Enviada", "Aceptada", "Rechazada"];

export const ROLES = {
  admin: {
    id: "admin",
    name: "Administrador",
    permissions: ["dashboard", "leads", "clients", "tasks", "interactions", "proposals", "settings"],
  },
  sales: {
    id: "sales",
    name: "Comercial",
    permissions: ["dashboard", "leads", "tasks", "interactions", "proposals"],
  },
  lawyer: {
    id: "lawyer",
    name: "Abogado/Revisor",
    permissions: ["dashboard", "clients", "interactions", "tasks"],
  },
  support: {
    id: "support",
    name: "Soporte",
    permissions: ["dashboard", "clients", "tasks"],
  },
};

export const DEFAULT_USERS = [
  { id: "u-1", name: "Marta Ruiz", email: "marta@legalprevent.com", role: "admin" },
  { id: "u-2", name: "Alvaro Navas", email: "alvaro@legalprevent.com", role: "sales" },
  { id: "u-3", name: "Clara Vidal", email: "clara@legalprevent.com", role: "lawyer" },
  { id: "u-4", name: "Irene Soler", email: "irene@legalprevent.com", role: "support" },
];

export const SCHEMA = {
  User: {
    id: "string",
    name: "string",
    email: "email",
    role: "Role.id",
  },
  Role: {
    id: "string",
    name: "string",
    permissions: "string[]",
  },
  Lead: {
    id: "string",
    companyName: "string",
    contactName: "string",
    email: "email",
    phone: "string",
    sector: "string",
    employees: "number",
    city: "string",
    source: "LeadSource",
    status: "LeadStatus",
    priority: "Priority",
    createdAt: "date",
    lastInteractionAt: "date",
    nextActionAt: "date",
    nextAction: "string",
    notes: "string",
    ownerId: "User.id",
    recommendedPlan: "Plan",
    estimatedMonthlyRevenue: "number",
    riskScore: "number",
    convertedClientId: "Client.id?",
  },
  Client: {
    id: "string",
    leadId: "Lead.id?",
    businessName: "string",
    taxId: "string",
    address: "string",
    primaryContact: "string",
    billingEmail: "email",
    plan: "Plan",
    monthlyPrice: "number",
    signupDate: "date",
    renewalDate: "date",
    status: "ClientStatus",
    legalReviewPending: "boolean",
    ownerId: "User.id",
  },
  Task: {
    id: "string",
    title: "string",
    description: "string",
    relatedType: "lead|client",
    relatedId: "Lead.id|Client.id",
    dueDate: "date",
    priority: "Priority",
    status: "TaskStatus",
    ownerId: "User.id",
  },
  Interaction: {
    id: "string",
    type: "InteractionType",
    relatedType: "lead|client",
    relatedId: "Lead.id|Client.id",
    date: "date",
    description: "string",
    createdBy: "User.id",
  },
  Proposal: {
    id: "string",
    relatedLeadId: "Lead.id?",
    relatedClientId: "Client.id?",
    plan: "Plan",
    price: "number",
    discount: "number",
    status: "ProposalStatus",
    sentAt: "date?",
    expiresAt: "date",
    notes: "string",
    ownerId: "User.id",
  },
  Payment: {
    id: "string",
    clientId: "Client.id",
    amount: "number",
    dueDate: "date",
    paidAt: "date?",
    status: "paid|pending|failed",
  },
  Document: {
    id: "string",
    relatedType: "lead|client",
    relatedId: "Lead.id|Client.id",
    name: "string",
    type: "contract|proposal|diagnostic|legal-review|other",
    createdAt: "date",
  },
  Note: {
    id: "string",
    relatedType: "lead|client",
    relatedId: "Lead.id|Client.id",
    body: "string",
    createdAt: "date",
    createdBy: "User.id",
  },
  CRMActivityLog: {
    id: "string",
    entityType: "string",
    entityId: "string",
    action: "string",
    detail: "string",
    createdAt: "date",
    createdBy: "User.id",
  },
};
