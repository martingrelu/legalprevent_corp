// Proveedor real de OpenAI (PR2, paso 9) SIN llamadas reales: un fetch falso
// imita a OpenAI y registra cada petición para comprobar exactamente qué se
// enviaría (store:false, sin herramientas, datos redactados, región…).
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../supabase/functions/sales-agent/index.ts";
import { OUTPUT_SCHEMA } from "../supabase/functions/sales-agent/validate.ts";

const SECRET = "secreto-de-prueba-de-al-menos-32-caracteres";
const OPENAI_KEY = "clave-openai-falsa-no-real";
const MODELS = {
  "gpt-5.4-mini": { in: 0.75, cached_in: 0.075, out: 4.5, eu: true, api_model: "gpt-5.4-mini-2026-03-17" },
  "gpt-5.6-luna": { in: 0.2, cached_in: 0.02, out: 1.2, eu: null, api_model: "gpt-5.6-luna" },
  "gpt-6-luna": { in: 0.1, cached_in: 0.01, out: 0.5, eu: true, api_model: "gpt-6-luna" },
};
const baseConfig = {
  enabled: true, public_enabled: false, preview_enabled: true, region: "eu", models: MODELS,
  max_input_chars: 1000, max_output_tokens: 400, max_history_turns: 8,
};
const goodOutput = JSON.stringify({ reply: "El plan Pyme cuesta 79 €/mes + IVA.", intent: "precios", actions: ["link:precios", "link:comprar:pyme"] });

type Call = { url: string; headers: Record<string, string>; body: any };
function setup(opts: {
  config?: Record<string, unknown>; env?: Record<string, string | undefined>;
  moderation?: unknown; moderationStatus?: number; responseStatus?: number; responseError?: unknown; response?: unknown;
  reserve?: string;
} = {}) {
  const env: Record<string, string | undefined> = {
    SUPABASE_URL: "https://p.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service", SUPABASE_ANON_KEY: "anon",
    AGENT_STATE_SECRET: SECRET, AGENT_PROVIDER: "openai", OPENAI_API_KEY: OPENAI_KEY, ...opts.env,
  };
  const openai: Call[] = [];
  const rpcs: Call[] = [];
  const fakeFetch = (async (url: string, init: RequestInit = {}) => {
    const call = { url: String(url), headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body || "{}")) };
    const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (call.url.includes("openai.com")) {
      openai.push(call);
      if (call.url.endsWith("/moderations")) {
        return ok(opts.moderation ?? { results: [{ flagged: false }] }, opts.moderationStatus ?? 200);
      }
      if (opts.responseStatus) return ok(opts.responseError ?? { error: { code: "server_error", message: "detalle interno" } }, opts.responseStatus);
      return ok(opts.response ?? {
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: goodOutput, annotations: [] }] }],
        usage: { input_tokens: 2400, input_tokens_details: { cached_tokens: 1800 }, output_tokens: 60, output_tokens_details: { reasoning_tokens: 0 } },
      });
    }
    rpcs.push(call);
    const name = call.url.split("/rpc/")[1];
    if (name === "agent_runtime_config") return ok({ ...baseConfig, ...opts.config });
    if (name === "agent_lab_whoami") return ok({ admin: call.headers.Authorization === "Bearer jwt-admin", sub: "tester" });
    if (name === "agent_preview_reserve") return ok({ status: opts.reserve ?? "reserved", reservation_id: "r-1" });
    if (name === "agent_preview_settle") return ok({ status: "settled", cost_eur: 0.00017 });
    if (name === "agent_preview_release") return ok({ status: "released" });
    if (name === "agent_preview_log_turn") return ok(1);
    return ok({}, 404);
  }) as typeof fetch;
  const deps = { env: (k: string) => env[k], fetch: fakeFetch, timeoutMs: 500 };
  const rpc = (name: string) => rpcs.filter((c) => c.url.endsWith(`/rpc/${name}`));
  return { deps, openai, rpc };
}
const ask = (message: string, model = "gpt-6-luna", token = "jwt-admin") =>
  new Request("https://p.supabase.co/functions/v1/sales-agent", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, Origin: "https://legalprevent.com" },
    body: JSON.stringify({ message, model }),
  });

test("petición a Responses: store:false, sin herramientas, JSON estricto, sin razonamiento, datos redactados", async () => {
  const { deps, openai } = setup();
  const response = await handleRequest(ask("Soy ana@empresa.es (612345678). ¿Cuánto cuesta el Pyme?", "gpt-5.4-mini"), deps);
  assert.equal(response.status, 200);
  const [moderation, generation] = openai;
  assert.equal(moderation.url, "https://eu.api.openai.com/v1/moderations");
  assert.equal(moderation.body.model, "omni-moderation-latest");
  assert.doesNotMatch(JSON.stringify(moderation.body), /ana@empresa|612345678/);

  assert.equal(generation.url, "https://eu.api.openai.com/v1/responses");
  assert.equal(generation.headers.Authorization, `Bearer ${OPENAI_KEY}`);
  const body = generation.body;
  assert.equal(body.store, false);
  assert.equal(body.model, "gpt-5.4-mini-2026-03-17", "versión fija elegible para la UE");
  assert.equal(body.max_output_tokens, 400);
  assert.deepEqual(body.reasoning, { effort: "none" });
  assert.deepEqual(body.text.format, { type: "json_schema", name: "respuesta_agente", schema: JSON.parse(JSON.stringify(OUTPUT_SCHEMA)), strict: true });
  for (const forbidden of ["tools", "tool_choice", "previous_response_id", "conversation", "background", "include"]) {
    assert.ok(!(forbidden in body), `no se envía ${forbidden}`);
  }
  assert.match(body.prompt_cache_key, /^lp-agent-/);
  assert.match(body.safety_identifier, /^[0-9a-f]{32}$/);
  assert.match(body.instructions, /una inteligencia artificial[\s\S]*BASE DE CONOCIMIENTO/);
  assert.doesNotMatch(JSON.stringify(body), /ana@empresa|612345678/);
  assert.match(JSON.stringify(body.input), /\[email\].*\[teléfono\]/);
});

test("respuesta de OpenAI: texto, acciones y uso real (incluida la caché) llegan a la liquidación", async () => {
  const { deps, rpc } = setup();
  const body = await (await handleRequest(ask("¿Cuánto cuesta el Pyme?", "gpt-6-luna"), deps)).json();
  assert.equal(body.debug.fallback_reason, null);
  assert.equal(body.debug.provider, "openai");
  assert.match(body.reply, /79 €\/mes/);
  assert.deepEqual(body.actions.map((a: any) => a.id), ["link:precios", "link:comprar:pyme"]);
  assert.deepEqual(rpc("agent_preview_settle")[0].body, { p_reservation_id: "r-1", p_input_tokens: 2400, p_cached_tokens: 1800, p_output_tokens: 60 });
  assert.equal(body.debug.usage.reasoning, 0);
});

test("región UE sin confirmar para el modelo: NO se llama a OpenAI (ni a otra región)", async () => {
  const { deps, openai, rpc } = setup();
  const body = await (await handleRequest(ask("hola", "gpt-5.6-luna"), deps)).json();
  assert.equal(body.debug.fallback_reason, "region_unavailable");
  assert.equal(openai.length, 0);
  assert.equal(rpc("agent_preview_reserve").length, 0);
});

test("región global solo si está configurada expresamente", async () => {
  const { deps, openai } = setup({ config: { region: "global" } });
  await handleRequest(ask("hola", "gpt-5.6-luna"), deps);
  assert.ok(openai.every((c) => c.url.startsWith("https://api.openai.com/v1/")));
  assert.equal(openai.length, 2);
});

test("moderación marcada: no se genera respuesta y la reserva se libera", async () => {
  const { deps, openai, rpc } = setup({ moderation: { results: [{ flagged: true }] } });
  const body = await (await handleRequest(ask("hola"), deps)).json();
  assert.equal(body.debug.fallback_reason, "moderation");
  assert.deepEqual(openai.map((c) => c.url.split("/v1/")[1]), ["moderations"]);
  assert.equal(rpc("agent_preview_reserve").length, 1);
  assert.equal(rpc("agent_preview_release").length, 1);
  assert.equal(rpc("agent_preview_settle").length, 0);
});

test("cupo de llamadas reales agotado: la base lo decide ANTES de contactar con OpenAI (ni moderación)", async () => {
  const { deps, openai, rpc } = setup({ reserve: "allowance_exhausted" });
  const body = await (await handleRequest(ask("¿Cuánto cuesta?"), deps)).json();
  assert.equal(body.debug.fallback_reason, "allowance_exhausted");
  assert.equal(openai.length, 0);
  assert.equal(rpc("agent_preview_reserve")[0].body.p_provider, "openai");
  assert.match(body.reply, /29 €\/mes/);
});

test("límite de gasto de OpenAI (429) o región no aprobada (403): fallback, reserva liberada, código visible en depuración", async () => {
  for (const [status, code] of [[429, "project_spend_limit_exceeded"], [403, "unsupported_country_region_territory"], [500, "server_error"]] as const) {
    const { deps, rpc } = setup({ responseStatus: status, responseError: { error: { code, message: "detalle interno" } } });
    const text = await (await handleRequest(ask("¿Cuánto cuesta?"), deps)).text();
    const body = JSON.parse(text);
    assert.equal(body.debug.fallback_reason, "provider_error", String(status));
    assert.deepEqual(body.debug.filters.provider_error, { status, code });
    assert.equal(rpc("agent_preview_release").length, 1);
    assert.equal(rpc("agent_preview_settle").length, 0);
    assert.doesNotMatch(text, /detalle interno/);
    assert.match(body.reply, /29 €\/mes/, "fallback comercial útil");
  }
  const { deps } = setup({ moderationStatus: 403, moderation: { error: { code: "unsupported_country_region_territory" } } });
  const body = await (await handleRequest(ask("hola"), deps)).json();
  assert.equal(body.debug.fallback_reason, "provider_error");
  assert.deepEqual(body.debug.filters.provider_error, { status: 403, code: "unsupported_country_region_territory" });
});

test("salida maliciosa, rechazo o truncada: se paga lo consumido y no llega al visitante", async () => {
  const outputs = [
    [{ type: "output_text", text: JSON.stringify({ reply: "Te hago un 30% de descuento: 55 €/mes.", intent: "precios", actions: [] }) }],
    [{ type: "refusal", refusal: "No puedo ayudar con eso." }],
    [{ type: "output_text", text: "{\"reply\": \"El plan Pyme cue" }],
  ];
  for (const content of outputs) {
    const { deps, rpc } = setup({ response: { status: "completed", output: [{ type: "message", content }], usage: { input_tokens: 900, output_tokens: 40 } } });
    const body = await (await handleRequest(ask("¿Cuánto cuesta?"), deps)).json();
    assert.equal(body.debug.fallback_reason, "invalid_output", JSON.stringify(content));
    assert.equal(rpc("agent_preview_settle").length, 1);
    assert.doesNotMatch(body.reply, /30%|55 €|No puedo ayudar con eso/);
  }
});

test("sin OPENAI_API_KEY o sin sesión de administrador: nunca se llama a OpenAI", async () => {
  let s = setup({ env: { OPENAI_API_KEY: undefined } });
  let body = await (await handleRequest(ask("hola"), s.deps)).json();
  assert.equal(body.debug.fallback_reason, "provider_not_enabled");
  assert.equal(s.openai.length, 0);
  s = setup();
  const response = await handleRequest(ask("hola", "gpt-6-luna", "anon"), s.deps);
  assert.equal(response.status, 403);
  assert.equal(s.openai.length, 0);
});

test("la clave de OpenAI nunca aparece en la respuesta ni en lo que se guarda", async () => {
  const { deps, rpc } = setup();
  const text = await (await handleRequest(ask("hola"), deps)).text();
  assert.ok(!text.includes(OPENAI_KEY));
  assert.ok(!JSON.stringify(rpc("agent_preview_log_turn")).includes(OPENAI_KEY));
});
