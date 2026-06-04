import {
  CLIENT_STATUSES,
  INTERACTION_TYPES,
  LEAD_SOURCES,
  LEAD_STATUSES,
  PIPELINE_COLUMNS,
  PLANS,
  PRIORITIES,
  PROPOSAL_STATUSES,
  ROLES,
  TASK_STATUSES,
  SCHEMA,
} from "./models.js";
import {
  addInteraction,
  applyAutomations,
  buildAlerts,
  canAccess,
  convertLeadToClient,
  dashboardMetrics,
  filteredClients,
  filteredLeads,
  formatCurrency,
  formatDate,
  formatDateTime,
  getCurrentUser,
  getEntityName,
  isOverdue,
  leadScore,
  loadState,
  mapLeadStatusToPipeline,
  mapPipelineToLeadStatus,
  resetState,
  saveState,
  trendData,
  updateClient,
  updateLeadStatus,
  upsertLead,
  upsertProposal,
  upsertTask,
} from "./store.js";

let state = applyAutomations(loadState());
let view = parseRoute();
let toastTimer = null;

const app = document.querySelector("#app");

window.addEventListener("hashchange", () => {
  view = parseRoute();
  render();
});

document.addEventListener("submit", handleSubmit);
document.addEventListener("click", handleClick);
document.addEventListener("change", handleChange);
document.addEventListener("dragstart", handleDragStart);
document.addEventListener("dragover", handleDragOver);
document.addEventListener("drop", handleDrop);

render();

function parseRoute() {
  const hash = window.location.hash.replace(/^#\/?/, "").split("?")[0];
  const [name = "dashboard", id = ""] = hash.split("/");
  return { name, id };
}

function go(name, id = "") {
  window.location.hash = id ? `#/${name}/${id}` : `#/${name}`;
}

function render() {
  const user = getCurrentUser(state);
  document.title = `LegalPrevent CRM - ${labelForView(view.name)}`;
  app.innerHTML = `
    <div class="shell">
      ${renderSidebar(user)}
      <main class="main">
        ${renderTopbar(user)}
        <section class="workspace">
          ${renderView()}
        </section>
      </main>
    </div>
    <div id="modal-root"></div>
    <div id="toast" class="toast" role="status"></div>
  `;
}

function renderSidebar(user) {
  const items = [
    ["dashboard", "Dashboard", "dashboard"],
    ["leads", "Leads", "leads"],
    ["pipeline", "Pipeline", "leads"],
    ["clients", "Clientes", "clients"],
    ["tasks", "Tareas", "tasks"],
    ["proposals", "Propuestas", "proposals"],
    ["settings", "Modelo y permisos", "settings"],
  ];

  return `
    <aside class="sidebar">
      <a class="brand" href="#/dashboard" aria-label="LegalPrevent CRM">
        <span class="brand-mark">LP</span>
        <span>
          <strong>LegalPrevent</strong>
          <small>CRM interno</small>
        </span>
      </a>
      <nav class="nav">
        ${items
          .filter(([, , permission]) => canAccess(state, permission))
          .map(
            ([name, label]) => `
              <a class="${view.name === name ? "active" : ""}" href="#/${name}">
                <span class="nav-dot"></span>${label}
              </a>
            `,
          )
          .join("")}
      </nav>
      <div class="role-card">
        <small>Sesion actual</small>
        <strong>${escapeHtml(user.name)}</strong>
        <span>${ROLES[user.role].name}</span>
      </div>
    </aside>
  `;
}

function renderTopbar(user) {
  const alerts = buildAlerts(state);
  return `
    <header class="topbar">
      <div>
        <p class="eyebrow">Panel administrador</p>
        <h1>${labelForView(view.name)}</h1>
      </div>
      <div class="topbar-actions">
        <label class="select-label">
          Rol
          <select data-action="switch-user">
            ${state.users
              .map((item) => `<option value="${item.id}" ${item.id === user.id ? "selected" : ""}>${escapeHtml(item.name)} - ${ROLES[item.role].name}</option>`)
              .join("")}
          </select>
        </label>
        <button class="ghost-button" data-action="reset-demo">Restaurar demo</button>
        <button class="primary-button" data-action="open-lead-modal">Nuevo lead</button>
      </div>
      ${alerts.length ? `<button class="alert-chip" data-action="go-alerts">${alerts.length} alertas</button>` : ""}
    </header>
  `;
}

function renderView() {
  const permissionByView = {
    dashboard: "dashboard",
    leads: "leads",
    pipeline: "leads",
    lead: "leads",
    clients: "clients",
    client: "clients",
    tasks: "tasks",
    proposals: "proposals",
    settings: "settings",
  };
  const permission = permissionByView[view.name] || "dashboard";
  if (!canAccess(state, permission)) {
    return renderAccessDenied(permission);
  }

  if (view.name === "dashboard") return renderDashboard();
  if (view.name === "leads") return renderLeads();
  if (view.name === "pipeline") return renderPipeline();
  if (view.name === "lead") return renderLeadDetail(view.id);
  if (view.name === "clients") return renderClients();
  if (view.name === "client") return renderClientDetail(view.id);
  if (view.name === "tasks") return renderTasks();
  if (view.name === "proposals") return renderProposals();
  if (view.name === "settings") return renderSettings();
  return renderDashboard();
}

function renderAccessDenied(permission) {
  return `
    <section class="empty-state">
      <h2>Acceso restringido</h2>
      <p>Tu rol actual no tiene permiso para entrar en esta seccion: ${escapeHtml(permission)}.</p>
      <button class="primary-button" data-action="go-dashboard">Volver al dashboard</button>
    </section>
  `;
}

function renderDashboard() {
  const metrics = dashboardMetrics(state);
  const alerts = buildAlerts(state);
  const hotLeads = [...state.leads]
    .filter((lead) => !["Cliente ganado", "Perdido"].includes(lead.status))
    .sort((a, b) => leadScore(b) - leadScore(a))
    .slice(0, 5);
  const nextTasks = [...state.tasks]
    .filter((task) => task.status !== "Completada")
    .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate))
    .slice(0, 6);

  return `
    <div class="page-grid">
      <section class="metric-grid">
        ${metricCard("Total leads", metrics.totalLeads, "Oportunidades registradas")}
        ${metricCard("Leads nuevos", metrics.newLeads, "Ultimos 7 dias")}
        ${metricCard("Demos agendadas", metrics.demosScheduled, "Pendientes")}
        ${metricCard("Demos realizadas", metrics.demosDone, "Sin contar cerradas")}
        ${metricCard("Clientes activos", metrics.activeClients, "En servicio")}
        ${metricCard("Clientes perdidos", metrics.lostLeads, "Leads marcados perdido")}
        ${metricCard("Facturacion mensual", formatCurrency(metrics.monthlyRevenue), "MRR estimado")}
        ${metricCard("Conversion", `${metrics.conversionRate}%`, "Lead a cliente")}
      </section>

      <section class="two-column">
        <article class="panel chart-panel">
          <div class="panel-header">
            <div>
              <p class="eyebrow">Evolucion</p>
              <h2>Leads y cierres</h2>
            </div>
          </div>
          ${renderTrendChart()}
        </article>
        <article class="panel">
          <div class="panel-header">
            <div>
              <p class="eyebrow">Automatizaciones</p>
              <h2>Alertas importantes</h2>
            </div>
          </div>
          ${alerts.length ? alerts.slice(0, 6).map(renderAlert).join("") : `<p class="muted">No hay alertas activas.</p>`}
        </article>
      </section>

      <section class="two-column">
        <article class="panel">
          <div class="panel-header">
            <div>
              <p class="eyebrow">Prioridad comercial</p>
              <h2>Leads calientes</h2>
            </div>
            <a class="text-link" href="#/pipeline">Ver pipeline</a>
          </div>
          <div class="stack-list">
            ${hotLeads
              .map(
                (lead) => `
                  <a class="list-row" href="#/lead/${lead.id}">
                    <span>
                      <strong>${escapeHtml(lead.companyName)}</strong>
                      <small>${escapeHtml(lead.contactName)} · ${escapeHtml(lead.sector)}</small>
                    </span>
                    <span class="score">${leadScore(lead)}</span>
                  </a>
                `,
              )
              .join("")}
          </div>
        </article>
        <article class="panel">
          <div class="panel-header">
            <div>
              <p class="eyebrow">Agenda</p>
              <h2>Proximas tareas</h2>
            </div>
            <button class="small-button" data-action="open-task-modal">Crear tarea</button>
          </div>
          <div class="stack-list">
            ${nextTasks.map(renderTaskRow).join("")}
          </div>
        </article>
      </section>
    </div>
  `;
}

function metricCard(label, value, helper) {
  return `
    <article class="metric-card">
      <span>${label}</span>
      <strong>${value}</strong>
      <small>${helper}</small>
    </article>
  `;
}

function renderTrendChart() {
  const data = trendData(state);
  const max = Math.max(...data.map((item) => Math.max(item.created, item.won)), 1);
  return `
    <div class="chart">
      ${data
        .map(
          (item) => `
            <div class="chart-group">
              <div class="bars">
                <span class="bar lead-bar" style="height:${(item.created / max) * 100}%"></span>
                <span class="bar won-bar" style="height:${(item.won / max) * 100}%"></span>
              </div>
              <small>${item.label}</small>
            </div>
          `,
        )
        .join("")}
    </div>
    <div class="legend"><span class="legend-leads"></span>Leads <span class="legend-won"></span>Ganados</div>
  `;
}

function renderAlert(alert) {
  const href = alert.entityType === "lead" ? `#/lead/${alert.entityId}` : `#/client/${alert.entityId}`;
  return `
    <a class="alert-row ${alert.severity}" href="${href}">
      <strong>${escapeHtml(alert.title)}</strong>
      <span>${escapeHtml(alert.message)}</span>
    </a>
  `;
}

function renderLeads() {
  const filters = readFiltersFromUrl();
  const leads = filteredLeads(state, filters);
  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <p class="eyebrow">Gestion comercial</p>
          <h2>Leads</h2>
        </div>
        <div class="button-row">
          <button class="secondary-button" data-action="clear-filters">Limpiar filtros</button>
          <button class="primary-button" data-action="open-lead-modal">Nuevo lead</button>
        </div>
      </div>
      ${renderLeadFilters(filters)}
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Empresa</th>
              <th>Contacto</th>
              <th>Estado</th>
              <th>Prioridad</th>
              <th>Fuente</th>
              <th>Responsable</th>
              <th>Proxima accion</th>
              <th>MRR</th>
            </tr>
          </thead>
          <tbody>
            ${leads.map(renderLeadTableRow).join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderLeadFilters(filters) {
  return `
    <form class="filters" data-form="filters">
      <input name="query" value="${escapeAttr(filters.query || "")}" placeholder="Buscar empresa, contacto o email" />
      ${selectField("status", LEAD_STATUSES, filters.status, "Estado", true)}
      ${selectField("source", LEAD_SOURCES, filters.source, "Fuente", true)}
      ${selectField("priority", PRIORITIES, filters.priority, "Prioridad", true)}
      ${selectField("ownerId", state.users.map((user) => [user.id, user.name]), filters.ownerId, "Responsable", true)}
      ${selectField("plan", PLANS, filters.plan, "Plan", true)}
      <button class="secondary-button" type="submit">Filtrar</button>
    </form>
  `;
}

function renderLeadTableRow(lead) {
  const owner = state.users.find((user) => user.id === lead.ownerId);
  return `
    <tr data-action="open-lead" data-id="${lead.id}">
      <td>
        <strong>${escapeHtml(lead.companyName)}</strong>
        <small>${escapeHtml(lead.sector)} · ${lead.employees} empleados</small>
      </td>
      <td>${escapeHtml(lead.contactName)}<small>${escapeHtml(lead.email)}</small></td>
      <td>${badge(lead.status)}</td>
      <td>${badge(lead.priority, `priority-${lead.priority.toLowerCase()}`)}</td>
      <td>${escapeHtml(lead.source)}</td>
      <td>${escapeHtml(owner?.name || "Sin asignar")}</td>
      <td>${escapeHtml(lead.nextAction)}<small>${formatDate(lead.nextActionAt)}</small></td>
      <td>${formatCurrency(lead.estimatedMonthlyRevenue)}</td>
    </tr>
  `;
}

function renderPipeline() {
  return `
    <section class="pipeline-page">
      <div class="panel-header">
        <div>
          <p class="eyebrow">Embudo comercial</p>
          <h2>Pipeline Kanban</h2>
        </div>
        <button class="primary-button" data-action="open-lead-modal">Nuevo lead</button>
      </div>
      <div class="kanban">
        ${PIPELINE_COLUMNS.map(renderPipelineColumn).join("")}
      </div>
    </section>
  `;
}

function renderPipelineColumn(column) {
  const items = state.leads.filter((lead) => mapLeadStatusToPipeline(lead.status) === column);
  const revenue = items.reduce((sum, lead) => sum + Number(lead.estimatedMonthlyRevenue || 0), 0);
  return `
    <article class="kanban-column" data-drop-status="${column}">
      <header>
        <span>${column}</span>
        <small>${items.length} · ${formatCurrency(revenue)}</small>
      </header>
      <div class="kanban-list">
        ${items.map(renderPipelineCard).join("")}
      </div>
    </article>
  `;
}

function renderPipelineCard(lead) {
  return `
    <article class="kanban-card" draggable="true" data-lead-id="${lead.id}">
      <a href="#/lead/${lead.id}">
        <strong>${escapeHtml(lead.companyName)}</strong>
        <span>${escapeHtml(lead.contactName)} · ${escapeHtml(lead.city)}</span>
      </a>
      <div class="card-meta">
        ${badge(lead.priority, `priority-${lead.priority.toLowerCase()}`)}
        <span>${formatCurrency(lead.estimatedMonthlyRevenue)}</span>
      </div>
      <label>
        Estado
        <select data-action="quick-status" data-id="${lead.id}">
          ${LEAD_STATUSES.map((status) => `<option value="${status}" ${status === lead.status ? "selected" : ""}>${status}</option>`).join("")}
        </select>
      </label>
    </article>
  `;
}

function renderLeadDetail(id) {
  const lead = state.leads.find((item) => item.id === id);
  if (!lead) return renderNotFound("Lead no encontrado");
  const relatedTasks = state.tasks.filter((task) => task.relatedType === "lead" && task.relatedId === id);
  const interactions = state.interactions.filter((item) => item.relatedType === "lead" && item.relatedId === id);
  const proposals = state.proposals.filter((item) => item.relatedLeadId === id);
  const documents = state.documents.filter((item) => item.relatedType === "lead" && item.relatedId === id);
  const notes = state.notes.filter((item) => item.relatedType === "lead" && item.relatedId === id);
  const owner = state.users.find((user) => user.id === lead.ownerId);

  return `
    <section class="detail-layout">
      <article class="panel detail-hero">
        <div>
          <a class="text-link" href="#/leads">Volver a leads</a>
          <h2>${escapeHtml(lead.companyName)}</h2>
          <p>${escapeHtml(lead.contactName)} · ${escapeHtml(lead.email)} · ${escapeHtml(lead.phone)}</p>
          <div class="badge-row">
            ${badge(lead.status)}
            ${badge(lead.priority, `priority-${lead.priority.toLowerCase()}`)}
            ${badge(`${leadScore(lead)} score`, "score-badge")}
          </div>
        </div>
        <div class="button-row">
          <button class="secondary-button" data-action="open-lead-modal" data-id="${lead.id}">Editar</button>
          <button class="secondary-button" data-action="open-task-modal" data-related-type="lead" data-related-id="${lead.id}">Crear tarea</button>
          <button class="secondary-button" data-action="open-interaction-modal" data-related-type="lead" data-related-id="${lead.id}" data-kind="Llamada">Registrar llamada</button>
          <button class="secondary-button" data-action="open-interaction-modal" data-related-type="lead" data-related-id="${lead.id}" data-kind="Demo">Agendar demo</button>
          <button class="secondary-button" data-action="open-proposal-modal" data-related-type="lead" data-related-id="${lead.id}">Enviar propuesta</button>
          <button class="primary-button" data-action="convert-lead" data-id="${lead.id}">Convertir en cliente</button>
        </div>
      </article>

      <div class="detail-grid">
        <article class="panel">
          <div class="panel-header"><h3>Datos generales</h3></div>
          ${keyValues([
            ["Sector", lead.sector],
            ["Empleados", lead.employees],
            ["Ciudad/provincia", lead.city],
            ["Fuente", lead.source],
            ["Responsable", owner?.name || "Sin asignar"],
            ["Creacion", formatDate(lead.createdAt)],
            ["Ultima interaccion", formatDateTime(lead.lastInteractionAt)],
            ["Proxima accion", `${lead.nextAction} · ${formatDate(lead.nextActionAt)}`],
            ["Plan recomendado", lead.recommendedPlan],
            ["Riesgo detectado", `${lead.riskScore}/100`],
          ])}
        </article>
        <article class="panel">
          <div class="panel-header"><h3>Notas internas</h3></div>
          <p class="note-block">${escapeHtml(lead.notes || "Sin notas")}</p>
          ${notes.map((note) => `<p class="note-block">${escapeHtml(note.body)}<small>${formatDateTime(note.createdAt)}</small></p>`).join("")}
        </article>
      </div>

      <div class="three-column">
        ${relatedPanel("Tareas pendientes", relatedTasks.map(renderTaskRow).join("") || emptyText("Sin tareas"))}
        ${relatedPanel("Propuestas enviadas", proposals.map(renderProposalMini).join("") || emptyText("Sin propuestas"))}
        ${relatedPanel("Documentos asociados", documents.map(renderDocumentMini).join("") || emptyText("Sin documentos"))}
      </div>

      <article class="panel">
        <div class="panel-header">
          <h3>Historial de interacciones</h3>
          <button class="small-button" data-action="open-interaction-modal" data-related-type="lead" data-related-id="${lead.id}">Registrar interaccion</button>
        </div>
        ${renderTimeline(interactions)}
      </article>
    </section>
  `;
}

function renderClients() {
  const filters = readFiltersFromUrl();
  const clients = filteredClients(state, filters);
  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <p class="eyebrow">Cartera</p>
          <h2>Clientes</h2>
        </div>
        <button class="secondary-button" data-action="clear-filters">Limpiar filtros</button>
      </div>
      <form class="filters" data-form="filters">
        <input name="query" value="${escapeAttr(filters.query || "")}" placeholder="Buscar razon social, contacto, CIF/NIF o email" />
        ${selectField("status", CLIENT_STATUSES, filters.status, "Estado", true)}
        ${selectField("plan", PLANS, filters.plan, "Plan", true)}
        ${selectField("ownerId", state.users.map((user) => [user.id, user.name]), filters.ownerId, "Responsable", true)}
        <button class="secondary-button" type="submit">Filtrar</button>
      </form>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Cliente</th>
              <th>CIF/NIF</th>
              <th>Plan</th>
              <th>Estado</th>
              <th>Renovacion</th>
              <th>Precio mensual</th>
              <th>Revision legal</th>
            </tr>
          </thead>
          <tbody>
            ${clients.map(renderClientTableRow).join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderClientTableRow(client) {
  return `
    <tr data-action="open-client" data-id="${client.id}">
      <td><strong>${escapeHtml(client.businessName)}</strong><small>${escapeHtml(client.primaryContact)} · ${escapeHtml(client.billingEmail)}</small></td>
      <td>${escapeHtml(client.taxId || "Pendiente")}</td>
      <td>${badge(client.plan)}</td>
      <td>${badge(client.status)}</td>
      <td>${formatDate(client.renewalDate)}</td>
      <td>${formatCurrency(client.monthlyPrice)}</td>
      <td>${client.legalReviewPending ? badge("Pendiente", "alert") : badge("Al dia", "success")}</td>
    </tr>
  `;
}

function renderClientDetail(id) {
  const client = state.clients.find((item) => item.id === id);
  if (!client) return renderNotFound("Cliente no encontrado");
  const relatedTasks = state.tasks.filter((task) => task.relatedType === "client" && task.relatedId === id);
  const interactions = state.interactions.filter((item) => item.relatedType === "client" && item.relatedId === id);
  const proposals = state.proposals.filter((item) => item.relatedClientId === id);
  const documents = state.documents.filter((item) => item.relatedType === "client" && item.relatedId === id);
  const payments = state.payments.filter((item) => item.clientId === id);
  const owner = state.users.find((user) => user.id === client.ownerId);

  return `
    <section class="detail-layout">
      <article class="panel detail-hero">
        <div>
          <a class="text-link" href="#/clients">Volver a clientes</a>
          <h2>${escapeHtml(client.businessName)}</h2>
          <p>${escapeHtml(client.primaryContact)} · ${escapeHtml(client.billingEmail)}</p>
          <div class="badge-row">
            ${badge(client.plan)}
            ${badge(client.status)}
            ${client.legalReviewPending ? badge("Revision legal pendiente", "alert") : badge("Revision al dia", "success")}
          </div>
        </div>
        <div class="button-row">
          <button class="secondary-button" data-action="open-client-modal" data-id="${client.id}">Editar cliente</button>
          <button class="secondary-button" data-action="open-task-modal" data-related-type="client" data-related-id="${client.id}">Crear tarea</button>
          <button class="secondary-button" data-action="open-interaction-modal" data-related-type="client" data-related-id="${client.id}">Registrar interaccion</button>
        </div>
      </article>

      <div class="detail-grid">
        <article class="panel">
          <div class="panel-header"><h3>Datos fiscales</h3></div>
          ${keyValues([
            ["Razon social", client.businessName],
            ["CIF/NIF", client.taxId || "Pendiente"],
            ["Direccion", client.address],
            ["Contacto principal", client.primaryContact],
            ["Email facturacion", client.billingEmail],
            ["Responsable", owner?.name || "Sin asignar"],
          ])}
        </article>
        <article class="panel">
          <div class="panel-header"><h3>Servicio contratado</h3></div>
          ${keyValues([
            ["Plan", client.plan],
            ["Precio mensual", formatCurrency(client.monthlyPrice)],
            ["Fecha alta", formatDate(client.signupDate)],
            ["Renovacion", formatDate(client.renewalDate)],
            ["Estado", client.status],
            ["Revision legal", client.legalReviewPending ? "Pendiente" : "Al dia"],
          ])}
        </article>
      </div>

      <div class="three-column">
        ${relatedPanel("Documentos generados", documents.map(renderDocumentMini).join("") || emptyText("Sin documentos"))}
        ${relatedPanel("Historial de pagos", payments.map(renderPaymentMini).join("") || emptyText("Sin pagos"))}
        ${relatedPanel("Tareas y revision", relatedTasks.map(renderTaskRow).join("") || emptyText("Sin tareas"))}
      </div>

      <article class="panel">
        <div class="panel-header">
          <h3>Historial de interacciones</h3>
          <button class="small-button" data-action="open-interaction-modal" data-related-type="client" data-related-id="${client.id}">Registrar interaccion</button>
        </div>
        ${renderTimeline(interactions)}
      </article>
      <article class="panel">
        <div class="panel-header"><h3>Propuestas vinculadas</h3></div>
        ${proposals.map(renderProposalMini).join("") || emptyText("Sin propuestas vinculadas")}
      </article>
    </section>
  `;
}

function renderTasks() {
  const tasks = [...state.tasks].sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <p class="eyebrow">Seguimiento</p>
          <h2>Tareas comerciales</h2>
        </div>
        <button class="primary-button" data-action="open-task-modal">Crear tarea</button>
      </div>
      <div class="task-board">
        ${TASK_STATUSES.map(
          (status) => `
            <article class="task-column">
              <h3>${status}</h3>
              ${tasks.filter((task) => task.status === status).map(renderTaskCard).join("") || emptyText("Sin tareas")}
            </article>
          `,
        ).join("")}
      </div>
    </section>
  `;
}

function renderTaskCard(task) {
  const owner = state.users.find((user) => user.id === task.ownerId);
  return `
    <article class="task-card ${isOverdue(task.dueDate) && task.status !== "Completada" ? "is-overdue" : ""}">
      <div>
        <strong>${escapeHtml(task.title)}</strong>
        <small>${escapeHtml(getEntityName(state, task.relatedType, task.relatedId))}</small>
      </div>
      <p>${escapeHtml(task.description)}</p>
      <div class="card-meta">
        ${badge(task.priority, `priority-${task.priority.toLowerCase()}`)}
        <span>${formatDate(task.dueDate)}</span>
      </div>
      <div class="card-meta">
        <span>${escapeHtml(owner?.name || "Sin responsable")}</span>
        <button class="tiny-button" data-action="open-task-modal" data-id="${task.id}">Editar</button>
      </div>
    </article>
  `;
}

function renderTaskRow(task) {
  const href = task.relatedType === "lead" ? `#/lead/${task.relatedId}` : `#/client/${task.relatedId}`;
  return `
    <a class="list-row ${isOverdue(task.dueDate) && task.status !== "Completada" ? "is-overdue" : ""}" href="${href}">
      <span>
        <strong>${escapeHtml(task.title)}</strong>
        <small>${escapeHtml(getEntityName(state, task.relatedType, task.relatedId))} · ${formatDate(task.dueDate)}</small>
      </span>
      ${badge(task.status)}
    </a>
  `;
}

function renderProposals() {
  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <p class="eyebrow">Ofertas</p>
          <h2>Propuestas comerciales</h2>
        </div>
        <button class="primary-button" data-action="open-proposal-modal">Crear propuesta</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Lead/cliente</th>
              <th>Plan</th>
              <th>Precio</th>
              <th>Descuento</th>
              <th>Estado</th>
              <th>Enviada</th>
              <th>Caduca</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            ${state.proposals.map(renderProposalRow).join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderProposalRow(proposal) {
  const relatedType = proposal.relatedLeadId ? "lead" : "client";
  const relatedId = proposal.relatedLeadId || proposal.relatedClientId;
  const href = relatedType === "lead" ? `#/lead/${relatedId}` : `#/client/${relatedId}`;
  return `
    <tr>
      <td><a class="text-link" href="${href}">${escapeHtml(getEntityName(state, relatedType, relatedId))}</a></td>
      <td>${badge(proposal.plan)}</td>
      <td>${formatCurrency(proposal.price)}</td>
      <td>${proposal.discount}%</td>
      <td>${badge(proposal.status)}</td>
      <td>${formatDate(proposal.sentAt)}</td>
      <td>${formatDate(proposal.expiresAt)}</td>
      <td>
        <button class="tiny-button" data-action="open-proposal-modal" data-id="${proposal.id}">Editar</button>
        ${
          proposal.status !== "Aceptada" && proposal.relatedLeadId
            ? `<button class="tiny-button success-action" data-action="accept-proposal" data-id="${proposal.id}">Aceptar</button>`
            : ""
        }
      </td>
    </tr>
  `;
}

function renderSettings() {
  return `
    <section class="two-column align-start">
      <article class="panel">
        <div class="panel-header">
          <div>
            <p class="eyebrow">Seguridad</p>
            <h2>Roles y permisos</h2>
          </div>
        </div>
        <div class="role-grid">
          ${Object.values(ROLES)
            .map(
              (role) => `
                <article class="role-permission-card">
                  <strong>${role.name}</strong>
                  <p>${role.permissions.join(", ")}</p>
                </article>
              `,
            )
            .join("")}
        </div>
      </article>
      <article class="panel">
        <div class="panel-header">
          <div>
            <p class="eyebrow">Base de datos</p>
            <h2>Modelos preparados</h2>
          </div>
        </div>
        <div class="schema-list">
          ${Object.entries(SCHEMA)
            .map(
              ([name, fields]) => `
                <details>
                  <summary>${name}</summary>
                  <pre>${escapeHtml(JSON.stringify(fields, null, 2))}</pre>
                </details>
              `,
            )
            .join("")}
        </div>
      </article>
      <article class="panel full-span">
        <div class="panel-header">
          <div>
            <p class="eyebrow">Integraciones futuras</p>
            <h2>Preparado para conectar</h2>
          </div>
        </div>
        <div class="integration-grid">
          ${["Email", "WhatsApp Business", "Stripe", "Calendario", "PDF propuestas", "IA resumen llamadas", "IA scoring leads", "Firma electronica"].map((item) => `<span>${item}</span>`).join("")}
        </div>
      </article>
    </section>
  `;
}

function renderLeadModal(lead = null) {
  const item = lead || {
    companyName: "",
    contactName: "",
    email: "",
    phone: "",
    sector: "",
    employees: "",
    city: "",
    source: "LinkedIn",
    status: "Nuevo",
    priority: "Media",
    nextActionAt: "",
    nextAction: "",
    notes: "",
    ownerId: getCurrentUser(state).id,
    recommendedPlan: "Pro",
    estimatedMonthlyRevenue: 590,
    riskScore: 50,
  };
  return modal(
    lead ? "Editar lead" : "Nuevo lead",
    `
      <form class="modal-form" data-form="lead" data-id="${lead?.id || ""}">
        <div class="form-grid">
          ${inputField("companyName", "Empresa", item.companyName)}
          ${inputField("contactName", "Persona de contacto", item.contactName)}
          ${inputField("email", "Email", item.email, "email")}
          ${inputField("phone", "Telefono", item.phone)}
          ${inputField("sector", "Sector", item.sector)}
          ${inputField("employees", "Empleados", item.employees, "number")}
          ${inputField("city", "Ciudad/provincia", item.city)}
          ${selectField("source", LEAD_SOURCES, item.source, "Fuente")}
          ${selectField("status", LEAD_STATUSES, item.status, "Estado")}
          ${selectField("priority", PRIORITIES, item.priority, "Prioridad")}
          ${dateField("nextActionAt", "Proxima accion fecha", item.nextActionAt)}
          ${inputField("nextAction", "Proxima accion", item.nextAction)}
          ${selectField("ownerId", state.users.map((user) => [user.id, user.name]), item.ownerId, "Responsable")}
          ${selectField("recommendedPlan", PLANS, item.recommendedPlan, "Plan recomendado")}
          ${inputField("estimatedMonthlyRevenue", "MRR estimado", item.estimatedMonthlyRevenue, "number")}
          ${inputField("riskScore", "Riesgo detectado 0-100", item.riskScore, "number")}
          <label class="full-field">Notas internas<textarea name="notes">${escapeHtml(item.notes || "")}</textarea></label>
        </div>
        <div class="modal-actions">
          <button class="secondary-button" type="button" data-action="close-modal">Cancelar</button>
          <button class="primary-button" type="submit">Guardar lead</button>
        </div>
      </form>
    `,
  );
}

function renderClientModal(client) {
  return modal(
    "Editar cliente",
    `
      <form class="modal-form" data-form="client" data-id="${client.id}">
        <div class="form-grid">
          ${inputField("businessName", "Razon social", client.businessName)}
          ${inputField("taxId", "CIF/NIF", client.taxId)}
          ${inputField("address", "Direccion", client.address)}
          ${inputField("primaryContact", "Contacto principal", client.primaryContact)}
          ${inputField("billingEmail", "Email facturacion", client.billingEmail, "email")}
          ${selectField("plan", PLANS, client.plan, "Plan contratado")}
          ${inputField("monthlyPrice", "Precio mensual", client.monthlyPrice, "number")}
          ${dateField("renewalDate", "Fecha renovacion", client.renewalDate)}
          ${selectField("status", CLIENT_STATUSES, client.status, "Estado")}
          ${selectField("ownerId", state.users.map((user) => [user.id, user.name]), client.ownerId, "Responsable")}
          <label class="check-field"><input type="checkbox" name="legalReviewPending" ${client.legalReviewPending ? "checked" : ""} /> Revision legal pendiente</label>
        </div>
        <div class="modal-actions">
          <button class="secondary-button" type="button" data-action="close-modal">Cancelar</button>
          <button class="primary-button" type="submit">Guardar cliente</button>
        </div>
      </form>
    `,
  );
}

function renderTaskModal(task = null, relatedType = "lead", relatedId = "") {
  const item = task || {
    title: "",
    description: "",
    relatedType,
    relatedId: relatedId || state.leads[0]?.id || "",
    dueDate: new Date().toISOString(),
    priority: "Media",
    status: "Pendiente",
    ownerId: getCurrentUser(state).id,
  };
  return modal(
    task ? "Editar tarea" : "Crear tarea",
    `
      <form class="modal-form" data-form="task" data-id="${task?.id || ""}">
        <div class="form-grid">
          ${inputField("title", "Titulo", item.title)}
          ${selectField("relatedType", [["lead", "Lead"], ["client", "Cliente"]], item.relatedType, "Relacion")}
          ${selectField("relatedId", relationOptions(item.relatedType), item.relatedId, "Lead o cliente")}
          ${dateField("dueDate", "Fecha limite", item.dueDate)}
          ${selectField("priority", PRIORITIES, item.priority, "Prioridad")}
          ${selectField("status", TASK_STATUSES, item.status, "Estado")}
          ${selectField("ownerId", state.users.map((user) => [user.id, user.name]), item.ownerId, "Responsable")}
          <label class="full-field">Descripcion<textarea name="description">${escapeHtml(item.description || "")}</textarea></label>
        </div>
        <div class="modal-actions">
          <button class="secondary-button" type="button" data-action="close-modal">Cancelar</button>
          <button class="primary-button" type="submit">Guardar tarea</button>
        </div>
      </form>
    `,
  );
}

function renderInteractionModal(relatedType = "lead", relatedId = "", kind = "Nota manual") {
  return modal(
    "Registrar interaccion",
    `
      <form class="modal-form" data-form="interaction">
        <div class="form-grid">
          ${selectField("type", INTERACTION_TYPES, kind, "Tipo")}
          ${selectField("relatedType", [["lead", "Lead"], ["client", "Cliente"]], relatedType, "Relacion")}
          ${selectField("relatedId", relationOptions(relatedType), relatedId || state.leads[0]?.id || "", "Lead o cliente")}
          ${dateField("date", "Fecha", new Date().toISOString())}
          <label class="full-field">Descripcion<textarea name="description" placeholder="Resumen de llamada, email, reunion o nota"></textarea></label>
        </div>
        <div class="modal-actions">
          <button class="secondary-button" type="button" data-action="close-modal">Cancelar</button>
          <button class="primary-button" type="submit">Registrar</button>
        </div>
      </form>
    `,
  );
}

function renderProposalModal(proposal = null, relatedType = "lead", relatedId = "") {
  const item = proposal || {
    relatedLeadId: relatedType === "lead" ? relatedId : "",
    relatedClientId: relatedType === "client" ? relatedId : "",
    plan: "Pro",
    price: 590,
    discount: 0,
    status: "Borrador",
    sentAt: "",
    expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
    notes: "",
    ownerId: getCurrentUser(state).id,
  };
  const currentType = item.relatedClientId ? "client" : "lead";
  const currentId = item.relatedClientId || item.relatedLeadId || relatedId || state.leads[0]?.id || "";
  return modal(
    proposal ? "Editar propuesta" : "Crear propuesta",
    `
      <form class="modal-form" data-form="proposal" data-id="${proposal?.id || ""}">
        <div class="form-grid">
          ${selectField("relatedType", [["lead", "Lead"], ["client", "Cliente"]], currentType, "Relacion")}
          ${selectField("relatedId", relationOptions(currentType), currentId, "Lead o cliente")}
          ${selectField("plan", PLANS, item.plan, "Plan propuesto")}
          ${inputField("price", "Precio", item.price, "number")}
          ${inputField("discount", "Descuento %", item.discount, "number")}
          ${selectField("status", PROPOSAL_STATUSES, item.status, "Estado")}
          ${dateField("sentAt", "Fecha envio", item.sentAt)}
          ${dateField("expiresAt", "Fecha caducidad", item.expiresAt)}
          ${selectField("ownerId", state.users.map((user) => [user.id, user.name]), item.ownerId, "Responsable")}
          <label class="full-field">Notas<textarea name="notes">${escapeHtml(item.notes || "")}</textarea></label>
        </div>
        <div class="modal-actions">
          <button class="secondary-button" type="button" data-action="close-modal">Cancelar</button>
          <button class="primary-button" type="submit">Guardar propuesta</button>
        </div>
      </form>
    `,
  );
}

function relationOptions(type) {
  if (type === "client") return state.clients.map((client) => [client.id, client.businessName]);
  return state.leads.map((lead) => [lead.id, lead.companyName]);
}

function handleSubmit(event) {
  const form = event.target;
  const formType = form.dataset.form;
  if (!formType) return;
  event.preventDefault();

  try {
    if (formType === "filters") {
      const params = new URLSearchParams(new FormData(form));
      const clean = new URLSearchParams();
      params.forEach((value, key) => {
        if (value) clean.set(key, value);
      });
      window.location.hash = `#/${view.name}${clean.toString() ? `?${clean.toString()}` : ""}`;
      view = parseRoute();
      render();
      return;
    }

    const formData = new FormData(form);
    if (formType === "lead") state = upsertLead(state, formData, form.dataset.id);
    if (formType === "task") state = upsertTask(state, formData, form.dataset.id);
    if (formType === "proposal") state = upsertProposal(state, formData, form.dataset.id);
    if (formType === "interaction") state = addInteraction(state, formData);
    if (formType === "client") state = updateClient(state, formData, form.dataset.id);

    closeModal();
    render();
    showToast("Cambios guardados correctamente.");
  } catch (error) {
    showToast(error.message, "error");
  }
}

function handleClick(event) {
  const button = event.target.closest("[data-action]");
  const row = event.target.closest("tr[data-action]");
  if (row && !button) {
    if (row.dataset.action === "open-lead") go("lead", row.dataset.id);
    if (row.dataset.action === "open-client") go("client", row.dataset.id);
    return;
  }
  if (!button) return;

  const action = button.dataset.action;
  if (action === "go-dashboard") go("dashboard");
  if (action === "go-alerts") go("dashboard");
  if (action === "clear-filters") {
    window.location.hash = `#/${view.name}`;
  }
  if (action === "reset-demo") {
    state = applyAutomations(resetState());
    render();
    showToast("Datos demo restaurados.");
  }
  if (action === "close-modal") closeModal();
  if (action === "open-lead-modal") openModal(renderLeadModal(state.leads.find((lead) => lead.id === button.dataset.id)));
  if (action === "open-client-modal") {
    const client = state.clients.find((item) => item.id === button.dataset.id);
    if (client) openModal(renderClientModal(client));
  }
  if (action === "open-task-modal") {
    const task = state.tasks.find((item) => item.id === button.dataset.id);
    openModal(renderTaskModal(task, button.dataset.relatedType || "lead", button.dataset.relatedId || ""));
  }
  if (action === "open-interaction-modal") {
    openModal(renderInteractionModal(button.dataset.relatedType || "lead", button.dataset.relatedId || "", button.dataset.kind || "Nota manual"));
  }
  if (action === "open-proposal-modal") {
    const proposal = state.proposals.find((item) => item.id === button.dataset.id);
    openModal(renderProposalModal(proposal, button.dataset.relatedType || "lead", button.dataset.relatedId || ""));
  }
  if (action === "convert-lead") {
    state = convertLeadToClient(state, button.dataset.id);
    render();
    showToast("Lead convertido en cliente.");
  }
  if (action === "accept-proposal") {
    const proposal = state.proposals.find((item) => item.id === button.dataset.id);
    if (proposal) {
      const formData = proposalToFormData({ ...proposal, status: "Aceptada" });
      state = upsertProposal(state, formData, proposal.id);
      render();
      showToast("Propuesta aceptada y lead convertido.");
    }
  }
}

function handleChange(event) {
  const target = event.target;
  if (target.dataset.action === "switch-user") {
    state.currentUserId = target.value;
    saveState(state);
    render();
    return;
  }
  if (target.dataset.action === "quick-status") {
    state = updateLeadStatus(state, target.dataset.id, target.value);
    render();
    showToast("Estado actualizado.");
    return;
  }
  if (target.name === "relatedType") {
    const form = target.closest("form");
    const relation = form?.querySelector("[name='relatedId']");
    if (relation) {
      relation.innerHTML = relationOptions(target.value).map(([value, label]) => `<option value="${value}">${escapeHtml(label)}</option>`).join("");
    }
  }
}

function handleDragStart(event) {
  const card = event.target.closest("[data-lead-id]");
  if (!card) return;
  event.dataTransfer.setData("text/plain", card.dataset.leadId);
}

function handleDragOver(event) {
  if (event.target.closest("[data-drop-status]")) {
    event.preventDefault();
  }
}

function handleDrop(event) {
  const column = event.target.closest("[data-drop-status]");
  if (!column) return;
  event.preventDefault();
  const leadId = event.dataTransfer.getData("text/plain");
  const nextStatus = mapPipelineToLeadStatus(column.dataset.dropStatus);
  state = updateLeadStatus(state, leadId, nextStatus);
  render();
  showToast(`Lead movido a ${nextStatus}.`);
}

function proposalToFormData(proposal) {
  const formData = new FormData();
  const relatedType = proposal.relatedClientId ? "client" : "lead";
  formData.set("relatedType", relatedType);
  formData.set("relatedId", proposal.relatedClientId || proposal.relatedLeadId);
  formData.set("plan", proposal.plan);
  formData.set("price", proposal.price);
  formData.set("discount", proposal.discount);
  formData.set("status", proposal.status);
  formData.set("sentAt", proposal.sentAt || new Date().toISOString());
  formData.set("expiresAt", proposal.expiresAt);
  formData.set("notes", proposal.notes);
  formData.set("ownerId", proposal.ownerId);
  return formData;
}

function openModal(content) {
  document.querySelector("#modal-root").innerHTML = content;
  document.body.classList.add("modal-open");
}

function closeModal() {
  document.querySelector("#modal-root").innerHTML = "";
  document.body.classList.remove("modal-open");
}

function modal(title, body) {
  return `
    <div class="modal-backdrop" data-action="close-modal"></div>
    <section class="modal" role="dialog" aria-modal="true" aria-label="${escapeAttr(title)}">
      <header>
        <h2>${title}</h2>
        <button class="icon-button" data-action="close-modal" aria-label="Cerrar">x</button>
      </header>
      ${body}
    </section>
  `;
}

function showToast(message, kind = "success") {
  const toast = document.querySelector("#toast");
  if (!toast) return;
  toast.textContent = message;
  toast.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.className = "toast";
  }, 2600);
}

function readFiltersFromUrl() {
  const hash = window.location.hash;
  const queryIndex = hash.indexOf("?");
  if (queryIndex === -1) return {};
  return Object.fromEntries(new URLSearchParams(hash.slice(queryIndex + 1)));
}

function inputField(name, label, value = "", type = "text") {
  return `<label>${label}<input name="${name}" type="${type}" value="${escapeAttr(value ?? "")}" /></label>`;
}

function dateField(name, label, value = "") {
  const formatted = value ? new Date(value).toISOString().slice(0, 10) : "";
  return `<label>${label}<input name="${name}" type="date" value="${formatted}" /></label>`;
}

function selectField(name, options, value, label, allowEmpty = false) {
  const opts = options.map((option) => (Array.isArray(option) ? option : [option, option]));
  return `
    <label>${label}
      <select name="${name}">
        ${allowEmpty ? `<option value="">Todos</option>` : ""}
        ${opts.map(([val, text]) => `<option value="${escapeAttr(val)}" ${String(val) === String(value) ? "selected" : ""}>${escapeHtml(text)}</option>`).join("")}
      </select>
    </label>
  `;
}

function badge(text, extraClass = "") {
  const normalized = String(text).toLowerCase().replace(/\s+/g, "-");
  return `<span class="badge status-${normalized} ${extraClass}">${escapeHtml(text)}</span>`;
}

function keyValues(rows) {
  return `<dl class="key-values">${rows.map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>`;
}

function relatedPanel(title, body) {
  return `<article class="panel compact-panel"><div class="panel-header"><h3>${title}</h3></div><div class="stack-list">${body}</div></article>`;
}

function renderProposalMini(proposal) {
  return `
    <div class="mini-item">
      <strong>${proposal.plan} · ${formatCurrency(proposal.price)}</strong>
      <span>${badge(proposal.status)} Caduca ${formatDate(proposal.expiresAt)}</span>
    </div>
  `;
}

function renderDocumentMini(document) {
  return `
    <div class="mini-item">
      <strong>${escapeHtml(document.name)}</strong>
      <span>${escapeHtml(document.type)} · ${formatDate(document.createdAt)}</span>
    </div>
  `;
}

function renderPaymentMini(payment) {
  return `
    <div class="mini-item">
      <strong>${formatCurrency(payment.amount)}</strong>
      <span>${badge(payment.status)} Vence ${formatDate(payment.dueDate)}</span>
    </div>
  `;
}

function renderTimeline(interactions) {
  if (!interactions.length) return emptyText("Sin interacciones");
  return `
    <div class="timeline">
      ${[...interactions]
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .map((item) => {
          const user = state.users.find((person) => person.id === item.createdBy);
          return `
            <article class="timeline-item">
              <span></span>
              <div>
                <strong>${escapeHtml(item.type)}</strong>
                <p>${escapeHtml(item.description)}</p>
                <small>${formatDateTime(item.date)} · ${escapeHtml(user?.name || "Usuario")}</small>
              </div>
            </article>
          `;
        })
        .join("")}
    </div>
  `;
}

function emptyText(text) {
  return `<p class="muted">${text}</p>`;
}

function renderNotFound(message) {
  return `<section class="empty-state"><h2>${message}</h2><button class="primary-button" data-action="go-dashboard">Volver al dashboard</button></section>`;
}

function labelForView(name) {
  const labels = {
    dashboard: "Dashboard CRM",
    leads: "Gestion de leads",
    pipeline: "Pipeline comercial",
    lead: "Ficha de lead",
    clients: "Gestion de clientes",
    client: "Ficha de cliente",
    tasks: "Tareas comerciales",
    proposals: "Propuestas comerciales",
    settings: "Configuracion CRM",
  };
  return labels[name] || "Dashboard CRM";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}
