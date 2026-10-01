// Alertas del presupuesto público (PR2e): contenido del email (solo cifras
// agregadas), envío con idempotencia, fallo y reintento, y que nada de esto
// afecte a la respuesta al visitante. Sin red: Resend y la base son falsos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAlertEmail, deliverAlerts, type AlertClaim } from "../supabase/functions/sales-agent/alerts.ts";
import { handleRequest } from "../supabase/functions/sales-agent/index.ts";
import { simulatedProvider } from "../supabase/functions/sales-agent/providers.ts";

const claim = (threshold: number, extra: Partial<AlertClaim> = {}): AlertClaim => ({
  month: "2026-10", threshold, budget_eur: 25, spent_eur: threshold === 100 ? 25 : (25 * threshold) / 100 + 0.01,
  calls_today: 214, projection_eur: 23.9, next_month: "2026-11-01", attempt: 1, ...extra,
});

test("email de alerta: textos aprobados por umbral y solo cifras agregadas", () => {
  const e50 = buildAlertEmail(claim(50));
  assert.equal(e50.subject, "[LegalPrevent] Agente comercial: 50 % del presupuesto de octubre");
  assert.match(e50.text, /12,51 € de 25,00 €.*\(50 %\)\. Proyección a fin de mes: 23,90 €/);
  assert.match(e50.text, /Llamadas hoy: 214/);
  const e80 = buildAlertEmail(claim(80));
  assert.match(e80.text, /Si se alcanza el 100 %, responderá sin IA .* hasta el 1 de noviembre/);
  const e100 = buildAlertEmail(claim(100));
  assert.equal(e100.subject, "[LegalPrevent] Agente comercial: presupuesto de octubre agotado; respuestas sin IA activas");
  assert.match(e100.text, /hasta el 1 de noviembre/);
  for (const e of [e50, e80, e100]) assert.doesNotMatch(e.text + e.subject, /@|session|conversaci[oó]n|mensaje del|visitante/i);
});

function fakes(opts: { claims?: AlertClaim[]; resend?: number | "network" } = {}) {
  const rpcs: Array<{ name: string; args: any }> = [];
  const posts: Array<{ headers: Record<string, string>; body: any }> = [];
  const rpc = async (name: string, args: Record<string, unknown>) => {
    rpcs.push({ name, args });
    if (name === "agent_alerts_claim") return opts.claims ?? [];
    return { status: "ok" };
  };
  const fetchFn = (async (_url: string, init: RequestInit = {}) => {
    posts.push({ headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    if (opts.resend === "network") throw new TypeError("fetch failed");
    return new Response("{}", { status: opts.resend ?? 200 });
  }) as typeof fetch;
  return { rpcs, posts, rpc, fetchFn };
}
const ENV: Record<string, string> = { RESEND_API_KEY: "re_test", FROM_EMAIL: "LegalPrevent <avisos@legalprevent.com>", LEAD_NOTIFY_EMAIL: "equipo@legalprevent.com" };

test("envío: clave de idempotencia por mes y umbral, y resultado registrado", async () => {
  const f = fakes({ claims: [claim(50), claim(80)] });
  const sent = await deliverAlerts(f.rpc, (k) => ENV[k], f.fetchFn);
  assert.equal(sent, 2);
  assert.deepEqual(f.posts.map((p) => p.headers["Idempotency-Key"]), ["agent-budget-alert/2026-10/50", "agent-budget-alert/2026-10/80"]);
  assert.deepEqual(f.posts[0].body.to, ["equipo@legalprevent.com"]);
  const results = f.rpcs.filter((r) => r.name === "agent_alert_result").map((r) => r.args);
  assert.deepEqual(results, [
    { p_month: "2026-10", p_threshold: 50, p_ok: true, p_error: null },
    { p_month: "2026-10", p_threshold: 80, p_ok: true, p_error: null },
  ]);
});

test("envío: AGENT_ALERT_EMAIL tiene prioridad sobre LEAD_NOTIFY_EMAIL", async () => {
  const f = fakes({ claims: [claim(50)] });
  await deliverAlerts(f.rpc, (k) => ({ ...ENV, AGENT_ALERT_EMAIL: "alertas@legalprevent.com" } as Record<string, string>)[k], f.fetchFn);
  assert.deepEqual(f.posts[0].body.to, ["alertas@legalprevent.com"]);
});

test("fallo de Resend o de red: se marca como fallida (se reintentará) y no lanza", async () => {
  for (const resend of [500, "network"] as const) {
    const f = fakes({ claims: [claim(80)], resend });
    assert.equal(await deliverAlerts(f.rpc, (k) => ENV[k], f.fetchFn), 0);
    const result = f.rpcs.find((r) => r.name === "agent_alert_result")!.args;
    assert.equal(result.p_ok, false);
    assert.equal(result.p_error, resend === "network" ? "network" : "http_500");
  }
});

test("sin email configurado no se reclama nada (las alertas siguen visibles en el CRM)", async () => {
  const f = fakes({ claims: [claim(50)] });
  assert.equal(await deliverAlerts(f.rpc, (k) => (k === "RESEND_API_KEY" ? undefined : ENV[k]), f.fetchFn), 0);
  assert.equal(f.rpcs.length, 0);
  assert.equal(f.posts.length, 0);
});

// Integración con la función: alertas en segundo plano, sin afectar al visitante.
const SECRET = "secreto-de-prueba-de-al-menos-32-caracteres";
const CONFIG = {
  enabled: true, public_enabled: true, preview_enabled: true, region: "eu", default_model: "gpt-6-luna",
  models: { "gpt-6-luna": { in: 0.1, cached_in: 0.01, out: 0.5, eu: null } },
  max_input_chars: 1000, max_output_tokens: 400, max_history_turns: 8,
};
function agentSetup(opts: { settle?: Record<string, unknown>; reserve?: Record<string, unknown>; resend?: number; edgeRuntime?: boolean } = {}) {
  const rpcs: Array<{ name: string; args: any }> = [];
  const resendPosts: string[] = [];
  const background: Array<Promise<unknown>> = [];
  const fakeFetch = (async (url: string, init: RequestInit = {}) => {
    if (String(url).startsWith("https://api.resend.com/")) {
      resendPosts.push(String(init.body));
      return new Response("{}", { status: opts.resend ?? 200 });
    }
    const name = String(url).split("/rpc/")[1];
    rpcs.push({ name, args: JSON.parse(String(init.body || "{}")) });
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (name === "agent_runtime_config") return ok(CONFIG);
    if (name === "agent_reserve") return ok(opts.reserve ?? { status: "reserved", reservation_id: "pub-1" });
    if (name === "agent_settle") return ok(opts.settle ?? { status: "settled", cost_eur: 0.0002, alerts_pending: false });
    if (name === "agent_release") return ok({ status: "released" });
    if (name === "agent_track_event") return ok({ ok: true });
    if (name === "agent_alerts_claim") return ok([claim(50)]);
    if (name === "agent_alert_result") return ok({ status: "ok" });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const env: Record<string, string> = {
    SUPABASE_URL: "https://p.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service", SUPABASE_ANON_KEY: "anon", AGENT_STATE_SECRET: SECRET, ...ENV,
  };
  const deps = { env: (k: string) => env[k], fetch: fakeFetch, provider: simulatedProvider(),
    ...(opts.edgeRuntime ? {} : { waitUntil: (t: Promise<unknown>) => { background.push(t); } }) };
  const visit = () => handleRequest(new Request("https://p.supabase.co/functions/v1/sales-agent", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer anon", Origin: "https://legalprevent.com" },
    body: JSON.stringify({ message: "¿Cuánto cuesta?" }),
  }), deps);
  return { rpcs, resendPosts, background, visit };
}

test("integración: liquidar con alertas pendientes envía el email en segundo plano", async () => {
  const s = agentSetup({ settle: { status: "settled", cost_eur: 0.0002, alerts_pending: true } });
  const response = await s.visit();
  assert.equal(response.status, 200);
  assert.equal(s.background.length, 1, "la entrega va en segundo plano");
  await Promise.all(s.background);
  assert.equal(s.resendPosts.length, 1);
  assert.doesNotMatch(s.resendPosts[0], /Cuánto cuesta/);
  // La liquidación lleva los tokens en caché.
  assert.ok("p_cached_tokens" in s.rpcs.find((r) => r.name === "agent_settle")!.args);
});

test("integración: sin deps.waitUntil usa EdgeRuntime.waitUntil conservando su objeto (camino real de Supabase)", async () => {
  // waitUntil dependiente de `this`: falla si se llama desligado de EdgeRuntime.
  const edgeRuntime = { tasks: [] as Array<Promise<unknown>>, waitUntil(task: Promise<unknown>) { this.tasks.push(task); } };
  const g = globalThis as { EdgeRuntime?: unknown };
  g.EdgeRuntime = edgeRuntime;
  try {
    const s = agentSetup({ settle: { status: "settled", cost_eur: 0.0002, alerts_pending: true }, edgeRuntime: true });
    const response = await s.visit();
    assert.equal(response.status, 200);
    assert.equal(edgeRuntime.tasks.length, 1, "la entrega se registra en EdgeRuntime");
    await Promise.all(edgeRuntime.tasks);
    assert.equal(s.resendPosts.length, 1);
  } finally {
    delete g.EdgeRuntime;
  }
});

test("integración: sin alertas pendientes no se reclama nada", async () => {
  const s = agentSetup();
  await s.visit();
  assert.equal(s.background.length, 0);
  assert.equal(s.rpcs.filter((r) => r.name === "agent_alerts_claim").length, 0);
});

test("integración: presupuesto agotado → respaldo sin IA y alerta del 100 % en segundo plano", async () => {
  const s = agentSetup({ reserve: { status: "budget_exhausted", alerts_pending: true } });
  const body = await (await s.visit()).json();
  assert.match(body.reply, /Ahora mismo no puedo darte una respuesta detallada/);
  assert.deepEqual(Object.keys(body).sort(), ["actions", "reply", "state"]);
  await Promise.all(s.background);
  assert.equal(s.resendPosts.length, 1);
});

test("integración: un fallo del email no cambia la respuesta al visitante", async () => {
  const ok = agentSetup({ settle: { status: "settled", cost_eur: 0.0002, alerts_pending: true } });
  const failing = agentSetup({ settle: { status: "settled", cost_eur: 0.0002, alerts_pending: true }, resend: 500 });
  const a = await (await ok.visit()).json();
  const b = await (await failing.visit()).json();
  await Promise.all([...ok.background, ...failing.background]);
  assert.equal(a.reply, b.reply);
  assert.equal(failing.rpcs.find((r) => r.name === "agent_alert_result")!.args.p_ok, false);
});
