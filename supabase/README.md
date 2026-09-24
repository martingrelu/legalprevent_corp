# Legal Prevent + Supabase

## 1. Crear proyecto

1. Entra en Supabase y crea un proyecto.
2. Abre `SQL Editor`.
3. Pega y ejecuta el archivo `schema.sql`.
4. Ejecuta después, en orden, los archivos de `supabase/migrations/`.
   `20260924_lead_notification_claim.sql` retira el alta directa de `anon`
   (solo quedan las funciones `submit_lead` / `submit_diagnostic`, que exigen
   la aceptación de la política de privacidad).
5. Para comprobarla en una base de pruebas:
   `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/sql/verify_pr0_migration.sql`
   (se ejecuta en una transacción con ROLLBACK).
6. Despliegue en producción de PR0: sigue `supabase/deploy/PR0.md` (orden
   función → migración → web, comprobaciones y recuperación ante errores).
   Laboratorio local reproducible: `tests/lab/run.sh` (ver `tests/lab/README.md`).

## 2. Crear usuario para el CRM

1. Ve a `Authentication` > `Users`.
2. Crea un usuario con email y contraseña.
3. Ese usuario podrá leer leads porque las políticas permiten lectura solo a usuarios autenticados.

## 3. Configurar la web

Edita `supabase-config.js`:

```js
window.LEGAL_PREVENT_SUPABASE = {
  url: "https://TU-PROYECTO.supabase.co",
  anonKey: "TU_SUPABASE_ANON_KEY"
};
```

Usa solo la clave pública `anon`. No pegues nunca la `service_role` en la web.

## 4. Flujo

- La landing llama a la función segura `submit_lead`, que crea registros en `public.leads`.
- El diagnóstico llama a `submit_lead` y `submit_diagnostic`.
- El CRM permite iniciar sesión con Supabase Auth y sincronizar los leads centrales.

## 5. Seguridad

- Visitantes anónimos solo pueden ejecutar funciones de alta de leads e informes.
- Solo usuarios autenticados pueden leer y actualizar leads.
- La clave privada `service_role` debe quedarse fuera del frontend.

## 6. Emails automáticos

La web está preparada para llamar a la Edge Function `smooth-action` después de crear cada lead.

### Proveedor recomendado

Usa Resend para emails transaccionales.

1. Crea cuenta en Resend.
2. Verifica el dominio `legalprevent.com`.
3. Crea una API key.

### Secretos en Supabase

En Supabase, añade estos secretos en `Project Settings` > `Edge Functions` > `Secrets`:

```text
RESEND_API_KEY=TU_API_KEY_DE_RESEND
LEAD_NOTIFY_EMAIL=tu-email-interno@legalprevent.com
FROM_EMAIL=Legal Prevent <noreply@legalprevent.com>
PUBLIC_SITE_URL=https://legalprevent.com
# Opcionales
LEAD_NOTIFY_HOURLY_CAP=20
ALLOWED_ORIGINS=https://legalprevent.com,https://www.legalprevent.com
```

`SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` los inyecta Supabase automáticamente
en las Edge Functions: no hay que crearlos.

No pongas `RESEND_API_KEY` en la web ni en GitHub.

### Despliegue

Desde una carpeta con Supabase CLI:

```bash
supabase functions deploy smooth-action --project-ref wtpfrlsbfishvworjdtr
```

La función está en:

```text
supabase/functions/send-lead-email/index.ts
```

En la configuración de Supabase, deja `Verify JWT with legacy secret` en OFF para esta función pública de envío controlado.

### Flujo de email

- La web guarda el lead con `submit_lead` y después envía a la función **solo el
  `leadId`** y el tipo de aviso (`new_lead` o `demo_request`).
- Completar el diagnóstico crea un único lead (`source = diagnostic_completed`).
  Si el visitante pide después una demostración, se marca ese mismo lead
  (`demo_requested_at`, RPC `request_lead_demo`) y se envía un aviso de demo:
  no se crea un segundo lead ni se modifica su consentimiento comercial.
- La función lee el lead de `public.leads` con la service role y envía un único
  email interno a `LEAD_NOTIFY_EMAIL`. Nunca envía emails a direcciones
  facilitadas por el visitante (no hay email de confirmación al lead: la
  confirmación se muestra en la página `/gracias/`).
- Cada lead genera como máximo un aviso de cada tipo y solo en los 15 minutos
  siguientes al alta o a la solicitud de demo. La reclamación y el tope global
  de `LEAD_NOTIFY_HOURLY_CAP` avisos por hora (20 por defecto) se hacen en una
  sola RPC con advisory lock (`claim_lead_notification`, solo service role).
- Resend recibe una clave de idempotencia por lead y tipo: un reintento tras un
  fallo no duplica el email.
- Si el email falla, la captación no se bloquea: el lead sigue entrando en Supabase.
- Si falla el alta del lead, la web muestra un aviso al visitante. No se guarda
  ninguna copia de sus datos en el navegador.

## 7. Stripe Checkout

La web está preparada para contratar planes desde la sección de precios mediante Stripe Checkout.

Para crear solo las tablas de Stripe sin tocar el resto del proyecto, ejecuta en Supabase el archivo:

```text
supabase/stripe-schema.sql
```

### Productos en Stripe

Crea estos productos con precio recurrente mensual:

```text
Starter  29 €/mes
Pyme     79 €/mes
Business 149 €/mes
Gestorías 199 €/mes
```

Stripe generará un ID por cada precio. Tienen formato `price_...`.

### Secretos en Supabase

Añade estos secretos en `Project Settings` > `Edge Functions` > `Secrets`:

```text
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PRICE_STARTER=price_1TniT0JnjZc4uuMeb4V5CYEg
STRIPE_PRICE_PYME=price_1TniToJnjZc4uuMepITJHoEe
STRIPE_PRICE_BUSINESS=price_1TniUEJnjZc4uuMe1dLrdHFm
STRIPE_PRICE_GESTORIAS=price_1TniUqJnjZc4uuMe19EDtrBa
STRIPE_WEBHOOK_SECRET=whsec_...
PUBLIC_SITE_URL=https://legalprevent.com
```

No pegues `STRIPE_SECRET_KEY` ni `STRIPE_WEBHOOK_SECRET` en la web.

### Funciones

Hay dos funciones preparadas:

```text
supabase/functions/create-checkout-session/index.ts
supabase/functions/stripe-webhook/index.ts
```

Nota operativa: si en Supabase la función de checkout se ha desplegado con el nombre `super-api`, la web debe llamar a:

```text
https://wtpfrlsbfishvworjdtr.supabase.co/functions/v1/super-api
```

Ese es el endpoint activo configurado actualmente en `supabase-bridge.js`.

Despliegue recomendado:

```bash
supabase functions deploy create-checkout-session --project-ref wtpfrlsbfishvworjdtr
supabase functions deploy stripe-webhook --project-ref wtpfrlsbfishvworjdtr
```

En la función `create-checkout-session`, deja `Verify JWT with legacy secret` en OFF para permitir que la web pública cree sesiones de pago controladas.

En la función `stripe-webhook`, Stripe enviará eventos del servidor. Configura el endpoint en Stripe:

```text
https://wtpfrlsbfishvworjdtr.supabase.co/functions/v1/stripe-webhook
```

Eventos recomendados:

```text
checkout.session.completed
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
invoice.paid
invoice.payment_failed
```

### Datos guardados

El archivo `schema.sql` crea tablas para:

```text
checkout_sessions
subscriptions
payments
```

El CRM podrá leer esos datos con el usuario autenticado de Supabase.
