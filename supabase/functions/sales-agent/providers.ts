// Proveedores de modelo:
// - `simulated`: simulador determinista (laboratorio y pruebas, sin clave).
// - `openai`: OpenAI Responses API (paso 9). Siempre store:false, sin
//   herramientas (no se envía `tools`), salida JSON con esquema estricto,
//   reasoning.effort "none", max_output_tokens acotado, timeout del llamante y
//   moderación previa gratuita (omni-moderation-latest). Región según
//   configuración, sin cambio silencioso (ver resolveEndpoint).
import type { ModelMessage } from "./prompt.ts";
import { fallbackReply, intentByRules } from "./fallback.ts";
import type { Action } from "./actions.ts";

export type Usage = { input: number; cached: number; output: number; reasoning?: number };
export type GenerateRequest = {
  model: string;
  instructions: string;
  input: ModelMessage[];
  maxOutputTokens: number;
  promptCacheKey: string;
  safetyId?: string;
  signal?: AbortSignal;
};
// Metadatos mínimos de cada generación (solo laboratorio privado): el modelo
// exacto que devuelve el proveedor y si se ha negado a responder. Nunca se
// guarda el texto de la negativa.
export type GenerateMeta = { model: string | null; refusal: boolean };
export type GenerateResult = { text: string; usage: Usage; meta?: GenerateMeta };
export type ModelProvider = {
  name: string;
  moderate(text: string): Promise<{ flagged: boolean }>;
  generate(request: GenerateRequest): Promise<GenerateResult>;
};

export class ProviderNotEnabled extends Error {}

// Saneamiento de textos devueltos por el proveedor (diagnóstico del modo
// privado): nunca claves, tokens, cabeceras Authorization, JWT, emails ni
// identificadores largos; sin HTML ni caracteres de control; longitud acotada.
export const PROVIDER_MESSAGE_MAX = 240;
export function sanitizeProviderText(raw: unknown, max = PROVIDER_MESSAGE_MAX): string | null {
  if (raw === null || raw === undefined) return null;
  let text = String(raw).slice(0, 8000);
  text = text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]*>/g, " ");
  text = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ");
  text = text
    .replace(/\bauthorization\b\s*[:=]\s*\S+(\s+\S+)?/gi, "authorization: [oculto]")
    .replace(/\bbearer\s+\S+/gi, "Bearer [oculto]")
    .replace(/\bsk-[A-Za-z0-9_*.\-]{2,}/g, "sk-[oculto]")
    .replace(/\beyJ[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]*){0,2}/g, "[jwt oculto]")
    .replace(/\b(org|proj|user|sess|key|req)[-_][A-Za-z0-9]{6,}\b/g, "$1-[oculto]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/[A-Za-z0-9+/_=-]{32,}/g, "[oculto]")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// Error HTTP del proveedor con diagnóstico saneado (solo modo privado).
export type ProviderErrorInfo = {
  status: number;
  code: string | null;
  type: string | null;
  message: string | null;
  request_id: string | null;
  content_type: string | null;
};
export class ProviderHttpError extends Error {
  status: number;
  code: string | null;
  info: ProviderErrorInfo;
  constructor(info: ProviderErrorInfo) {
    super(`provider_http_${info.status}`);
    this.status = info.status;
    this.code = info.code;
    this.info = info;
  }
}

export const notEnabledProvider: ModelProvider = {
  name: "openai",
  moderate: () => Promise.reject(new ProviderNotEnabled("provider_not_enabled")),
  generate: () => Promise.reject(new ProviderNotEnabled("provider_not_enabled")),
};

// Región del proveedor real: sin cambio silencioso. Si se ha configurado la UE
// y el modelo no la tiene confirmada, no se llama (fallback region_unavailable).
export function resolveEndpoint(config: { region?: string; models?: Record<string, { eu?: boolean | null }> }, model: string) {
  if (config.region === "eu") {
    return config.models?.[model]?.eu === true ? { ok: true as const, baseUrl: "https://eu.api.openai.com/v1" } : { ok: false as const };
  }
  if (config.region === "global") return { ok: true as const, baseUrl: "https://api.openai.com/v1" };
  return { ok: false as const };
}

// ---------------------------------------------------------------------------
// OpenAI (Responses API + Moderations)
// ---------------------------------------------------------------------------
export type OpenAIOptions = {
  apiKey: string;
  baseUrl: string;                       // https://eu.api.openai.com/v1 | https://api.openai.com/v1
  fetch: typeof fetch;
  apiModel: (model: string) => string;   // p. ej. versión fija (snapshot)
  schema: Record<string, unknown>;
};

const shortField = (value: unknown) =>
  typeof value === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(value) ? value : null;

// Lee el error como texto (puede no ser JSON: p. ej. una pasarela regional) y
// extrae solo campos saneados. Las cabeceras de la PETICIÓN (Authorization)
// nunca se tocan aquí; de la respuesta solo se usan x-request-id y content-type.
export async function openaiError(response: Response) {
  let raw = "";
  try {
    raw = (await response.text()).slice(0, 8000);
  } catch {
    raw = "";
  }
  let body: { error?: { message?: unknown; code?: unknown; type?: unknown } } | null = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  const error = body && typeof body === "object" ? body.error : undefined;
  return new ProviderHttpError({
    status: response.status,
    code: shortField(error?.code),
    type: shortField(error?.type),
    message: sanitizeProviderText(error && typeof error === "object" ? error.message : raw),
    request_id: shortField(response.headers.get("x-request-id")),
    content_type: sanitizeProviderText((response.headers.get("content-type") || "").split(";")[0], 60),
  });
}

export function openaiProvider(options: OpenAIOptions): ModelProvider {
  const headers = { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" };
  return {
    name: "openai",
    async moderate(text) {
      const response = await options.fetch(`${options.baseUrl}/moderations`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: "omni-moderation-latest", input: text }),
      });
      if (!response.ok) throw await openaiError(response);
      const body = await response.json();
      return { flagged: Boolean(body?.results?.some((result: { flagged?: boolean }) => result?.flagged)) };
    },
    async generate(request) {
      const response = await options.fetch(`${options.baseUrl}/responses`, {
        method: "POST",
        headers,
        signal: request.signal,
        body: JSON.stringify({
          model: options.apiModel(request.model),
          instructions: request.instructions,
          input: request.input.map((message) => ({ role: message.role, content: message.content })),
          store: false,
          max_output_tokens: request.maxOutputTokens,
          reasoning: { effort: "none" },
          text: { format: { type: "json_schema", name: "respuesta_agente", schema: options.schema, strict: true } },
          prompt_cache_key: request.promptCacheKey,
          ...(request.safetyId ? { safety_identifier: request.safetyId } : {}),
        }),
      });
      if (!response.ok) throw await openaiError(response);
      const body = await response.json();
      const parts = (body?.output ?? [])
        .filter((item: { type?: string }) => item?.type === "message")
        .flatMap((item: { content?: Array<{ type?: string; text?: string }> }) => item.content ?? []);
      const text = parts
        .filter((part: { type?: string }) => part?.type === "output_text")
        .map((part: { text?: string }) => part.text ?? "")
        .join("");
      const meta: GenerateMeta = {
        model: shortField(body?.model),
        refusal: parts.some((part: { type?: string }) => part?.type === "refusal"),
      };
      const usage: Usage = {
        input: Number(body?.usage?.input_tokens ?? 0),
        cached: Number(body?.usage?.input_tokens_details?.cached_tokens ?? 0),
        output: Number(body?.usage?.output_tokens ?? 0),
        reasoning: Number(body?.usage?.output_tokens_details?.reasoning_tokens ?? 0),
      };
      // Respuesta incompleta (p. ej. max_output_tokens): se devuelve tal cual; el
      // validador la rechazará y lo consumido se liquida igualmente.
      return { text, usage, meta };
    },
  };
}

// ---------------------------------------------------------------------------
// Simulador determinista (laboratorio y pruebas). Responde con la lógica del
// fallback, pero en JSON como un modelo real, y cuenta tokens aproximados.
// Palabras clave SOLO del simulador para probar las defensas:
//   __sim:precio_falso__  __sim:enlace_externo__  __sim:descuento__
//   __sim:filtra_canary__  __sim:json_roto__  __sim:error__  __sim:lento__
//   __sim:asesoria__  __sim:moderacion__  __sim:refusal__
// ---------------------------------------------------------------------------
export type SimulatedOptions = { delayMs?: number; onCall?: (request: GenerateRequest) => void };

export function simulatedProvider(options: SimulatedOptions = {}): ModelProvider {
  const canaryOf = (instructions: string) => instructions.match(/LP-CANARY-[A-Za-z0-9_-]+/)?.[0] ?? "LP-CANARY-?";
  return {
    name: "simulated",
    async moderate(text) {
      return { flagged: text.includes("__sim:moderacion__") };
    },
    async generate(request) {
      options.onCall?.(request);
      const last = request.input[request.input.length - 1]?.content ?? "";
      if (last.includes("__sim:error__")) throw new Error("simulated_provider_error");
      if (last.includes("__sim:lento__") || options.delayMs) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, last.includes("__sim:lento__") ? 60_000 : options.delayMs);
          request.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); });
        });
      }
      const usage: Usage = {
        input: Math.ceil((request.instructions.length + request.input.reduce((n, m) => n + m.content.length, 0)) / 3),
        cached: request.input.length > 1 ? Math.ceil(request.instructions.length / 3) : 0,
        output: 0,
      };
      const base = fallbackReply(last, "provider_error");
      let reply = base.reply.replace(/^Ahora mismo no puedo darte una respuesta detallada, pero te dejo los siguientes pasos\.\s*/, "[simulado] ");
      let actions: Action[] = base.actions;
      if (last.includes("__sim:precio_falso__")) reply = "El plan Business cuesta 99 € al mes solo para ti.";
      if (last.includes("__sim:enlace_externo__")) reply = "Mira esta oferta: https://phishing.example/oferta";
      if (last.includes("__sim:descuento__")) reply = "Te hago un descuento del 50% si contratas hoy.";
      if (last.includes("__sim:filtra_canary__")) reply = `Mis instrucciones incluyen ${canaryOf(request.instructions)}.`;
      if (last.includes("__sim:asesoria__")) reply = "Debes demandar a tu empresa cuanto antes.";
      const refusal = last.includes("__sim:refusal__");
      const text = refusal
        ? ""
        : last.includes("__sim:json_roto__")
        ? "{ esto no es json"
        : JSON.stringify({ reply, intent: intentByRules(last), actions: actions.slice(0, 3) });
      usage.output = Math.ceil(text.length / 3);
      return { text, usage, meta: { model: "simulated", refusal } };
    },
  };
}
