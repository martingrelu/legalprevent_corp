# PR2 · Implementación del modo privado (laboratorio de evaluación)

Decisiones aprobadas (30/09/2026): comparar `gpt-5.4-mini`, `gpt-5.6-luna` y
`gpt-6-luna`; sin herramientas; modo público apagado; conversaciones privadas
guardadas 30 días solo para evaluación; probador = cuenta de administrador del
CRM del usuario; solo español; presupuesto de pruebas 5 € separado de los
25 €/mes públicos; procesamiento en la UE cuando esté disponible; ZDR sin
presuponer.

## 1. Piezas y orden de construcción

| # | Pieza | Archivos | Depende de OpenAI |
|---|---|---|---|
| 1 | Migración `20261001_agent_private_lab.sql` | ver §2 | No |
| 2 | Proveedor de modelos con interfaz y simulador | `supabase/functions/sales-agent/providers.ts` | No (el simulador) |
| 3 | Núcleo del agente: prompt, redacción, validación, fallback | `supabase/functions/sales-agent/{prompt,redact,validate,fallback,kb}.ts` | No |
| 4 | Edge Function `sales-agent` (solo modo privado) | `supabase/functions/sales-agent/index.ts` | No (con simulador) |
| 5 | Base de conocimiento v0 (solo datos ✅ de la auditoría) | `agent/kb/comercial.json` + esquema | No |
| 6 | Laboratorio privado en el CRM | `crm/src/agent-lab.js` + ruta `#/agente` | No |
| 7 | Ejecutor de la batería | `crm/src/agent-lab.js` (botón "Ejecutar batería") | No |
| 8 | Pruebas unitarias + laboratorio con OpenAI simulado + verificación SQL | `tests/`, `tests/lab/`, `tests/sql/` | No |
| 9 | Proveedor real OpenAI (Responses API) | `providers.ts` | **Sí** (clave) |

Todo hasta el paso 8 se construye y prueba sin clave ni gasto. El paso 9 es el
único que necesita el proyecto de OpenAI.

## 2. Migración

- `private.settings` → clave `agent` ampliada (sin tocar el presupuesto público):
  ```json
  {
    "public_enabled": false,
    "preview_enabled": true,
    "preview_budget_eur": 5,
    "max_calls_per_minute": 20,
    "region": "eu",                       // "eu" | "global"
    "models": {
      "gpt-5.4-mini": { "in": 0.75, "cached_in": 0.075, "out": 4.50, "eu": null },
      "gpt-5.6-luna": { "in": 0.20, "cached_in": 0.02,  "out": 1.20, "eu": null },
      "gpt-6-luna":   { "in": 0.10, "cached_in": 0.01,  "out": 0.50, "eu": null }
    },                                      // USD por Mtok; "eu": true/false tras comprobarlo
    "usd_eur": 0.90,
    "default_model": null                   // se fija tras la evaluación
  }
  ```
- Presupuesto **separado** para pruebas: `agent_budget_months` pasa a tener
  ámbito (`scope`: `public` | `preview`); `agent_reserve`/`agent_settle` reciben
  el ámbito y el modelo, y calculan el coste con los precios del modelo
  (incluida la entrada en caché). Compatibles con las llamadas actuales
  (ámbito por defecto `public`).
- `private.agent_test_transcripts` (solo modo privado): conversación, modelo,
  turnos (texto ya redactado), acciones, tokens, coste, latencia, motivo de
  fallback, valoración (1–5 por criterio) y comentario; `expires_at = now() + 30 días`.
- Borrado automático: `agent_purge_test_transcripts()` (service role) llamado
  por la propia función de forma oportunista (sin pg_cron) + verificación de que
  nada supera 30 días.
- RPC para el CRM (solo administrador): listar conversaciones de prueba, valorar,
  resumen por modelo (calidad media, coste medio, latencia p50/p95, % fallback).
- Nada nuevo sobre IP (según la decisión 6: solo investigación).

## 3. Edge Function `sales-agent`

```
POST /functions/v1/sales-agent
Authorization: Bearer <JWT de administrador del CRM>   (modo privado)
{ "session": "...", "state": "<historial firmado>", "message": "...", "model": "gpt-6-luna" }
```

1. Modo público: `public_enabled=false` → 403 (siempre en PR2).
2. Modo privado: JWT válido (verificado con Supabase Auth) + `is_crm_admin`; si no → 401/403.
3. Modelo solicitado ∈ `agent.models`; si no → 400.
4. Estado firmado con HMAC (`AGENT_STATE_SECRET`); recorte a 8 turnos.
5. Mensaje ≤ 1.000 caracteres; redacción de emails, teléfonos, DNI/NIE/CIF e IBAN.
6. Detector de inyección → fallback (registrado en la conversación de prueba).
7. Moderación de OpenAI (gratuita) → si marca, fallback.
8. `agent_reserve(scope='preview', model, max tokens)`; sin presupuesto → fallback.
9. Proveedor: `simulated` (laboratorio) u `openai` (Responses API, `store:false`,
   sin `tools`, `text.format` = JSON schema estricto, `max_output_tokens: 400`,
   `reasoning.effort: none` cuando el modelo lo admita, `prompt_cache_key` por
   versión de la base, timeout 20 s, sin reintentos). Endpoint según región
   (§4).
10. Validación de salida → si falla, fallback (motivo registrado).
11. `agent_settle` con tokens reales (entrada, entrada en caché, salida).
12. Guarda el turno en `agent_test_transcripts` (solo modo privado).
13. Respuesta: `{reply, actions, intent, state, debug:{model, tokens, cost_eur, latency_ms, fallback_reason, filtros}}`
    (`debug` solo en modo privado).

Primer mensaje de cada conversación: identificación fija como asistente de IA
(no depende del modelo).

## 4. Región UE y retención

- `agent.region = "eu"` → endpoint `https://eu.api.openai.com/v1`; `"global"` →
  `https://api.openai.com/v1`. **Sin cambio silencioso de región**: si la UE no
  está habilitada para el proyecto o el modelo, la llamada falla y se responde
  con fallback (y se ve en el panel de depuración). Así nunca se envían datos
  fuera de la UE si hemos configurado UE.
- Requisitos (documentación de OpenAI, 30/09/2026): la residencia de datos se
  solicita a ventas de OpenAI; para regiones fuera de EE. UU. exige aprobación
  de controles de abuso (Modified Abuse Monitoring o ZDR) y firmar una enmienda
  de retención; +10 % de precio en modelos publicados desde el 5/03/2026.
  Qué modelos admiten procesamiento regional se comprueba en la guía "Your data"
  → `agent.models.<modelo>.eu` se rellena con el resultado.
- ZDR / Modified Abuse Monitoring: requieren aprobación previa de OpenAI. Sin
  ellos, OpenAI conserva registros de abuso hasta 30 días (no se usan para
  entrenar en la API). Con `store:false` no hay estado de aplicación. No se
  presupone ZDR: el panel de depuración mostrará la configuración vigente.
- Mientras la UE no esté aprobada, el modo privado puede usar `"global"` solo con
  vuestra autorización expresa (conversaciones de prueba, sin datos de terceros).

## 5. Laboratorio privado en el CRM (`/crm/#/agente`)

- Solo visible con sesión de administrador.
- Conversación libre con selector de modelo; panel de depuración por turno.
- "Ejecutar batería": envía `docs/pr2/eval/bateria-v1.json` con el modelo
  elegido, aplica las reglas automáticas y guarda resultados.
- Valoración humana por respuesta (5 criterios de la rúbrica) y comentario.
- Comparativa por modelo: infracciones, fallback, coste/conversación,
  latencia p50/p95, nota media por criterio.
- Contador del presupuesto de pruebas (x € de 5 €).

## 6. Pruebas (antes de usar la clave)

- Unitarias: redacción (emails, teléfonos, DNI/NIE/CIF, IBAN), detector de
  inyección, validador de salida (precios, enlaces, frases prohibidas, marcador),
  fallback por motivo, HMAC del estado, esquema de la base, deriva de precios
  web↔base, región sin cambio silencioso.
- Laboratorio (OpenAI simulado en el gateway): modo público 403; privado sin
  administrador 401/403; presupuesto de pruebas separado del público; 50
  peticiones simultáneas; error/timeout del proveedor → reserva liberada;
  transcripciones solo en privado y purgadas a los 30 días; `agent_events` sin
  texto; el simulador comprueba que nunca recibe datos personales.
- Verificación SQL de la migración (ROLLBACK) y mutaciones.

## 7. Clave de OpenAI (cuando lleguemos al paso 9)

Lo haréis vosotros; nunca pasará por el chat ni por el repositorio:
1. platform.openai.com → Settings → Projects → **Create project**
   `legalprevent-sales-agent` (región UE si os la aprueban).
2. En el proyecto → **Limits**: límite de gasto mensual (p. ej. 30 $) y
   modelos permitidos: los tres candidatos.
3. En el proyecto → **API keys → Create new secret key** (permisos restringidos:
   Responses y Moderations). Copiarla una sola vez.
4. Supabase → proyecto `legalprevent_corp` → **Edge Functions → Secrets → Add
   new secret**: nombre `OPENAI_API_KEY`, valor = la clave → Save. Añadir también
   `AGENT_STATE_SECRET` (os daré el comando para generarla en vuestro ordenador).
5. Yo solo comprobaré que el secreto existe (nombre y huella), nunca su valor.
