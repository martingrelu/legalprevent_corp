// Aviso interno de nuevo lead (desplegada en Supabase como `smooth-action`).
//
// Seguridad (PR0):
// - Solo acepta un `leadId` y el tipo de aviso (`new_lead` | `demo_request`).
//   Todo lo demás del cuerpo se ignora: los datos del email se leen de
//   `public.leads` con la service role, nunca de la petición.
// - Solo envía al buzón interno fijo `LEAD_NOTIFY_EMAIL`. No existe ningún
//   envío a direcciones facilitadas por el visitante.
// - La reclamación y el tope horario global se resuelven en una sola RPC
//   (`claim_lead_notification`) serializada con un advisory lock: cada lead
//   genera como máximo un aviso de cada tipo y las peticiones concurrentes no
//   pueden superar el tope. CORS no se usa como autenticación.
// - Clave de idempotencia en Resend: un reintento tras un fallo ambiguo no
//   duplica el email durante 24 horas.
// - Las respuestas nunca incluyen detalles internos ni errores del proveedor.

type Env = (name: string) => string | undefined;

export type Deps = {
  env: Env;
  fetch: typeof fetch;
};

export type NotificationKind = "new_lead" | "demo_request";

type LeadRow = {
  id: string;
  company_name: string | null;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  sector: string | null;
  employees: number | null;
  source: string | null;
  page_url: string | null;
  score: number | null;
  commercial_consent: boolean | null;
};

type ClaimResult =
  | { status: "throttled" | "not_eligible" }
  | { status: "claimed"; claimed_at: string; lead: LeadRow };

const DEFAULT_ALLOWED_ORIGINS = "https://legalprevent.com,https://www.legalprevent.com";
const DEFAULT_HOURLY_CAP = 20;
const MAX_BODY_BYTES = 64 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;

const text = (value: unknown) => String(value ?? "").trim();

const escapeHtml = (value: unknown) =>
  text(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

// Para asuntos y cabeceras: sin saltos de línea ni caracteres de control.
const singleLine = (value: unknown, max = 120) =>
  text(value).replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, max);

const allowedOrigins = (env: Env) =>
  (env("ALLOWED_ORIGINS") || DEFAULT_ALLOWED_ORIGINS)
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

const corsHeaders = (origin: string | null, env: Env): Record<string, string> => {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
  if (origin && allowedOrigins(env).includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
};

const json = (status: number, body: Record<string, unknown>, cors: Record<string, string>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

// Compatibilidad con la versión anterior del bridge (aún en cachés de
// navegador), que enviaba el lead completo: solo se aprovecha su `id`.
const extractLeadId = (body: unknown) => {
  if (!body || typeof body !== "object") return "";
  const record = body as { leadId?: unknown; lead?: { id?: unknown } };
  return text(record.leadId ?? record.lead?.id);
};

const extractKind = (body: unknown): NotificationKind | null => {
  const kind = (body as { kind?: unknown } | null)?.kind;
  if (kind === undefined) return "new_lead";
  return kind === "new_lead" || kind === "demo_request" ? kind : null;
};

const restHeaders = (serviceKey: string, extra: Record<string, string> = {}) => ({
  apikey: serviceKey,
  Authorization: `Bearer ${serviceKey}`,
  "Content-Type": "application/json",
  ...extra,
});

async function rpc(deps: Deps, baseUrl: string, serviceKey: string, name: string, args: Record<string, unknown>) {
  const response = await deps.fetch(`${baseUrl}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: restHeaders(serviceKey),
    body: JSON.stringify(args),
  });
  if (!response.ok) throw new Error(`${name}_failed`);
  return response.json();
}

async function releaseClaim(
  deps: Deps,
  baseUrl: string,
  serviceKey: string,
  leadId: string,
  kind: NotificationKind,
  claimedAt: string,
) {
  try {
    await rpc(deps, baseUrl, serviceKey, "release_lead_notification", {
      p_lead_id: leadId,
      p_kind: kind,
      p_claimed_at: claimedAt,
    });
  } catch {
    // Si no se puede liberar, el lead sigue visible en el CRM igualmente.
  }
}

export function buildInternalEmail(lead: LeadRow, kind: NotificationKind, env: Env) {
  const brandUrl = env("PUBLIC_SITE_URL") || "https://legalprevent.com";
  const score = lead.score === null || lead.score === undefined ? "" : String(lead.score);
  const subjectSuffix = score ? ` · Score ${score}` : "";
  const company = lead.company_name || "Empresa pendiente";
  const email = text(lead.email).toLowerCase();
  const title = kind === "demo_request"
    ? "Solicitud de demostración tras diagnóstico"
    : "Nuevo lead en Legal Prevent";
  const commercial = lead.commercial_consent === true ? "Sí" : "No";

  const html = `
      <div style="font-family:Inter,Arial,sans-serif;line-height:1.5;color:#0f172a">
        <h1 style="margin:0 0 12px">${escapeHtml(title)}${escapeHtml(subjectSuffix)}</h1>
        <p><strong>Empresa:</strong> ${escapeHtml(company)}</p>
        <p><strong>Contacto:</strong> ${escapeHtml(lead.contact_name || "Contacto pendiente")}</p>
        <p><strong>Email:</strong> ${escapeHtml(email || "No indicado")}</p>
        <p><strong>Teléfono:</strong> ${escapeHtml(lead.phone || "No indicado")}</p>
        <p><strong>Sector:</strong> ${escapeHtml(lead.sector || "No indicado")}</p>
        <p><strong>Empleados:</strong> ${escapeHtml(lead.employees ?? "No indicado")}</p>
        <p><strong>Origen:</strong> ${escapeHtml(lead.source || "web")}</p>
        <p><strong>Página:</strong> ${escapeHtml(lead.page_url || brandUrl)}</p>
        <p><strong>Acepta comunicaciones comerciales:</strong> ${commercial}</p>
        <p style="color:#64748b">Datos leídos del CRM (lead ${escapeHtml(lead.id)}).</p>
      </div>
    `;

  return {
    from: env("FROM_EMAIL") || "Legal Prevent <onboarding@resend.dev>",
    to: [env("LEAD_NOTIFY_EMAIL") || "legal@legalprevent.com"],
    ...(EMAIL_RE.test(email) ? { reply_to: email } : {}),
    subject: singleLine(`${kind === "demo_request" ? "Demo solicitada" : "Nuevo lead Legal Prevent"}: ${company}${subjectSuffix}`),
    html,
  };
}

export async function handleRequest(request: Request, deps: Deps): Promise<Response> {
  const origin = request.headers.get("origin");
  const cors = corsHeaders(origin, deps.env);

  if (origin && !cors["Access-Control-Allow-Origin"]) {
    return json(403, { ok: false, error: "Origen no permitido" }, cors);
  }
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }
  if (request.method !== "POST") {
    return json(405, { ok: false, error: "Método no permitido" }, cors);
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return json(413, { ok: false, error: "Solicitud demasiado grande" }, cors);
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { ok: false, error: "Solicitud no válida" }, cors);
  }

  const leadId = extractLeadId(body);
  const kind = extractKind(body);
  if (!UUID_RE.test(leadId) || !kind) {
    return json(400, { ok: false, error: "Solicitud no válida" }, cors);
  }

  const baseUrl = text(deps.env("SUPABASE_URL")).replace(/\/$/, "");
  const serviceKey = text(deps.env("SUPABASE_SERVICE_ROLE_KEY"));
  const resendKey = text(deps.env("RESEND_API_KEY"));
  if (!baseUrl || !serviceKey || !resendKey) {
    console.error("send-lead-email: configuración incompleta");
    return json(500, { ok: false, error: "Servicio no disponible" }, cors);
  }

  let claim: ClaimResult;
  try {
    claim = (await rpc(deps, baseUrl, serviceKey, "claim_lead_notification", {
      p_lead_id: leadId,
      p_kind: kind,
      p_hourly_cap: Number(deps.env("LEAD_NOTIFY_HOURLY_CAP")) || DEFAULT_HOURLY_CAP,
    })) as ClaimResult;
  } catch (error) {
    console.error("send-lead-email: error de base de datos", error instanceof Error ? error.message : "desconocido");
    return json(500, { ok: false, error: "Servicio no disponible" }, cors);
  }

  if (claim?.status === "throttled") {
    console.warn("send-lead-email: tope horario de avisos alcanzado");
    return json(202, { ok: true, notified: false }, cors);
  }
  // Respuesta idéntica si no existe, ya se notificó o está fuera de plazo: no
  // se revela cuál de los casos se ha dado.
  if (claim?.status !== "claimed" || !claim.lead) {
    return json(200, { ok: true, notified: false }, cors);
  }

  let sent = false;
  try {
    const response = await deps.fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `lead-notification/${kind}/${leadId}`,
      },
      body: JSON.stringify(buildInternalEmail(claim.lead, kind, deps.env)),
    });
    sent = response.ok;
    if (!sent) console.error("send-lead-email: Resend respondió", response.status);
  } catch {
    console.error("send-lead-email: error de red con Resend");
  }

  if (!sent) {
    // Se libera para permitir un reintento dentro del plazo; la clave de
    // idempotencia evita el duplicado si Resend llegó a aceptar el envío.
    await releaseClaim(deps, baseUrl, serviceKey, leadId, kind, claim.claimed_at);
    return json(502, { ok: false, error: "No se pudo enviar el aviso" }, cors);
  }
  return json(200, { ok: true, notified: true }, cors);
}

// En Supabase (Deno) se arranca el servidor; en los tests (Node) solo se
// importan las funciones exportadas.
type DenoLike = {
  serve: (handler: (request: Request) => Promise<Response>) => void;
  env: { get: (name: string) => string | undefined };
};
const denoRuntime = (globalThis as { Deno?: DenoLike }).Deno;
if (denoRuntime?.serve) {
  denoRuntime.serve((request) =>
    handleRequest(request, {
      env: (name) => denoRuntime.env.get(name),
      fetch,
    })
  );
}
