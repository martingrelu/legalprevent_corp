-- Rollback de 20260928_stripe_webhook.sql (PR1d).
-- Retira la función de registro. Conserva las columnas stripe_event_created,
-- payments.updated_at y private.stripe_events (datos y trazabilidad; no
-- molestan al webhook anterior).
-- Antes de ejecutarlo, vuelve a desplegar una versión del webhook que no use
-- stripe_record_event (o Stripe recibirá 500 y reintentará).
begin;
drop function if exists public.stripe_record_event(text, text, timestamptz, text, jsonb);
commit;
