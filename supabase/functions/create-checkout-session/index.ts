// Checkout público de la web (desplegada en Supabase como `super-api`).
//
// Seguridad (PR1e):
// - Las URL de retorno las fija el servidor (PUBLIC_SITE_URL): se ignoran las
//   que envíe el cliente, así nadie puede usar una sesión de pago de
//   LegalPrevent para redirigir a otra web.
// - CORS solo para las webs permitidas (ALLOWED_ORIGINS); una petición de
//   navegador desde otro origen se rechaza. CORS no es autenticación (una
//   llamada directa puede omitir o falsear Origin): el control real es
//   checkout_allow, que se aplica a todas las peticiones antes de Stripe.
// - El email solo se pasa a Stripe si tiene formato válido.
// - Las respuestas nunca incluyen detalles de Stripe ni internos.

type Env = (name: string) => string | undefined;

export type Deps = {
  env: Env;
  fetch: typeof fetch;
};

const DEFAULT_ALLOWED_ORIGINS = "https://legalprevent.com,https://www.legalprevent.com";
const DEFAULT_SITE_URL = "https://legalprevent.com";
const MAX_BODY_BYTES = 8 * 1024;
const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;

const PLAN_PRICE_ENV: Record<string, string> = {
  starter: "STRIPE_PRICE_STARTER",
  pyme: "STRIPE_PRICE_PYME",
  business: "STRIPE_PRICE_BUSINESS",
  gestorias: "STRIPE_PRICE_GESTORIAS",
};

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
  if (origin && allowedOrigins(env).includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
};

const json = (status: number, body: Record<string, unknown>, cors: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const GENERIC_ERROR = "No se ha podido iniciar el pago. Inténtalo de nuevo o escríbenos.";

// URL de retorno fijas: solo dependen de la configuración y del plan validado.
export function returnUrls(env: Env, plan: string) {
  const site = (env("PUBLIC_SITE_URL") || DEFAULT_SITE_URL).replace(/\/+$/, "");
  return {
    success: `${site}/gracias/?origen=stripe&plan=${encodeURIComponent(plan)}`,
    cancel: `${site}/#precios`,
  };
}

export async function handleRequest(request: Request, deps: Deps): Promise<Response> {
  const { env } = deps;
  const origin = request.headers.get("origin");
  const cors = corsHeaders(origin, env);

  if (origin && !allowedOrigins(env).includes(origin)) return json(403, { error: "Origen no permitido" }, cors);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return json(405, { error: "Método no permitido" }, cors);

  const stripeKey = env("STRIPE_SECRET_KEY");
  const baseUrl = (env("SUPABASE_URL") || "").replace(/\/+$/, "");
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!stripeKey || !baseUrl || !serviceKey) {
    console.error("super-api: falta configuración");
    return json(500, { error: GENERIC_ERROR }, cors);
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json(413, { error: "Petición demasiado grande" }, cors);
  let body: { plan?: unknown; email?: unknown };
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    return json(400, { error: "Petición no válida" }, cors);
  }

  const plan = String(body?.plan ?? "").trim().toLowerCase();
  if (!Object.hasOwn(PLAN_PRICE_ENV, plan)) return json(400, { error: "Plan no válido" }, cors);
  const priceId = env(PLAN_PRICE_ENV[plan]);
  if (!priceId) {
    console.error("super-api: plan sin precio configurado", plan);
    return json(500, { error: GENERIC_ERROR }, cors);
  }
  const rawEmail = String(body?.email ?? "").trim().toLowerCase();
  const email = rawEmail.length <= 254 && EMAIL_RE.test(rawEmail) ? rawEmail : "";

  const restHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };

  // Límite antes de tocar Stripe. Si la base no responde, no se crea la sesión.
  try {
    const limit = await deps.fetch(`${baseUrl}/rest/v1/rpc/checkout_allow`, {
      method: "POST",
      headers: restHeaders,
      body: JSON.stringify({ p_email: email || null }),
    });
    if (!limit.ok) {
      console.error("super-api: checkout_allow respondió", limit.status);
      return json(503, { error: GENERIC_ERROR }, cors);
    }
    if ((await limit.json()) !== true) {
      console.warn("super-api: límite de checkout alcanzado");
      return json(429, { error: "Demasiados intentos. Inténtalo en unos minutos." }, cors);
    }
  } catch {
    console.error("super-api: error de red con la base (límites)");
    return json(503, { error: GENERIC_ERROR }, cors);
  }

  const urls = returnUrls(env, plan);
  const params = new URLSearchParams({
    mode: "subscription",
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
    success_url: urls.success,
    cancel_url: urls.cancel,
    "metadata[plan]": plan,
    "metadata[source]": "legalprevent_web",
    "subscription_data[metadata][plan]": plan,
    allow_promotion_codes: "true",
    "automatic_tax[enabled]": "true",
    billing_address_collection: "required",
    "tax_id_collection[enabled]": "true",
  });
  if (email) params.set("customer_email", email);

  let session: { id?: string; url?: string; status?: string; payment_status?: string; customer_email?: string };
  try {
    const response = await deps.fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${stripeKey}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    });
    session = await response.json().catch(() => ({}));
    if (!response.ok || !session.id || !session.url) {
      console.error("super-api: Stripe respondió", response.status);
      return json(502, { error: GENERIC_ERROR }, cors);
    }
  } catch {
    console.error("super-api: error de red con Stripe");
    return json(502, { error: GENERIC_ERROR }, cors);
  }

  // Registro de la sesión abierta. Si falla, el pago sigue adelante: el
  // webhook la registrará al completarse.
  try {
    const insert = await deps.fetch(`${baseUrl}/rest/v1/checkout_sessions`, {
      method: "POST",
      headers: { ...restHeaders, Prefer: "return=minimal" },
      body: JSON.stringify({
        stripe_session_id: session.id,
        plan,
        price_id: priceId,
        status: session.status || null,
        payment_status: session.payment_status || null,
        customer_email: session.customer_email || email || null,
        checkout_url: session.url,
        payload: session,
      }),
    });
    if (!insert.ok) console.error("super-api: no se pudo registrar la sesión", insert.status);
  } catch {
    console.error("super-api: error de red al registrar la sesión");
  }

  return json(200, { id: session.id, url: session.url }, cors);
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
