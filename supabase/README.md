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

- La landing inserta leads en `public.leads`.
- El diagnóstico inserta leads en `public.leads` e informes en `public.diagnostics`.
- El CRM permite iniciar sesión con Supabase Auth y sincronizar los leads centrales.

## 5. Seguridad

- Visitantes anónimos solo pueden crear leads e informes.
- Solo usuarios autenticados pueden leer y actualizar leads.
- La clave privada `service_role` debe quedarse fuera del frontend.
