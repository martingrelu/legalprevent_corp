# Runbook de despliegue · PR1a

Límites persistentes de altas públicas, consentimiento con fecha y versión,
demo solicitada visible en el CRM, retirada de la compatibilidad temporal de
PR0 y mínimo privilegio (Stripe, columnas del CRM).

Orden validado en el laboratorio (`tests/lab`): **web → migraciones →
(opcional) sonda de IP**. La web nueva funciona sobre la base sin PR1a; al
revés, la web de PR0 no distingue el nuevo `rate_limited` y mostraría
"gracias" a un visitante bloqueado por el límite.

Todas las comprobaciones de `pr1a-checks.sh` son de solo lectura: no crean
registros ni envían emails (medido en el laboratorio en todos los estados; las
sondas que podrían insertar solo se ejecutan si detectan la migración).

---

## 0. Preparación (sin cambios en producción)

- [ ] `tests/lab/run.sh` en verde en la rama.
- [ ] Revisa <https://status.supabase.com>.
- [ ] `supabase/deploy/pr1a-checks.sh pre` → `todo correcto`.
- [ ] SQL Editor → `supabase/deploy/pr1-inventory.sql` (solo lectura). Comprueba
      `diagnostics web antigua (compatibilidad temporal) desde PR0` = **0**. Si no
      es 0, no retires la compatibilidad todavía.
- [ ] Copia de `leads` (SQL Editor → `select * from public.leads order by created_at, id;`
      → Export CSV) en la carpeta privada de copias. PR1a no borra datos, pero
      marca `privacy_review_required` y cambia permisos.

## 1. Publicar la web

1. Merge del PR de PR1a en `main` (GitHub Pages).
2. `supabase/deploy/pr1a-checks.sh after-web` → `todo correcto` (GitHub Pages
   puede tardar unos minutos).

Efecto: la web envía la versión de los textos de consentimiento y reconoce
`rate_limited`. El CRM muestra "Demo solicitada" (la columna ya existe desde
PR0); los datos de consentimiento aparecerán tras el paso 2.

## 2. Migraciones y verificación

En el SQL Editor, en este orden (cada una en una transacción):

1. `supabase/migrations/20260925_crm_admin_policies.sql` — no cambia nada en
   producción: incorpora al repositorio las políticas "CRM admin" existentes.
2. `supabase/migrations/20260925_public_limits_consent.sql`.
3. `tests/sql/verify_pr1a_migration.sql` → `OK: verificación PR1a superada`
   (termina en ROLLBACK: no deja datos ni cambia la configuración).
4. `supabase/deploy/pr1a-checks.sh after-migration` → `todo correcto`.
5. CRM: inicia sesión, pulsa "Sincronizar Supabase" y comprueba que los leads
   cargan, que un lead se puede editar y que los históricos muestran "Revisar
   privacidad".

Límites iniciales (tabla `private.settings`, clave `public_limits`): 3 altas
por email y día (leads y diagnósticos por separado), 20 por minuto y 200 por
hora en total; por IP, 5 por hora **solo si** se configura `client_ip_source`.

## 3. Límite por IP (opcional, requiere autorización expresa)

1. SQL Editor → `supabase/deploy/pr1a-header-probe.sql` (crea una función
   temporal que solo devuelve a quien la llama sus propias cabeceras de IP).
2. `supabase/deploy/pr1a-header-probe.sh` → indica qué cabecera es fiable (la
   que Supabase fija y el cliente no puede falsear) o `none`.
3. SQL Editor → `supabase/deploy/pr1a-header-probe-drop.sql` (elimina la sonda).
4. Si hay una cabecera fiable:
   `update private.settings set value = '"<cabecera>"', updated_at = now() where key = 'client_ip_source';`

## 4. Prueba real (requiere autorización expresa)

- [ ] Demo con `martingreluu+prueba-pr1a@gmail.com` y comunicaciones comerciales
      marcadas → en la base: `privacy_policy_version` y `commercial_consent_version`
      = `2026-06-04` con sus fechas; en el CRM, "Comunicaciones comerciales: Sí ·
      fecha · versión"; un aviso interno.

---

## Ajustes operativos

```sql
-- Cambiar límites (null = sin límite; 0 = cerrar la captación pública)
update private.settings
   set value = '{"ip_per_hour": 5, "email_per_day": 3, "global_per_minute": 20, "global_per_hour": 200}',
       updated_at = now()
 where key = 'public_limits';

-- Intentos rechazados en la última hora (sin datos personales: emails e IPs en hash)
select split_part(bucket, ':', 1) as ambito, sum(greatest(hits - 1, 0)) as intentos
  from private.rate_counters where window_start >= now() - interval '1 hour' group by 1;
```

## Recuperación ante errores

| Síntoma | Acción |
|---|---|
| Paso 1: fallos en la web nueva | `git revert -m 1 <commit de merge>` en `main`. La base aún no ha cambiado. |
| Paso 2: la migración da error | No se aplica nada (transacción). Guarda el mensaje. La web nueva funciona sobre la base sin PR1a. |
| Paso 2: `verify_pr1a` con `FALLO`, el CRM no carga o la web no guarda leads | `supabase/rollback/20260925_public_limits_consent_down.sql` (vuelve a las funciones y permisos de PR0; conserva consentimientos y columnas). `20260925_crm_admin_policies.sql` no necesita rollback. |
| Demasiados rechazos legítimos por el límite | Sube los umbrales en `private.settings` (ver arriba); no requiere despliegue. |
| Tras configurar la IP, rechazos inesperados | `update private.settings set value = '"none"' where key = 'client_ip_source';` |
| Restaurar la copia CSV de `leads` hecha antes de PR1a | `\copy public.leads (<columnas del CSV>) from 'leads.csv' with (format csv, header true, null 'null')` y después vuelve a marcar la revisión jurídica: `update public.leads set privacy_review_required = true where privacy_accepted_at is null;` (probado el 2026-09-25 con la copia real: 66/66). |
