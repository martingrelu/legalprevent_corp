// Agente comercial de LegalPrevent (Edge Function `sales-agent`), PR2.
//
// Dos modos con EL MISMO flujo de controles (no hay una segunda implementación):
// - privado: laboratorio del CRM (JWT de administrador). Modelo elegido en el
//   laboratorio, presupuesto de pruebas, turnos guardados 30 días, debug.
// - público: visitantes de la web, solo si agent.public_enabled es true. Modelo
//   decidido por el servidor (default_model), presupuesto público, conversación
//   solo en el estado firmado (nada de texto en la base), eventos anónimos y
//   respuesta mínima (sin modelo, costes, tokens, filtros ni errores).
// Con public_enabled=false una petición pública recibe 403 antes de reservar
// presupuesto o contactar con ningún proveedor.
// Proveedor: AGENT_PROVIDER=openai (Responses API, store:false, sin
// herramientas) o simulated (laboratorio). Sin proveedor válido → fallback.
//
// Orden de controles por mensaje: CORS → tamaño → modo/probador → modelo →
// historial firmado → límites de conversación y longitud → redacción de datos
// personales → detector de inyección → moderación → reserva de presupuesto →
// modelo (timeout, sin herramientas, salida JSON) → validación de salida →
// liquidación → registro (privado: turno; público: evento anónimo) → respuesta.
// La clave del proveedor y la service role nunca salen de aquí.
import { type Action, resolveAction } from "./actions.ts";
import { deliverAlerts } from "./alerts.ts";
import { AI_DISCLOSURE, fallbackReply, type FallbackReason } from "./fallback.ts";
import { detectInjection } from "./guard.ts";
import { KB } from "./kb.ts";
import { buildInput, buildInstructions, maxInputTokens } from "./prompt.ts";
import {
  notEnabledProvider, openaiProvider, ProviderHttpError, ProviderNotEnabled, resolveEndpoint, simulatedProvider,
  type GenerateResult, type ModelProvider, type Usage,
} from "./providers.ts";
import { redact } from "./redact.ts";
import { type AgentState, canaryFor, newConversationId, signState, verifyState } from "./state.ts";
import { OUTPUT_SCHEMA, validateOutput } from "./validate.ts";

type Env = (name: string) => string | undefined;
export type Deps = {
  env: Env; fetch: typeof fetch; provider?: ModelProvider; now?: () => number; timeoutMs?: number;
  // Tareas en segundo plano (emails de alertas) que no deben retrasar la respuesta.
  waitUntil?: (task: Promise<unknown>) => void;
};

type RuntimeConfig = {
  enabled: boolean; public_enabled: boolean; preview_enabled: boolean; region: string; default_model?: string | null;
  models: Record<string, { in: number; cached_in: number; out: number; eu: boolean | null; api_model?: string }>;
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

// Identificador estable y anónimo para la detección de abuso de OpenAI
// (recomendado por su API): hash de la conversación, sin datos personales.
async function safetyIdFor(conversationId: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`lp-agent:${conversationId}`)));
  return Array.from(digest.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

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
  let body: { message?: unknown; state?: unknown; model?: unknown; case_id?: unknown; page?: unknown };
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
  // Modo: administrador → privado; si no, público solo con public_enabled.
  // Sin modo válido → 403 ANTES de cualquier reserva o llamada a un proveedor.
  const mode: "private" | "public" | null = tester.admin === true ? "private" : config.public_enabled === true ? "public" : null;
  if (!mode) return json(403, { error: "El asistente no está disponible" }, cors);
  if (mode === "private" && !config.preview_enabled) return json(403, { error: "Laboratorio desactivado" }, cors);
  const isPublic = mode === "public";

  // Modelo: en público lo decide SOLO el servidor (default_model); lo que envíe
  // el navegador se ignora. En privado lo elige el laboratorio, de la lista.
  let model: string;
  if (isPublic) {
    model = typeof config.default_model === "string" ? config.default_model : "";
  } else {
    model = String(body.model ?? "");
    if (!config.models?.[model]) return json(400, { error: "Modelo no permitido" }, cors);
  }
  const publicModelReady = !isPublic || Boolean(config.models?.[model]);
  const caseId = !isPublic && typeof body.case_id === "string" && /^[A-Z]{3}-\d{2}$/.test(body.case_id) ? body.case_id : null;
  const pagePath = typeof body.page === "string" && /^\/[A-Za-z0-9/_-]{0,120}$/.test(body.page) ? body.page : null;

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

  if (!publicModelReady) fallback("disabled");
  else if (state.n >= MAX_TURNS_PER_CONVERSATION) fallback("conversation_limit");
  else if (original.length > config.max_input_chars) fallback("message_too_long");
  else {
    const injection = detectInjection(redacted.text);
    filters.injection = injection.rule;
    if (injection.suspicious) fallback("injection");
  }

  // Proveedor. OpenAI solo con clave y con la región configurada disponible
  // para el modelo: si no, NO se llama (sin cambio silencioso de región).
  let provider: ModelProvider = notEnabledProvider;
  let regionBlocked = false;
  const openaiKey = env("OPENAI_API_KEY");
  if (deps.provider) provider = deps.provider;
  else if (env("AGENT_PROVIDER") === "simulated") provider = simulatedProvider();
  else if (env("AGENT_PROVIDER") === "openai" && openaiKey) {
    const endpoint = resolveEndpoint(config, model);
    filters.region = config.region;
    if (endpoint.ok) {
      filters.endpoint = endpoint.baseUrl;
      provider = openaiProvider({
        apiKey: openaiKey, baseUrl: endpoint.baseUrl, fetch: deps.fetch, schema: OUTPUT_SCHEMA as unknown as Record<string, unknown>,
        apiModel: (name) => config.models[name]?.api_model || name,
      });
    } else regionBlocked = true;
  }
  filters.provider = regionBlocked ? "openai" : provider.name;
  if (!fallbackReason && regionBlocked) fallback("region_unavailable");
  if (!fallbackReason && provider === notEnabledProvider) fallback("provider_not_enabled");
  const providerFailure = (error: unknown): FallbackReason => {
    // Diagnóstico saneado; solo llega al navegador en modo privado (ver sanitizeProviderText).
    if (error instanceof ProviderHttpError) filters.provider_error = error.info;
    return error instanceof ProviderNotEnabled ? "provider_not_enabled" : "provider_error";
  };

  // Presupuesto según el modo: mismas fases (reservar → liquidar o liberar),
  // distinto libro. Privado: presupuesto de pruebas y cupo de llamadas reales.
  // Público: presupuesto público heredado (PR1b; su cálculo se revisa en PR2e).
  const budget = isPublic
    ? {
      reserve: (maxIn: number, maxOut: number) =>
        rpc("agent_reserve", { p_session_id: state.c, p_max_input_tokens: maxIn, p_max_output_tokens: maxOut }),
      settle: (id: string, used: Usage, latency: number) =>
        rpc("agent_settle", {
          p_reservation_id: id, p_input_tokens: used.input, p_output_tokens: used.output, p_latency_ms: latency,
          p_cached_tokens: Math.min(used.cached, used.input),
        }),
      release: (id: string, latency: number) => rpc("agent_release", { p_reservation_id: id, p_latency_ms: latency }),
    }
    : {
      reserve: (maxIn: number, maxOut: number) =>
        rpc("agent_preview_reserve", {
          p_conversation_id: state.c, p_model: model, p_max_input_tokens: maxIn, p_max_output_tokens: maxOut,
          p_provider: provider.name,
        }),
      settle: (id: string, used: Usage) =>
        rpc("agent_preview_settle", {
          p_reservation_id: id, p_input_tokens: used.input, p_cached_tokens: Math.min(used.cached, used.input), p_output_tokens: used.output,
        }),
      release: (id: string) => rpc("agent_preview_release", { p_reservation_id: id }),
    };
  const elapsed = () => (deps.now ? deps.now() : Date.now()) - started;
  // Alertas del presupuesto público: si la base indica que hay emails
  // pendientes, se envían en segundo plano; nunca afectan a la respuesta.
  let alertsPending = false;
  const noteAlerts = (result: unknown) => {
    if (isPublic && (result as { alerts_pending?: boolean } | null)?.alerts_pending === true) alertsPending = true;
  };

  if (!fallbackReason) {
    const instructions = buildInstructions(canary);
    const input = buildInput(state.t, redacted.text, config.max_history_turns);
    // Cota superior estricta (no estimación): el coste real nunca supera la reserva.
    const maxInput = maxInputTokens(instructions, input, OUTPUT_SCHEMA);
    let reservation: { status: string; reservation_id?: string };
    try {
      // La reserva va ANTES de cualquier contacto con el proveedor (también la
      // moderación): así el presupuesto y el cupo de llamadas reales lo cubren todo.
      reservation = await budget.reserve(maxInput, config.max_output_tokens);
      noteAlerts(reservation);
    } catch {
      reservation = { status: "provider_error" };
    }
    if (reservation.status !== "reserved") {
      const known: FallbackReason[] = [
        "disabled", "budget_exhausted", "rate_limited", "model_invalid", "allowance_exhausted", "session_limit", "daily_limit", "hourly_limit",
      ];
      fallback(known.includes(reservation.status as FallbackReason) ? reservation.status as FallbackReason : "provider_error");
    } else {
      try {
        const moderation = await provider.moderate(redacted.text);
        if (moderation.flagged) fallback("moderation");
      } catch (error) {
        fallback(providerFailure(error));
      }
    }
    if (reservation.status === "reserved" && fallbackReason) {
      await budget.release(reservation.reservation_id as string, elapsed()).catch(() => {});
    } else if (reservation.status === "reserved") {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      let generated: GenerateResult | null = null;
      try {
        generated = await provider.generate({
          model, instructions, input, maxOutputTokens: config.max_output_tokens,
          promptCacheKey: `lp-agent-${KB.version}`, safetyId: await safetyIdFor(state.c), signal: controller.signal,
        });
      } catch (error) {
        fallback(controller.signal.aborted ? "timeout" : providerFailure(error));
      } finally {
        clearTimeout(timer);
      }
      if (!generated) {
        await budget.release(reservation.reservation_id as string, elapsed()).catch(() => {});
      } else {
        usage = generated.usage;
        // Lo consumido se paga aunque la salida se rechace.
        try {
          const settled = await budget.settle(reservation.reservation_id as string, usage, elapsed());
          noteAlerts(settled);
          costEur = Number(settled.cost_eur ?? 0);
        } catch {
          console.error("sales-agent: no se pudo liquidar la reserva");
        }
        // Solo laboratorio privado: modelo exacto devuelto y negativa (sin su texto).
        filters.model_returned = generated.meta?.model ?? null;
        if (generated.meta?.refusal) {
          filters.refusal = true;
          fallback("refusal");
        } else {
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
  }

  if (firstTurn) reply = AI_DISCLOSURE + reply;
  const latencyMs = (deps.now ? deps.now() : Date.now()) - started;

  const nextState: AgentState = {
    v: 1, c: state.c, n: state.n + 1,
    t: [...state.t, { r: "u" as const, x: redacted.text.slice(0, config.max_input_chars) }, { r: "a" as const, x: reply }]
      .slice(-config.max_history_turns * 2),
  };

  if (isPublic) {
    // Público: NUNCA se guarda el texto. Solo eventos anónimos (sin mensaje ni
    // respuesta) para métricas agregadas; un fallo aquí no afecta al visitante.
    const events: Array<Record<string, unknown>> = [];
    if (firstTurn) events.push({ event_type: "conversation_started" });
    events.push({ event_type: "message", intent });
    if (fallbackReason) events.push({ event_type: "ai_fallback", target: fallbackReason });
    for (const event of events) {
      await rpc("agent_track_event", { p_event: { ...event, session_id: state.c, page_path: pagePath } }).catch(() => {
        console.error("sales-agent: no se pudo registrar el evento público");
      });
    }
    if (alertsPending) {
      const task = deliverAlerts((name, args) => rpc(name, args), env, deps.fetch).catch(() => 0);
      const background = deps.waitUntil ?? (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime?.waitUntil;
      if (background) background(task);
    }
    // Respuesta mínima: sin modelo, costes, tokens, filtros, errores ni debug.
    return json(200, { reply, actions: actions.map(resolveAction), state: await signState(nextState, stateSecret) }, cors);
  }

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
