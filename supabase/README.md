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
