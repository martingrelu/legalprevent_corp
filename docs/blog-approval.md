# Aprobación jurídica del blog: procedimiento y requisitos

Estado: **implementado en la rama, sin activar en el repositorio**. Este documento no se publica (no está en
`.github/pages-allowlist.txt`). La clave, `allowed_signers` y la variable de Actions las configura el responsable;
mientras no existan, ningún artículo puede pasar la verificación (falla cerrado). CODEOWNERS y la protección de `main`
siguen sin activarse.

## 1. Principio

Ningún artículo jurídico se publica sin la autorización expresa del responsable (Luis Martín Grecco, abogado;
usuario de GitHub `martingrelu`, en `seo-engine/approvers.json`). Cambiar `review_status` a `approved` **no aprueba
nada**: solo declara la intención. La aprobación es un registro **firmado con la clave privada del responsable** sobre el
SHA-256 del contenido revisado.

Por qué una firma y no una revisión de GitHub: una aprobación que dependa solo de la sesión de GitHub del responsable
(una revisión, un comentario, lanzar un workflow) puede producirla cualquiera que use esa sesión, incluido un agente o un
motor automático. La firma exige además algo que solo tiene el responsable: la clave privada y su contraseña.

**Qué es y qué no es.** Es una *autorización individual firmada*: deja constancia atribuible, vinculada al contenido y
verificable. **No** es una segunda revisión independiente. Aceptar ese nivel de control es una decisión del responsable.

## 2. Configuración única (la hace el responsable, en su máquina y en GitHub)

1. Crear una clave SSH **dedicada** y con contraseña (no reutilizar la de acceso a GitHub ni cargarla en un agente SSH):
   ```
   ssh-keygen -t ed25519 -f ~/.ssh/legalprevent_approval -C "legalprevent-blog-approval"
   ```
   Con una llave FIDO2 (`-t ed25519-sk`) se exigiría además tocarla al firmar; el soporte está previsto pero **no está probado**.
2. Obtener su huella: `ssh-keygen -lf ~/.ssh/legalprevent_approval.pub` → `SHA256:…`.
3. Crear `seo-engine/allowed_signers` con **una sola línea** y subirlo por PR:
   ```
   martingrelu namespaces="legalprevent-blog-approval" <contenido de legalprevent_approval.pub>
   ```
4. Definir la variable de Actions **`BLOG_APPROVER_FINGERPRINT`** con esa huella: GitHub → Settings → Secrets and
   variables → Actions → pestaña *Variables* → *New repository variable*. Es una variable (no un secreto): la huella es pública.
   Es el anclaje de confianza: **quien solo pueda hacer push no puede cambiarla** y, por tanto, tampoco sustituir la clave
   por otra en `allowed_signers`.

## 3. Procedimiento por artículo

1. El borrador vive en `content/blog/<slug>.md` con `review_status` `draft` o `in_review`: no genera HTML ni necesita firma.
2. Tras revisarlo, el responsable deja `review_status: "approved"` y `approved_at` = **la fecha de hoy** (UTC).
3. En **su terminal**: `node seo-engine/approve.mjs <slug>`. Muestra título, slug y SHA-256, pide escribir los 8 primeros
   caracteres del hash y la contraseña de la clave. Firma, comprueba la firma contra `allowed_signers` y escribe
   `content/blog/approvals/<slug>/<fecha>-approve-<hash8>.json`.
4. Se commitea ese registro junto con el artículo. Una PR sin firma válida no supera `blog-ci / approval`.
5. Tras el merge, `blog-render.mjs` genera `blog/<slug>/index.html`, se añade a la allowlist y `pages.yml` lo publica
   (en una PR aparte, también con CI).

`approve.mjs` se niega a ejecutarse sin terminal interactiva o en CI. Es una barrera de proceso, **no un control criptográfico**:
el control real es que la clave tenga contraseña y que el agente no pueda usarla.

## 4. Qué cuenta como aprobado

Un artículo está aprobado solo si, para el hash SHA-256 de su contenido **actual**, el registro firmado más reciente es una
*aprobación* válida: firma correcta con la clave fijada, espacio de nombres `legalprevent-blog-approval`, identidad del
responsable, timestamp no futuro, nombre de fichero coherente con su contenido y `approved_at` igual a la fecha de la firma.

| Situación | Resultado |
|---|---|
| `review_status: approved` sin registro firmado | falla |
| Cambio del contenido (cuerpo, título, fechas, fuentes…) tras firmar | falla (el hash ya no coincide) |
| Firma de otra clave o con otro espacio de nombres (p. ej. firma de commit) | falla |
| Registro manipulado (campos, firma o nombre del fichero) | falla |
| `allowed_signers` sustituido por otra clave | falla (la huella no coincide con la fijada) |
| Variable `BLOG_APPROVER_FINGERPRINT` ausente o con formato inválido | falla |
| `allowed_signers` con más de una clave, o de otra identidad | falla |
| Revocación posterior (o con el mismo instante) | falla |
| Timestamp futuro (más de 5 min de desfase) | falla |
| Fixture en `content/blog` | falla |
| Error al ejecutar `ssh-keygen` | falla |

El hash cubre todo salvo `review_status`, `approved_at` y `approval`: esos campos cambian al aprobar y no son contenido revisado.

## 5. Historial auditable

- Cada aprobación y revocación es un fichero nuevo, firmado e inmutable: `content/blog/approvals/<slug>/<AAAAMMDD>T<HHMMSS>Z-<approve|revoke>-<hash8>.json`.
  `approve.mjs` nunca sobrescribe; cualquier edición rompe la firma o el nombre.
- El historial es la lista de ficheros más `git log`. Eliminar un registro es visible en git.
- **Revocar:** `node seo-engine/approve.mjs <slug> --revoke [--sha256 <hash>]` firma una revocación para ese contenido. Una
  aprobación posterior del mismo contenido lo restablece.

## 6. CI (`blog-ci.yml`)

- Eventos: `pull_request` y `push` a `main`; nunca `pull_request_target`.
- `contents: read` en cada job; sin escritura, sin `GITHUB_TOKEN` para la API ni secretos. La verificación es **offline**
  (`ssh-keygen -Y verify`). Lo único que lee del entorno es la variable pública `BLOG_APPROVER_FINGERPRINT`.
- Acciones fijadas por SHA, `persist-credentials: false`, sin texto de la PR en `run:`. No despliega ni escribe: el despliegue
  sigue siendo solo `pages.yml` (allowlist).
- En PR de forks las variables de Actions no están disponibles: la verificación fallaría cerrada si hubiese artículos aprobados.

## 7. Límites y riesgos

- **Sin segundo revisor.** Si se compromete la cuenta o la clave, alguien puede aprobar en nombre del responsable.
- **Pérdida o compromiso de la clave:** generar otra, actualizar `allowed_signers` (por PR) y la variable, y volver a firmar los
  artículos vigentes. Las firmas antiguas dejan de validar al cambiar la clave fijada.
- **Quien administre el repositorio puede cambiar la variable.** Es el anclaje; protege frente a quien solo tiene push o un token de CI.
- **La fecha firmada la declara el firmante.** Es indicativa; el orden fiable lo da `git log`.
- **Contenido ya aprobado:** volver a un texto firmado antes (mismo hash) lo vuelve a aprobar salvo que se haya revocado.
- **Sin protección de rama:** mientras `main` no la tenga, el check no es obligatorio. Un administrador podría fusionar sin
  que pase. CODEOWNERS y la protección de `main` quedan documentadas y sin activar (sección 9).
- **El soporte de llaves FIDO2** y la verificación en el runner con OpenSSH 9.6 solo están probados con claves ed25519 normales en local.

## 8. Rotación y primer uso

Hasta que existan `allowed_signers` y la variable, el CI pasa si no hay artículos aprobados y falla si los hay. Esto es
intencionado: la publicación no es posible sin la configuración del responsable.

## 9. CODEOWNERS y protección de `main` (requisitos; no activados)

`.github/CODEOWNERS` (no existe todavía):

```
/content/blog/              @martingrelu
/blog/                      @martingrelu
/seo-engine/                @martingrelu
/.github/                   @martingrelu
/tests/                     @martingrelu
```

Branch protection (o ruleset) sobre `main`:

- PR obligatoria y sin pushes directos; bloquear force-push y borrado de la rama.
- Comprobaciones de estado requeridas: `tests` y `approval` (workflow "Blog CI (tests y aprobaciones)"), con la rama al día.
- Incluir a los administradores (sin bypass) y requerir resolución de conversaciones.
- No exigir aprobaciones de revisión si el responsable es el único mantenedor (GitHub no permite aprobar la propia PR).
  Con un segundo revisor, activar además la revisión de Code Owners.
- Los checks obligatorios no deben depender de filtros de rutas; `blog-ci.yml` no los usa.

## 10. Modo opcional "pr-review" (para un segundo revisor)

`seo-engine/verify-approval.mjs` conserva el modo `"mode": "pr-review"` en `approvers.json`: aprobación por revisión de GitHub
ligada al SHA de la cabeza de la PR y al hash del contenido (`approval {pr, content_sha256}`). Necesita un `GITHUB_TOKEN` con
`pull-requests: read`, que `blog-ci.yml` **no** concede. No se usa mientras el responsable sea una sola persona. GitHub no
permite aprobar la propia PR, por eso este modo no sirve para el flujo actual.

## 11. Fuera de alcance de esta fase

Registro de fuentes jurídicas, verificador de citas, generación con IA y la cuenta de bot que abre los borradores.

## Verificación de citas antes de firmar (F2.4)

`node seo-engine/approve.mjs <slug>` ya **no firma** una aprobación si las citas del artículo no superan esta puerta
(`seo-engine/approval-gate.mjs`), antes de pedir las confirmaciones:

1. **Offline:** candado, registro de fuentes, tipos y vinculación, reconocimientos de revisión, referencias sin cita. Si falla,
   no se sale a la red.
2. **En vivo, estricto, con reintentos:** cada cita contra su fuente (BOE, AEPD, INSST) y su candado. Todo lo que no sea
   «coincide» bloquea.
3. Si una fuente de la AEPD o del INSST no responde, la puerta sugiere `node seo-engine/except.mjs <slug> <cita>`. Con una
   excepción firmada y vigente (F2.3c) la cita queda en `REVISION_EXCEPCIONAL` y la firma exige **escribir `EXCEPCIONAL`**
   además del hash. El BOE nunca admite excepción.

Reglas añadidas: una aprobación se firma **siempre sobre el contenido actual** (`--sha256` solo vale para revocar); cualquier
error técnico de la puerta es un «no firmar»; la puerta es de solo lectura (no escribe nada, ni siquiera si falla).

**Qué es y qué no es.** Es un cinturón de seguridad para el responsable: evita firmar lo que el CI va a rechazar. No es el
control de fondo: ese lo dan `citations` y `sources-live` (desde la rama base) y la firma. La revocación no pasa por la puerta.

**Corrección incluida:** `approve.mjs` decidía si ejecutarse comparando su ruta sin resolver enlaces simbólicos; con un enlace
salía con 0 **sin hacer nada** (parecía que se había firmado). Ahora compara la ruta real, igual que `except.mjs`.
