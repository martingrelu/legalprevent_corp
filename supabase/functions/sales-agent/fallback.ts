// Respuesta comercial SIN IA (determinista). Se usa cuando el agente está
// desactivado, sin presupuesto, en un límite, con error o lentitud del
// proveedor, moderación, inyección detectada o salida no válida. Nunca muestra
// errores técnicos. Sus textos pasan el mismo validador que el modelo.
import type { Action, Intent } from "./actions.ts";
import { KB } from "./kb.ts";

export type FallbackReason =
  | "disabled" | "budget_exhausted" | "rate_limited" | "model_invalid" | "session_limit" | "daily_limit"
  | "conversation_limit" | "message_too_long" | "injection" | "moderation" | "provider_error" | "timeout"
  | "invalid_output" | "region_unavailable" | "provider_not_enabled" | "allowance_exhausted";

const PARTNER = /\b(gestor[ií]a|asesor[ií]a|despacho|cartera de clientes|mis clientes|varias empresas|muchas empresas|empresas cliente|llevo la (contabilidad|gesti[oó]n))\b/i;

export function intentByRules(message: string): Intent {
  const text = message.toLowerCase();
  if (PARTNER.test(text)) return "partner_gestoria";
  if (/\b(precio|cu[aá]nto|cuesta|tarifa|plan(es)?|coste)\b/.test(text)) return "precios";
  if (/\bdemo|demostraci[oó]n\b/.test(text)) return "demo";
  if (/\bdiagn[oó]stico\b/.test(text)) return "diagnostico";
  if (/\b(contratar|comprar|suscrib|alta)\b/.test(text)) return "contratar";
  if (/\b(persona|humano|llamar|tel[eé]fono|contacto|email|correo)\b/.test(text)) return "contacto_humano";
  if (/\b(ya soy cliente|mi cuenta|no puedo entrar|factura|cobrad|cancelar mi)\b/.test(text)) return "cliente_actual";
  if (/\b(demand|despid|multa|sanci[oó]n|inspecci[oó]n|abogad|legal|ley|obligad)/.test(text)) return "asesoramiento_juridico";
  return "otro";
}

const planesTexto = () =>
  KB.planes.filter((plan) => plan.precio_mes_eur).map((plan) => `${plan.nombre} ${plan.precio_mes_eur} €/mes`).join(", ");

export function fallbackReply(message: string, reason: FallbackReason): { reply: string; intent: Intent; actions: Action[] } {
  const intent = intentByRules(message);
  if (reason === "injection") {
    return {
      reply: "Solo puedo ayudarte con información sobre LegalPrevent: planes, diagnóstico gratuito, demo o el programa Partner. ¿Qué necesitas?",
      intent: "otro", actions: ["link:diagnostico", "link:precios", "form:demo"],
    };
  }
  if (reason === "message_too_long") {
    return {
      reply: "Tu mensaje es demasiado largo para procesarlo. Resúmelo en unas líneas o, si lo prefieres, déjanos tus datos y te contactamos.",
      intent, actions: ["form:contacto", "link:diagnostico"],
    };
  }
  if (reason === "session_limit" || reason === "conversation_limit") {
    return {
      reply: "Hemos llegado al límite de mensajes de esta conversación. Para seguir, solicita una demo o haz el diagnóstico gratuito y el equipo te ayudará personalmente.",
      intent, actions: ["form:demo", "link:diagnostico", "handoff"],
    };
  }
  const intro = "Ahora mismo no puedo darte una respuesta detallada, pero te dejo los siguientes pasos.";
  if (intent === "partner_gestoria") {
    return {
      reply: `${intro} Si gestionas el cumplimiento de varias empresas, el plan Partner (199 €/mes + IVA) está pensado para gestorías, asesorías y despachos.`,
      intent, actions: ["link:partner", "form:partner"],
    };
  }
  if (intent === "precios" || intent === "contratar") {
    return {
      reply: `${intro} Nuestros planes: ${planesTexto()} (+ IVA aplicable) y Enterprise a consultar.`,
      intent, actions: ["link:precios", "link:diagnostico", "form:demo"],
    };
  }
  if (intent === "asesoramiento_juridico") {
    return {
      reply: `${intro} LegalPrevent no presta asesoramiento jurídico individualizado. El diagnóstico gratuito te orienta sobre tus áreas de riesgo y, para tu caso concreto, conviene consultar a un profesional.`,
      intent, actions: ["link:diagnostico", "handoff"],
    };
  }
  return {
    reply: `${intro} Puedes hacer el diagnóstico gratuito, solicitar una demo o escribirnos a ${KB.contacto.email}.`,
    intent, actions: ["link:diagnostico", "form:demo", "handoff"],
  };
}

export const AI_DISCLOSURE = "Soy el asistente virtual de LegalPrevent, una inteligencia artificial. ";
