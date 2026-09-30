// Agente comercial de LegalPrevent (Edge Function `sales-agent`), PR2.
//
// En PR2 solo funciona el MODO PRIVADO (laboratorio del CRM, administradores):
// el modo público responde 403 mientras agent.public_enabled sea false.
// Proveedor: simulador (AGENT_PROVIDER=simulated). El proveedor real de
// OpenAI (paso 9) no está implementado: sin él, todo acaba en fallback.
//
// Orden de controles por mensaje: CORS → tamaño → modo/probador → modelo →
// historial firmado → límites de conversación y longitud → redacción de datos
// personales → detector de inyección → moderación → reserva de presupuesto →
// modelo (timeout, sin herramientas, salida JSON) → validación de salida →
// liquidación → registro del turno (solo privado) → respuesta.
// La clave del proveedor y la service role nunca salen de aquí.
import { type Action, resolveAction } from "./actions.ts";
import { AI_DISCLOSURE, fallbackReply, type FallbackReason } from "./fallback.ts";
import { detectInjection } from "./guard.ts";
import { KB } from "./kb.ts";
import { buildInput, buildInstructions, estimateTokens } from "./prompt.ts";
import { notEnabledProvider, ProviderNotEnabled, resolveEndpoint, simulatedProvider, type ModelProvider, type Usage } from "./providers.ts";
import { redact } from "./redact.ts";
import { type AgentState, canaryFor, newConversationId, signState, verifyState } from "./state.ts";
import { validateOutput } from "./validate.ts";

type Env = (name: string) => string | undefined;
export type Deps = { env: Env; fetch: typeof fetch; provider?: ModelProvider; now?: () => number; timeoutMs?: number };

type RuntimeConfig = {
  enabled: boolean; public_enabled: boolean; preview_enabled: boolean; region: string;
  models: Record<string, { in: number; cached_in: number; out: number; eu: boolean | null }>;
  max_input_chars: number; max_output_tokens: number; max_history_turns: number;
};

const DEFAULT_ALLOWED_ORIGINS = "https://legalprevent.com,https://www.legalprevent.com";
const MAX_BODY = 16 * 1024;
const MAX_TURNS_PER_CONVERSATION = 30;
const DEFAULT_TIMEOUT_MS = 20_000;

const allowedOrigins = (env: Env) => (env("ALLOWED_ORIGINS") || DEFAULT_ALLOWED_ORIGINS).split(",").map((o) => o.trim()).filter(Boolean);
const corsHeaders = (origin: string | null, env: Env): Record<string, string> => ({
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  Vary: "Origin",
  ...(origin && allowedOrigins(env).includes(origin) ? { "Access-Control-Allow-Origin": origin } : {}),
});
const json = (status: number, body: Record<string, unknown>, cors: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

export async function handleRequest(request: Request, deps: Deps): Promise<Response> {
  const { env } = deps;
  const origin = request.headers.get("origin");
  const cors = corsHeaders(origin, env);
  if (origin && !allowedOrigins(env).includes(origin)) return json(403, { error: "Origen no permitido" }, cors);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return json(405, { error: "Método no permitido" }, cors);

  const baseUrl = (env("SUPABASE_URL") || "").replace(/\/+$/, "");
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = env("SUPABASE_ANON_KEY");
  const stateSecret = env("AGENT_STATE_SECRET");
  if (!baseUrl || !serviceKey || !anonKey || !stateSecret || stateSecret.length < 32) {
    console.error("sales-agent: falta configuración");
    return json(503, { error: "No disponible" }, cors);
  }

  const rpc = async (name: string, args: Record<string, unknown>, token = serviceKey) => {
    const response = await deps.fetch(`${baseUrl}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: { apikey: token === serviceKey ? serviceKey : anonKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    if (!response.ok) throw new Error(`${name}_${response.status}`);
    return response.json();
  };

  const raw = await request.text();
  if (raw.length > MAX_BODY) return json(413, { error: "Petición demasiado grande" }, cors);
  let body: { message?: unknown; state?: unknown; model?: unknown; case_id?: unknown };
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    return json(400, { error: "Petición no válida" }, cors);
  }

  let config: RuntimeConfig;
  try {
    config = await rpc("agent_runtime_config", {});
  } catch {
    console.error("sales-agent: no se pudo leer la configuración");
    return json(503, { error: "No disponible" }, cors);
  }

  // Modo privado: JWT de administrador del CRM (PostgREST valida la firma).
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  let tester: { admin: boolean; sub: string | null } = { admin: false, sub: null };
  if (token && token !== anonKey) {
    try {
      tester = await rpc("agent_lab_whoami", {}, token);
    } catch {
      tester = { admin: false, sub: null };
    }
  }
  const preview = tester.admin === true;
  if (!preview) {
    // PR2: el modo público no existe todavía.
    return json(403, { error: "El asistente no está disponible" }, cors);
  }
  if (!config.preview_enabled) return json(403, { error: "Laboratorio desactivado" }, cors);

  const model = String(body.model ?? "");
  if (!config.models?.[model]) return json(400, { error: "Modelo no permitido" }, cors);
  const caseId = typeof body.case_id === "string" && /^[A-Z]{3}-\d{2}$/.test(body.case_id) ? body.case_id : null;

  let state: AgentState;
  if (body.state) {
    const verified = await verifyState(String(body.state), stateSecret);
    if (!verified) return json(400, { error: "Conversación no válida" }, cors);
    state = verified;
  } else {
    state = { v: 1, c: newConversationId(), n: 0, t: [] };
  }

  const original = String(body.message ?? "").trim();
  if (!original) return json(400, { error: "Mensaje vacío" }, cors);
  const redacted = redact(original.slice(0, config.max_input_chars + 1));
  const firstTurn = state.n === 0;
  const canary = await canaryFor(stateSecret);
  const started = deps.now ? deps.now() : Date.now();

  let reply = "";
  let intent: string = "otro";
  let actions: Action[] = [];
  let fallbackReason: FallbackReason | null = null;
  let usage: Usage = { input: 0, cached: 0, output: 0 };
  let costEur = 0;
  const filters: Record<string, unknown> = { redacted: redacted.found };

  const fallback = (reason: FallbackReason) => {
    fallbackReason = reason;
    ({ reply, intent, actions } = fallbackReply(redacted.text, reason));
  };

  if (state.n >= MAX_TURNS_PER_CONVERSATION) fallback("conversation_limit");
  else if (original.length > config.max_input_chars) fallback("message_too_long");
  else {
    const injection = detectInjection(redacted.text);
    filters.injection = injection.rule;
    if (injection.suspicious) fallback("injection");
  }

  const provider = deps.provider ?? (env("AGENT_PROVIDER") === "simulated" ? simulatedProvider() : notEnabledProvider);
  filters.provider = provider.name;

  if (!fallbackReason && provider === notEnabledProvider) fallback("provider_not_enabled");
  if (!fallbackReason && provider.name === "openai") {
    const endpoint = resolveEndpoint(config, model);
    filters.region = config.region;
    if (!endpoint.ok) fallback("region_unavailable");
  }

  if (!fallbackReason) {
    try {
      const moderation = await provider.moderate(redacted.text);
      if (moderation.flagged) fallback("moderation");
    } catch (error) {
      fallback(error instanceof ProviderNotEnabled ? "provider_not_enabled" : "provider_error");
    }
  }

  if (!fallbackReason) {
    const instructions = buildInstructions(canary);
    const input = buildInput(state.t, redacted.text, config.max_history_turns);
    const maxInput = estimateTokens(instructions) + input.reduce((n, m) => n + estimateTokens(m.content), 0);
    let reservation: { status: string; reservation_id?: string };
    try {
      reservation = await rpc("agent_preview_reserve", {
        p_conversation_id: state.c, p_model: model, p_max_input_tokens: maxInput, p_max_output_tokens: config.max_output_tokens,
      });
    } catch {
      reservation = { status: "provider_error" };
    }
    if (reservation.status !== "reserved") {
      const known: FallbackReason[] = ["disabled", "budget_exhausted", "rate_limited", "model_invalid"];
      fallback(known.includes(reservation.status as FallbackReason) ? reservation.status as FallbackReason : "provider_error");
    } else {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      let generated: { text: string; usage: Usage } | null = null;
      try {
        generated = await provider.generate({
          model, instructions, input, maxOutputTokens: config.max_output_tokens,
          promptCacheKey: `lp-agent-${KB.version}`, signal: controller.signal,
        });
      } catch (error) {
        fallback(controller.signal.aborted ? "timeout" : error instanceof ProviderNotEnabled ? "provider_not_enabled" : "provider_error");
      } finally {
        clearTimeout(timer);
      }
      if (!generated) {
        await rpc("agent_preview_release", { p_reservation_id: reservation.reservation_id }).catch(() => {});
      } else {
        usage = generated.usage;
        // Lo consumido se paga aunque la salida se rechace.
        try {
          const settled = await rpc("agent_preview_settle", {
            p_reservation_id: reservation.reservation_id, p_input_tokens: usage.input,
            p_cached_tokens: Math.min(usage.cached, usage.input), p_output_tokens: usage.output,
          });
          costEur = Number(settled.cost_eur ?? 0);
        } catch {
          console.error("sales-agent: no se pudo liquidar la reserva");
        }
        const checked = validateOutput(generated.text, canary);
        filters.validation = checked.reasons;
        if (checked.ok && checked.output) {
          ({ reply, intent, actions } = checked.output);
          actions = actions.slice(0, 3);
        } else {
          fallback("invalid_output");
        }
      }
    }
  }

  if (firstTurn) reply = AI_DISCLOSURE + reply;
  const latencyMs = (deps.now ? deps.now() : Date.now()) - started;

  const nextState: AgentState = {
    v: 1, c: state.c, n: state.n + 1,
    t: [...state.t, { r: "u" as const, x: redacted.text.slice(0, config.max_input_chars) }, { r: "a" as const, x: reply }]
      .slice(-config.max_history_turns * 2),
  };

  try {
    await rpc("agent_preview_log_turn", {
      p_turn: {
        conversation_id: state.c, turn: state.n, model, case_id: caseId,
        user_text: redacted.text.slice(0, config.max_input_chars), reply, actions, intent,
        input_tokens: usage.input, cached_tokens: Math.min(usage.cached, usage.input), output_tokens: usage.output,
        cost_eur: costEur, latency_ms: latencyMs, fallback_reason: fallbackReason, filters, tester_sub: tester.sub,
      },
    });
  } catch {
    console.error("sales-agent: no se pudo guardar el turno de prueba");
  }

  return json(200, {
    conversation_id: state.c,
    reply,
    intent,
    actions: actions.map(resolveAction),
    state: await signState(nextState, stateSecret),
    debug: { model, provider: provider.name, usage, cost_eur: costEur, latency_ms: latencyMs, fallback_reason: fallbackReason, filters },
  }, cors);
}

// En Supabase (Deno) se arranca el servidor; en los tests (Node) solo se
// importan las funciones exportadas.
type DenoLike = {
  serve: (handler: (request: Request) => Promise<Response>) => void;
  env: { get: (name: string) => string | undefined };
};
const denoRuntime = (globalThis as { Deno?: DenoLike }).Deno;
if (denoRuntime?.serve) {
  denoRuntime.serve((request) => handleRequest(request, { env: (name) => denoRuntime.env.get(name), fetch }));
}
