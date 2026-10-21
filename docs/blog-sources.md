# Registro de fuentes jurídicas y verificador de citas (Fase 2 · F2.1)

Estado: **F2.1 implementada en la rama, sin integrar en el CI ni en la firma**. Cubre el registro, el esquema, el
adaptador del BOE y la verificación offline. Queda para fases posteriores: AEPD e INSST (F2.2), integración en el CI y
comprobación programada de deriva (F2.3) y reconocimiento de pendientes en `approve.mjs` (F2.4). Este documento no se
publica (no está en `.github/pages-allowlist.txt`).

## Principios

- **Determinista:** ninguna IA decide qué es cierto. Un modelo (fase futura) solo propondría borradores.
- **Falla cerrado:** un error de red, un 5xx, una respuesta inesperada o una cita no localizable nunca es `verified`.
- **Nada es válido solo por existir:** `verified` significa "coherente con su candado". La firma humana sigue siendo imprescindible.
- **Separación de roles:** generar (futuro), verificar (este código), revisar jurídicamente y autorizar la publicación (tu firma).
  El verificador no firma, y la firma no la puede producir ninguna automatización.

## Qué hay

| Fichero | Función |
|---|---|
| `content/sources/registry.json` | Fuentes oficiales admitidas. Hoy: 6 normas del BOE comprobadas contra la API. |
| `seo-engine/sources/schema.mjs` | Esquema estricto del registro, las citas, los candados y los reconocimientos. |
| `seo-engine/sources/text.mjs` | Normalización y comparación literal de citas (`[...]` para omisiones). |
| `seo-engine/sources/adapters/boe.mjs` | API de datos abiertos del BOE: metadatos, índice, bloques y versiones. |
| `seo-engine/sources/verify-citations.mjs` | **Offline**: coherencia de un artículo con el registro y sus candados. |
| `seo-engine/sources/verify-sources.mjs` | **En línea**: `--lock` calcula candados, `--check` los autentica. |
| `tests/sources-*.test.mjs`, `tests/fixtures/boe/` | 52 tests sin red, con respuestas reales del BOE como fixtures. |

## Tipos de fuente y naturaleza jurídica

`binding` no se escribe a mano: se deriva del `kind` y el esquema rechaza cualquier otra combinación.

| `kind` | `binding` | Autoridad | Puede apoyar una afirmación sobre una norma (`type: "norma"`) |
|---|---|---|---|
| `disposicion` | `vinculante` | BOE | Sí |
| `texto_consolidado` | `informativo` | BOE (el BOE declara informativo el texto consolidado) | Sí, señalando que es informativo |
| `guia` | `no_vinculante` | AEPD, INSST | **No**: `guia_como_norma` falla. Solo para `type: "criterio"` |

Las URL del registro deben ser `https` y de host exacto (`www.boe.es`, `www.aepd.es`, `www.insst.es`); un host parecido, `http` o credenciales se rechazan.
Un registro nunca lleva campos como `verified`: las claves desconocidas son un error.

## Citas en el artículo

Las citas van en el front matter (JSON), junto a `review_status`, y forman parte del contenido que se firma:

```json
"citations": [
  {
    "id": "c1",
    "source": "boe-lo-3-2018",
    "type": "norma",
    "locator": { "article": "5" },
    "quote": "estarán sujetas al deber de confidencialidad al que se refiere el artículo 5.1.f) del Reglamento (UE) 2016/679",
    "lock": { "...": "lo escribe verify-sources.mjs --lock --write" }
  }
],
"review_ack": [
  { "citation": "c1", "reason": "solo_existencia", "note": "Explica por qué se acepta este motivo de revisión." }
]
```

- `locator`: exactamente uno de `article` (`"5"`, `"5 bis"`) o `block` (id de bloque del BOE, p. ej. `da1`).
- `quote`: literal. Se tolera la tipografía (comillas, guiones, espacios) pero no las palabras ni las mayúsculas. Admite `[...]` para omitir tramos, en orden.
- `lock`: candado con fecha de comprobación, `fecha_actualizacion` del bloque, versión vigente y hashes SHA-256 del texto y de la cita. No se guarda el texto de la norma.
- Como `citations`, `lock` y `review_ack` están en el front matter, cambiarlos cambia el hash del contenido: **aceptar una fuente modificada exige una firma nueva**.

## Estados y motivos

| Estado | Efecto | Motivos (ejemplos) |
|---|---|---|
| `verified` | Coherente; no basta para publicar | — |
| `needs_review` | Bloquea hasta reconocerlo en `review_ack` con una nota | `solo_existencia`, `consolidacion_no_finalizada`, `version_con_vigencia_futura`, `fuente_modificada`, `candado_caducado`, `adaptador_no_implementado`, `fuente_inalcanzable`, `referencia_sin_cita`, `articulo_sin_citas` |
| `failed` | Bloquea; **no se puede reconocer** | `sin_candado`, `fuente_desconocida`, `guia_como_norma`, `norma_derogada`, `identificador_inexistente`, `locator_no_encontrado`, `cita_no_encontrada`, `cita_solo_en_version_anterior`, `cita_editada_tras_candado`, `candado_inconsistente`, `candado_futuro`, `cita_invalida`, `ack_sin_uso` |

Un reconocimiento sin uso (`ack_sin_uso`) falla: no puede quedar como cheque en blanco. En un borrador todo se informa pero nada bloquea; solo bloquean los artículos aprobados.

## Uso

```
node seo-engine/sources/verify-citations.mjs                      # offline, sin red
node seo-engine/sources/verify-sources.mjs --lock <slug>          # comprueba en línea (no escribe)
node seo-engine/sources/verify-sources.mjs --lock <slug> --write  # escribe los candados si nada falla
node seo-engine/sources/verify-sources.mjs --check [<slug>]       # autentica los candados contra la fuente
```

La verificación en línea pide solo GET a la API oficial, a un ritmo de 1 petición por segundo, con un `User-Agent` identificable y con caché por ejecución.
Un 5xx, un fallo de red o un tiempo agotado cuenta como **no verificado** (exit 1).

## Cómo se impide una cita inventada

1. La fuente debe estar en el registro, que solo admite fuentes oficiales con identificador y host válidos.
2. Un identificador del BOE inexistente da 404 en la API: `identificador_inexistente`.
3. Un artículo que no está en el índice falla (`locator_no_encontrado`) y una cita que no aparece en la versión vigente falla (`cita_no_encontrada`).
4. Un candado escrito a mano no es de fiar: `--check` recalcula el candado en vivo. Un texto distinto sin que el bloque haya cambiado desde la fecha del candado es `candado_inconsistente`.
5. Cambiar la cita después del candado la invalida (`cita_editada_tras_candado`).

## Limitaciones conocidas

1. Se verifica **existencia y literalidad**, no la **interpretación jurídica**. Que el artículo diga lo que dice la norma lo decide la revisión humana.
2. Las afirmaciones **sin cita** solo se detectan por una heurística de menciones de normas (`Ley n/aaaa`, `Real Decreto n/aaaa`, `BOE-A-…`). No cubre normas de la UE ni afirmaciones sin referencia.
3. El texto consolidado es informativo y puede ir por detrás del BOE oficial. Los metadatos de derogación y vigencia del BOE pueden no reflejar derogaciones parciales de un precepto: la comprobación es de fecha de versión y texto, no una garantía de vigencia.
4. AEPD e INSST no se verifican todavía (F2.2): su cita queda como `adaptador_no_implementado` y exige reconocimiento. En las pruebas, algunas rutas de la AEPD dieron 500 ("Acceso Bloqueado") y 503 desde un cliente automatizado; el PDF solo se podrá verificar por hash y cabeceras, no por texto.
5. La normalización puede dar un falso "no encontrada" ante diferencias que no sean tipográficas: se prefiere un falso fallo a un falso válido.
6. Hay dependencia de red y de la disponibilidad de la API del BOE. No se han verificado sus condiciones de reutilización; por eso solo se guardan hashes y la cita breve ya presente en el artículo.
7. Aún no está integrado en el CI ni en `approve.mjs`: hasta F2.3 y F2.4 estas comprobaciones no bloquean la publicación por sí solas.
8. No cubre EUR-Lex (RGPD), jurisprudencia ni normativa autonómica o convenios.
