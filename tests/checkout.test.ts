// Pruebas del checkout público (`super-api`, PR1e).
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../supabase/functions/create-checkout-session/index.ts";

const env: Record<string, string> = {
  STRIPE_SECRET_KEY: "sk_prueba",
  STRIPE_PRICE_STARTER: "price_starter",
  STRIPE_PRICE_PYME: "price_pyme",
  SUPABASE_URL: "https://proyecto.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-secreta",
  PUBLIC_SITE_URL: "https://legalprevent.com",
};

type Call = { url: string; body: string };
function setup({ allow = true as unknown, allowStatus = 200, stripeStatus = 200, stripeThrows = false, insertStatus = 201 } = {}) {
  const calls: Call[] = [];
  const fakeFetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), body: String(init.body ?? "") });
    if (String(url).endsWith("/rpc/checkout_allow")) return new Response(JSON.stringify(allow), { status: allowStatus });
    if (String(url) === "https://api.stripe.com/v1/checkout/sessions") {
      if (stripeThrows) throw new Error("red caída");
      return stripeStatus === 200
        ? Response.json({ id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1", status: "open", payment_status: "unpaid" })
        : Response.json({ error: { message: "detalle interno de Stripe: price_starter inactivo" } }, { status: stripeStatus });
    }
    if (String(url).endsWith("/rest/v1/checkout_sessions")) return new Response("", { status: insertStatus });
    return new Response("inesperado", { status: 500 });
  }) as typeof fetch;
  const stripeParams = () => new URLSearchParams(calls.find((c) => c.url.startsWith("https://api.stripe.com/"))?.body || "");
  return { calls, stripeParams, deps: { env: (k: string) => env[k], fetch: fakeFetch } };
}

const post = (body: unknown, origin: string | null = "https://legalprevent.com") =>
  new Request("https://proyecto.supabase.co/functions/v1/super-api", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

test("crea la sesión con URL de retorno fijas aunque el cliente envíe otras", async () => {
  const { stripeParams, deps } = setup();
  const response = await handleRequest(post({
    plan: "Starter",
    email: "Ana@Empresa.es",
    successUrl: "https://phishing.example/robo",
    cancelUrl: "javascript:alert(1)",
  }), deps);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" });
  assert.equal(response.headers.get("access-control-allow-origin"), "https://legalprevent.com");
  const params = stripeParams();
  assert.equal(params.get("success_url"), "https://legalprevent.com/gracias/?origen=stripe&plan=starter");
  assert.equal(params.get("cancel_url"), "https://legalprevent.com/#precios");
  assert.equal(params.get("line_items[0][price]"), "price_starter");
  assert.equal(params.get("customer_email"), "ana@empresa.es");
});

test("petición de navegador desde otra web: 403 sin llamar a Stripe ni a la base", async () => {
  for (const method of ["POST", "OPTIONS"]) {
    const { calls, deps } = setup();
    const request = method === "POST"
      ? post({ plan: "starter" }, "https://evil.example")
      : new Request("https://x/functions/v1/super-api", { method, headers: { Origin: "https://evil.example" } });
    const response = await handleRequest(request, deps);
    assert.equal(response.status, 403, method);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.equal(calls.length, 0);
  }
  const { deps } = setup();
  const preflight = await handleRequest(new Request("https://x/functions/v1/super-api", { method: "OPTIONS", headers: { Origin: "https://www.legalprevent.com" } }), deps);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "https://www.legalprevent.com");
});

test("límite superado: 429 sin crear sesión en Stripe", async () => {
  const { calls, deps } = setup({ allow: false });
  const response = await handleRequest(post({ plan: "pyme" }), deps);
  assert.equal(response.status, 429);
  assert.equal(calls.some((c) => c.url.startsWith("https://api.stripe.com/")), false);
});

test("si la base de límites no responde, no se crea la sesión (503)", async () => {
  const { calls, deps } = setup({ allowStatus: 500 });
  assert.equal((await handleRequest(post({ plan: "pyme" }), deps)).status, 503);
  assert.equal(calls.some((c) => c.url.startsWith("https://api.stripe.com/")), false);
});

test("plan no válido o sin precio configurado; cuerpo no JSON", async () => {
  const { calls, deps } = setup();
  assert.equal((await handleRequest(post({ plan: "enterprise" }), deps)).status, 400);
  assert.equal((await handleRequest(post({ plan: "__proto__" }), deps)).status, 400);
  assert.equal((await handleRequest(post("no es json"), deps)).status, 400);
  assert.equal((await handleRequest(post({ plan: "business" }), deps)).status, 500, "business sin STRIPE_PRICE_BUSINESS");
  assert.equal(calls.length, 0);
});

test("email con formato no válido no se envía a Stripe ni al límite por email", async () => {
  const { calls, stripeParams, deps } = setup();
  assert.equal((await handleRequest(post({ plan: "starter", email: "no-es-email\r\nBcc: x@y.z" }), deps)).status, 200);
  assert.equal(stripeParams().get("customer_email"), null);
  assert.deepEqual(JSON.parse(calls[0].body), { p_email: null });
});

test("errores de Stripe: respuesta genérica sin detalles internos", async () => {
  for (const options of [{ stripeStatus: 400 }, { stripeThrows: true }]) {
    const { deps } = setup(options);
    const response = await handleRequest(post({ plan: "starter" }), deps);
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /detalle interno|price_starter|red caída/);
  }
});

test("si no se puede registrar la sesión, el pago sigue adelante", async () => {
  const { deps } = setup({ insertStatus: 500 });
  const response = await handleRequest(post({ plan: "starter" }), deps);
  assert.equal(response.status, 200);
});

test("sin Origin (servidor a servidor) se permite, pero sigue sujeto al límite", async () => {
  const { calls, deps } = setup();
  assert.equal((await handleRequest(post({ plan: "starter" }, null), deps)).status, 200);
  assert.ok(calls[0].url.endsWith("/rpc/checkout_allow"));
});
