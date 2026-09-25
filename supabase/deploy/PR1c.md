# Runbook de despliegue · PR1c

Conservación limitada (desactivada), supresión a petición del interesado y
retirada del consentimiento comercial desde el CRM.

Orden: **migración → web (CRM)**. El CRM nuevo sobre la base sin PR1c solo
fallaría al pulsar los botones nuevos (mensaje de error, sin efectos); el CRM
publicado funciona sobre la base con PR1c (probado).

## 0. Preparación
- [ ] `tests/lab/run.sh` en verde en la rama.
- [ ] Revisa <https://status.supabase.com>.
- [ ] `supabase/deploy/pr1c-checks.sh pre` → `todo correcto`.

## 1. Migración y verificación
1. SQL Editor → `supabase/migrations/20260927_retention_erasure.sql` → Run.
2. SQL Editor → `tests/sql/verify_pr1c_migration.sql` → `OK: verificación PR1c superada`
   (ROLLBACK: no borra nada ni activa la conservación).
3. `supabase/deploy/pr1c-checks.sh after-migration` → `todo correcto`.

## 2. Web (CRM)
1. Merge del PR en `main`.
2. `supabase/deploy/pr1c-checks.sh after-web` → `todo correcto`.
3. CRM → Sincronizar Supabase: el panel principal muestra "Conservación de 12
   meses: desactivada…" y la ficha de un lead, "Protección de datos".

## 3. Prueba real y limpieza (requiere autorización expresa)
- [ ] Con "Eliminar por solicitud de supresión", borrar los leads de prueba
      (`martingreluu+prueba-pr0@…`, `+prueba-pr0-diag@…`, `+prueba-pr1a@…`).
      Comprobar que desaparecen del CRM tras sincronizar.

## Conservación (NO activar sin validación jurídica)

```sql
-- Qué borraría (solo recuentos): desde el CRM, o como administrador del CRM
-- select public.retention_preview();

-- Activar (tras la validación jurídica y con autorización)
update private.settings set value = '{"enabled": true, "months": 12}', updated_at = now() where key = 'retention';
-- Programar con pg_cron (requiere activar la extensión): pendiente de decisión.
```

Criterios: leads que no son "Cliente ganado", sin suscripción ni checkout con su
email, sin actividad en 12 meses y **no** pendientes de revisión jurídica;
diagnósticos de más de 12 meses sin un lead que se conserve con su email.

## Recuperación
| Síntoma | Acción |
|---|---|
| La migración da error | No se aplica nada (transacción). |
| `verify_pr1c` con `FALLO` | `supabase/rollback/20260927_retention_erasure_down.sql` (retira las funciones; conserva registros y la columna de retirada). |
| El CRM nuevo falla | `git revert -m 1 <merge>`; la base con PR1c funciona con el CRM anterior. |
| Supresión por error | No se puede deshacer desde la aplicación: restaurar desde la copia de Supabase o la CSV más reciente (ver runbooks de PR0/PR1a). |
