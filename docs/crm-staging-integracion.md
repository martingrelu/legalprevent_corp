# LP-CRM-002: validación de integración en staging

Entorno de prueba: proyecto `ubyopnnfmajmrqhkapjk` (staging).
Producción `wtpfrlsbfishvworjdtr`: **prohibido** en cualquier ejecución de esta guía.

## 1. Dependencias SQL (solo en staging, en este orden)

Ejecutar en el SQL Editor del proyecto de staging, sin tocar producción:

1. `supabase/schema.sql` (leads, diagnostics)
2. `supabase/migrations/20260815_enable_crm_manual_leads.sql`
3. `supabase/migrations/20260923_add_lead_funnel_fields.sql`
4. `supabase/migrations/20260925_public_limits_consent.sql` (esquema `private`, consentimiento)
5. `supabase/migrations/20260925_crm_admin_policies.sql` (`is_crm_admin()`)
6. `supabase/migrations/20260927_retention_erasure.sql` (eliminación y retirada de consentimiento)
7. `supabase/migrations/20261029_crm_operativa_preparada.sql` (`crm_records`, RLS)

No ejecutar agente, Stripe, checkout ni el resto de migraciones: no son necesarios para el CRM.
Si una migración falla por dependencia, el error de SQL indica cuál falta; detenerse ahí.

## 2. Rol administrador del usuario de staging

El usuario de prueba debe tener `app_metadata.crm_role = 'admin'`. Ejecutar en staging, sustituyendo el email de prueba:

```sql
update auth.users
   set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"crm_role":"admin"}'::jsonb
 where email = 'EMAIL_DE_PRUEBA_STAGING';

select email, raw_app_meta_data->>'crm_role' as crm_role from auth.users where email = 'EMAIL_DE_PRUEBA_STAGING';
```

El resultado debe mostrar `admin`. Hay que cerrar y volver a abrir sesión para que el JWT lo incluya.
No se modifica el método de autenticación ni el usuario habitual.

## 3. Configuración de prueba (sin tocar el repositorio)

`supabase-config.js` apunta a producción. El runner lo sustituye en el navegador de prueba mediante interceptación de peticiones.
Variables de entorno, definidas solo en la terminal de quien ejecuta, nunca en el repositorio:

- `STAGING_URL=https://ubyopnnfmajmrqhkapjk.supabase.co`
- `STAGING_ANON_KEY` (clave pública del proyecto de staging)
- `STAGING_EMAIL` y `STAGING_PASSWORD` (usuario de prueba; se pasan solo en la terminal)

## 4. Protecciones contra producción

El runner `tests/lab/crm-staging-integration.cjs` se detiene antes de cualquier petición si:

- `STAGING_URL` no es exactamente `https://ubyopnnfmajmrqhkapjk.supabase.co`;
- la URL contiene `wtpfrlsbfishvworjdtr`;
- falta la clave de staging.

Durante la ejecución, cualquier petición a `*.supabase.co` que no sea staging se bloquea.

## 5. Batería de integración (una sola ejecución)

1. **Autenticación**: el administrador entra con el formulario real del CRM y ve el panel.
2. **Permisos**: la clave anónima no puede leer `crm_records`.
3. **Persistencia**: importar una copia con datos reales ficticios (`.test`) → "Confirmado por Supabase: N nuevos".
4. **Lectura**: `crm_records` devuelve los N registros con `kind` y `local_id` correctos.
5. **Importación repetida**: repetir la misma importación → "0 nuevos", sin duplicados en la tabla.
6. **Fallo de red**: interceptar `crm_records` con un corte durante un cambio → la cabecera muestra error y el estado local no cambia.
7. **Recuperación**: restablecer la red y reintentar → "Sincronizado", recuento remoto igual al esperado.
8. **Eliminación y retirada**: sobre un lead creado en staging, retirada de consentimiento (dos veces) y eliminación; comprobar que el reintento no restaura consentimiento ni duplica entradas de auditoría de forma inesperada.

## 6. Conservación de resultados y retirada

- Guardar en una carpeta fechada fuera del repositorio: capturas, registro de peticiones, recuentos antes y después, commit usado (`223d9bb` o posterior) y URL usada.
- Borrar el proyecto de staging desde su panel solo tras confirmación. No tocar producción.
- Confirmar que `supabase-config.js` del repositorio sigue apuntando a producción sin cambios.

## 7. Qué debe hacer la persona que ejecuta

1. Crear el usuario de prueba y aplicar la sección 2.
2. Exportar `STAGING_ANON_KEY`, `STAGING_EMAIL` y `STAGING_PASSWORD` en su terminal.
3. Ejecutar `node tests/lab/crm-staging-integration.cjs`.
