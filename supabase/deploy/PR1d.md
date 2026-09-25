# Runbook de despliegue · PR1d (webhook de Stripe)

Stripe (modo real) envía los eventos a
`https://wtpfrlsbfishvworjdtr.supabase.co/functions/v1/stripe-webhook`, pero esa
función no existía: todas las entregas daban 404 y no se guardaba ninguna
suscripción ni pago. PR1d despliega `stripe-webhook` con ese nombre (no hay que
tocar nada en Stripe) y recupera los eventos perdidos.

Orden: **migración → función → reenvío de eventos**. La función necesita la RPC
`stripe_record_event`; sin ella respondería 500 y Stripe reintentaría.

## 0. Preparación
- [ ] `tests/lab/run.sh` en verde en la rama.
- [ ] `supabase/deploy/pr1d-checks.sh pre` → `todo correcto`.
- [ ] Edge Functions → Secrets: existe `STRIPE_WEBHOOK_SECRET` (solo mirar el nombre).

## 1. Migración y verificación
1. SQL Editor → `supabase/migrations/20260928_stripe_webhook.sql` → Run.
2. SQL Editor → `tests/sql/verify_pr1d_migration.sql` → `OK: verificación PR1d superada` (ROLLBACK).
3. `supabase/deploy/pr1d-checks.sh after-migration` → `todo correcto`.

## 2. Función `stripe-webhook`
1. Edge Functions → Deploy a new function → Via Editor.
2. Nombre: **`stripe-webhook`** (exactamente, es la URL que usa Stripe).
3. Pegar `supabase/functions/stripe-webhook/index.ts` en `index.ts` → Deploy.
4. Details / Settings: **desactivar "Enforce JWT verification"** (Stripe no envía
   JWT; la autenticación es la firma) → Save.
5. `supabase/deploy/pr1d-checks.sh after-function` → `todo correcto`.

## 3. Recuperar los eventos (requiere autorización expresa)
Stripe conserva los eventos 30 días: reenviar antes de ~10/10/2026.
1. Stripe → Workbench → Webhooks → Legal Prevent Stripe Webhook → Entregas de eventos.
2. Reenviar **uno** (p. ej. un `customer.subscription.created`):
   - 200 → la firma coincide; seguir.
   - 400 → `STRIPE_WEBHOOK_SECRET` no es el de este destino: copiar el secreto
     de firma de este destino (icono del ojo) a Edge Functions → Secrets →
     `STRIPE_WEBHOOK_SECRET`, y reenviar de nuevo.
3. Reenviar el resto en orden de fecha. El orden no es crítico: la base descarta
   un evento más antiguo que el último aplicado y los duplicados.
4. Comprobar en el SQL Editor:
   ```sql
   select type, outcome, count(*) from private.stripe_events group by 1, 2 order by 1, 2;
   select stripe_subscription_id, status, plan, current_period_end from public.subscriptions order by updated_at desc;
   select stripe_invoice_id, status, amount_paid from public.payments order by updated_at desc;
   ```

## 4. Retirar `dynamic-endpoint` (después, cuando todo lo anterior esté bien)
No la usa Stripe (apunta a `stripe-webhook`). Antes de borrarla, en sus Logs
comprobar que no recibe peticiones.

## Recuperación
| Síntoma | Acción |
|---|---|
| La migración da error | No se aplica nada (transacción). |
| `verify_pr1d` con `FALLO` | `supabase/rollback/20260928_stripe_webhook_down.sql` (retira la RPC; conserva columnas y registro). |
| La función responde 500 | Logs de la función: falta configuración o falla la RPC. Stripe reintenta 3 días; si no se resuelve, borrar la función `stripe-webhook` (vuelve el 404 de hoy, sin pérdida adicional: los eventos se pueden reenviar). |
| 401 en `after-function` | Falta desactivar "Enforce JWT verification". |
