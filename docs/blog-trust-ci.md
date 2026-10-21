# Controles de confianza del blog en CI (F2.3a)

Dos checks obligatorios, `separation` y `citations`, definidos en `.github/workflows/blog-trust.yml` y ejecutados con
`pull_request_target`. Objetivo: **un PR (generado o comprometido) no puede modificar, sustituir ni desactivar los
controles que lo juzgan**, y el contenido del PR nunca se ejecuta.

## Qué comprueba cada control

| Check | Qué hace | Falla si |
|---|---|---|
| `separation` | Decide el origen por el **autor del PR** (`martingrelu` = humano; cualquier otro, o rama `seo/`, = generador). Si es generador, solo permite crear/editar `content/blog/<slug>.md` en `draft`/`in_review`, como fichero regular (modo `100644`). | Toca cualquier otra ruta (registro, firmas, código, workflows, `approvers.json`…), usa enlaces simbólicos, submódulos o ejecutables, escribe `approved_at`/`approval`/`review_ack` o estado `approved`, o hay cualquier error interno. |
| `citations` | Lee los artículos y el registro del PR **como datos**, y verifica offline las citas de los artículos `approved` contra el registro (candado `lock`, `source_sha256`, tipos y vinculación). | Hay citas que bloquean, falta/está corrupto el registro con artículos aprobados, un artículo tocado no se puede analizar, slug ≠ nombre de fichero, o cualquier error interno (falla cerrado). |

La verificación contra la fuente en vivo (`sources-live`), las excepciones firmadas y la comprobación programada son fases
posteriores (F2.3b–d) y **no** forman parte de esto. Estos checks no usan la red.

## Las seis condiciones de D4 y su evidencia

| # | Condición | Cómo se cumple | Evidencia (tests) |
|---|---|---|---|
| 1 | No se ejecuta código, scripts, dependencias ni configuración del PR | El workflow hace `checkout` **solo** de `base.sha`; ejecuta únicamente `node seo-engine/ci/*.mjs` de esa rama base; sin `npm`/`npx`/acciones locales/`setup-node`/caché. Las llamadas a git son con SHAs validados, sin shell, con `diff` sin `ext-diff`/`textconv`. | `ci-trust-workflow` (1, 2, 3); `ci-trust-adversarial`: PR que reemplaza los `.mjs`, el workflow, `package.json` y `.npmrc` con cargas que escriben un fichero centinela → el centinela **no** aparece; `diff.external`, `textconv`, `smudge`, `fsmonitor`, `pager`, `hooksPath`, `sshCommand` hostiles en el repo → no se ejecutan. |
| 2 | Ficheros del PR solo como datos no confiables | Se leen como objetos (`diff -z --raw`, `cat-file blob` por SHA) y solo se extraen a un temporal ficheros **regulares** de rutas permitidas (`content/blog/<slug>.md`, `registry.json`). Tope de 1 MB por blob y 400 ficheros. | `ci-safe-git`: `materializeData` omite enlaces/ejecutables/gitlinks y rutas no permitidas; `readBlob` respeta el tope; `ci-trust-adversarial`: artículo gigante, binario, JSON hostil (`__proto__`) → falla cerrado. |
| 3 | Sin secretos ni escritura | `permissions: {}` global; cada job `contents: read`; sin `secrets.*`, `GITHUB_TOKEN`, `id-token`, `environment`. | `ci-trust-workflow` (4). |
| 4 | Sin inyección por rama, título, rutas o metadatos | Ningún `${{ }}` dentro de un `run`; los únicos datos del PR (número, SHAs, autor, rama) llegan por **variables de entorno** y se validan (SHA 40 hex, número entero); título, cuerpo y etiquetas **no se usan**. Todo texto del PR se sanea (`sanitize.mjs`): controles, saltos de línea, bidi → `�`; los `::` nunca abren línea; `%`/`\r`/`\n` escapados; tabla de resumen sin `` ` `` ni `\|`. | `ci-trust-workflow` (5); `ci-sanitize`; `ci-trust-adversarial`: rutas con `\n::set-output`, `::error::`, bidi, `%0A`; autor/rama con `$(…)`, comillas, `\n::set-env`; SHAs con forma de opción (`--output=…`). |
| 5 | El verificador viene de una referencia protegida que el PR no puede modificar | `pull_request_target` usa el workflow y los scripts de la **rama base** del PR. El responsable (`approvers.json`) se lee del árbol de confianza, no del PR. | `ci-trust-adversarial`: un PR que cambia `approvers.json` para declararse responsable sigue siendo generador y se rechaza; el repositorio verificado queda intacto tras ejecutar los controles. **Límite**: que GitHub use realmente el workflow de la rama base solo puede demostrarse con una PR de prueba (ver "Pendiente"). |
| 6 | Funciona con ramas y PRs apilados | El diff es `base...head` (contra el ancestro común): cada PR se juzga por lo que añade sobre **su** base, y que la base avance no cambia el veredicto. Con `FETCH_PR=1` se trae `refs/pull/N/head` y se comprueba que sigue siendo `HEAD_SHA` (si el PR se actualizó durante la ejecución, falla). | `ci-trust-adversarial`: main ← A ← B con base que avanza. **Límite**: la protección de `pull_request_target` se evalúa contra la rama base de cada PR; para PRs apilados esa rama base (p. ej. `feat/blog-plantilla`) debe contener estos ficheros (ver riesgos). |

## Pruebas

- Estáticas del workflow: `tests/ci-trust-workflow.test.mjs`.
- Saneado y lectura segura de git: `tests/ci-sanitize.test.mjs`, `tests/ci-safe-git.test.mjs`.
- Adversarias con repositorios git temporales: `tests/ci-trust-adversarial.test.mjs` (15 casos).
- Mutación (sobre copias, no sobre el repositorio): se desactivó cada control (modo de fichero, origen por defecto,
  falla cerrado, saneado, escape de saltos, guardia de artículos tocados, `approvers.json` leído del PR, validación de SHA,
  materialización de ficheros especiales, `pull_request_target`, `checkout` del head, permiso de escritura): **12 de 12
  mutaciones detectadas** por al menos un test.

## Riesgos residuales

1. **Un workflow nuevo solo protege cuando está en la rama base.** Mientras `blog-trust.yml` no exista en la base de un PR,
   `pull_request_target` no lo ejecuta para ese PR. Hasta que se integre en `main` (y en las ramas base de los PRs
   apilados) hay que tratarlo como no activo. No se ha desplegado nada.
2. **Hay que marcar `separation` y `citations` como checks obligatorios** (ruleset de `main`) para que un PR no pueda
   fusionarse sin ellos; también que **el propio cambio** de `.github/workflows/blog-trust.yml` y `seo-engine/ci/**`
   exija revisión del responsable (CODEOWNERS). Ambos requieren autorización y no están activados.
3. **El título del check** (`separation`, `citations`) debe ser estable: si se renombra el job, el ruleset deja de exigirlo.
4. **Ventana de ejecución**: un `push` al PR durante el job se detecta (SHA de `refs/pull/N/head`), pero solo en la
   ejecución con `FETCH_PR=1`; el resultado se asocia al SHA evaluado, no al siguiente.
5. **Acción de terceros**: solo `actions/checkout` fijada por SHA. Una actualización exige revisión humana del SHA.
6. **`pull_request_target` y forks**: este repositorio no recibe PRs de forks de terceros; si lo hiciera, siguen siendo
   seguros (no se ejecuta nada del PR y no hay secretos), pero conviene exigir aprobación manual de workflows externos.
7. Lo que depende del comportamiento de GitHub no se demuestra en local: se verificará con una PR de prueba controlada
   (solo con autorización expresa).

## Diseño de ejecución segura en CI (resumen)

```
PR abierto/actualizado ──► GitHub arranca blog-trust.yml DE LA RAMA BASE
   job separation / citations  (permisos: contents: read; sin secretos)
     1. checkout de base.sha (código de confianza)           ← el PR no entra en el disco
     2. git fetch refs/pull/N/head; comprobar == HEAD_SHA     ← objetos, sin checkout
     3. diff base...head; lectura por SHA de blob; tope de tamaño/nº
     4. extracción solo de ficheros regulares permitidos a un temporal
     5. verificación offline con la lógica de la rama base
     6. salida saneada; cualquier excepción ⇒ exit 1 (falla cerrado)
```

## F2.3b — `sources-live` (comprobación en vivo, estricta, con reintentos)

Tercer job de `blog-trust.yml` (`seo-engine/ci/check-sources-live.mjs`, lógica en `seo-engine/sources/live-check.mjs`).
Solo lectura; el único job con salida a la red, y solo a `www.boe.es`, `www.aepd.es` y `www.insst.es` (el registro lo exige
por esquema y se vuelve a exigir antes de salir). Es un control técnico: **no autoriza publicar**.

- **Alcance:** artículos `approved` que el PR añade o modifica, y los que citan una fuente cuya entrada del registro es nueva
  o cambia en el PR. Más de 40 citas en una ejecución **falla** (no se omite en silencio).
- **Resultado por cita:** `confirmed` · `changed` (la fuente cambió desde el candado) · `contradicted` (cita/candado/registro
  incoherentes) · `unreachable` (inconcluso tras los reintentos) · `unchecked` (sin candado, fuente desconocida, cita inválida).
- **Modo estricto (por defecto y fijado en el workflow):** todo lo que no sea `confirmed` bloquea. El BOE inconcluso bloquea
  siempre y **nunca** es excepcionable; AEPD/INSST inconclusos bloquean y se marcan `excepcionable` solo como dato para una
  futura excepción firmada (F2.3c, no implementada). `LIVE_MODE=informative` existe para uso local: no falla, pero avisa
  «NO verificado» y jamás muestra `confirmed`.
- **Reintentos:** solo para lo transitorio (red, timeout, 5xx, 429/403, soft-block). Espera exponencial con jitter y tope,
  1–5 intentos (3 por defecto). Un resultado definitivo (cita no encontrada, derogada, registro modificado…) no se repite.
  Un error inesperado se trata como `unreachable`.
- **Web (AEPD/INSST):** `vigencia_no_acreditable` y demás motivos permanentes ya están en el candado y no cuentan como cambio;
  solo cuentan los motivos nuevos y `fuente_modificada`.
- **Pruebas:** `tests/sources-live.test.mjs` (10), `tests/ci-sources-live.test.mjs` (7, con `fetch` sustituido por un
  registro de URLs); 11 mutaciones, todas detectadas.
- **No validado todavía:** el comportamiento real desde los ejecutores de GitHub (bloqueos de AEPD/INSST, límites del BOE) y
  la duración real del job. Depende de la prueba D5 y de una PR de prueba, ambas sin autorizar.

## F2.3c — Excepciones firmadas para AEPD/INSST inaccesibles

Cuando una fuente de la AEPD o del INSST no responde (bloqueo, caída), `sources-live` bloquea en modo estricto. El responsable
puede **firmar una excepción** temporal. Es un acto distinto de aprobar el artículo y no verifica la fuente.

- **Estado propio: `REVISION_EXCEPCIONAL`** («revisión excepcional documentada»). Nunca `verified` ni `confirmed`; en el log sale
  como aviso («NO verificada») con su caducidad. No aprueba el artículo ni publica nada ni modifica artículos aprobados.
- **Solo transforma `unreachable`.** `changed`, `contradicted` y `unchecked` siguen bloqueando.
- **BOE: nunca.** Ni la herramienta, ni el formato del registro, ni la evaluación, ni `sources-live` lo permiten.
- **Sin evidencias de fallo:** cualquier fallo offline de la cita (cita editada tras el candado, registro modificado, candado
  inconsistente, localizador incompatible…) deniega la excepción aunque esté bien firmada.
- **Firma independiente:** espacio de nombres `legalprevent-source-exception`, distinto del de las aprobaciones
  (`legalprevent-blog-approval`): una firma de aprobación no vale como excepción ni al revés. Misma clave y misma huella fijada
  (variable `BLOG_APPROVER_FINGERPRINT`); `allowed_signers` no cambia.
- **Vinculación criptográfica** (todo dentro del texto firmado): slug, SHA-256 del contenido, cita, fuente, autoridad,
  huella de la entrada del registro, huella del candado, fecha del candado y huella de la cita. Cambiar cualquiera invalida la
  excepción (no se puede reutilizar para otra cita, versión, fuente o candado).
- **Caducidad:** como máximo 7 días desde la firma **y** nunca después de que el candado cumpla 7 días (`verified_at` + 7).
  Un candado de más de 7 días no admite excepción: hay que recalcularlo.
- **Revocación:** un registro `revoke` posterior prevalece; ante empate de marca de tiempo, la revocación.
- **Falla cerrado:** un registro ilegible, con campos de más o de menos, con nombre que no coincide con su contenido, mal firmado
  o de otra identidad deniega toda excepción de esa cita (no se ignora).
- **Dónde se firma:** `node seo-engine/except.mjs <slug> <id-de-cita> [--revoke]` en terminal interactiva propia (no en CI),
  con confirmación de los 8 primeros caracteres de la vinculación y la contraseña de la clave. Escribe solo
  `content/blog/exceptions/<slug>/<fecha>-<grant|revoke>-<hash8>.json`.
- **En CI (`sources-live`):** los registros llegan del PR como **datos**; la clave sale de `seo-engine/allowed_signers` de la
  **rama base** (código de confianza) y la huella de la variable de Actions. Un PR que traiga su propio `allowed_signers` o su
  propia huella no cambia nada. Sin clave en la base o sin huella fijada, no se aplica ninguna excepción. Un PR generado por
  el motor no puede añadir excepciones (la regla de separación solo le deja tocar su borrador).

### Fallo de F2.3b corregido en esta fase

`check-sources-live.mjs` decidía si ejecutarse comparando `import.meta.url` con `process.argv[1]`. Si la ruta se resolvía de
forma distinta (p. ej. un enlace simbólico), el script **salía con 0 sin comprobar nada**. En el workflow no ocurría, pero era un
éxito silencioso. Ahora se ejecuta siempre al cargarse, como los otros controles, y un test estático prohíbe esa guarda en
`seo-engine/ci/`.

### Pendiente y límites

- No se ha firmado ninguna excepción real ni se ha probado en GitHub Actions.
- Para que el CI aplique excepciones, `seo-engine/allowed_signers` tiene que estar en la rama base (hoy solo está en la rama de #29).
- La política de qué hacer ante una indisponibilidad que supere 7 días es del responsable: hay que recalcular el candado.
- Sin integrar en `approve.mjs` (F2.4) ni en la comprobación programada (F2.3d).

## F2.3d — Comprobación programada de deriva (artículos publicados)

Workflow `.github/workflows/sources-drift.yml` (`schedule` semanal, lunes 05:23 UTC, y `workflow_dispatch`) que ejecuta
`seo-engine/ci/check-drift.mjs` sobre `main`. Responde a una pregunta distinta de `sources-live`: **¿siguen coincidiendo con sus
fuentes oficiales las citas de los artículos ya publicados?** Es solo lectura y no autoriza nada.

- **Qué hace:** para cada artículo `approved` de `content/blog/`, comprueba que su aprobación firmada sigue siendo válida
  (clave de `allowed_signers` + huella fijada) y compara cada cita con la fuente en vivo y con su candado (misma lógica y
  reintentos que `sources-live`).
- **Qué NO hace:** no modifica ni despublica artículos, no abre issues ni PR, no escribe en el repositorio (`contents: read`,
  sin secretos ni token de la API) y **no aplica excepciones firmadas** (F2.3c es para PR, no para lo ya publicado).
- **Estado por artículo y salida del script:**

  | Estado | Cuándo | Salida |
  |---|---|---|
  | `OK` | todas las citas coinciden con su candado y la aprobación firmada es válida | 0 |
  | `REVISION_JURIDICA_NECESARIA` | la fuente cambió, contradice la cita, la cita no se puede comprobar o la aprobación ya no es válida | 1 |
  | `NO_COMPROBADO` | superó el presupuesto de la ejecución (60 citas por defecto, 1–200 con `DRIFT_MAX_CITATIONS`) | 1 |
  | `INCONCLUSO` | la fuente no respondió tras los reintentos y no hay deriva detectada | 3 |

  `INCONCLUSO` **no es un éxito**: el job falla y el mensaje lo dice. Un error interno o una entrada inválida terminan en 1
  (falla cerrado). La revisión jurídica manda sobre lo inconcluso.
- **Dónde queda la constancia:** resumen del job y anotaciones (`::error` / `::warning`), con los datos saneados; el
  historial de ejecuciones de Actions es el registro. `DRIFT_OUT` (opcional, uso local) guarda un informe JSON. GitHub avisa
  al responsable cuando una ejecución programada falla.
- **Activación:** los workflows con `schedule` solo corren desde la rama por defecto. Hasta estar en `main` no hace nada.
  Necesita la variable `BLOG_APPROVER_FINGERPRINT` (la misma de las aprobaciones).
- **Pruebas:** `tests/sources-drift.test.mjs` (9), `tests/ci-drift.test.mjs` (8, con árbol de `main` con aprobación firmada
  real y `fetch` sustituido) y `tests/ci-drift-workflow.test.mjs` (4, estático). Incluyen: salida 3 para lo inconcluso,
  excepción firmada que no tapa nada, aprobación inválida, presupuesto, entradas inválidas y comprobación de que el árbol
  no se modifica.
- **Límites:** no se ha ejecutado contra la red real ni en GitHub. La decisión de qué hacer ante un hallazgo (retirar,
  actualizar, volver a firmar) es del responsable; F2.4 integrará el recalculo de candados y la firma.
