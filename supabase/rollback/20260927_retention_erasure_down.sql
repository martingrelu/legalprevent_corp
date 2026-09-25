-- ROLLBACK de 20260927_retention_erasure.sql (PR1c).
--
-- Retira las funciones de conservación, supresión y retirada del
-- consentimiento. CONSERVA la configuración, los registros de supresiones y
-- de conservación (prueba de que se atendieron solicitudes) y la columna
-- commercial_consent_withdrawn_at (prueba de retiradas ya hechas).
--
-- Todo o nada: una única transacción.
begin;

drop function if exists public.retention_preview();
drop function if exists public.retention_run();
drop function if exists public.crm_erase_contact(text, text);
drop function if exists public.crm_withdraw_commercial_consent(uuid);
drop function if exists private.retention_diagnostic_candidates(timestamptz);
drop function if exists private.retention_lead_candidates(timestamptz);
drop function if exists private.retention_cutoff();
drop function if exists private.lead_last_activity(public.leads);

commit;
