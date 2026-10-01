// Alertas del presupuesto público (PR2e): 50, 80 y 100 %. La base registra
// cada umbral UNA vez por mes (private.agent_budget_alerts) y el CRM lo muestra
// aunque falle el email. Aquí solo se envía el email: se reclaman las alertas
// pendientes con un arrendamiento (nunca dos envíos a la vez) y Resend recibe
// una clave de idempotencia por mes y umbral (un reintento tras un corte no
// duplica el email). Solo cifras agregadas: nunca texto de conversaciones ni
// datos de visitantes. Un fallo aquí no afecta al bloqueo del presupuesto, que
// vive en agent_reserve.

export type AlertClaim = {
  month: string; threshold: number; budget_eur: number; spent_eur: number;
  calls_today: number; projection_eur: number | null; next_month: string; attempt: number;
};

const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const eur = (n: number) => `${Number(n || 0).toFixed(2).replace(".", ",")} €`;
const monthName = (yyyyMm: string) => MONTHS[Number(yyyyMm.slice(5, 7)) - 1] ?? yyyyMm;
const nextMonthName = (yyyyMmDd: string) => `1 de ${MONTHS[Number(yyyyMmDd.slice(5, 7)) - 1] ?? yyyyMmDd}`;

export function buildAlertEmail(alert: AlertClaim): { subject: string; text: string } {
  const mes = monthName(alert.month);
  const gastado = `${eur(alert.spent_eur)} de ${eur(alert.budget_eur)}`;
  const proyeccion = alert.projection_eur === null ? "" : ` Proyección a fin de mes: ${eur(alert.projection_eur)}.`;
  const hasta = nextMonthName(alert.next_month);
  if (alert.threshold >= 100) {
    return {
      subject: `[LegalPrevent] Agente comercial: presupuesto de ${mes} agotado; respuestas sin IA activas`,
      text: [
        `El agente comercial ha alcanzado el límite del presupuesto público de ${mes} (${gastado}).`,
        `Desde ahora responde sin IA (texto fijo con diagnóstico, demo y contacto) hasta el ${hasta}.`,
        `Llamadas hoy: ${alert.calls_today}. Detalle en el CRM → Agente IA.`,
        "Ampliar el presupuesto requiere un cambio de configuración autorizado.",
      ].join("\n"),
    };
  }
  return {
    subject: `[LegalPrevent] Agente comercial: ${alert.threshold} % del presupuesto de ${mes}`,
    text: [
      `El agente comercial ha consumido ${gastado} del presupuesto público de ${mes} (${alert.threshold} %).${proyeccion}`,
      `Llamadas hoy: ${alert.calls_today}.`,
      alert.threshold >= 80
        ? `Si se alcanza el 100 %, responderá sin IA (texto fijo con diagnóstico, demo y contacto) hasta el ${hasta}.`
        : "No hay que hacer nada; es un aviso informativo.",
      "Detalle en el CRM → Agente IA. Este aviso se envía una vez por umbral y mes.",
    ].join("\n"),
  };
}

type Rpc = (name: string, args: Record<string, unknown>) => Promise<any>;
type Env = (name: string) => string | undefined;

// Envía los emails pendientes. Devuelve cuántos se enviaron. Nunca lanza.
export async function deliverAlerts(rpc: Rpc, env: Env, fetchFn: typeof fetch): Promise<number> {
  const apiKey = env("RESEND_API_KEY");
  const from = env("FROM_EMAIL");
  const to = env("AGENT_ALERT_EMAIL") || env("LEAD_NOTIFY_EMAIL");
  // Sin email configurado no se reclama nada: las alertas siguen visibles en el CRM.
  if (!apiKey || !from || !to) return 0;
  let claims: AlertClaim[];
  try {
    claims = await rpc("agent_alerts_claim", { p_lease_seconds: 600 });
  } catch {
    return 0;
  }
  let sent = 0;
  for (const alert of claims ?? []) {
    const { subject, text } = buildAlertEmail(alert);
    let ok = false;
    let error: string | null = null;
    try {
      const response = await fetchFn("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": `agent-budget-alert/${alert.month}/${alert.threshold}`,
        },
        body: JSON.stringify({ from, to: [to], subject, text }),
      });
      ok = response.ok;
      if (!ok) error = `http_${response.status}`;
    } catch {
      error = "network";
    }
    try {
      await rpc("agent_alert_result", { p_month: alert.month, p_threshold: alert.threshold, p_ok: ok, p_error: error });
    } catch {
      // Si no se puede marcar, el arrendamiento caduca y se reintenta; la clave
      // de idempotencia evita el duplicado en Resend.
    }
    if (ok) sent += 1;
  }
  return sent;
}
