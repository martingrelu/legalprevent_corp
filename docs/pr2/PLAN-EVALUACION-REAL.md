# PR2 · Plan de evaluación real de los tres modelos (borrador para aprobación)

> **Estado:** planteamiento APROBADO el 01/10/2026. Antes de la primera tanda hay que desplegar y verificar la mejora del punto 8. Todavía no se ha cambiado la región, no se ha concedido cupo y no se ha hecho ninguna llamada real.
> **Configuración actual:**
> - `public_enabled = false`
> - `real_call_allowance = 0`
> - `region = eu`
> - presupuesto privado de 5 € (gastado: 0,0002 €)

## 1. Alcance

| Elemento | Valor |
|---|---|
| Modelos | `gpt-6-luna`, `gpt-5.6-luna` y `gpt-5.4-mini` (snapshot `gpt-5.4-mini-2026-03-17`) |
| Batería | `docs/pr2/eval/bateria-v1.json`: 49 casos y **62 turnos** (47 casos de 1 turno, INY-08 con 2 turnos y ROB-04 con 13) |
| Turnos que llegan a OpenAI | **56 por modelo** |
| Turnos que se cortan antes de OpenAI | **6 por modelo**: 5 por el detector de inyección (INY-01, INY-02, INY-03, INY-06 y uno de INY-08) y 1 por longitud (ROB-01). Son iguales en los tres modelos porque los filtros son deterministas, y cuentan igual para el cumplimiento de reglas. |
| Mismos casos | Sí. Mismo fichero, mismo orden y mismo texto. Cada caso empieza una conversación nueva. |
| Modo | Exclusivamente privado. El laboratorio del CRM solo está disponible para administradores y el modo público sigue apagado. |

El recuento de 56 y 6 se ha calculado en local con el `guard.ts` y el `redact.ts` desplegados, aplicados a los 62 turnos de la batería.

## 2. Decisión previa: la región

El proyecto actual de OpenAI tiene residencia **Global**, así que la batería real **solo puede ejecutarse en Global**. La alternativa es esperar a que OpenAI apruebe un proyecto europeo (`SOLICITUD-OPENAI-UE.md`). La autorización de la opción B se limitaba a un único mensaje, por lo que la batería necesita una **autorización nueva y explícita** para usar Global.

- **Opción 1 · Global para la batería:** los casos son sintéticos, sin datos personales ni de terceros. Se mantienen `store:false`, la redacción de datos personales y la moderación previa.
- **Opción 2 · Esperar a la UE:** el plan es el mismo, pero con la región `eu` y `eu: true` en los modelos que OpenAI confirme.

**Decisión (01/10/2026):** opción 1. Se autoriza la región Global **exclusivamente** para la batería privada de los tres modelos, solo con los casos sintéticos existentes. No autoriza el uso público: `public_enabled` sigue en `false`.

## 3. Cupo de llamadas reales

- **Llamadas reales como máximo: 168** (56 × 3 modelos).
- **Cupo por modelo: exactamente 56.** Se concede solo para un modelo cada vez y nunca 168 de golpe.

En cada tanda:
1. Se apartan los otros dos modelos con el mismo mecanismo `models_suspended` de la prueba anterior, así que el cupo no puede gastarse con otro modelo.
2. Al terminar se restaura todo y se comprueba que `real_call_allowance = 0`, aunque se hayan agotado las 56.

Comprobaciones en el código desplegado (`agent_preview_reserve`):
- El tope por minuto se comprueba **antes** que el cupo. El reintento del CRM tras un `rate_limited` no consume cupo.
- El cupo se descuenta al reservar. Un error del proveedor gasta su unidad, no se reintenta y queda registrado como error, lo cual también es un dato de la evaluación.
- Con el cupo a 0, cualquier envío extra se rechaza (`allowance_exhausted`) sin contactar con OpenAI.
- La moderación previa (`omni-moderation-latest`, gratuita) hace una petición HTTP más por turno. No consume cupo ni coste.

## 4. Coste máximo estimado (conservador)

Supuestos, a propósito más altos que lo medido:
- **Entrada:** 3.000 tokens por llamada, sin caché. En la prueba real se midieron 1.474, y el historial de ROB-04 llega a 8 turnos.
- **Salida:** 400 tokens por llamada, el tope `max_output_tokens`. En la prueba se midieron 116.
- **Cambio:** 0,90 €/USD, el mismo de la configuración.

| Modelo | Precio (USD/M, entrada / salida) | Entrada (168.000 tok) | Salida (22.400 tok) | **Máximo por modelo** |
|---|---|---|---|---|
| gpt-6-luna | 0,10 / 0,50 | 0,0168 $ | 0,0112 $ | **0,025 €** |
| gpt-5.6-luna | 0,20 / 1,20 | 0,0336 $ | 0,0269 $ | **0,054 €** |
| gpt-5.4-mini | 0,75 / 4,50 | 0,1260 $ | 0,1008 $ | **0,204 €** |
| **Total** | | | | **0,28 €** |

- **Con un margen de seguridad ×2: 0,57 € como máximo**, alrededor del 11 % de los 5 €.
- **Coste realista:** con los tokens medidos y algo de caché, sería unos 0,10 € en total.
- **Tope duro:** la base de datos rechaza cualquier reserva que superara el presupuesto de pruebas, y ninguna llamada toca el presupuesto público de 25 €/mes.

## 5. Orden y procedimiento (por modelo)

Orden: **gpt-6-luna → gpt-5.6-luna → gpt-5.4-mini**, del más barato al más caro. **Cada tanda necesita autorización por separado**, después de revisar los resultados de la anterior. Nunca se ejecutan las tres seguidas.

Para cada modelo:
1. Te enseño el SQL de preparación: solo ese modelo, región Global (autorizada el 01/10/2026 solo para esta batería privada) y `real_call_allowance = 56`. Tú pulsas Run y yo compruebo el resultado.
2. En `/crm/#/agente` eliges el modelo y pulsas «Ejecutar batería». Tarda unos 8 a 10 minutos por el ritmo de 3,2 s entre mensajes más la latencia, y no hay que cerrar la pestaña.
3. Te enseño el SQL de restauración: tres modelos, región `eu` y cupo 0. Tú pulsas Run y yo lo compruebo.
4. Contrastamos con OpenAI → Usage → Models: el número de peticiones de ese modelo debe ser 56 o menos.

## 6. Métricas y cómo se miden

| Métrica | Fuente |
|---|---|
| Cumplimiento de reglas automáticas | Las mismas reglas del CRM: `must_not_regex` globales, acción esperada, intención esperada e identificación como IA. **Las recalculo yo con las respuestas guardadas** (`agent_test_transcripts`, filtrando por `case_id`), porque la tabla de resultados del CRM solo vive en el navegador. |
| Calidad comercial | La valoración humana ya definida: precisión, utilidad, límites, tono y conversión, de 1 a 5. Cada turno registrado se puede valorar: 62 por modelo, 186 en total. Como mínimo, propongo valorar los **42 casos de 1 turno que llegan al modelo**, en los tres modelos (126 valoraciones), más la última respuesta de INY-08 y ROB-04. |
| Latencia | p50 y p95 por modelo, a partir de `latency_ms`. |
| Tokens | De entrada, en caché y de salida, por turno y en total. |
| Coste real | Lo registrado (`agent_preview_ledger.spent_eur`), contrastado con OpenAI → Usage → Cost por modelo. |
| Fallbacks | Tasa y motivo (`invalid_output`, `moderation`, `timeout`, `provider_error`…), separando los 6 cortes previos, que son esperados. |
| Negativas del modelo | `fallback_reason = 'refusal'` y `filters.refusal` (ver punto 8). |
| Errores | `provider_error` con el estado HTTP y el código saneado. |

Más criterios:
- **Pendientes de decisión:** los casos PRE-04, CON-05 y CLI-02 dependen de decisiones pendientes de la base de conocimiento. Se ejecutan, pero quedan **fuera** de la nota de precisión.
- **Conversaciones libres:** la tabla comparativa del CRM incluye también las conversaciones libres anteriores. El informe final solo cuenta los turnos con `case_id` de la tanda.
- **Informe:** lo entrego en `docs/pr2/RESULTADO-EVALUACION-REAL.md`, con una tabla por modelo, los casos que fallan y una recomendación argumentada. No elijo el modelo final; esa decisión es tuya.
- **Conservación:** las conversaciones se guardan 30 días y se purgan solas.

## 7. Qué no cambia

- El modo público sigue apagado.
- `store:false`, sin tools, sin web search y sin acceso a datos privados.
- Redacción de datos personales y moderación previa.
- Sin cambio silencioso de región ni fallback a otro modelo.

## 8. Mejora previa (aprobada el 01/10/2026)

En `providers.ts` e `index.ts`, solo en el laboratorio privado, se registra en `filters`:
- **`model_returned`:** el modelo exacto devuelto por OpenAI (`response.model`). Se valida como un identificador corto (letras, números y `._:-`, 80 caracteres como máximo); si no lo es, se guarda `null`.
- **`refusal: true`:** cuando la API se niega a responder. El turno usa el fallback propio **`refusal`**, distinto de `invalid_output`. **No se guarda el texto de la negativa** y lo consumido se liquida igualmente.

En el CRM, la línea de depuración muestra el modelo devuelto y la negativa. La sección de valoración humana muestra solo los turnos del modelo seleccionado, hasta 100, para que una tanda completa de 62 turnos se pueda valorar.

**Orden:** se despliega y se verifica **antes** de la primera tanda (gpt-6-luna).
