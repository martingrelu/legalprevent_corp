// Proveedores de modelo. En los pasos 1–8 de PR2 solo existe el SIMULADOR
// (sin clave, sin gasto). El proveedor real de OpenAI (paso 9) no está
// implementado: seleccionarlo devuelve provider_not_enabled y el visitante
// recibe el fallback.
import type { ModelMessage } from "./prompt.ts";
import { fallbackReply, intentByRules } from "./fallback.ts";
import type { Action } from "./actions.ts";

export type Usage = { input: number; cached: number; output: number };
export type GenerateRequest = {
  model: string;
  instructions: string;
  input: ModelMessage[];
  maxOutputTokens: number;
  promptCacheKey: string;
  signal?: AbortSignal;
};
export type ModelProvider = {
  name: string;
  moderate(text: string): Promise<{ flagged: boolean }>;
  generate(request: GenerateRequest): Promise<{ text: string; usage: Usage }>;
};

export class ProviderNotEnabled extends Error {}

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
// Simulador determinista (laboratorio y pruebas). Responde con la lógica del
// fallback, pero en JSON como un modelo real, y cuenta tokens aproximados.
// Palabras clave SOLO del simulador para probar las defensas:
//   __sim:precio_falso__  __sim:enlace_externo__  __sim:descuento__
//   __sim:filtra_canary__  __sim:json_roto__  __sim:error__  __sim:lento__
//   __sim:asesoria__  __sim:moderacion__
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
      const text = last.includes("__sim:json_roto__")
        ? "{ esto no es json"
        : JSON.stringify({ reply, intent: intentByRules(last), actions: actions.slice(0, 3) });
      usage.output = Math.ceil(text.length / 3);
      return { text, usage };
    },
  };
}
