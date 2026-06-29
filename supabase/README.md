# Legal Prevent + Supabase

## 1. Crear proyecto

1. Entra en Supabase y crea un proyecto.
2. Abre `SQL Editor`.
3. Pega y ejecuta el archivo `schema.sql`.

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
```

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

- Email interno: avisa de un nuevo lead.
- Email al lead: confirma que la solicitud se ha recibido.
- Si el email falla, la captación no se bloquea: el lead sigue entrando en Supabase.

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
