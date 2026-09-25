// Webhook de Stripe (desplegada en Supabase como `stripe-webhook`, la URL que
// tiene configurada Stripe; verify_jwt desactivado: la autenticación es la
// firma de Stripe).
//
// Seguridad y fiabilidad (PR1d):
// - Firma HMAC de Stripe con tolerancia de 5 minutos (rechaza mensajes
//   antiguos reenviados) y aceptando cualquiera de las firmas v1 (Stripe envía
//   dos durante la rotación del secreto).
// - Adaptado a la API 2026-04-22 (y anteriores): el periodo de la suscripción
//   está en sus items y la suscripción de una factura en `parent`.
// - Todo se guarda con una sola RPC (`stripe_record_event`) que descarta
//   duplicados y eventos más antiguos que el último aplicado.
// - Si la base falla se responde 500 para que Stripe reintente; nunca se
//   confirma un evento que no se ha guardado.
// - Las respuestas nunca incluyen detalles internos.

type Env = (name: string) => string | undefined;

export type Deps = {
  env: Env;
  fetch: typeof fetch;
  now?: () => number; // milisegundos
};

// deno-lint-ignore no-explicit-any
type StripeObject = Record<string, any>;
type Kind = "checkout_session" | "subscription" | "payment" | "ignored";

export const TOLERANCE_SECONDS = 300;
const MAX_BODY_BYTES = 512 * 1024;
const encoder = new TextEncoder();

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const hexToBytes = (hex: string) => {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
};

const timingSafeEqual = (a: Uint8Array, b: Uint8Array) => {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let index = 0; index < a.length; index += 1) result |= a[index] ^ b[index];
  return result === 0;
};

export async function verifyStripeSignature(payload: string, header: string, secret: string, nowSeconds: number) {
  let timestamp = "";
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [key, ...rest] = part.trim().split("=");
    const value = rest.join("=");
    if (key === "t") timestamp = value;
    if (key === "v1") signatures.push(value);
  }
  if (!/^\d+$/.test(timestamp) || signatures.length === 0) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > TOLERANCE_SECONDS) return false;

  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${payload}`)));
  return signatures.some((signature) => {
    const bytes = hexToBytes(signature);
    return bytes !== null && timingSafeEqual(digest, bytes);
  });
}

const stripeId = (value: unknown) => {
  if (typeof value === "string") return value || null;
  if (value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string") return (value as { id: string }).id;
  return null;
};
const isoFromSeconds = (seconds: unknown) =>
  typeof seconds === "number" && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;

// Traduce el evento a la fila que guarda stripe_record_event.
export function mapEvent(event: { type?: string; data?: { object?: StripeObject } }): { kind: Kind; row: Record<string, unknown> } {
  const object: StripeObject = event.data?.object || {};
  const type = event.type || "";

  if (type.startsWith("checkout.session.")) {
    return {
      kind: "checkout_session",
      row: {
        stripe_session_id: object.id,
        stripe_customer_id: stripeId(object.customer),
        stripe_subscription_id: stripeId(object.subscription),
        plan: object.metadata?.plan || null,
        status: object.status || null,
        payment_status: object.payment_status || null,
        customer_email: object.customer_details?.email || object.customer_email || null,
        payload: object,
      },
    };
  }

  if (type.startsWith("customer.subscription.")) {
    // Desde la API 2025-03-31 el periodo está en cada item de la suscripción.
    const item = object.items?.data?.[0] || {};
    return {
      kind: "subscription",
      row: {
        stripe_subscription_id: object.id,
        stripe_customer_id: stripeId(object.customer),
        plan: object.metadata?.plan || item.price?.metadata?.plan || null,
        status: object.status || null,
        current_period_start: isoFromSeconds(item.current_period_start ?? object.current_period_start),
        current_period_end: isoFromSeconds(item.current_period_end ?? object.current_period_end),
        cancel_at_period_end: Boolean(object.cancel_at_period_end),
        payload: object,
      },
    };
  }

  if (type === "invoice.paid" || type === "invoice.payment_failed") {
    return {
      kind: "payment",
      row: {
        stripe_invoice_id: object.id,
        stripe_customer_id: stripeId(object.customer),
        // Desde la API 2025-03-31 la suscripción de la factura está en `parent`.
        stripe_subscription_id: stripeId(object.parent?.subscription_details?.subscription) || stripeId(object.subscription),
        amount_paid: Number.isInteger(object.amount_paid) ? object.amount_paid : 0,
        currency: object.currency || "eur",
        status: object.status || null,
        hosted_invoice_url: object.hosted_invoice_url || null,
        payload: object,
      },
    };
  }

  // customer.created, invoice_payment.paid...: solo se registra que llegaron.
  return { kind: "ignored", row: {} };
}

export async function handleRequest(request: Request, deps: Deps): Promise<Response> {
  if (request.method !== "POST") return json(405, { error: "Método no permitido" });

  const secret = deps.env("STRIPE_WEBHOOK_SECRET");
  const baseUrl = deps.env("SUPABASE_URL");
  const serviceKey = deps.env("SUPABASE_SERVICE_ROLE_KEY");
  if (!secret || !baseUrl || !serviceKey) {
    console.error("stripe-webhook: falta configuración");
    return json(500, { error: "Configuración incompleta" });
  }

  const rawBody = await request.text();
  if (encoder.encode(rawBody).length > MAX_BODY_BYTES) return json(413, { error: "Evento demasiado grande" });

  const nowSeconds = Math.floor((deps.now ? deps.now() : Date.now()) / 1000);
  const valid = await verifyStripeSignature(rawBody, request.headers.get("stripe-signature") || "", secret, nowSeconds);
  if (!valid) return json(400, { error: "Firma no válida" });

  let event: { id?: unknown; type?: unknown; created?: unknown; data?: { object?: StripeObject } };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json(400, { error: "Evento no válido" });
  }
  if (typeof event.id !== "string" || typeof event.type !== "string" || typeof event.created !== "number") {
    return json(400, { error: "Evento no válido" });
  }

  const { kind, row } = mapEvent(event as { type: string; data?: { object?: StripeObject } });
  try {
    const response = await deps.fetch(`${baseUrl.replace(/\/+$/, "")}/rest/v1/rpc/stripe_record_event`, {
      method: "POST",
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        p_event_id: event.id,
        p_type: event.type,
        p_created: new Date(event.created * 1000).toISOString(),
        p_kind: kind,
        p_row: row,
      }),
    });
    if (!response.ok) {
      console.error("stripe-webhook: la base respondió", response.status, event.type);
      return json(500, { error: "No se pudo registrar el evento" });
    }
    const result = await response.json();
    console.info("stripe-webhook:", event.type, result?.status);
  } catch {
    console.error("stripe-webhook: error de red con la base", event.type);
    return json(500, { error: "No se pudo registrar el evento" });
  }

  return json(200, { received: true });
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
