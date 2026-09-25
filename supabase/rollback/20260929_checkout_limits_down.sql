-- Rollback de 20260929_checkout_limits.sql (PR1e).
-- Retira la función de límites; conserva la configuración y los contadores.
-- Antes, vuelve a desplegar una versión de `super-api` que no use
-- checkout_allow (si no, el checkout respondería 503).
begin;
drop function if exists public.checkout_allow(text);
commit;
