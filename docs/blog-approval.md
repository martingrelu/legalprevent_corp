# Aprobación jurídica del blog: procedimiento y requisitos

Estado: **documentado, no activado**. Este documento no se publica (no está en `.github/pages-allowlist.txt`).
Nada de lo que describe en las secciones "CODEOWNERS" y "Protección de `main`" está configurado todavía.

## 1. Principio

Ningún artículo jurídico se publica sin la aprobación expresa del responsable de revisión
(Luis Martín Grecco, abogado; usuario de GitHub en `seo-engine/approvers.json`). La aprobación
es la revisión **Approve** de GitHub sobre la PR, no un campo de texto editable.

## 2. Cómo funciona

1. El borrador vive en `content/blog/<slug>.md` con `review_status` `draft` o `in_review`. Mientras
   no esté aprobado no genera ningún HTML en `blog/`.
2. Para proponer la publicación, el autor deja en el artículo:
   - `review_status: "approved"` y `approved_at` (fecha real, no futura, no anterior a `date_modified`);
   - `approval: { "pr": <n.º de la PR>, "content_sha256": "<hash>" }`. El hash se obtiene con
     `node seo-engine/blog-render.mjs --hash content/blog/<slug>.md`.
3. El responsable revisa y pulsa **Approve** en esa PR. La aprobación queda ligada por GitHub al
   SHA exacto de la cabeza de la PR.
4. `blog-ci / approval` ejecuta `seo-engine/verify-approval.mjs` y solo pasa si:
   - la **última** revisión decisiva del responsable (`APPROVED`, `CHANGES_REQUESTED` o `DISMISSED`) es `APPROVED`;
   - el contenido del artículo en el commit que aprobó tiene el hash `approval.content_sha256`;
   - en la propia PR, ese commit es la cabeza actual: cualquier push posterior (también de código) exige una aprobación nueva.
5. Tras el merge, `blog-render.mjs` genera `blog/<slug>/index.html`, se añade a la allowlist y
   `pages.yml` lo publica. Eso se hace en una PR aparte y también necesita aprobación.
6. En cada ejecución (y al hacer push a `main`) se reverifica toda aprobación. Si una aprobación
   se revoca después, el check falla y avisa; no despublica solo.

Cualquier error, dato ausente o respuesta inesperada de GitHub cuenta como fallo (fail closed).

## 3. Qué impide superar la verificación

| Situación | Resultado |
|---|---|
| Sin revisión, o solo comentarios | falla |
| Aprobación de otra persona | falla |
| Aprobación revocada (cambios solicitados o descartada después) | falla |
| Contenido modificado tras la aprobación (hash distinto) | falla |
| Push a la PR posterior a la aprobación | falla hasta una nueva aprobación |
| Artículo de pruebas (`"fixture": true`) en `content/blog` | falla |
| Error de red o de API | falla |

## 4. Autor y revisor jurídico son la misma persona

GitHub **no permite aprobar la propia PR**: el autor solo puede comentar. Si la PR la abre y revisa la
misma cuenta, no existe ninguna revisión `APPROVED` y `blog-ci / approval` fallará siempre.
Además, con "Require approval of the most recent reviewable push" activado, quien hizo el último push
tampoco puede aprobar esa PR.

Procedimientos válidos:

1. **Recomendado.** Los borradores de IA los abre una cuenta de bot o GitHub App; el responsable los
   aprueba. Si el responsable edita el texto, lo hace en una PR aparte o lo revisa una segunda persona.
2. **Segundo revisor.** Una segunda cuenta de revisión (colaborador) aprueba; hay que añadirla a `approvers.json`
   y a CODEOWNERS (el verificador actual solo acepta un usuario).
3. **No válido.** Saltarse la protección como administrador. Rompe la trazabilidad en contenido jurídico.

No se implementa una "auto-aprobación" por comentario: daría trazabilidad, pero no una segunda
comprobación independiente. Si se quisiera, sería una decisión explícita y se documentaría como excepción.

## 5. CODEOWNERS (requisito; no activado)

Fichero `.github/CODEOWNERS`, que **no existe todavía**. Contenido previsto (sustituir el usuario por el real):

```
/content/blog/              @martingrelu
/blog/                      @martingrelu
/seo-engine/                @martingrelu
/.github/                   @martingrelu
/tests/                     @martingrelu
```

CODEOWNERS no tiene efecto hasta activar "Require review from Code Owners" en la protección de `main`.

## 6. Protección de `main` (requisitos; no activada)

Branch protection (o ruleset) sobre `main`:

- Requerir pull request antes de fusionar; sin pushes directos.
- Requerir al menos 1 aprobación.
- Requerir revisión de los Code Owners.
- Descartar aprobaciones obsoletas cuando se suben nuevos commits.
- Requerir aprobación del push más reciente revisable (el último en pushear no puede aprobar).
- Requerir comprobaciones de estado: `tests` y `approval` (workflow "Blog CI (tests y aprobaciones)"), con la rama al día.
- Requerir resolución de conversaciones.
- Incluir a los administradores (sin bypass) y restringir quién puede hacer push.
- Bloquear force-push y borrado de la rama.

Notas:
- Los checks obligatorios no deben depender de filtros de rutas: si no se ejecutan, la PR queda pendiente.
  `blog-ci.yml` no los usa a propósito.
- **Por comprobar en una PR de prueba antes de activar:** que el check `approval` se actualice al enviar una
  revisión (`pull_request_review`). Si no se refrescara en la PR, bastará con "Re-run jobs" tras aprobar,
  porque el verificador lee las revisiones en el momento de ejecutarse.

## 7. Seguridad del workflow `blog-ci.yml`

- Eventos: `pull_request`, `pull_request_review` y `push` a `main`. Nunca `pull_request_target`.
- Permisos vacíos por defecto; cada job solo `contents: read` (y `approval` además `pull-requests: read`). Sin escritura.
- Sin secretos propios ni claves de API: solo el `GITHUB_TOKEN` de solo lectura, que llega únicamente al paso de verificación.
- Acciones fijadas por SHA, `persist-credentials: false`, sin interpolar en `run:` texto controlable por el autor de la PR.
- No despliega, no publica ni escribe en el repositorio: el despliegue sigue siendo solo `pages.yml` (allowlist).
- Una PR de un fork recibe un token de solo lectura y ningún secreto.

## 8. Fuera de alcance de esta fase

Registro de fuentes jurídicas, verificador de citas, generación con IA y la cuenta de bot que abre los borradores.
