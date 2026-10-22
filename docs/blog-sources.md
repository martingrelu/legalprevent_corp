# Registro de fuentes jurídicas y verificador de citas (Fase 2 · F2.1 y F2.2)

Estado: **F2.1 (BOE) y F2.2 (AEPD e INSST) implementadas en la rama, sin integrar en el CI ni en la firma**. Queda para fases
posteriores: integración en el CI y comprobación programada de deriva (F2.3) y reconocimiento de pendientes en `approve.mjs`
(F2.4). Este documento no se publica (no está en `.github/pages-allowlist.txt`).

## Principios

- **Determinista:** ninguna IA decide qué es cierto. Un modelo (fase futura) solo propondría borradores.
- **Falla cerrado:** un error de red, un 5xx, una página de acceso bloqueado, una respuesta inesperada o una cita no localizable nunca es `verified`.
- **Una URL válida no acredita nada:** que una dirección responda 200 no demuestra su contenido ni su vigencia.
- **Nada se publica sin revisión humana:** `verified` significa "coherente con su candado". La firma humana sigue siendo imprescindible.
- **Fuentes oficiales separadas del contenido generado por IA:** ver "Separación".

## Qué hay

| Fichero | Función |
|---|---|
| `content/sources/registry.json` | Fuentes oficiales admitidas: 6 normas del BOE, 2 guías de la AEPD y 2 guías del INSST, comprobadas en línea al incorporarlas |
| `seo-engine/sources/schema.mjs` | Esquema estricto del registro, las citas, los candados (BOE y web) y los reconocimientos |
| `seo-engine/sources/adapters/boe.mjs` | API de datos abiertos del BOE: metadatos, índice, bloques y versiones |
| `seo-engine/sources/adapters/web.mjs` | AEPD e INSST: HTML y PDF, `robots.txt`, redirecciones, tamaño, fuentes inaccesibles |
| `seo-engine/sources/html.mjs`, `text.mjs` | Texto de HTML, comparación literal de citas (`[...]` para omisiones) y huellas |
| `seo-engine/sources/verify-citations.mjs` | **Offline**: coherencia de un artículo con el registro y sus candados |
| `seo-engine/sources/verify-sources.mjs` | **En línea**: `--lock` calcula candados y `--check` los autentica contra la fuente en vivo |
| `seo-engine/sources/separation.mjs` | Separación entre fuentes oficiales y contenido generado por IA |
| `tests/sources-*.test.mjs`, `tests/fixtures/{boe,web}/` | Pruebas sin red, con respuestas reales recortadas de BOE, AEPD e INSST |

## Naturaleza jurídica de cada fuente

`binding` no se escribe a mano: se deriva del `kind`, y el esquema rechaza cualquier otra combinación.

| `kind` | `binding` | Autoridad | Puede apoyar lo que dice la norma (`type: "norma"`) |
|---|---|---|---|
| `disposicion` | `vinculante` | BOE (publicación oficial) | Sí |
| `texto_consolidado` | `informativo` | BOE (el BOE declara informativo el texto consolidado) | Sí, señalando que es informativo |
| `criterio_administrativo` | `criterio_administrativo` | AEPD (informes, resoluciones, criterios) | **No**: `criterio_como_norma` falla. Solo `type: "criterio"` |
| `guia` | `no_vinculante` | AEPD, INSST | **No**: `guia_como_norma` falla. Solo `type: "criterio"` |

El registro actual solo contiene fuentes de tipo `texto_consolidado` y `guia`. El tipo `criterio_administrativo` está en el esquema y probado,
pero **aún no hay ninguna entrada real** de ese tipo. Las URL deben ser `https` y de host exacto; un host parecido, `http` o credenciales se rechazan.
Las fuentes web pueden declarar `urls.document` (PDF de una ficha) y `urls.index` (listado oficial donde consta su título).

## Citas en el artículo

Las citas van en el front matter (JSON) y forman parte del contenido que se firma:

```json
"citations": [
  { "id": "c1", "source": "boe-lo-3-2018", "type": "norma", "locator": { "article": "5" },
    "quote": "estarán sujetas al deber de confidencialidad…", "lock": { "...": "lo escribe verify-sources.mjs" } },
  { "id": "g1", "source": "insst-gt-simplificacion-documental", "type": "criterio", "locator": { "section": "Resumen" } }
],
"review_ack": [
  { "citation": "g1", "reason": "vigencia_no_acreditable", "note": "Explica por qué se acepta este motivo." }
]
```

- `locator`: BOE → `article` (`"5"`, `"5 bis"`) o `block`; AEPD/INSST → `section` o `page`. Un localizador de otro tipo falla (`localizador_incompatible`).
- `quote`: literal; solo se tolera la tipografía. Admite `[...]` para omitir tramos, en orden.
- El candado lleva `source_sha256` (hash de la entrada del registro), la fecha de comprobación y las huellas de lo comprobado. No se guarda el texto de las fuentes.

## Fuentes web (AEPD, INSST): qué se comprueba y qué no

Estas fuentes no tienen API ni metadatos de vigencia. Se comprueba: URL oficial `https` sin salir del dominio (cada redirección se valida), `robots.txt`,
código de estado, tipo de contenido (HTML o PDF), tamaño, título contra la ficha o el listado oficial y, en HTML, que la cita aparezca literalmente.
En PDF se guardan hash, tipo y `Last-Modified`, pero **no se lee el texto** (`pdf_sin_verificacion_textual`).

**Una cita web nunca es `verified`:** como mínimo lleva `vigencia_no_acreditable` y exige reconocimiento escrito del responsable.
Si la URL responde pero no es lo registrado (título distinto, tipo inesperado, redirigida), se marca para revisión; si no existe (404/410) o redirige fuera del dominio oficial, falla.
Cualquier problema de acceso (403, 429, 5xx, tiempo agotado, página de "acceso bloqueado" que responde 200, `robots.txt` ilegible) es **inconcluso**: `needs_review` sin candado.

La huella del HTML se calcula sobre una **ventana de contenido** (los primeros 1000 caracteres desde el `h1`), no sobre la página: en las páginas reales del INSST el HTML crudo
cambia en cada descarga por un token de sesión, y hay menús y una ventana de acceso alrededor. Para un PDF se usa el hash de sus bytes.

## Estados y motivos

| Estado | Efecto | Motivos (ejemplos) |
|---|---|---|
| `verified` | Coherente; no basta para publicar. Solo posible en el BOE | — |
| `needs_review` | Bloquea hasta reconocerlo en `review_ack` con una nota | `solo_existencia`, `vigencia_no_acreditable`, `pdf_sin_verificacion_textual`, `titulo_no_coincide`, `tipo_inesperado`, `url_redirigida`, `fuente_inalcanzable`, `bloqueado_por_robots`, `fuente_demasiado_grande`, `candado_caducado`, `consolidacion_no_finalizada`, `version_con_vigencia_futura`, `fuente_modificada`, `referencia_sin_cita`, `articulo_sin_citas` |
| `failed` | Bloquea; **no se puede reconocer** | `sin_candado`, `fuente_desconocida`, `registro_modificado`, `guia_como_norma`, `criterio_como_norma`, `localizador_incompatible`, `norma_derogada`, `identificador_inexistente`, `url_inexistente`, `redireccion_no_oficial`, `locator_no_encontrado`, `cita_no_encontrada`, `cita_solo_en_version_anterior`, `cita_editada_tras_candado`, `candado_inconsistente`, `candado_futuro`, `cita_invalida`, `ack_sin_uso` |

Un reconocimiento sin uso falla. En un borrador todo se informa pero nada bloquea; solo bloquean los artículos aprobados.

## Uso

```
node seo-engine/sources/verify-citations.mjs                      # offline, sin red
node seo-engine/sources/verify-sources.mjs --lock <slug>          # comprueba en línea (no escribe)
node seo-engine/sources/verify-sources.mjs --lock <slug> --write  # escribe los candados si nada falla
node seo-engine/sources/verify-sources.mjs --check [<slug>]       # autentica los candados contra la fuente
```

Ritmo de 1 petición por segundo y host, `User-Agent` identificable, caché por ejecución y `robots.txt` respetado.

## Lo que protege la firma

El hash SHA-256 que firma el responsable cubre todo el front matter salvo `review_status`, `approved_at` y `approval`. Por tanto **`citations`, sus `lock` y `review_ack` están dentro del contenido firmado**:
cambiar una nota, quitar un reconocimiento, tocar un candado, cambiar una cita, su tipo, su fuente o su localizador invalida la aprobación (probado con la firma real del sistema en `tests/sources-signature.test.mjs`).

El **registro de fuentes no** está en ese hash. Lo protege `source_sha256`: cada candado lleva el hash de la entrada que se comprobó. Si la entrada cambia después (por ejemplo, para reclasificar una guía como norma),
`verify-citations.mjs` falla con `registro_modificado` y hay que volver a comprobar y firmar. Hacen falta las dos puertas: la firma sobre el contenido y la verificación de las citas.

## Separación entre fuentes oficiales e IA

- El registro y los candados solo contienen identificadores, URL, hashes y fechas; nunca texto generado por un modelo.
- `separation.mjs` define la regla para cambios de origen generador. El origen se decide por el **autor** (todo lo que no sea del responsable se trata como generado), no por el nombre de la rama, que se puede falsear: solo pueden tocar `content/blog/<slug>.md` en `draft`/`in_review`; no pueden tocar el registro, `review_ack`, `approved_at`, `approval`, aprobaciones ni código/CI, ni modificar un artículo aprobado.
- Los candados sí pueden venir de un proceso automático: los produce y autentica el verificador contra la fuente oficial, no el modelo.
- Aún no está conectado al CI (F2.3): hoy es una función probada, no un bloqueo.

## Limitaciones conocidas

1. Se verifica **existencia y literalidad**, no la **interpretación jurídica**. Que el artículo diga lo que dice la fuente lo decide la revisión humana.
2. Las afirmaciones **sin cita** solo se detectan por una heurística de menciones de normas (`Ley n/aaaa`, `Real Decreto n/aaaa`, `BOE-A-…`); no cubre normas de la UE ni afirmaciones sin referencia.
3. En AEPD e INSST **no se puede acreditar la vigencia** de una guía: la verificación de una web nunca llega a `verified`. Que la web responda no prueba que la guía siga vigente ni que no haya sido sustituida.
4. **PDF:** no se lee su texto (sin dependencias); las citas de un PDF, y las de una ficha del INSST que tiene PDF, quedan para revisión humana.
5. La **AEPD es inestable desde clientes automatizados**: en las pruebas, algunas rutas dieron 500 ("Acceso Bloqueado") y 503, y su `robots.txt` prohíbe documentos concretos. Esos casos son inconclusos, no válidos. Puede ocurrir lo mismo desde las IP del CI.
6. La huella del HTML usa una ventana de 1000 caracteres desde el `h1`: un cambio posterior en el texto de la página no se detecta con ella (la cita sí se busca en el texto completo, y el PDF se vigila por su hash).
7. La extracción de texto de HTML es genérica y no un analizador completo; una entidad HTML desconocida se deja tal cual y puede dar un falso "no encontrada". Se prefiere un falso fallo a un falso válido.
8. Los metadatos de derogación del BOE pueden no reflejar derogaciones parciales de un precepto, y el texto consolidado es informativo y puede ir por detrás del oficial.
9. No se han verificado las condiciones de reutilización de BOE, AEPD e INSST: solo se guardan hashes y la cita breve ya presente en el artículo.
10. No cubre EUR-Lex (RGPD), jurisprudencia ni normativa autonómica o convenios.
11. Aún no está integrado en el CI ni en `approve.mjs` (F2.3 y F2.4): hoy estas comprobaciones no bloquean la publicación por sí solas.
