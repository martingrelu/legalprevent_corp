// Pruebas de la Edge Function de aviso interno de leads (PR0).
// Ejecutar: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../supabase/functions/send-lead-email/index.ts";

const LEAD_ID = "3f2b9c1e-8a4d-4f6b-9c2e-1a2b3c4d5e6f";
const NOTIFY_TO = "interno@legalprevent.com";
const CLAIMED_AT = "2026-09-24T10:00:00.123456+00:00";

const baseEnv: Record<string, string> = {
  SUPABASE_URL: "https://proyecto.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-secreta",
  RESEND_API_KEY: "re_secreta",
  LEAD_NOTIFY_EMAIL: NOTIFY_TO,
  FROM_EMAIL: "Legal Prevent <noreply@legalprevent.com>",
};

const dbLead = {
  id: LEAD_ID,
  company_name: "Talleres Pérez",
  contact_name: "Ana",
  email: "ana@talleresperez.es",
  phone: "600000000",
  sector: "Industria",
  employees: 12,
  source: "demo_requested",
  page_url: "https://legalprevent.com/",
  score: 64,
  commercial_consent: false,
};

type Call = { url: string; method: string; headers: Record<string, string>; body: string };

function setup(options: {
  env?: Record<string, string>;
  claim?: unknown;
  claimStatus?: number;
  resendStatus?: number;
  resendThrows?: boolean;
} = {}) {
  const env = { ...baseEnv, ...(options.env || {}) };
  const calls: Call[] = [];
  const fakeFetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method || "GET";
    calls.push({
      url,
      method,
      headers: (init.headers || {}) as Record<string, string>,
      body: String(init.body ?? ""),
    });
    if (url.startsWith("https://api.resend.com/")) {
      if (options.resendThrows) throw new Error("red caída con detalle secreto");
      const status = options.resendStatus ?? 200;
      return new Response(JSON.stringify(status === 200 ? { id: "email_1" } : { message: "detalle interno de Resend" }), { status });
    }
    if (url.endsWith("/rest/v1/rpc/claim_lead_notification")) {
      const claim = "claim" in options ? options.claim : { status: "claimed", claimed_at: CLAIMED_AT, lead: dbLead };
      return new Response(JSON.stringify(claim), { status: options.claimStatus ?? 200 });
    }
    if (url.endsWith("/rest/v1/rpc/release_lead_notification")) {
      return new Response("true", { status: 200 });
    }
    return new Response("inesperado", { status: 500 });
  }) as typeof fetch;

  const deps = { env: (name: string) => env[name], fetch: fakeFetch };
  const resendCalls = () => calls.filter((call) => call.url.startsWith("https://api.resend.com/"));
  const rpcCalls = (name: string) => calls.filter((call) => call.url.endsWith(`/rpc/${name}`));
  return { deps, calls, resendCalls, rpcCalls };
}

function post(body: unknown, origin: string | null = "https://legalprevent.com") {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (origin) headers.Origin = origin;
  return new Request("https://proyecto.supabase.co/functions/v1/smooth-action", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("envía un único aviso, solo al buzón interno y con datos leídos de la base", async () => {
  const { deps, resendCalls } = setup();
  const response = await handleRequest(post({ leadId: LEAD_ID }), deps);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, notified: true });

  const sent = resendCalls();
  assert.equal(sent.length, 1, "no debe haber email de confirmación al visitante");
  const message = JSON.parse(sent[0].body);
  assert.deepEqual(message.to, [NOTIFY_TO]);
  assert.equal(message.reply_to, "ana@talleresperez.es");
  assert.match(message.html, /Talleres Pérez/);
});

test("ignora destinatarios y datos inyectados en la petición", async () => {
  const { deps, resendCalls } = setup();
  const response = await handleRequest(
    post({
      leadId: LEAD_ID,
      to: "victima@example.com",
      email: "victima@example.com",
      lead: { email: "victima@example.com", company_name: "<b>phishing</b>" },
      form: { email: "victima@example.com" },
    }),
    deps,
  );
  assert.equal(response.status, 200);
  const sent = resendCalls();
  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0].body, /victima@example\.com|phishing/);
  assert.deepEqual(JSON.parse(sent[0].body).to, [NOTIFY_TO]);
});

test("el formato antiguo con destinatario y sin leadId no envía nada", async () => {
  const { deps, calls } = setup();
  const response = await handleRequest(
    post({ eventType: "demo_requested", lead: { email: "victima@example.com" }, form: { email: "victima@example.com" } }),
    deps,
  );
  assert.equal(response.status, 400);
  assert.equal(calls.length, 0, "no debe consultar la base ni Resend");
});

test("acepta el formato del bridge anterior usando solo lead.id", async () => {
  const { deps, rpcCalls, resendCalls } = setup();
  const response = await handleRequest(
    post({ lead: { id: LEAD_ID, email: "victima@example.com" }, page: "https://evil.example" }),
    deps,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(rpcCalls("claim_lead_notification")[0].body), {
    p_lead_id: LEAD_ID,
    p_kind: "new_lead",
    p_hourly_cap: 20,
  });
  assert.deepEqual(JSON.parse(resendCalls()[0].body).to, [NOTIFY_TO]);
});

test("rechaza leadId o tipo de aviso no válidos sin tocar la base", async () => {
  const bodies = [
    { leadId: "" },
    { leadId: "123" },
    { leadId: `${LEAD_ID}&notified_at=not.is.null` },
    { leadId: "*" },
    { leadId: { id: LEAD_ID } },
    { leadId: LEAD_ID, kind: "confirmation_to_visitor" },
    { leadId: LEAD_ID, kind: null },
  ];
  for (const body of bodies) {
    const { deps, calls } = setup();
    const response = await handleRequest(post(body), deps);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(calls.length, 0);
  }
});

test("la reclamación se hace con una única RPC de la service role (recuento y marca atómicos)", async () => {
  const { deps, calls, rpcCalls } = setup({ env: { LEAD_NOTIFY_HOURLY_CAP: "7" } });
  await handleRequest(post({ leadId: LEAD_ID, kind: "demo_request" }), deps);
  const claims = rpcCalls("claim_lead_notification");
  assert.equal(claims.length, 1);
  assert.deepEqual(JSON.parse(claims[0].body), { p_lead_id: LEAD_ID, p_kind: "demo_request", p_hourly_cap: 7 });
  assert.equal(claims[0].headers.Authorization, "Bearer service-role-secreta");
  assert.equal(
    calls.filter((call) => call.url.includes("/rest/v1/") && !call.url.includes("/rpc/")).length,
    0,
    "no hay lecturas ni escrituras separadas que puedan intercalarse",
  );
});

test("lead inexistente, fuera de plazo o ya notificado: no envía y responde igual", async () => {
  const { deps, resendCalls } = setup({ claim: { status: "not_eligible" } });
  const response = await handleRequest(post({ leadId: LEAD_ID }), deps);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, notified: false });
  assert.equal(resendCalls().length, 0);
});

test("tope horario alcanzado: no envía", async () => {
  const { deps, resendCalls } = setup({ claim: { status: "throttled" } });
  const response = await handleRequest(post({ leadId: LEAD_ID }), deps);
  assert.equal(response.status, 202);
  assert.equal(resendCalls().length, 0);
});

test("respuesta inesperada de la base: no envía", async () => {
  for (const claim of [{}, { status: "claimed" }, null]) {
    const { deps, resendCalls } = setup({ claim });
    const response = await handleRequest(post({ leadId: LEAD_ID }), deps);
    assert.equal(response.status, 200);
    assert.equal(resendCalls().length, 0);
  }
  const failing = setup({ claimStatus: 500 });
  assert.equal((await handleRequest(post({ leadId: LEAD_ID }), failing.deps)).status, 500);
  assert.equal(failing.resendCalls().length, 0);
});

test("usa una clave de idempotencia estable por lead y tipo de aviso", async () => {
  const first = setup();
  await handleRequest(post({ leadId: LEAD_ID }), first.deps);
  const demo = setup();
  await handleRequest(post({ leadId: LEAD_ID, kind: "demo_request" }), demo.deps);
  assert.equal(first.resendCalls()[0].headers["Idempotency-Key"], `lead-notification/new_lead/${LEAD_ID}`);
  assert.equal(demo.resendCalls()[0].headers["Idempotency-Key"], `lead-notification/demo_request/${LEAD_ID}`);
});

test("si Resend falla, libera solo la reclamación propia y no filtra detalles", async () => {
  for (const options of [{ resendStatus: 500 }, { resendThrows: true }]) {
    const { deps, rpcCalls } = setup(options);
    const response = await handleRequest(post({ leadId: LEAD_ID }), deps);
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /Resend|secreto|interno de/);
    const releases = rpcCalls("release_lead_notification");
    assert.equal(releases.length, 1);
    assert.deepEqual(JSON.parse(releases[0].body), {
      p_lead_id: LEAD_ID,
      p_kind: "new_lead",
      p_claimed_at: CLAIMED_AT,
    });
  }
});

test("el aviso de demo se distingue del de nuevo lead y muestra el consentimiento comercial", async () => {
  const { deps, resendCalls } = setup({
    claim: { status: "claimed", claimed_at: CLAIMED_AT, lead: { ...dbLead, source: "diagnostic_completed", commercial_consent: true } },
  });
  await handleRequest(post({ leadId: LEAD_ID, kind: "demo_request" }), deps);
  const message = JSON.parse(resendCalls()[0].body);
  assert.match(message.subject, /^Demo solicitada: Talleres Pérez/);
  assert.match(message.html, /Solicitud de demostración tras diagnóstico/);
  assert.match(message.html, /Acepta comunicaciones comerciales:<\/strong> Sí/);

  const newLead = setup();
  await handleRequest(post({ leadId: LEAD_ID }), newLead.deps);
  const newMessage = JSON.parse(newLead.resendCalls()[0].body);
  assert.match(newMessage.subject, /^Nuevo lead Legal Prevent: /);
  assert.match(newMessage.html, /Acepta comunicaciones comerciales:<\/strong> No/);
});

test("escapa el HTML y limpia saltos de línea del asunto", async () => {
  const hostile = {
    ...dbLead,
    company_name: 'ACME\r\nBcc: x@evil.com <script>alert("x")</script>',
    contact_name: "<img src=x onerror=alert(1)>",
    email: "no-es-un-email",
  };
  const { deps, resendCalls } = setup({ claim: { status: "claimed", claimed_at: CLAIMED_AT, lead: hostile } });
  await handleRequest(post({ leadId: LEAD_ID }), deps);
  const message = JSON.parse(resendCalls()[0].body);
  assert.doesNotMatch(message.subject, /[\r\n]/);
  assert.ok(message.subject.length <= 120);
  assert.doesNotMatch(message.html, /<script|<img/);
  assert.match(message.html, /&lt;script&gt;/);
  assert.equal("reply_to" in message, false, "no se usa reply_to con un email no válido");
});

test("CORS: origen no permitido recibe 403 sin tocar la base", async () => {
  const { deps, calls } = setup();
  const response = await handleRequest(post({ leadId: LEAD_ID }, "https://evil.example"), deps);
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
  assert.equal(calls.length, 0);
});

test("CORS: preflight del dominio oficial devuelve su origen, no un comodín", async () => {
  const { deps } = setup();
  const response = await handleRequest(
    new Request("https://proyecto.supabase.co/functions/v1/smooth-action", {
      method: "OPTIONS",
      headers: { Origin: "https://www.legalprevent.com" },
    }),
    deps,
  );
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://www.legalprevent.com");
});

test("rechaza métodos distintos de POST, JSON inválido y cuerpos grandes", async () => {
  const { deps, calls } = setup();
  const get = await handleRequest(new Request("https://x/functions/v1/smooth-action", { method: "GET" }), deps);
  assert.equal(get.status, 405);
  assert.equal((await handleRequest(post("{no json"), deps)).status, 400);
  assert.equal((await handleRequest(post({ leadId: LEAD_ID, relleno: "x".repeat(70_000) }), deps)).status, 413);
  assert.equal(calls.length, 0);
});

test("sin configuración completa responde 500 genérico sin llamar a nadie", async () => {
  const { deps, calls } = setup({ env: { SUPABASE_SERVICE_ROLE_KEY: "" } });
  const response = await handleRequest(post({ leadId: LEAD_ID }), deps);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { ok: false, error: "Servicio no disponible" });
  assert.equal(calls.length, 0);
});
