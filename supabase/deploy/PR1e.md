# Runbook de despliegue · PR1e (checkout público y funciones sobrantes)

La función de checkout de la web (`super-api`, código en
`supabase/functions/create-checkout-session`) aceptaba cualquier URL de retorno
(una sesión de pago de LegalPrevent podía acabar en otra web), respondía a
cualquier origen (CORS `*`) y no tenía límite. PR1e fija las URL en el
servidor, limita CORS a legalprevent.com y añade límites en la base.

La web no cambia (ya envía las URL correctas; ahora se ignoran).

Orden: **migración → función**. La función nueva necesita `checkout_allow`;
sin ella respondería 503 y el checkout dejaría de funcionar.

## 0. Preparación
- [ ] `tests/lab/run.sh` en verde en la rama.
- [ ] `supabase/deploy/pr1e-checks.sh pre` → `todo correcto`.

## 1. Migración y verificación
1. SQL Editor → `supabase/migrations/20260929_checkout_limits.sql` → Run.
2. SQL Editor → `tests/sql/verify_pr1e_migration.sql` → `OK: verificación PR1e superada` (ROLLBACK).
3. `supabase/deploy/pr1e-checks.sh after-migration` → `todo correcto`.

## Seguridad del checkout: qué protege y qué no

**CORS no es autenticación.** Solo impide que otra web use el checkout desde
el navegador de un visitante. Una llamada directa (curl, script) puede omitir o
falsear `Origin`; por eso `checkout_allow` se consulta en **todas** las
peticiones, antes de llamar a Stripe (probado en `tests/lab/checkout.lab.mjs`:
llamadas sin `Origin` o con el de la web quedan sujetas al mismo límite).

**Límites por defecto** (`private.settings`, clave `checkout_limits`):

| Clave | Valor | Para qué |
|---|---|---|
| `global_per_minute` | 30 | Cortafuegos contra avalanchas: evita llenar `checkout_sessions` y agotar la API de Stripe. |
| `global_per_hour` | null | Sin ventana por hora: un ataque no puede dejar el checkout bloqueado una hora. |
| `email_per_hour` | 5 | Solo si se envía email (la web no lo envía hoy). |

**Riesgo residual (denegación de servicio).** El límite global es común a
todos: quien envíe más de 30 peticiones por minuto de forma sostenida bloquea
también a los clientes legítimos **mientras dure el ataque**; el bloqueo
termina, como máximo, un minuto después de que pare. El tráfico legítimo actual
es de pocas sesiones al día. La mitigación completa es un límite por visitante
(IP), pendiente de verificar qué cabecera es fiable en Supabase (mismo
bloqueo que `client_ip_source` en PR1a).

**Qué ve el cliente al alcanzar el límite.** La función responde 429; la web
muestra "No hemos podido abrir Stripe todavía. Déjanos tu email y te ayudamos a
finalizar el alta" y lleva al formulario de contacto (el lead se captura
igualmente). En Edge Functions → `super-api` → Logs aparece
`super-api: límite de checkout alcanzado`.

**Cómo ajustarlo** (SQL Editor, efecto inmediato, sin redesplegar):
```sql
-- Subir el cortafuegos (p. ej. durante una campaña)
update private.settings set value = jsonb_set(value, '{global_per_minute}', '60'), updated_at = now() where key = 'checkout_limits';
-- Quitar el límite global temporalmente
update private.settings set value = jsonb_set(value, '{global_per_minute}', 'null'), updated_at = now() where key = 'checkout_limits';
-- Cerrar el checkout (emergencia)
update private.settings set value = jsonb_set(value, '{global_per_minute}', '0'), updated_at = now() where key = 'checkout_limits';
```

## 2. Función `super-api`
1. Edge Functions → `super-api` → Code → sustituir `index.ts` por
   `supabase/functions/create-checkout-session/index.ts` → Deploy.
2. No cambiar la verificación JWT (la web envía la clave pública).
3. `supabase/deploy/pr1e-checks.sh after-function` → `todo correcto`.
4. Prueba real: legalprevent.com/#precios → pulsar un plan → se abre Stripe
   Checkout → cerrar sin pagar (la sesión caduca sola).

## 3. Retirar funciones que no se usan (las borra el usuario, tras autorizarlo)

Comprobado el 25/09/2026 (solo lectura):
- Ningún repositorio local (legalprevent, legalprevent_corp, eurohire-*,
  Casify, etc.) llama a `dynamic-endpoint` ni a `rapid-api`, y ningún otro
  proyecto usa este proyecto de Supabase.
- Stripe tiene dos destinos: `eurohirelegal.tech` (otro proyecto) y
  `…/functions/v1/stripe-webhook`. Ninguno apunta a estas funciones.
- Database Webhooks: ninguno. Cron: 0 tareas.
- Invocations de ambas en los últimos 5 días (máximo del panel): ninguna.

- `dynamic-endpoint`: webhook antiguo; Stripe apunta a `stripe-webhook`.
- `rapid-api`: plantilla "hello world" de Supabase.

Antes de borrar cada una: Edge Functions → la función → Invocations → sin
peticiones en los últimos días, y guardar una copia con Download (el código no
está en el repositorio; `dynamic-endpoint` es una versión antigua de
`stripe-webhook`).

## Recuperación
| Síntoma | Acción |
|---|---|
| La migración da error | No se aplica nada (transacción). |
| `verify_pr1e` con `FALLO` | `supabase/rollback/20260929_checkout_limits_down.sql`. |
| El checkout responde 503 | Falta `checkout_allow` o la base no responde: revisar la migración. |
| El checkout nuevo falla por cualquier motivo | Volver a desplegar la versión anterior de `super-api`: copia exacta (SHA-256 `15ca7b6e…44c0`, igual a la de producción el 25/09/2026) en `~/LegalPrevent-backups/2026-09-25-pr1e/super-api-anterior.ts` y en el historial de git (`git show 7b7147f:supabase/functions/create-checkout-session/index.ts`). La migración puede quedarse: la versión anterior no la usa. |
| 429 con tráfico legítimo | Ajustar `checkout_limits` (SQL de arriba). |
