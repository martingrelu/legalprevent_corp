// Base de conocimiento comercial del agente (fuente controlada por
// LegalPrevent). Cada dato lleva su estado:
//   "confirmado"  → el agente puede usarlo;
//   "provisional" → decidido internamente pero NO publicable todavía: no se
//                   envía al modelo y el validador rechaza sus cifras;
//   "pendiente"   → sin definir: el agente responde que no dispone de ese dato y
//                   ofrece contacto humano.
// Cambios solo por PR. Una prueba compara los precios confirmados con los de la
// web (index.html y partner/index.html).
// Auditoría y decisiones: docs/pr2/AUDITORIA-COMERCIAL.md (30/09/2026).

export type Estado = "confirmado" | "provisional" | "pendiente";

export const KB = {
  version: "2026-10-01.1",
  idioma: "es",
  empresa: {
    nombre: "LegalPrevent",
    que_es:
      "Plataforma tecnológica (SaaS B2B) de apoyo al cumplimiento normativo y la gestión preventiva de riesgos legales para empresas y profesionales: diagnóstico, generación documental automatizada, alertas, seguimiento y evidencias.",
    que_no_es:
      "No es un despacho de abogados ni presta asesoramiento jurídico individualizado. Los resultados de la plataforma son orientativos y deben revisarse antes de implantarse.",
    validacion_juridica:
      "Existe un servicio adicional y opcional de validación jurídica por abogados o profesionales, independiente de la plataforma y con contratación específica (sin precio publicado).",
  },
  planes: [
    { id: "starter", nombre: "Starter", estado: "confirmado" as Estado, precio_mes_eur: 29,
      descripcion: "Para empresas pequeñas que quieren ordenar obligaciones esenciales.",
      url_contratar: "https://legalprevent.legal/comprar?plan=starter" },
    { id: "pyme", nombre: "Pyme", estado: "confirmado" as Estado, precio_mes_eur: 79,
      descripcion: "Diagnóstico, documentación y alertas para equipos en crecimiento.",
      url_contratar: "https://legalprevent.legal/comprar?plan=pyme" },
    { id: "business", nombre: "Business", estado: "confirmado" as Estado, precio_mes_eur: 149,
      descripcion: "Mayor cobertura y seguimiento continuo.",
      nota_interna: "\"Soporte profesional ampliado\" aparece en la web pero está PENDIENTE de definir: no se menciona ni interpreta.",
      url_contratar: "https://legalprevent.legal/comprar?plan=business" },
    { id: "partner", nombre: "Partner", estado: "confirmado" as Estado, precio_mes_eur: 199,
      descripcion: "Para gestorías, asesorías y despachos profesionales que gestionan el cumplimiento de su cartera de empresas cliente desde un único entorno.",
      url_contratar: "https://legalprevent.legal/comprar?plan=partner", url_info: "https://legalprevent.com/partner/" },
    { id: "enterprise", nombre: "Enterprise", estado: "confirmado" as Estado, precio_mes_eur: null,
      descripcion: "Solución a medida para grupos, múltiples centros y necesidades avanzadas. Precio a consultar.",
      accion: "form:contacto" },
  ],
  iva: "Todos los precios son + IVA aplicable.",
  pago_anual: {
    estado: "provisional" as Estado,
    motivo: "Existe en la página de contratación pero no se anuncia hasta publicarlo en la web (decisión 30/09/2026).",
    precios_anuales_eur: { starter: 261, pyme: 711, business: 1341 },
  },
  documentos_ia_mes: {
    estado: "provisional" as Estado,
    motivo: "Límites del código de la plataforma pendientes de verificar en producción antes de usarlos.",
    valores: { starter: 5, pyme: 20, business: 60, partner: "150 por empresa cliente", enterprise: "sin límite" },
  },
  partner_fundador_2026: {
    estado: "confirmado" as Estado,
    hechos: [
      "\"Partner Fundador 2026\" es la promoción vigente del plan Partner para nuevas contrataciones formalizadas durante 2026.",
      "Permite incorporar y gestionar empresas cliente sin límite numérico hasta el 31/12/2026.",
      "El plan Partner incluye hasta 150 generaciones mediante IA por empresa cliente y mes natural (publicado en la página Partner).",
      "Si una empresa cliente tiene una suscripción propia activa, se le aplican los límites de su propio plan.",
      "Se puede empezar con algunas empresas y ampliar progresivamente.",
    ],
    futuro:
      "Las condiciones a partir de 2027 están pendientes de definición contractual: el agente no promete precios ni condiciones futuras y deriva a contacto.",
  },
  areas: ["Protección de datos (RGPD)", "Canal de denuncias", "Laboral", "Igualdad y diversidad", "Compliance empresarial"],
  diagnostico: {
    estado: "confirmado" as Estado,
    hechos: [
      "Es gratuito.",
      "Se completa en menos de 5 minutos: 21 preguntas con respuestas Sí, No o Parcialmente.",
      "Muestra un informe visual con nivel de cumplimiento, áreas críticas, prioridades y riesgos detectados.",
    ],
    no_prometer: "No prometer informe en PDF ni envío por email.",
    url: "https://legalprevent.com/diagnostico/",
  },
  demo: {
    estado: "confirmado" as Estado,
    hechos: ["Se solicita con el formulario de demo de la web; el equipo revisa la solicitud y contacta con los próximos pasos."],
    pendiente: "Plazo de respuesta, duración y formato: no se indican.",
  },
  contratacion: {
    estado: "confirmado" as Estado,
    hechos: [
      "Se contrata online en la página de contratación con pago seguro con Stripe; después se crea el acceso a la plataforma.",
      "No hay periodo de prueba gratuito ni cupones publicados.",
      "Enterprise no se contrata online: se solicita por contacto.",
    ],
  },
  cancelacion: {
    estado: "pendiente" as Estado,
    motivo: "Permanencia, cancelación y reembolsos pendientes de revisión contractual.",
  },
  contacto: {
    estado: "confirmado" as Estado,
    email: "legal@legalprevent.com",
    formulario: "Formulario de contacto o demo de la web.",
    telefono: null,
    whatsapp: null,
  },
  excluido: [
    "Logos o nombres de clientes de la portada.",
    "Testimonios de la portada.",
    "Estadísticas y resultados sin fuente (porcentajes, multiplicadores, horas ahorradas).",
    "Cifras de sanciones: no se cuantifican.",
    "Paneles de ejemplo de la portada.",
  ],
} as const;

// Precios que el agente puede citar (el validador rechaza cualquier otra cifra en €).
export function preciosPublicables(): number[] {
  return KB.planes.flatMap((plan) => (plan.estado === "confirmado" && plan.precio_mes_eur ? [plan.precio_mes_eur] : []));
}

// Enlaces que el agente puede usar.
export const ENLACES = {
  diagnostico: "https://legalprevent.com/diagnostico/",
  precios: "https://legalprevent.com/#precios",
  partner: "https://legalprevent.com/partner/",
  contacto: "https://legalprevent.com/#contacto",
  comprar: (plan: string) => `https://legalprevent.legal/comprar?plan=${plan}`,
} as const;

export const PLANES_COMPRABLES = ["starter", "pyme", "business", "partner"] as const;

// Texto de la base que se envía al modelo: SOLO lo confirmado.
export function kbParaModelo(): string {
  const confirmados = KB.planes.filter((p) => p.estado === "confirmado");
  const lineas = [
    `Versión de la base: ${KB.version}.`,
    `QUÉ ES: ${KB.empresa.que_es}`,
    `QUÉ NO ES: ${KB.empresa.que_no_es}`,
    `VALIDACIÓN JURÍDICA: ${KB.empresa.validacion_juridica}`,
    "PLANES (precios mensuales):",
    ...confirmados.map((p) =>
      `- ${p.nombre}: ${p.precio_mes_eur ? `${p.precio_mes_eur} €/mes` : "precio a consultar"}. ${p.descripcion}`),
    `IVA: ${KB.iva}`,
    `ÁREAS: ${KB.areas.join(", ")}.`,
    "PARTNER (promoción Partner Fundador 2026):",
    ...KB.partner_fundador_2026.hechos.map((h) => `- ${h}`),
    `- ${KB.partner_fundador_2026.futuro}`,
    "DIAGNÓSTICO GRATUITO:",
    ...KB.diagnostico.hechos.map((h) => `- ${h}`),
    `- ${KB.diagnostico.no_prometer}`,
    "DEMO:",
    ...KB.demo.hechos.map((h) => `- ${h}`),
    `- ${KB.demo.pendiente}`,
    "CONTRATACIÓN:",
    ...KB.contratacion.hechos.map((h) => `- ${h}`),
    `CONTACTO HUMANO: formulario de contacto o demo, o el email ${KB.contacto.email}. No hay teléfono ni WhatsApp.`,
    "SIN INFORMACIÓN (responde que no dispones de ese dato y ofrece contacto humano): permanencia, cancelación y reembolsos; pago anual; límites de documentos IA de los planes Starter, Pyme, Business y Enterprise; qué es el soporte del plan Business; condiciones a partir de 2027; plazos, duración o formato de la demo.",
    "PROHIBIDO MENCIONAR: nombres o logos de clientes, testimonios, estadísticas o resultados, cifras de sanciones.",
  ];
  return lineas.join("\n");
}
