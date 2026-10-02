// Lista CERRADA de intenciones y acciones. El modelo solo puede sugerirlas;
// la función las valida y el navegador las pinta. Ninguna ejecuta nada en el
// servidor: son enlaces o la apertura del formulario existente (con sus
// consentimientos, vía submit_lead).
import { ENLACES, KB, PLANES_COMPRABLES } from "./kb.ts";

export const INTENTS = [
  "saludo", "precios", "planes", "partner_gestoria", "diagnostico", "demo", "contratar",
  "contacto_humano", "cliente_actual", "asesoramiento_juridico", "privacidad", "fuera_de_ambito", "otro",
] as const;
export type Intent = (typeof INTENTS)[number];

export const ACTIONS = [
  "link:diagnostico", "link:precios", "link:partner",
  ...PLANES_COMPRABLES.map((plan) => `link:comprar:${plan}` as const),
  "form:demo", "form:contacto", "form:partner", "handoff",
] as const;
export type Action = (typeof ACTIONS)[number];

export type ResolvedAction = { id: Action; label: string; url?: string; form?: "demo" | "contacto"; email?: string };

const PLAN_NAMES: Record<string, string> = Object.fromEntries(KB.planes.map((plan) => [plan.id, plan.nombre]));

export function resolveAction(id: Action): ResolvedAction {
  if (id === "link:diagnostico") return { id, label: "Hacer el diagnóstico gratuito", url: ENLACES.diagnostico };
  if (id === "link:precios") return { id, label: "Ver planes y precios", url: ENLACES.precios };
  if (id === "link:partner") return { id, label: "Conocer el plan Partner", url: ENLACES.partner };
  if (id === "form:demo") return { id, label: "Solicitar una demo", form: "demo" };
  if (id === "form:contacto") return { id, label: "Dejar mis datos de contacto", form: "contacto" };
  if (id === "form:partner") return { id, label: "Hablar con el equipo sobre Partner", form: "contacto" };
  if (id === "handoff") return { id, label: "Hablar con una persona", form: "contacto", email: KB.contacto.email };
  const plan = id.slice("link:comprar:".length);
  return { id, label: `Contratar ${PLAN_NAMES[plan]}`, url: ENLACES.comprar(plan) };
}

// Garantía determinista (ALC-06): si el modelo rechaza un asesoramiento
// jurídico sin ofrecer ninguna salida, se añade el formulario de contacto
// existente. Nunca sustituye ni duplica acciones elegidas por el modelo.
export function ensureLegalContact(intent: string, actions: Action[]): Action[] {
  return intent === "asesoramiento_juridico" && actions.length === 0 ? ["form:contacto"] : actions;
}
