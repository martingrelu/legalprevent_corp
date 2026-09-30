# PR2 · Agente comercial de IA (LP-SALES-AGENT-001) — diseño técnico y plan de pruebas

Estado: **propuesta, pendiente de aprobación.** Rama `feat/pr2-agente-comercial`
(desde `main` 46591c4). Nada en producción, sin push.

---

## 1. Auditoría: qué reutilizamos de PR0/PR1

| Pieza existente (en producción) | Uso en PR2 |
|---|---|
| `private.settings` clave `agent` (PR1b): `enabled`, presupuesto 25 €/mes, umbrales 50/80/100 %, precios por Mtok, 12 mensajes/sesión/24 h, 600 llamadas/día, TTL de reservas | Configuración del agente. Se actualizan modelo y precios (ver §6) y se añaden claves nuevas (§5). |
| `agent_reserve` / `agent_settle` / `agent_release` (PR1b, solo service role, advisory lock, probado con 200 reservas simultáneas) | **Control de gasto propio**: antes de cada llamada a OpenAI se reserva el coste máximo; después se liquida el real. Presupuesto agotado → fallback. |
| `private.agent_usage`, `agent_budget_months` | Coste real por llamada y por mes. |
| `agent_track_event` + `agent_events` (sin texto, sin email, sin IP; tipos cerrados) | Métricas del embudo: conversación iniciada, clic a diagnóstico/demo/precios/partner, fallback, traspaso a humano. |
| `agent_metrics(p_days)` (CRM administrador) | Panel de métricas del agente en el CRM. |
| `private.rate_hit` + `private.rate_counters` (PR1a) | Límite global por minuto de mensajes y de sesiones nuevas. |
| `submit_lead` + consentimientos versionados + `consent_events` (PR1a) | **Única vía de captación.** El agente no guarda datos personales: ofrece el formulario existente (privacidad obligatoria, comercial opcional). |
| `smooth-action` / `claim_lead_notification` (PR0) | Aviso interno del lead captado desde el agente (tipo `new_lead` o `demo_request`). |
| Resend con dominio verificado (`avisos@legalprevent.com`) | Alertas internas de presupuesto (50/80/100 %) e incidencias. |
| CRM con sesión de administrador (`is_crm_admin`) | **Modo privado de prueba** dentro del CRM (§7). |
| `crm_erase_contact` (PR1c) | Supresión de leads captados por el agente, igual que el resto. |
| Laboratorio (`tests/lab`), réplica de producción, verificadores SQL con ROLLBACK, `*-checks.sh` | Pruebas y despliegue paso a paso, igual que PR1. |

Lo que **no** existe y hay que crear: la Edge Function del agente, la base de
conocimiento comercial, el modo privado, los filtros de entrada/salida, el
límite por IP (depende de la sonda de cabeceras pendiente desde PR1a) y el
texto legal sobre el uso de IA y de OpenAI.

## 2. Arquitectura

```
Navegador (widget público — fase visual posterior — o página privada del CRM)
   │ POST /functions/v1/sales-agent   {session, state, message, page}
   ▼
Edge Function `sales-agent` (Supabase, Deno)            OPENAI_API_KEY solo aquí
   1. Origen permitido (CORS) · tamaño · formato
   2. Modo: público (agent.public_enabled) o privado (JWT de administrador del CRM)
   3. Estado firmado: verifica HMAC del historial (el navegador no puede inventar turnos)
   4. Límites: global/minuto (rate_hit) · sesión (agent_reserve) · día · IP (cuando se verifique)
   5. Filtros de entrada: longitud, redacción de emails/teléfonos/DNI, detector de inyección
   6. Moderación de OpenAI (gratuita) sobre el mensaje
   7. agent_reserve(max tokens) ──► presupuesto agotado / desactivado → FALLBACK
   8. OpenAI Responses API: modelo configurable, store:false, sin herramientas,
      salida estructurada (JSON schema), max_output_tokens, timeout 20 s
   9. Filtros de salida: precios y planes == base de conocimiento, enlaces permitidos,
      sin asesoramiento jurídico, sin datos inventados → si falla, FALLBACK
  10. agent_settle (coste real) / agent_release (si falla) · agent_track_event
  11. Alertas 50/80/100 % → email interno (Resend)
   ▼
Respuesta: {reply, actions[], intent, state firmado}   ← nunca detalles técnicos
```

Decisiones de diseño:
- **Sin herramientas de OpenAI (function calling).** El modelo solo devuelve un
  JSON con la respuesta y *acciones sugeridas* de una lista cerrada; es la
  función quien las valida y el widget quien las pinta. El modelo no puede
  ejecutar nada.
- **Sin estado en nuestra base en modo público.** El historial viaja con el
  navegador firmado con HMAC (`AGENT_STATE_SECRET`), recortado a los últimos 8
  turnos. No guardamos el texto de las conversaciones públicas (minimización).
  En modo privado sí se guardan (§7).
- **Base de conocimiento en el propio prompt** (pequeña, versionada, ~3.500
  tokens) en lugar de búsqueda vectorial: más barato, auditable y cacheable.
- **`store: false`** en OpenAI: no se guarda estado de aplicación. OpenAI
  conserva registros de abuso hasta 30 días salvo aprobación de Zero Data
  Retention (decisión §10).
- **Proyecto propio en OpenAI** con límite de gasto mensual en su panel (segunda
  barrera, además de la nuestra) y clave solo en Supabase Secrets.

## 3. Base de conocimiento comercial

Archivo versionado en el repositorio: `agent/kb/comercial.json`, validado con
esquema y empaquetado en la función (sin base de datos, sin edición desde el
navegador). Cada cambio pasa por PR.

```jsonc
{
  "version": "2026-10-01",
  "revisado_por": "…", "revisado_el": "…",
  "empresa": { "nombre": "LegalPrevent", "que_es": "…", "que_no_es": "no es un despacho; no presta asesoramiento jurídico individualizado" },
  "planes": [
    { "id": "starter", "nombre": "Starter", "precio_mes_eur": 29, "iva": "+ IVA aplicable",
      "para_quien": "…", "incluye": ["…"], "no_incluye": ["…"], "url": "https://legalprevent.legal/comprar?plan=starter" },
    { "id": "pyme", … 79 }, { "id": "business", … 149 },
    { "id": "partner_fundador", "precio_mes_eur": 199, "condiciones": "sin límite de empresas cliente hasta el 31/12/2026", "url": "/partner/" },
    { "id": "enterprise", "precio": "a consultar", "accion": "contacto" }
  ],
  "areas": ["RGPD", "Canal de denuncias", "Laboral", "Igualdad", "Compliance", "AI Compliance Center", …],
  "condiciones_comerciales": { "permanencia": "PENDIENTE", "cancelacion": "PENDIENTE", "prueba_gratuita": "PENDIENTE", "descuentos": "no existen salvo los publicados" },
  "diagnostico": { "que_es": "gratuito, <5 min, 21 preguntas", "url": "/diagnostico/" },
  "demo": { "como": "formulario de demo (consentimientos PR1)", "plazo_respuesta": "PENDIENTE" },
  "partner": { "senales": ["gestoría", "asesoría", "despacho", "cartera de clientes", "varias empresas"], "argumentos": ["…"], "url": "/partner/" },
  "faq": [ { "pregunta": "…", "respuesta": "…" } ],
  "enlaces_permitidos": ["/diagnostico/", "/partner/", "/#precios", "/#contacto", "https://legalprevent.legal/comprar?plan=…"],
  "prohibido_afirmar": ["logos o nombres de clientes", "estadísticas de la portada no verificadas", "garantías de ausencia de sanciones", "descuentos no publicados"]
}
```

- **Fuente única de precios:** una prueba compara los precios del JSON con los
  de `index.html` y `partner/index.html`; si difieren, la prueba falla (no se
  puede publicar un agente con precios distintos a la web).
- **Borrador inicial** a partir del texto actual de la web; los campos
  `PENDIENTE` los completáis vosotros (§10).

## 4. Acciones permitidas y prohibidas

Permitidas (lista cerrada; el modelo solo las *sugiere*, la función las valida):

| Acción | Qué hace | Datos personales |
|---|---|---|
| `link:diagnostico` | Botón al diagnóstico gratuito | No |
| `link:precios` / `link:partner` | Botón a precios o a la página Partner | No |
| `link:comprar:<plan>` | Botón a `legalprevent.legal/comprar?plan=…` (solo planes del JSON) | No |
| `form:demo` / `form:contacto` / `form:partner` | Muestra el formulario **existente** con sus consentimientos; envía por `submit_lead` | Sí, solo por el formulario |
| `intent:<tipo>` | Clasifica (precios, partner_gestoria, demo, soporte_cliente, fuera_de_ambito…) para métricas | No |
| `handoff` | Ofrece contacto humano (formulario o email público) | No |

Prohibidas expresamente (ni existen en el código):
- Leer o escribir leads, clientes, suscripciones, pagos o cualquier tabla (salvo contabilidad/eventos vía RPC de service role).
- Acceso a la plataforma privada (`legalprevent.legal`) o a datos de clientes.
- Crear sesiones de pago, aplicar descuentos o cupones, prometer condiciones.
- Enviar emails a visitantes o a terceros.
- Navegar por internet, leer URLs, ejecutar código, leer archivos.
- Asesoramiento jurídico individualizado (responde con información general y deriva a diagnóstico/demo).
- Recoger datos personales dentro del chat: emails, teléfonos y DNI se **eliminan antes** de enviar el mensaje a OpenAI y se invita a usar el formulario.

## 5. Protección

**Inyección de instrucciones**
- Instrucciones del sistema fijas y la base de conocimiento como *datos*; el mensaje del visitante va delimitado y nunca se mezcla con las instrucciones.
- Sin herramientas: aunque el modelo sea engañado, no puede ejecutar nada.
- Salida estructurada con esquema estricto; lo que no encaja → fallback.
- Validación de salida: cualquier precio en € debe existir en el JSON; enlaces solo de `enlaces_permitidos`; lista de frases de asesoramiento jurídico y de promesas prohibidas; marcador secreto en las instrucciones para detectar su filtración.
- Detector heurístico de inyección en la entrada (p. ej., "ignora las instrucciones", "system prompt", bloques de rol): no se envía al modelo, se responde con el fallback comercial.
- Historial firmado (HMAC): el navegador no puede inventar turnos del asistente.

**Abuso y conversaciones largas**
- Mensaje ≤ 1.000 caracteres; historial enviado al modelo ≤ 8 turnos / ~2.500 tokens.
- 12 mensajes por sesión en 24 h (ya en PR1b); al llegar, cierre amable con CTA a demo/diagnóstico.
- 600 llamadas al día (PR1b) y **nuevo** tope global por minuto (`agent.max_calls_per_minute`, p. ej. 20) y de sesiones nuevas por minuto.
- Límite por IP: pendiente de la sonda de cabeceras de PR1a (necesita autorización); mientras tanto, los topes globales + presupuesto.
- Timeout de 20 s y un solo intento (sin reintentos que dupliquen gasto).

**Gasto inesperado**
- Reserva previa del **coste máximo** de cada llamada (entrada + `max_output_tokens`), liquidación con el coste real; presupuesto mensual serializado (probado).
- `max_output_tokens` = 400; `reasoning.effort` = none (sin tokens de razonamiento).
- Alertas por email al 50/80/100 %; al 100 %, solo fallback.
- Interruptor `agent.enabled` y `agent.public_enabled` (efecto inmediato por SQL).
- Límite de gasto del proyecto en el panel de OpenAI (segunda barrera).
- Presupuesto separado para pruebas privadas (`agent.preview_budget_eur`, p. ej. 5 €).

**Fallback comercial** (sin IA, determinista): mensaje útil según la intención
detectada por reglas y botones a diagnóstico, demo, precios y Partner. Se usa
cuando: desactivado, presupuesto agotado, límite alcanzado, error o timeout de
OpenAI, moderación, inyección detectada o salida no válida. Nunca muestra
errores técnicos.

## 6. Coste estimado por conversación

Precios oficiales (Standard, 30/09/2026, por millón de tokens): `gpt-5.4-mini`
0,75 $ entrada · 0,075 $ entrada en caché · 4,50 $ salida. Supuestos: prefijo
estable (instrucciones + base) ~4.500 tokens, historial ≤ 2.500 tokens, 1 $ ≈
0,90 € (conservador). Rango: con caché de OpenAI – sin caché.

| Escenario | gpt-5.4-mini | gpt-5.6-luna | gpt-6-luna |
|---|---|---|---|
| A. Consulta rápida (3 mensajes) | 0,7–1,2 cént. | 0,2–0,3 cént. | 0,1–0,2 cént. |
| B. Conversación comercial típica (6) | 1,4–2,7 cént. | 0,4–0,7 cént. | 0,2–0,4 cént. |
| C. Partner/gestoría larga (12, tope) | 3,7–6,7 cént. | 1,0–1,8 cént. | 0,5–0,9 cént. |
| D. Abuso al máximo permitido por sesión | 4,5–7,5 cént. | 1,2–2,0 cént. | 0,6–1,0 cént. |

- Con `gpt-5.4-mini`, 25 €/mes ≈ **920 conversaciones típicas** en el peor caso (sin caché).
- Peor caso de abuso diario con los topes actuales: ≈ 2,9 €/día → el presupuesto mensual lo corta igualmente.
- Moderación de OpenAI: gratuita. Procesamiento en la UE (si se aprueba): +10 %.
- `private.settings.agent` se actualizará con el modelo y precios elegidos (en €) antes de publicar.

## 7. Modo privado de prueba

- `agent.public_enabled = false` hasta vuestra aprobación: la función rechaza
  peticiones públicas (el widget público ni siquiera se publica en PR2).
- Página privada **dentro del CRM** (`/crm/#/agente`), solo para administradores
  del CRM (JWT verificado en la función con `is_crm_admin`): conversación real con
  el modelo real, más un panel de depuración: intención, acciones, tokens, coste,
  motivo del fallback y resultado de los filtros.
- Las conversaciones privadas **sí se guardan** (`private.agent_test_transcripts`,
  30 días) para revisarlas y convertir los fallos en pruebas; se pueden marcar
  como "correcta / incorrecta" con un comentario.
- Selector de modelo en modo privado (entre los autorizados en `agent.models_allowed`)
  para comparar calidad/coste con las mismas conversaciones.
- Batería de conversaciones difíciles preparada (§8.5) para que Martín y tú la
  ejecutéis y valoréis.
- Presupuesto de pruebas separado (p. ej. 5 €).

## 8. Plan de pruebas

**8.1 Seguridad** (unitarias + laboratorio con OpenAI simulado)
- La clave nunca aparece en respuestas, logs ni en el código del navegador (búsqueda en el bundle y en respuestas).
- Modo público desactivado → 403; modo privado sin JWT de administrador → 401/403.
- CORS: otras webs rechazadas; llamadas directas siguen sujetas a límites.
- Historial manipulado (HMAC inválido, turnos de asistente inventados) → rechazado.
- 30 ataques de inyección conocidos → no llegan al modelo o su salida se bloquea (el simulador devuelve salidas maliciosas: precios falsos, enlaces externos, "te recomiendo demandar", filtración del marcador).
- Mutaciones: quitar cada filtro hace fallar su prueba.

**8.2 Costes**
- Presupuesto con 200 conversaciones simultáneas: nunca se supera (ya probado en PR1b; se repite con la función real).
- OpenAI falla o tarda → reserva liberada, coste 0, fallback.
- Coste liquidado = tokens reales × precio configurado (incluida la entrada en caché).
- Alertas 50/80/100 % una sola vez cada una.

**8.3 Precisión comercial**
- Prueba de deriva: precios del JSON == precios de la web.
- El validador rechaza cualquier precio, plan, descuento o enlace fuera del JSON.
- Batería con el modelo real (privada, autorizada, coste estimado < 1 €): preguntas de precios, presión por descuentos, comparación con competidores, peticiones de asesoramiento jurídico, detección Partner/gestoría, fuera de ámbito, clientes actuales con soporte. Criterios por regla + revisión humana.

**8.4 Privacidad**
- Emails/teléfonos/DNI redactados antes de llamar a OpenAI (el simulador comprueba lo recibido).
- `agent_events` y `agent_usage` sin texto ni datos personales.
- Los leads del agente pasan por `submit_lead` con consentimientos y versión; aparecen en el CRM con origen `agente`; se pueden suprimir con `crm_erase_contact`.
- Modo público: ningún texto de conversación en nuestra base.

**8.5 Concurrencia**
- 50 sesiones simultáneas + tope por minuto: exactamente N llamadas al modelo.
- Una misma sesión con 20 mensajes simultáneos: exactamente 12.
- Presupuesto al límite con carreras: ninguna llamada por encima.

**8.6 Despliegue** (igual que PR1): migración → verificación SQL con ROLLBACK →
función → comprobaciones de solo lectura → prueba privada con vosotros →
aprobación → (fase visual) widget público.

## 9. Entregables de PR2

1. Migración: claves nuevas de `agent` (modelo/precios, `public_enabled`,
   `max_calls_per_minute`, presupuesto de pruebas, modelos permitidos),
   `agent_test_transcripts` y su RPC, `agent_guard` (tope global).
2. Edge Function `sales-agent` + base de conocimiento + filtros + fallback.
3. Página privada en el CRM con panel de depuración y valoración.
4. Pruebas (unitarias, laboratorio con OpenAI simulado, verificación SQL) y runbook.
5. **No** incluye el widget público (fase visual con la mascota).

## 10. Decisiones que necesito de vosotros

1. **Modelo.** `gpt-5.4-mini` cuesta ~4–8 veces más que `gpt-5.6-luna`/`gpt-6-luna`
   (modelos más nuevos). Propuesta: arrancar con `gpt-5.4-mini` y comparar en el
   modo privado con las mismas conversaciones antes de fijarlo.
2. **Texto legal** (necesita validación jurídica): aviso visible de que se habla
   con una IA (transparencia del Reglamento de IA), mención de OpenAI como
   encargado del tratamiento y transferencia internacional en la Política de
   Privacidad (nueva versión de consentimiento).
3. **Conservación**: modo público sin guardar texto (propuesto); modo privado
   guardado 30 días.
4. **OpenAI**: crear el proyecto `legalprevent-sales-agent`, fijar su límite de
   gasto mensual y guardar la clave en Supabase (`OPENAI_API_KEY`) vosotros.
   Opcional: solicitar procesamiento en la UE y/o Zero Data Retention.
5. **Probadores**: cuenta de administrador del CRM para Martín (o un rol
   `agent_tester` separado, más restrictivo).
6. **Base de conocimiento**: completar los `PENDIENTE` (qué incluye cada plan,
   permanencia, cancelación, prueba gratuita, plazo de respuesta a demos, cómo se
   agenda la demo) y confirmar si los logos y cifras de la portada son reales.
7. **Límite por IP**: autorizar la sonda de cabeceras (una petición de prueba
   desde el navegador a una función temporal) para poder limitar por visitante.
8. **Traspaso a humano**: ¿solo formulario, o también email/teléfono/WhatsApp público?
9. **Idiomas**: ¿solo español o también inglés/catalán?
10. **Presupuesto de pruebas**: ¿5 € separados de los 25 € de producción?

## 11. Decisiones aprobadas (30/09/2026)

1. Comparar `gpt-5.4-mini`, `gpt-5.6-luna` y `gpt-6-luna` en modo privado; modelo definitivo tras la evaluación.
2. El agente se identifica como IA. Público: sin texto guardado. Privado: 30 días solo para evaluación. Política de Privacidad pendiente de validación jurídica antes de publicar.
3. Procesamiento en la UE cuando esté disponible para el modelo; ZDR documentado, sin presuponerlo.
4. Probador: cuenta de administrador del CRM del usuario (sin rol nuevo).
5. Excluidas cifras, testimonios, logos y afirmaciones no confirmadas; auditoría en `AUDITORIA-COMERCIAL.md`.
6. IP: solo investigación técnica en lectura; sin almacenamiento ni tracking nuevos.
7. Contacto humano: formulario, email y teléfono (sin WhatsApp).
8. Solo español; arquitectura preparada para más idiomas.
9. Presupuesto de pruebas 5 €; público 25 €/mes; límites de PostgreSQL además del de OpenAI.
10. Sin herramientas; prohibido: datos de clientes, pagos, precios, descuentos, emails, navegación, asesoramiento individual.

Siguientes documentos: `AUDITORIA-COMERCIAL.md`, `eval/bateria-v1.json`, `IMPLEMENTACION-MODO-PRIVADO.md`.
