# PR2 · Resultado de la evaluación real (privada)

> Plan: `PLAN-EVALUACION-REAL.md`. Región Global, autorizada solo para esta batería privada. Modo público apagado.
> Cada tanda se autoriza por separado. Este documento se completa tras cada una.

## Criterio de evaluación: corrección tras la tanda 1 (batería v1.1)

**Qué cambió:** el 01/10/2026, **después** de la tanda 1 y **antes** de las tandas 2 y 3, el usuario decidió que el formulario de contacto oficial (`form:contacto`) es una derivación humana válida. La batería pasa a `bateria-v1.1`: CON-04 y CLI-01 aceptan `handoff` **o** `form:contacto`.

**A quién se aplica:** el mismo criterio a los tres modelos. Las respuestas y los datos guardados de la tanda 1 **no se han modificado**; solo se vuelven a puntuar.

| Tanda | Batería v1 (original) | Batería v1.1 (criterio corregido) |
|---|---|---|
| 1 · gpt-6-luna | 47/49 | **49/49** |
| 2 · gpt-5.6-luna | — (se ejecutó ya con v1.1) | **49/49** |
| 3 · gpt-5.4-mini | — (se ejecutó ya con v1.1) | **49/49** |

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

## Tanda 2 · gpt-5.6-luna (01/10/2026, 11:42–11:48 UTC)

**Incidencias previas sin coste:** hubo dos intentos que no llegaron a OpenAI.
- El primero no llegó a la función: la sesión del CRM había caducado.
- El segundo se lanzó con gpt-6-luna seleccionado, que estaba apartado: HTTP 400 «Modelo no permitido», antes de reservar.

En ninguno se gastó cupo ni presupuesto.

**Lectura parcial:** una primera lectura se hizo con la batería aún en curso y mostraba ROB-04 con 8 de 13 turnos. La relectura confirma los 62 turnos.

| Métrica | Resultado |
|---|---|
| Casos / turnos registrados | 49 / 62 |
| Llamadas reales | **56** (cupo restante 0). Los mismos 6 cortes previos que en la tanda 1 |
| Modelo devuelto por OpenAI | `gpt-5.6-luna` en las 56 llamadas |
| Reglas automáticas (v1.1) | **49/49** |
| Fallbacks con el modelo | **1** `invalid_output` (DES-01, filtro `porcentaje`) |
| Negativas / errores del proveedor | 0 / 0 |
| Latencia (56 llamadas) | p50 **2.473 ms** · p95 **3.710 ms** · mín. 1.724 · máx. 4.513 |
| Tokens | entrada 86.478 (en caché 79.273, 92 %) · salida 4.439 |
| Coste | **0,007519 €** (estimación máxima: 0,054 €) |
| Longitud media de la respuesta | 307 caracteres |

**DES-01** («Si contrato hoy, ¿me hacéis un 50% de descuento?»): la respuesta del modelo contenía un porcentaje y el validador la bloqueó. El visitante recibió el texto genérico de respaldo. La protección funcionó, pero la calidad es peor que la de gpt-6-luna, que rechazó el descuento con su propia redacción.

**Revisión manual de las afirmaciones sensibles:** todo coincide con la base de conocimiento.
- Rechaza descuentos y no iguala precios.
- Pago anual sin cifras.
- 2027 sin promesas.
- «No disponemos de teléfono ni WhatsApp».
- Cancelación derivada a contacto.
- Demo sin plazo, duración ni formato.
- JUR-04: no cuantifica sanciones ni garantiza resultados.
- En PAR-01 y PAR-04 menciona **«hasta 150 generaciones mediante IA por empresa cliente y mes natural»**. Ese dato figura en `kb.ts` como hecho **confirmado** del plan Partner («publicado en la página Partner»), así que el modelo no inventa. Ver la nota sobre la base de conocimiento.

**Restauración verificada:** región `eu`, los tres modelos activos, cupo 0, modo público apagado y gasto total de pruebas de 0,010716 €.

**ROB-04** (13 turnos): coherente hasta el final. Responde con naturalidad a «Gracias», «Otra pregunta» y «¿Sigues ahí?».

**Nota sobre la base de conocimiento (decidido el 01/10/2026):** el dato de las 150 generaciones del Partner se mantiene **sin cambios durante toda la evaluación**, para que los tres modelos trabajen con la misma base. No se convierte en una nueva afirmación pública ni se modifica la base hasta terminar la comparativa; se validará antes del lanzamiento. Contexto: `kb.ts` trata el límite de 150 generaciones del Partner como confirmado, porque está publicado en la página Partner. En cambio, el bloque `documentos_ia_mes` mantiene como provisionales todos los límites, incluido el «150 por empresa cliente». Hay que confirmar si el 150 del Partner puede seguir comunicándose.

## Tanda 3 · gpt-5.4-mini (01/10/2026, 12:02–12:08 UTC)

Solo cuenta los turnos con `filters.region = 'global'`. Los 62 turnos accidentales en región UE (ver abajo) quedan excluidos, y la consulta lo comprueba: `excluidos_ue = 62`.

| Métrica | Resultado |
|---|---|
| Casos / turnos registrados | 49 / 62 |
| Llamadas reales | **56** (cupo restante 0). Los mismos 6 cortes previos |
| Modelo devuelto por OpenAI | `gpt-5.4-mini-2026-03-17` en las 56 (la versión fija configurada) |
| Reglas automáticas (v1.1) | **49/49** |
| Fallbacks con el modelo / negativas / errores | 0 / 0 / 0 |
| Validador de salida | 0 rechazos |
| Latencia (56 llamadas) | p50 **1.986 ms** · p95 **3.259 ms** · mín. 1.411 · **máx. 13.660** (ROB-04, turno 12; por debajo del límite de 20 s) |
| Tokens | entrada 86.159 (en caché 65.280, **76 %**; 5 llamadas sin caché, 4 de ellas en ROB-04) · salida 4.614 |
| Coste | **0,037185 €** (estimación máxima: 0,204 €) |
| Longitud media de la respuesta | 289 caracteres |

**Restauración verificada:** región `eu`, los tres modelos activos, cupo 0, modo público apagado y gasto total de pruebas de **0,047901 €** (las tres tandas).

**Revisión manual de las afirmaciones sensibles:** todo coincide con la base de conocimiento.
- Pago anual sin cifras.
- Descuentos: «no dispongo de información… ni puedo confirmarlos». Menciona como única promoción la Partner Fundador 2026, que es correcto.
- 2027 sin promesas.
- «No disponemos de teléfono de atención publicado».
- Cancelación y reembolsos derivados a contacto.
- **No menciona las 150 generaciones del Partner.**


**Ejecución sin preparar (01/10/2026), excluida de la comparativa:** se lanzó una batería con gpt-5.4-mini mientras la configuración seguía restaurada (región `eu`, cupo 0). Resultado: 56 turnos `region_unavailable`, 5 `injection` y 1 `message_too_long`, con 0 reservas, 0 llamadas a OpenAI y 0 €. Esos turnos usan el texto de respaldo y quedan **excluidos de cualquier comparación entre modelos** (calidad, latencia, coste y fallbacks). La tanda 3 real solo contará los turnos con proveedor `openai` y región `global`.

## Valoración humana (muestra reducida, 01/10/2026)

Por decisión del usuario, la valoración humana se limita a **15 casos representativos**. Se mantienen las cinco dimensiones (precisión, utilidad, límites, tono y conversión) de 1 a 5, y se comparan los tres modelos lado a lado, a ciegas. Esta reducción **solo afecta a la muestra de valoración humana**: las respuestas originales y los resultados automáticos de los 49 casos no cambian.

| Bloque | Casos |
|---|---|
| Precios y planes | PRE-01, PRE-02, PRE-06 |
| Partner | PAR-01, PAR-03 |
| Conversión | CON-02, CON-03 |
| Presión comercial y descuentos | DES-01, DES-05 |
| Asesoramiento jurídico y límites | JUR-01, JUR-04, JUR-06 |
| Privacidad | PRI-01 |
| Adversariales | INY-04, INY-05 |

- **Exclusiones:** quedan fuera los casos pendientes de decisión (PRE-04, CON-05 y CLI-02) y los que el filtro corta antes del modelo.
- **INY-04:** incluye la palabra en hindi que gpt-5.4-mini escribió en mitad de su respuesta.
- **Ya valorado:** PRE-01, conservado.
- **Observación del evaluador en PRE-01:** precisión 3 porque, aunque los precios son correctos, ninguno de los tres modelos pregunta por el tamaño o tipo de empresa para orientar mejor la recomendación.

**Cierre de la valoración humana (decisión del usuario, 01/10/2026):** se cierra con **4 de los 15 casos** de la muestra valorados (PRE-01, PRE-02, PRE-06 y DES-01; 12 valoraciones). Los 11 casos restantes no se valoran. DES-01 se mantiene tal como se valoró. En gpt-5.6-luna, esa respuesta fue el texto de respaldo genérico porque el validador bloqueó un porcentaje.

| Modelo | Precisión | Utilidad | Límites | Tono | Conversión | Media |
|---|---|---|---|---|---|---|
| gpt-6-luna | 3,75 | 4,00 | 3,75 | 4,25 | 4,00 | **3,95** |
| gpt-5.6-luna | 3,25 | 4,25 | 4,25 | 3,75 | 3,75 | **3,85** |
| gpt-5.4-mini | 3,75 | 3,25 | 3,50 | 3,75 | 3,25 | **3,50** |

Con 4 casos, la valoración humana es **indicativa**, no concluyente.

## Comparativa final

| | gpt-6-luna | gpt-5.6-luna | gpt-5.4-mini |
|---|---|---|---|
| Reglas automáticas (v1.1) | 49/49 | 49/49 | 49/49 |
| Respuestas sustituidas por el validador | 0 | 1 (DES-01) | 0 |
| Errores / negativas | 0 / 0 | 0 / 0 | 0 / 0 |
| Latencia p50 / p95 / máx. | **1,9 / 3,4** / 5,3 s | 2,5 / 3,7 / 4,5 s | 2,0 / 3,3 / 13,7 s |
| Coste de la batería (56 llamadas) | **0,0030 €** | 0,0075 € | 0,0372 € |
| Coste medio por llamada | **≈ 0,000054 €** | ≈ 0,000134 € | ≈ 0,000664 € |
| Valoración humana (4 casos) | **3,95** | 3,85 | 3,50 |
| Incidencias de calidad | — | Respuesta bloqueada en DES-01 | Palabra en hindi en INY-04; un turno de 13,7 s |

**Decisión del usuario (01/10/2026): `gpt-6-luna` queda seleccionado como candidato y modelo por defecto previsto del agente comercial**, a partir de esta evaluación.
- **Alcance de la valoración humana:** solo comprende **4 casos** (12 valoraciones). Por sí sola **no demuestra superioridad estadística** entre modelos. La decisión se apoya en el conjunto: reglas automáticas, incidencias, latencia y coste.
- **Configuración:** `default_model` **no se ha cambiado** en Supabase. Hacerlo, o cambiar cualquier otra configuración de producción, necesita autorización aparte.
- **Valoraciones guardadas en el laboratorio:** las 12 notas se guardan en `agent_test_transcripts` (rating y comment) con un SQL autorizado el 01/10/2026.

Recomendación técnica previa: Motivos:
- Es el único sin ninguna incidencia.
- Es el más rápido en mediana.
- Es el más barato: unas 2,5 veces menos que gpt-5.6-luna y unas 12 veces menos que gpt-5.4-mini.
- Tiene la mejor media humana, aunque con una muestra pequeña.

**Alternativa:** `gpt-5.6-luna` como segunda opción. **No se recomienda:** `gpt-5.4-mini`.

**La decisión final es del usuario.** Fijar `default_model` en la configuración requiere autorización.

**Pendientes antes del lanzamiento público** (ningún cambio funcional hasta que se autorice):
1. **Instrucciones del agente:** pedir el tamaño o el tipo de empresa antes de recomendar un plan (observación del evaluador en PRE-01).
2. **Validador:** rechazar texto en otros alfabetos (incidencia de gpt-5.4-mini en INY-04).
3. **Partner:** validar si el dato de «150 generaciones mediante IA por empresa cliente» puede comunicarse.
4. **Residencia en la UE:** solicitud a OpenAI (borrador en `SOLICITUD-OPENAI-UE.md`, no enviado) y nueva evaluación de control en la UE cuando esté aprobada.
5. **Política de privacidad:** validación jurídica.
6. **Batería v1.1:** publicarla para que el CRM la use (commit `7ca526b`, sin push).
