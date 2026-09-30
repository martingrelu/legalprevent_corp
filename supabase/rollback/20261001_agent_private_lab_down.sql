-- Rollback de 20261001_agent_private_lab.sql (PR2).
-- Retira las funciones del laboratorio privado. Conserva el libro del
-- presupuesto de pruebas (trazabilidad del gasto) y BORRA las conversaciones de
-- prueba (solo existían para evaluación). Las claves añadidas a
-- private.settings.agent se quedan (inofensivas; public_enabled=false).
begin;
drop function if exists public.agent_runtime_config();
drop function if exists public.agent_preview_reserve(text, text, integer, integer);
drop function if exists public.agent_preview_settle(uuid, integer, integer, integer);
drop function if exists public.agent_preview_release(uuid);
drop function if exists public.agent_preview_log_turn(jsonb);
drop function if exists public.agent_purge_test_transcripts();
drop function if exists public.agent_lab_whoami();
drop function if exists public.agent_lab_turns(text, integer);
drop function if exists public.agent_lab_rate(bigint, jsonb, text);
drop function if exists public.agent_lab_summary();
drop function if exists private.agent_model_cost(text, integer, integer, integer, jsonb);
drop table if exists private.agent_test_transcripts;
commit;
