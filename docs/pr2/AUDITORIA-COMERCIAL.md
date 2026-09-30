# PR2 · Auditoría de la información comercial publicada (30/09/2026)

Fuentes revisadas (solo lectura):
- Web pública `legalprevent_corp` (`main` 46591c4): portada, `/partner/`,
  `/diagnostico/`, `/gracias/`, Términos y Condiciones, Aviso Legal,
  Documentación legal, Política de Privacidad.
- Plataforma `legalprevent` (commit desplegado 44920bb, **sin** los cambios
  locales sin confirmar): `lib/billing/plans.ts` ("fuente única de verdad del
  catálogo"), `lib/billing/entitlements.ts`, `app/api/stripe/checkout/route.ts`,
  `app/(marketing)/comprar/`.

Regla para el agente: **solo usará lo marcado ✅ tras vuestra confirmación**.
Todo lo ⚠️/❌ queda fuera de la base de conocimiento hasta resolverlo.

## 1. Planes y precios

| Plan | Web | Plataforma (checkout) | Estado |
|---|---|---|---|
| Starter | 29 €/mes + IVA | 29 €/mes · **anual 261 €/año** ("3 meses gratis", ahorro 87 €) | ⚠️ La web no muestra el precio anual |
| Pyme | 79 €/mes + IVA | 79 €/mes · **anual 711 €/año** (ahorro 237 €) | ⚠️ Ídem |
| Business | 149 €/mes + IVA | 149 €/mes · **anual 1.341 €/año** (ahorro 447 €) | ⚠️ Ídem |
| Partner | "Partner Fundador 2026", 199 €/mes + IVA | nombre **"Gestorías"**, 199 €/mes, **sin** modalidad anual | ⚠️ Nombre distinto |
| Enterprise | "Consultar" → contacto | "Consultar", sin checkout | ✅ |

Preguntas:
1. ¿El agente puede mencionar el pago anual ("3 meses gratis")? Es un precio
   publicado en `legalprevent.legal/comprar`, pero no en la web. Si sí, ¿lo
   añadimos también a la web para que coincidan?
2. ¿Nombre oficial del plan de 199 €: "Partner Fundador 2026", "Gestorías" o
   "Plan Partner"? (La página Partner usa los tres.)

## 2. Funcionalidades por plan

| Dato | Web | Plataforma | Estado |
|---|---|---|---|
| Descripción Starter | "Para empresas pequeñas que quieren ordenar obligaciones esenciales." | — | ⚠️ Genérica |
| Descripción Pyme | "Diagnóstico, documentación y alertas para equipos en crecimiento." | — | ⚠️ Genérica |
| Descripción Business | "Mayor cobertura, seguimiento continuo y soporte profesional ampliado." | — | ⚠️ "Soporte profesional ampliado" sin definir |
| Documentos IA / mes | no se publica (salvo Partner) | Starter **5**, Pyme **20**, Business **60**, Partner **150 por empresa**, Enterprise sin límite | ❌ La web no lo dice |
| Partner | "Hasta 150 generaciones IA por empresa y mes natural", sin límite de empresas hasta 31/12/2026 | 150 por empresa; cobertura de cartera | ✅ Coinciden |
| Formación | no se publica | acceso en todos los planes | ❌ ¿Se puede mencionar? |
| Áreas | RGPD, Canal de denuncias, Laboral, Igualdad, Compliance, "Prevención legal continua"; Partner añade Governance y AI Compliance Center | — | ⚠️ ¿Qué áreas incluye cada plan? ¿AI Compliance Center es solo Partner? |
| Usuarios por cuenta | no se publica | — | ❌ Falta |
| Soporte / validación jurídica | "Soporte profesional"; Términos: validación por abogados = servicio **adicional con contratación específica** | — | ⚠️ El agente dirá que es un servicio aparte, sin precio |

Preguntas:
3. Tabla oficial "qué incluye cada plan" (áreas, documentos IA/mes, usuarios, soporte).
4. ¿Qué es exactamente "soporte profesional ampliado" en Business?

## 3. Partner / gestorías

✅ Publicado y coherente: 199 €/mes + IVA; nuevas contrataciones durante 2026;
empresas cliente sin límite hasta 31/12/2026; 150 generaciones IA por empresa y
mes; si una empresa cliente tiene suscripción propia se aplican sus límites; desde
01/01/2027 "modelo Partner vigente", aviso con 30 días y cancelación de la
renovación sin penalización; condiciones preferentes 2027 "se comunicarán".

Preguntas:
5. ¿El agente puede decir algo sobre 2027 más allá de "se comunicará con 30 días"?
   (Propuesta: nada más.)

## 4. Diagnóstico gratuito

✅ Gratuito, "menos de 5 minutos", 21 preguntas (Sí/No/Parcialmente), informe
visual con áreas críticas, prioridades y riesgos. Pide empresa, email, teléfono,
empleados y sector, con privacidad obligatoria y comunicaciones comerciales opcionales.

⚠️ El texto de la página habla de "arquitectura preparada / cuando se conecten
las integraciones" (PDF, automatizaciones). El agente **no** prometerá informe
en PDF ni envío por email.

## 5. Demo

⚠️ Formulario "Solicitar demostración" (solo email + consentimientos). La página
de gracias dice: "revisamos la solicitud, contactamos contigo, te indicamos
próximos pasos".

Preguntas:
6. ¿Plazo de respuesta que podemos comprometer (p. ej., "en 24–48 h laborables")?
7. ¿La demo es por videollamada? ¿Duración? ¿Hay agenda (Calendly u otra)?

## 6. Contratación

✅ Botones "Contratar" → `legalprevent.legal/comprar?plan=…` → pago con Stripe
(IVA automático, dirección de facturación y NIF obligatorios) → crear contraseña
y acceso. Enterprise → contacto.
✅ Sin periodo de prueba ni cupones en el checkout (no hay `trial_period_days`
ni `allow_promotion_codes`).

## 7. Cancelación y permanencia

❌ **No publicado** en la web ni en los Términos para los planes de empresa.
Solo Partner: cancelar la renovación sin penalización ante nuevas condiciones 2027.
Términos §10: "tarifas publicadas en cada momento"; la falta de pago puede
suspender el acceso. La plataforma respeta `cancel_at_period_end` (el acceso se
mantiene hasta el fin del periodo pagado).

Preguntas:
8. ¿Hay permanencia? ¿Se puede cancelar en cualquier momento? ¿Cómo (desde el
   panel, por email)? ¿Se mantiene el acceso hasta el fin del periodo? ¿Reembolsos
   en el plan anual?

## 8. Contacto

⚠️ Único contacto publicado: **legal@legalprevent.com** (Aviso Legal y Política
de Privacidad). **No hay teléfono publicado** en ninguna página.

Preguntas:
9. ¿Email comercial para el agente (¿legal@ u otro, p. ej. hola@/comercial@)?
10. ¿Teléfono comercial y horario?

## 9. Afirmaciones excluidas del agente (hasta confirmar su veracidad)

| Afirmación en la portada | Motivo |
|---|---|
| Logos "Novaline, Altair Group, Medixia, UrbanOps, Northbit" | Posibles clientes ficticios de maqueta |
| "72 % de los riesgos…", "4.8x más coste…", "31h mensuales…" | Estadísticas sin fuente |
| "58 % menos incidencias", "3,2x mayor control", "41 horas ahorradas" | Resultados sin fuente |
| Testimonios ★★★★★ (Director General, Gerente, Administración) | Sin identificar |
| Panel de ejemplo "82 % cumplimiento, +14 %" | Maqueta ilustrativa |
| "Hasta 20M€ o el 4 %" (RGPD) | Dato normativo correcto, pero el agente no dará cifras de sanciones: solo "consulta la normativa / diagnóstico" |

Pregunta:
11. ¿Alguno de estos es real y verificable? (Si no, conviene también revisarlos
    en la web por la normativa de publicidad.)

## 10. Otras observaciones

- La Política de Privacidad (04/06/2026) no nombra encargados ni transferencias;
  la "Documentación legal" (DPA para clientes) sí lista OpenAI, Stripe, Resend,
  Supabase y Hostinger. Pendiente de validación jurídica antes del agente público.
- La Documentación legal cita a Hostinger como alojamiento web; la web está en
  GitHub Pages (Hostinger gestiona el dominio y el correo).
- Stripe muestra un precio "Business Anual" creado el 13/09/2026, coherente
  con la plataforma.
