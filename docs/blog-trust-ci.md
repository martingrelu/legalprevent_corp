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
