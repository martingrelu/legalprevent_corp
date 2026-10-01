// Validación de la salida del modelo. Cualquier incumplimiento → fallback
// (la respuesta del modelo no llega al visitante). Es la última barrera frente
// a inyecciones que hayan engañado al modelo y frente a invenciones.
import { ACTIONS, INTENTS, type Action, type Intent } from "./actions.ts";
import { KB, preciosPublicables } from "./kb.ts";

export type ModelOutput = { reply: string; intent: Intent; actions: Action[] };

export const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "intent", "actions"],
  properties: {
    reply: { type: "string" },
    intent: { type: "string", enum: [...INTENTS] },
    actions: { type: "array", items: { type: "string", enum: [...ACTIONS] } },
  },
} as const;

const UNEXPECTED_SCRIPT = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;
const ALLOWED_HOSTS = new Set(["legalprevent.com", "www.legalprevent.com", "legalprevent.legal"]);
const MONEY = /(\d{1,3}(?:[.\s]\d{3})+|\d+)(?:,\d{1,2})?\s?(?:€|eur(?:os?)?\b)|(?:€|eur)\s?(\d{1,3}(?:[.\s]\d{3})+|\d+)/gi;
const FORBIDDEN: Array<[string, RegExp]> = [
  ["porcentaje", /\d+(?:[.,]\d+)?\s?%/],
  ["multiplicador", /\b\d+(?:[.,]\d+)?\s?x\b/i],
  ["descuento_concedido", /\b(te|le|os|les)\s+(hago|hacemos|aplico|aplicamos|dejo|dejamos|doy|damos|ofrezco|ofrecemos|regalo|regalamos)\b[^.\n]{0,30}\b(descuento|rebaja|precio especial|mes(es)? gratis|cup[oó]n)/i],
  ["garantia_sancion", /\b(garantiz|asegur)\w*\b[^.\n]{0,30}\b(no\s+)?(te|le|os)?\s*(van a\s+)?(multar|sancionar|inspeccionar|multa|sanci[oó]n)/i],
  ["asesoramiento_imperativo", /\b(debes|deber[ií]as|tienes que|tiene que|te recomiendo que|le recomiendo que|te aconsejo que)\s+(demandar|denunciar|recurrir|reclamar|despedir|impugnar)/i],
  ["cliente_o_testimonio", /\b(novaline|altair group|medixia|urbanops|northbit)\b|★/i],
  ["telefono", /(?:\+|00)?(?:34[\s.-]?)?\b[6-9](?:[\s.-]?\d){8}\b/],
  ["instrucciones_internas", /PROHIBIDO MENCIONAR|SIN INFORMACI[OÓ]N \(responde|REGLAS DEL ASISTENTE|Versi[oó]n de la base/i],
];

export function parseModelOutput(text: string): ModelOutput | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const out = data as Partial<ModelOutput>;
  if (!out || typeof out.reply !== "string" || !INTENTS.includes(out.intent as Intent) || !Array.isArray(out.actions)) return null;
  if (!out.actions.every((action) => ACTIONS.includes(action as Action))) return null;
  return { reply: out.reply, intent: out.intent as Intent, actions: [...new Set(out.actions as Action[])] };
}

export function validateOutput(text: string, canary: string): { ok: boolean; output: ModelOutput | null; reasons: string[] } {
  const output = parseModelOutput(text);
  if (!output) return { ok: false, output: null, reasons: ["json_invalido"] };
  const reasons: string[] = [];
  const reply = output.reply;

  if (!reply.trim() || reply.length > 1500) reasons.push("longitud");
  // Solo alfabeto latino (con tildes y ñ), cifras, signos y emojis: cualquier
  // otra escritura (cirílico, devanagari, árabe, CJK…) indica una salida
  // degradada del modelo (incidente de la evaluación del 01/10/2026).
  if (UNEXPECTED_SCRIPT.test(reply)) reasons.push("alfabeto_inesperado");
  if (output.actions.length > 4) reasons.push("demasiadas_acciones");
  if (reply.includes(canary) || /LP-CANARY-/i.test(reply)) reasons.push("filtracion_instrucciones");

  const allowed = new Set(preciosPublicables());
  for (const match of reply.matchAll(MONEY)) {
    const amount = Number((match[1] ?? match[2]).replace(/[.\s]/g, ""));
    if (!allowed.has(amount)) reasons.push(`precio_no_publicado:${amount}`);
  }
  for (const [name, pattern] of FORBIDDEN) if (pattern.test(reply)) reasons.push(name);

  for (const match of reply.matchAll(/\bhttps?:\/\/([^\s/)\]>"']+)/gi)) {
    if (!ALLOWED_HOSTS.has(match[1].toLowerCase())) reasons.push(`enlace_externo:${match[1].toLowerCase()}`);
  }
  for (const match of reply.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
    if (match[0].toLowerCase() !== KB.contacto.email) reasons.push("email_no_permitido");
  }
  return { ok: reasons.length === 0, output, reasons: [...new Set(reasons)] };
}
