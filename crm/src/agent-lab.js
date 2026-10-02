// Laboratorio PRIVADO del agente comercial (PR2). Solo administradores del
// CRM: conversación con los modelos candidatos, panel de depuración, batería
// de evaluación con reglas automáticas, valoración humana y comparativa por
// modelo. El agente público sigue apagado.

const MODELS = ["gpt-5.4-mini", "gpt-5.6-luna", "gpt-6-luna"];
const BATTERY_URL = "../docs/pr2/eval/bateria-v1.json";
const RATING_KEYS = ["precision", "utilidad", "limites", "tono", "conversion"];
// Turnos visibles para valorar: los del modelo seleccionado (una tanda de la batería son 62).
const RATING_TURNS_MAX = 100;
// La batería respeta el tope global de mensajes por minuto (agent.max_calls_per_minute,
// 20 por defecto): ~3,2 s entre mensajes y, si aun así lo alcanza, espera y reintenta.
const BATTERY_PACE_MS = 3200;
const RATE_LIMIT_WAIT_MS = 30000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const lab = {
  model: MODELS[2],
  state: null,
  messages: [],
  busy: false,
  summary: null,
  turns: [],
  battery: null,
  results: [],
  progress: "",
  error: "",
};

const api = () => window.LegalPreventSupabase;
const esc = (value) =>
  String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const euros = (value) => `${Number(value || 0).toFixed(4)} €`;

export function renderAgentLab() {
  const budget = lab.summary?.budget;
  const spentPct = budget ? Math.min(100, (Number(budget.spent_eur) / Math.max(Number(budget.limit_eur), 0.0001)) * 100) : 0;
  return `
    <div class="agent-lab" data-agent-lab>
      <section class="panel agent-lab-status">
        <div>
          <p class="eyebrow">Modo privado · solo administradores</p>
          <h2>Laboratorio del agente comercial</h2>
          <p class="muted">El agente <strong>no es público</strong>${lab.summary ? ` (modo público: ${lab.summary.public_enabled ? "ACTIVADO" : "apagado"}, región: ${esc(lab.summary.region)})` : ""}.
            Las conversaciones de prueba se guardan 30 días solo para evaluación. No escribas datos personales reales.</p>
        </div>
        <div class="agent-lab-budget">
          <small>Presupuesto de pruebas</small>
          <strong>${budget ? `${euros(budget.spent_eur)} de ${Number(budget.limit_eur).toFixed(2)} €` : "—"}</strong>
          <div class="agent-lab-bar"><span style="width:${spentPct.toFixed(1)}%"></span></div>
          ${budget && Number(budget.reserved_eur) > 0 ? `<small>Reservado en curso: ${euros(budget.reserved_eur)}</small>` : ""}
        </div>
      </section>

      ${lab.error ? `<p class="agent-lab-error" role="alert">${esc(lab.error)}</p>` : ""}
      ${renderPublicBudget()}

      <div class="agent-lab-grid">
        <section class="panel agent-lab-chat">
          <header class="agent-lab-toolbar">
            <label>Modelo
              <select data-lab="model">${MODELS.map((m) => `<option ${m === lab.model ? "selected" : ""}>${m}</option>`).join("")}</select>
            </label>
            <button class="ghost-button" data-lab="reset">Nueva conversación</button>
          </header>
          <div class="agent-lab-messages" aria-live="polite">
            ${lab.messages.length ? lab.messages.map(renderMessage).join("") : `<p class="muted">Escribe como lo haría un visitante de la web.</p>`}
          </div>
          <form class="agent-lab-input" data-lab="send">
            <textarea name="message" rows="2" maxlength="1200" placeholder="¿Cuánto cuesta LegalPrevent?" ${lab.busy ? "disabled" : ""}></textarea>
            <button class="primary-button" ${lab.busy ? "disabled" : ""}>${lab.busy ? "Enviando…" : "Enviar"}</button>
          </form>
        </section>

        <section class="panel agent-lab-battery">
          <h3>Batería de evaluación</h3>
          <p class="muted">${lab.battery ? `${esc(lab.battery.version)} · ${lab.battery.casos.length} casos` : "Cargando batería…"}. Se ejecuta con el modelo seleccionado y aplica las reglas automáticas; después valora las respuestas abajo.</p>
          <button class="secondary-button" data-lab="run-battery" ${lab.busy || !lab.battery ? "disabled" : ""}>Ejecutar batería con ${esc(lab.model)}</button>
          ${lab.progress ? `<p class="muted">${esc(lab.progress)}</p>` : ""}
          ${lab.results.length ? renderResults() : ""}
        </section>
      </div>

      <section class="panel">
        <h3>Comparativa por modelo</h3>
        ${renderSummary()}
      </section>

      <section class="panel">
        <h3>Valoración humana (últimos turnos de ${esc(lab.model)})</h3>
        <button class="ghost-button" data-lab="refresh">Actualizar</button>
        ${renderTurns()}
      </section>
    </div>
  `;
}

function renderMessage(message) {
  if (message.role === "user") return `<div class="agent-msg user"><p>${esc(message.text)}</p></div>`;
  const d = message.debug || {};
  const validation = d.filters?.validation?.length ? ` · filtros: ${esc(d.filters.validation.join(", "))}` : "";
  const returned = d.filters?.model_returned ? ` · modelo devuelto ${esc(d.filters.model_returned)}` : "";
  const refusal = d.filters?.refusal ? " · <strong>negativa del modelo</strong>" : "";
  const pe = d.filters?.provider_error;
  const providerError = pe
    ? `<small class="agent-debug agent-provider-error">Error del proveedor: HTTP ${esc(pe.status)}${pe.code ? ` · código ${esc(pe.code)}` : ""}${pe.type ? ` · tipo ${esc(pe.type)}` : ""}${pe.content_type ? ` · ${esc(pe.content_type)}` : ""}${pe.request_id ? ` · petición ${esc(pe.request_id)}` : ""}${pe.message ? `<br>«${esc(pe.message)}»` : ""}</small>`
    : "";
  return `
    <div class="agent-msg assistant">
      <p>${esc(message.text)}</p>
      ${message.actions?.length ? `<div class="agent-actions">${message.actions.map((a) => `<span class="chip">${esc(a.label)}${a.url ? ` → ${esc(a.url)}` : a.form ? " (formulario)" : ""}</span>`).join("")}</div>` : ""}
      <small class="agent-debug">${esc(d.model)} · ${esc(d.provider)} · intención ${esc(message.intent)} ·
        ${d.fallback_reason ? `<strong>fallback: ${esc(d.fallback_reason)}</strong>` : "respuesta del modelo"} ·
        tokens ${d.usage ? `${d.usage.input}/${d.usage.cached}/${d.usage.output}` : "0"} · ${euros(d.cost_eur)} · ${esc(d.latency_ms)} ms${returned}${refusal}${validation}</small>
      ${providerError}
    </div>`;
}

function renderResults() {
  const passed = lab.results.filter((r) => r.pass).length;
  return `
    <p><strong>${passed}/${lab.results.length}</strong> casos sin infracciones automáticas.</p>
    <table class="agent-lab-table">
      <thead><tr><th>Caso</th><th>Categoría</th><th>Resultado</th><th>Fallback</th><th>Coste</th><th>ms</th></tr></thead>
      <tbody>${lab.results.map((r) => `
        <tr class="${r.pass ? "" : "agent-fail"}">
          <td>${esc(r.id)}</td><td>${esc(r.categoria)}</td>
          <td>${r.pass ? "OK" : esc(r.reasons.join("; "))}</td>
          <td>${esc(r.fallbacks.join(", ") || "—")}</td><td>${euros(r.cost)}</td><td>${esc(r.latency)}</td>
        </tr>`).join("")}</tbody>
    </table>`;
}

// Presupuesto PÚBLICO (25 €/mes, PR2e): consumo del mes y alertas 50/80/100 %.
// Solo cifras agregadas. El bloqueo al 100 % lo aplica la base de datos.
// Textos aprobados en el Paso 0: mes con nombre y «1 de [mes siguiente]».
const MONTH_NAMES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const monthName = (iso) => MONTH_NAMES[Number(String(iso || "").slice(5, 7)) - 1] ?? String(iso ?? "");
const ALERT_TEXT = {
  50: (b) => `Agente comercial · 50 % del presupuesto de ${monthName(b.month)}.`,
  80: (b) => `Agente comercial · 80 % del presupuesto. Al llegar al 100 % responderá sin IA hasta el 1 de ${monthName(b.next_month)}.`,
  100: (b) => `Presupuesto agotado. El agente responde sin IA hasta el 1 de ${monthName(b.next_month)}. Las conversaciones siguen ofreciendo diagnóstico, demo y contacto.`,
};
const EMAIL_STATUS = { pending: "email pendiente", sending: "email enviándose", sent: "email enviado", failed: "email fallido (se reintentará)" };
function renderPublicBudget() {
  const b = lab.summary?.public_budget;
  if (!b) return "";
  const pct = Math.min(100, (Number(b.spent_eur) / Math.max(Number(b.limit_eur), 0.0001)) * 100);
  const top = (b.alerts || []).reduce((max, a) => (a.threshold > (max?.threshold ?? 0) ? a : max), null);
  return `
      <section class="panel agent-lab-public-budget">
        <div class="agent-lab-budget">
          <small>Presupuesto público · ${esc(monthName(b.month))} ${esc(String(b.month).slice(0, 4))}</small>
          <strong>${euros(b.spent_eur)} de ${Number(b.limit_eur).toFixed(2)} € · ${pct.toFixed(1)} %</strong>
          <div class="agent-lab-bar"><span style="width:${pct.toFixed(1)}%"></span></div>
          <small>Llamadas hoy: ${esc(b.calls_today)} · modelo público: ${esc(b.model ?? "sin fijar")}${Number(b.reserved_eur) > 0 ? ` · reservado: ${euros(b.reserved_eur)}` : ""}</small>
        </div>
        ${top ? `<p class="agent-lab-alert agent-lab-alert-${esc(top.threshold)}" role="status"><strong>${esc(ALERT_TEXT[top.threshold]?.(b) ?? "")}</strong>
          <small>${(b.alerts || []).map((a) => `${esc(a.threshold)} %: ${esc(EMAIL_STATUS[a.email_status] ?? a.email_status)}`).join(" · ")}</small></p>` : ""}
      </section>`;
}

function renderSummary() {
  const models = lab.summary?.models || [];
  if (!models.length) return `<p class="muted">Aún no hay conversaciones de prueba.</p>`;
  return `
    <table class="agent-lab-table">
      <thead><tr><th>Modelo</th><th>Conversaciones</th><th>Turnos</th><th>Coste/conv.</th><th>p50 ms</th><th>p95 ms</th><th>% fallback</th><th>Valorados</th>${RATING_KEYS.map((k) => `<th>${k}</th>`).join("")}</tr></thead>
      <tbody>${models.map((m) => `
        <tr><td>${esc(m.model)}</td><td>${esc(m.conversations)}</td><td>${esc(m.turns)}</td><td>${euros(m.cost_per_conversation_eur)}</td>
          <td>${esc(Math.round(m.latency_p50_ms ?? 0))}</td><td>${esc(Math.round(m.latency_p95_ms ?? 0))}</td>
          <td>${(Number(m.fallback_rate || 0) * 100).toFixed(1)}</td><td>${esc(m.rated)}</td>
          ${RATING_KEYS.map((k) => `<td>${m.avg_rating?.[k] ?? "—"}</td>`).join("")}</tr>`).join("")}</tbody>
    </table>`;
}

function renderTurns() {
  const turns = lab.turns.filter((t) => t.model === lab.model).slice(0, RATING_TURNS_MAX);
  if (!turns.length) return `<p class="muted">Sin turnos todavía con ${esc(lab.model)}.</p>`;
  return `<div class="agent-lab-turns">${turns.map((t) => `
    <form class="agent-turn" data-lab="rate" data-id="${esc(t.id)}">
      <p><small>${esc(t.model)} · ${esc(t.case_id || "libre")} · turno ${esc(t.turn)}${t.filters?.model_returned ? ` · ${esc(t.filters.model_returned)}` : ""}${t.filters?.refusal ? " · negativa del modelo" : ""} ${t.fallback_reason ? `· fallback ${esc(t.fallback_reason)}` : ""}${t.filters?.provider_error ? ` · HTTP ${esc(t.filters.provider_error.status)}${t.filters.provider_error.message ? ` «${esc(t.filters.provider_error.message)}»` : ""}` : ""}</small></p>
      <p><strong>Visitante:</strong> ${esc(t.user_text)}</p>
      <p><strong>Agente:</strong> ${esc(t.reply)}</p>
      <div class="agent-rating">
        ${RATING_KEYS.map((k) => `<label>${k}<select name="${k}"><option value="">—</option>${[1, 2, 3, 4, 5].map((n) => `<option ${t.rating?.[k] === n ? "selected" : ""}>${n}</option>`).join("")}</select></label>`).join("")}
        <input name="comment" maxlength="500" placeholder="Comentario" value="${esc(t.comment || "")}">
        <button class="secondary-button">${t.rating ? "Actualizar" : "Valorar"}</button>
      </div>
    </form>`).join("")}</div>`;
}

// ---------------------------------------------------------------------------
// Datos y acciones
// ---------------------------------------------------------------------------
async function refresh(rerender) {
  try {
    const [summary, turns] = await Promise.all([api().agentLabSummary(), api().agentLabTurns(null, 300)]);
    lab.summary = summary;
    lab.turns = turns || [];
    lab.error = "";
  } catch (error) {
    lab.error = error.message;
  }
  rerender();
}

async function send(message, rerender, caseId = null) {
  lab.messages.push({ role: "user", text: message });
  const result = await api().agentLabSend({ model: lab.model, message, state: lab.state, caseId });
  lab.state = result.state;
  lab.messages.push({ role: "assistant", text: result.reply, actions: result.actions, intent: result.intent, debug: result.debug });
  rerender();
  return result;
}

const globalRules = () =>
  (lab.battery?.reglas_globales?.must_not_regex || []).map((rule) =>
    rule.startsWith("(?i)") ? new RegExp(rule.slice(4), "i") : new RegExp(rule));

function turnText(turn) {
  // Marcadores de la batería del tipo "<1.200 caracteres …>" → texto real.
  const long = /^<\s*([\d.]+)\s*caracteres/i.exec(turn);
  return long ? `${"Necesito información detallada. ".repeat(Math.ceil(Number(long[1].replace(".", "")) / 32))}¿Cuánto cuesta?` : turn;
}

async function runBattery(rerender) {
  const cases = lab.battery.casos;
  const maxEur = { "gpt-5.4-mini": 0.6, "gpt-5.6-luna": 0.2, "gpt-6-luna": 0.1 }[lab.model] ?? 1;
  if (!window.confirm(`Ejecutar ${cases.length} casos con ${lab.model}? Coste máximo estimado con el modelo real: ~${maxEur.toFixed(2)} €. (Con el simulador: 0 €.)`)) return;
  lab.busy = true;
  lab.results = [];
  const rules = globalRules();
  for (const [index, testCase] of cases.entries()) {
    lab.progress = `Caso ${index + 1}/${cases.length}: ${testCase.id}`;
    lab.state = null;
    lab.messages = [];
    rerender();
    const reasons = [];
    const fallbacks = [];
    let cost = 0;
    let latency = 0;
    let last = null;
    try {
      for (const turn of testCase.turnos) {
        await sleep(BATTERY_PACE_MS);
        const stateBefore = lab.state;
        last = await send(turnText(turn), rerender, testCase.id);
        if (last.debug?.fallback_reason === "rate_limited") {
          lab.progress = `Caso ${index + 1}/${cases.length}: ${testCase.id} · tope por minuto alcanzado, esperando…`;
          rerender();
          await sleep(RATE_LIMIT_WAIT_MS);
          lab.state = stateBefore;
          lab.messages.splice(-2, 2);
          last = await send(turnText(turn), rerender, testCase.id);
        }
        cost += Number(last.debug?.cost_eur || 0);
        latency = Math.max(latency, Number(last.debug?.latency_ms || 0));
        if (last.debug?.fallback_reason) fallbacks.push(last.debug.fallback_reason);
        for (const rule of rules) if (rule.test(last.reply)) reasons.push(`regla ${rule.source.slice(0, 24)}…`);
      }
      const ids = (last?.actions || []).map((a) => a.id);
      if (testCase.acciones?.length && !testCase.acciones.some((a) => ids.includes(a))) reasons.push(`acción esperada: ${testCase.acciones.join(" | ")}`);
      if (testCase.intent && last?.intent !== testCase.intent) reasons.push(`intención ${last?.intent} ≠ ${testCase.intent}`);
      // Brevedad (casos de alcance, v1.2): sin contar la frase de identificación como IA.
      const words = (last?.reply || "").replace(/^Soy el asistente virtual de LegalPrevent, una inteligencia artificial\.\s*/, "").trim().split(/\s+/).filter(Boolean).length;
      if (testCase.max_palabras && words > testCase.max_palabras) reasons.push(`${words} palabras > ${testCase.max_palabras}`);
      if (!/^Soy el asistente virtual de LegalPrevent, una inteligencia artificial\./.test(lab.messages.find((m) => m.role === "assistant")?.text || "")) reasons.push("sin identificación como IA");
    } catch (error) {
      reasons.push(`error: ${error.message}`);
    }
    lab.results.push({ id: testCase.id, categoria: testCase.categoria, pass: reasons.length === 0, reasons, fallbacks, cost, latency });
  }
  lab.busy = false;
  lab.progress = `Batería terminada con ${lab.model}.`;
  await refresh(rerender);
}

export function mountAgentLab(root, rerender) {
  if (!root || root.dataset.mounted) return;
  root.dataset.mounted = "1";
  const rerenderLab = () => {
    const scrollY = window.scrollY;
    rerender();
    window.scrollTo(0, scrollY);
  };
  if (!lab.battery) {
    fetch(BATTERY_URL, { cache: "no-store" }).then((r) => r.json()).then((battery) => { lab.battery = battery; rerenderLab(); })
      .catch(() => { lab.error = "No se pudo cargar la batería de evaluación."; rerenderLab(); });
  }
  if (!lab.summary) refresh(rerenderLab);
}

export async function handleAgentLabEvent(event, rerender) {
  const target = event.target.closest("[data-lab]");
  if (!target) return false;
  const kind = target.dataset.lab;
  if (event.type === "change" && kind === "model") {
    lab.model = target.value;
    lab.state = null;
    lab.messages = [];
    rerender();
    return true;
  }
  if (event.type === "click" && kind === "reset") {
    lab.state = null;
    lab.messages = [];
    rerender();
    return true;
  }
  if (event.type === "click" && kind === "refresh") {
    await refresh(rerender);
    return true;
  }
  if (event.type === "click" && kind === "run-battery") {
    await runBattery(rerender);
    return true;
  }
  if (event.type === "submit" && kind === "send") {
    event.preventDefault();
    const message = new FormData(target).get("message")?.toString().trim();
    if (!message || lab.busy) return true;
    lab.busy = true;
    lab.error = "";
    rerender();
    try {
      await send(message, rerender);
    } catch (error) {
      lab.error = error.message;
    }
    lab.busy = false;
    await refresh(rerender);
    return true;
  }
  if (event.type === "submit" && kind === "rate") {
    event.preventDefault();
    const data = new FormData(target);
    const rating = Object.fromEntries(RATING_KEYS.filter((k) => data.get(k)).map((k) => [k, Number(data.get(k))]));
    try {
      await api().agentLabRate(Number(target.dataset.id), rating, String(data.get("comment") || ""));
      await refresh(rerender);
    } catch (error) {
      lab.error = error.message;
      rerender();
    }
    return true;
  }
  return false;
}
