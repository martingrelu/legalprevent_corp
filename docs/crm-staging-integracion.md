# LP-CRM-002 · Integración en staging (procedimiento único)

Proyecto de prueba: `ubyopnnfmajmrqhkapjk`. Producción `wtpfrlsbfishvworjdtr`: **prohibido** en cualquier paso.

## Paso 1 · Generar el paquete SQL (local, sin red)

    tools/crm-staging-bundle.sh

Genera `supabase/staging/crm-staging-install.sql` con el conjunto mínimo del CRM, en este orden:

1. `schema.sql` (leads, diagnostics; incluye tablas de pagos que comparten el esquema base)
2. `20260815_enable_crm_manual_leads.sql` (alta de leads desde el CRM)
3. `20260923_add_lead_funnel_fields.sql` (campos del embudo)
4. `20260924_lead_notification_claim.sql` (`demo_requested_at`, lo lee el CRM)
5. `20260925_crm_admin_policies.sql` (`is_crm_admin()`)
6. `20260925_public_limits_consent.sql` (consentimiento; incluye también funciones del formulario público, sin uso en el CRM)
7. `20260927_retention_erasure.sql` (eliminación y retirada de consentimiento)
8. `20261029_crm_operativa_preparada.sql` (`crm_records`, RLS)

Verificado en un PostgreSQL 16 desechable: el paquete se aplica de principio a fin y crea `leads`, `diagnostics`, `crm_records` y las cuatro funciones del CRM.

**Corrección y motivo.** La migración `20260927` falla tal cual: en sus funciones SQL, `l.created_at` debe escribirse `(l).created_at`. El generador aplica esa corrección solo al paquete, comprobando que el texto encaja exactamente una vez. **El archivo original no se modifica.** Antes de aplicar la migración en producción, esta corrección debe decidirse aparte.

No se ejecutan agente comercial, Stripe, checkout ni el resto de migraciones.

## Paso 2 · Una única acción en Supabase (la tuya)

En el SQL Editor del proyecto `ubyopnnfmajmrqhkapjk` (comprueba en la URL del editor que es ese proyecto), pega y ejecuta **el contenido completo** de `supabase/staging/crm-staging-install.sql`.

Después, con el email de prueba de staging, ejecuta:

    update auth.users
       set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"crm_role":"admin"}'::jsonb
     where email = 'EMAIL_DE_PRUEBA_STAGING';

Cierra y vuelve a abrir la sesión del CRM para que el JWT incluya el rol.

## Paso 3 · Ejecución de la integración (automática)

Define estas variables solo en tu terminal (nunca en el repositorio):

    STAGING_ANON_KEY=...    # clave pública del proyecto de staging (Settings → API)
    STAGING_EMAIL=...       # usuario de prueba de staging
    STAGING_PASSWORD=...    # su contraseña

Luego: `node tests/lab/crm-staging-integration.cjs`

El runner levanta el CRM en local, sustituye la configuración del navegador de prueba por la de staging y bloquea cualquier otra petición a `*.supabase.co`. Escenarios: autenticación, permisos con clave anónima, persistencia, lectura, importación repetida, fallo de red, recuperación y funciones de retirada y eliminación. Escribe `crm-staging-results/resultados.json` y una captura fuera del control de versiones.

## Protecciones contra producción

El runner se detiene antes de cualquier petición si:
- `STAGING_URL` no es exactamente `https://ubyopnnfmajmrqhkapjk.supabase.co`;
- la URL contiene `wtpfrlsbfishvworjdtr`;
- falta la clave anónima o las credenciales de staging.

El generador de SQL también aborta si el paquete contiene la referencia de producción.

## Pendiente de verificación manual

Fallo parcial **en la interfaz** al eliminar o retirar consentimiento (la nube confirma y el guardado local falla): requiere un lead real de staging creado por el formulario. El runner comprueba las funciones, no esa ruta de la interfaz.

## Limpieza

Tras la ejecución, guarda `crm-staging-results/` fuera del repositorio y borra el proyecto de staging solo tras tu confirmación. No se toca producción.
