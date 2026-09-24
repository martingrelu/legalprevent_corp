# Runbook de despliegue · PR0

Corrige la función `smooth-action` (enviaba emails a direcciones arbitrarias),
cierra el alta directa de `anon` y registra la privacidad y el consentimiento
comercial por separado. Orden validado en el laboratorio (`tests/lab`):
**función → migración → web**.

Proyecto Supabase: `wtpfrlsbfishvworjdtr` · Web: <https://legalprevent.com> (GitHub Pages).

Todas las comprobaciones de `pr0-checks.sh` son de solo lectura: no crean
registros ni envían emails (medido en el laboratorio en todos los estados).

---

## 0. Preparación (sin cambios en producción)

- [ ] `tests/lab/run.sh` en verde en la rama `fix/pr0-send-lead-email`.
- [ ] `supabase/deploy/pr0-checks.sh pre` → `RESULTADO: todo correcto`.
- [ ] **Copia de la función actual**: Dashboard → Edge Functions → `smooth-action`
      → Code → descarga o copia `index.ts` y guárdalo (solo como registro: **no**
      se debe volver a publicar, es la versión vulnerable).
- [ ] **Captura de la base**: SQL Editor → pega `supabase/deploy/pr0-snapshot.sql`
      → Run → Export CSV. Comprueba:
  - `columna notified_at existe` = `false`
  - `postgres miembro de anon/authenticated/service_role` = `true`
    (si alguno es `false`, `verify_pr0_migration.sql` no podrá cambiar de rol:
    avisa antes de seguir)
  - anota `filas en leads` y `filas en diagnostics`.
- [ ] **Copia de datos**: Table Editor → `leads` y `diagnostics` → Export CSV
      (o confirma que hay backup diario activo en Database → Backups).

### Configuración de la función (Dashboard → Edge Functions → Secrets)

| Secreto | Estado requerido |
|---|---|
| `RESEND_API_KEY` | Obligatorio. Sin él la función responde 500 y no hay avisos. |
| `LEAD_NOTIFY_EMAIL` | Recomendado: buzón interno que recibe los avisos (por defecto `legal@legalprevent.com`). |
| `FROM_EMAIL` | Obligatorio en la práctica: remitente de un **dominio verificado en Resend** (p. ej. `Legal Prevent <noreply@legalprevent.com>`). El valor por defecto `onboarding@resend.dev` solo entrega al dueño de la cuenta de Resend. |
| `PUBLIC_SITE_URL` | Opcional (`https://legalprevent.com`). |
| `LEAD_NOTIFY_HOURLY_CAP` | Opcional (por defecto 20 avisos/hora). |
| `ALLOWED_ORIGINS` | Opcional. Por defecto `https://legalprevent.com,https://www.legalprevent.com`. **No** lo pongas a `*`. |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Los inyecta Supabase. Requieren las claves JWT *legacy* activas (Settings → API Keys); hoy lo están (la web usa la clave `anon` legacy). |

- [ ] Secretos revisados.
- [ ] Resend: dominio del `FROM_EMAIL` verificado.
- [ ] `Verify JWT` de `smooth-action`: **dejar como está (OFF)**. La seguridad no
      depende de él; cambiarlo durante el despliegue añade un riesgo innecesario.

---

## 1. Publicar la función (cierra la vulnerabilidad)

1. Dashboard → Edge Functions → `smooth-action` → Code.
2. Sustituye el contenido de `index.ts` por
   `supabase/functions/send-lead-email/index.ts` de la rama PR0 → Deploy.
3. `supabase/deploy/pr0-checks.sh after-function` → `todo correcto`.

Efecto esperado: la vulnerabilidad queda cerrada al instante. Los leads se
siguen guardando; **los avisos internos quedan en pausa** hasta el paso 2
(la función responde 500 genérico porque aún no existe la RPC de reclamación).
Haz el paso 2 a continuación.

## 2. Migración y verificación

1. SQL Editor → pega `supabase/migrations/20260924_lead_notification_claim.sql`
   → Run. Se ejecuta en una sola transacción: o se aplica entera o nada.
2. SQL Editor → pega `tests/sql/verify_pr0_migration.sql` → Run → debe
   mostrar `OK: verificación PR0 superada` (se ejecuta con ROLLBACK: no deja datos).
3. `supabase/deploy/pr0-checks.sh after-migration` → `todo correcto`.

Efecto esperado: vuelven los avisos internos. La web publicada sigue
funcionando (demo: igual; diagnóstico: se guarda en `diagnostics` como hoy
gracias a la compatibilidad temporal).

Nota: tras la migración, `anon` ya no puede leer `leads`; para comprobar
columnas usa el SQL Editor, no la API con la clave pública.

## 3. Publicar la web

1. Merge de `fix/pr0-send-lead-email` en `main` (GitHub Pages publica solo).
2. Espera ~10 minutos (caché de GitHub Pages) y ejecuta
   `supabase/deploy/pr0-checks.sh after-web` → `todo correcto`.

## 4. Prueba real (requiere autorización expresa)

Crea datos reales y un email interno. Usa un email de prueba propio.

- [ ] Formulario de demo de la portada → llega a `/gracias/`, aparece en el CRM
      y llega **un** aviso interno. El email de prueba **no** recibe nada.
- [ ] Diagnóstico con solo la privacidad marcada → lead con
      `commercial_consent = false`; "Solicitar demostración" → mismo lead,
      aviso "Demo solicitada".
- [ ] En el CRM, marca los leads de prueba como "Perdido" con una nota "prueba PR0".

---

## Recuperación ante errores

**Nunca vuelvas a publicar la versión anterior de la función**: reabre la
vulnerabilidad. Las opciones seguras son:

| Síntoma | Acción |
|---|---|
| Paso 1: `after-function` falla o la función da errores inesperados | Publica `supabase/rollback/smooth-action-stub.ts` en `smooth-action`: no envía nada, la captación sigue y solo se pausan los avisos. Revisa el código publicado y los *Logs* de la función. |
| Paso 1 OK pero no llegan avisos tras el paso 2 | Revisa los *Logs* de `smooth-action`: `configuración incompleta` → faltan secretos; `Resend respondió 4xx` → `FROM_EMAIL`/dominio; `error de base de datos` → revisa la migración. Los leads siguen en el CRM. |
| Paso 2: la migración da error | No se ha aplicado nada (transacción). Guarda el mensaje de error; la función nueva sigue segura con los avisos en pausa. |
| Paso 2: `verify_pr0_migration.sql` muestra `FALLO` o la web deja de guardar leads | Ejecuta `supabase/rollback/20260924_lead_notification_claim_down.sql` (una transacción; conserva las columnas nuevas). Tras el rollback la web publicada funciona como antes; la función nueva no envía avisos pero sigue sin enviar a terceros. |
| Paso 3: fallos en la web nueva | `git revert -m 1 <commit de merge>` en `main` (vuelve a la web anterior, compatible con la base migrada). La caché puede tardar ~10 min. |

Tras cualquier recuperación, ejecuta de nuevo el `pr0-checks.sh` del paso
correspondiente y apunta qué se hizo y cuándo.
