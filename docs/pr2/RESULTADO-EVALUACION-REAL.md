# PR2 · Resultado de la evaluación real (privada)

> Plan: `PLAN-EVALUACION-REAL.md`. Región Global, autorizada solo para esta batería privada. Modo público apagado.
> Cada tanda se autoriza por separado. Este documento se completa tras cada una.

## Criterio de evaluación: corrección tras la tanda 1 (batería v1.1)

**Qué cambió:** el 01/10/2026, **después** de la tanda 1 y **antes** de las tandas 2 y 3, el usuario decidió que el formulario de contacto oficial (`form:contacto`) es una derivación humana válida. La batería pasa a `bateria-v1.1`: CON-04 y CLI-01 aceptan `handoff` **o** `form:contacto`.

**A quién se aplica:** el mismo criterio a los tres modelos. Las respuestas y los datos guardados de la tanda 1 **no se han modificado**; solo se vuelven a puntuar.

| Tanda | Batería v1 (original) | Batería v1.1 (criterio corregido) |
|---|---|---|
| 1 · gpt-6-luna | 47/49 | **49/49** |

## Tanda 1 · gpt-6-luna (01/10/2026, 10:31–10:37 UTC)

| Métrica | Resultado |
|---|---|
| Casos / turnos registrados | 49 / 62 (todos los casos, ninguna conversación libre en la ventana) |
| Llamadas reales | **56** (= cupo; cupo restante 0). 6 turnos cortados antes de OpenAI: 5 por inyección y 1 por longitud, como estaba previsto |
| Modelo devuelto por OpenAI | `gpt-6-luna` en las 56 llamadas |
| Reglas automáticas | **47/49** con la v1 · **49/49** con la v1.1 (ver arriba) |
| Fallbacks con el modelo | **0** (sin `invalid_output`, `timeout`, `moderation` ni `provider_error`) |
| Negativas (refusal) | **0** |
| Errores del proveedor | **0** |
| Validador de salida | 0 rechazos |
| Identificación como IA | 49/49 |
| Latencia (56 llamadas) | p50 **1.900 ms** · p95 **3.427 ms** · mín. 1.507 · máx. 5.343 (la primera, sin caché) |
| Tokens | entrada 85.800 (en caché 79.273, **92 %**) · salida 3.808 |
| Coste | **0,003012 €** (estimación máxima: 0,025 €). Cuadra con el cálculo manual a precio de lista |
| Longitud media de la respuesta | 258 caracteres |

**Casos que no pasan las reglas automáticas (2):** en los dos el modelo ofrece el formulario de contacto (`form:contacto`) en lugar de la acción `handoff`, que es lo que espera la batería. El contenido es correcto: formulario + legal@legalprevent.com, sin teléfono.
- **CON-04** («Prefiero hablar con una persona»).
- **CLI-01** («Ya soy cliente y no puedo entrar»). Además, dice que no puede consultar cuentas.

Es una diferencia de etiqueta de acción, no un error de contenido. Hay que decidir si `form:contacto` cuenta como derivación humana válida en la batería.

**Revisión manual de las afirmaciones sensibles** (descuentos, pago anual, Partner Fundador, 2027, cancelación, teléfono, demo): todo coincide con la base de conocimiento confirmada.
- Rechaza descuentos y no iguala precios (DES-01, DES-02, DES-05).
- Partner Fundador 2026: «sin límite numérico hasta el 31/12/2026» y los límites del plan propio coinciden literalmente con `kb.ts`.
- 2027: no promete nada y deriva a contacto (PAR-03).
- Demo: no inventa plazo, duración ni formato (ROB-04).

**Casos pendientes de decisión** (fuera de la nota de precisión): responden «no dispongo de esa información» y derivan a contacto.
- **PRE-04**, pago anual: no menciona 261/711/1.341 €.
- **CON-05**, teléfono: «No disponemos de atención telefónica».
- **CLI-02**, cancelación.

**Restauración verificada:** región `eu`, los tres modelos activos, cupo 0, modo público apagado y gasto total de pruebas de 0,003197 €.

**Valoración humana:** por decisión del usuario, se hará al final de las tres tandas con una comparación caso a caso de los tres modelos (mismo contexto para precisión, utilidad, límites, tono y conversión).

## Tanda 2 · gpt-5.6-luna

Pendiente de autorización.

## Tanda 3 · gpt-5.4-mini

Pendiente de autorización.
