-- ROLLBACK de 20260926_agent_budget.sql (PR1b).
--
-- Retira las funciones del agente (reserva, liquidación, liberación, eventos y
-- métricas). Mientras no exista la Edge Function del agente (PR2), no afecta a
-- nada visible. CONSERVA las tablas de private (consumo, presupuesto, eventos)
-- y la configuración `agent`: son registros de gasto y métricas anónimas.
--
-- Todo o nada: una única transacción.
begin;

drop function if exists public.agent_reserve(text, integer, integer);
drop function if exists public.agent_settle(uuid, integer, integer, integer);
drop function if exists public.agent_release(uuid, integer);
drop function if exists public.agent_track_event(jsonb);
drop function if exists public.agent_metrics(integer);

commit;
