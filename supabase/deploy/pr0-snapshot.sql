-- Captura previa al despliegue de PR0 (SOLO LECTURA: no modifica nada).
-- Ejecútala en el SQL Editor de Supabase ANTES de la migración y guarda el
-- resultado (Export → CSV) junto al registro del despliegue. Sirve para:
--   * confirmar que producción coincide con lo probado en el laboratorio;
--   * disponer de las definiciones reales por si hay que hacer rollback.

-- 1. Versión de Postgres y rol con el que se ejecuta el SQL Editor.
select 'version' as item, version() as valor
union all select 'current_user', current_user
-- 2. ¿Puede el SQL Editor asumir los roles de la API? (lo necesita
--    tests/sql/verify_pr0_migration.sql para `set local role`)
union all select 'postgres miembro de anon', pg_has_role(current_user, 'anon', 'member')::text
union all select 'postgres miembro de authenticated', pg_has_role(current_user, 'authenticated', 'member')::text
union all select 'postgres miembro de service_role', pg_has_role(current_user, 'service_role', 'member')::text
-- 3. Estado de la migración (debe ser false antes de desplegar).
union all select 'columna notified_at existe', exists(select 1 from information_schema.columns where table_schema='public' and table_name='leads' and column_name='notified_at')::text
union all select 'función claim_lead_notification existe', exists(select 1 from pg_proc where proname='claim_lead_notification')::text
-- 4. Volumen actual (para comparar después).
union all select 'filas en leads', (select count(*) from public.leads)::text
union all select 'filas en diagnostics', (select count(*) from public.diagnostics)::text
-- 5. Privilegios actuales de anon.
union all select 'anon INSERT leads', has_table_privilege('anon','public.leads','INSERT')::text
union all select 'anon SELECT leads', has_table_privilege('anon','public.leads','SELECT')::text
union all select 'anon INSERT diagnostics', has_table_privilege('anon','public.diagnostics','INSERT')::text
-- 6. Definiciones actuales de las funciones que cambia la migración.
union all select 'def submit_lead', pg_get_functiondef('public.submit_lead(jsonb)'::regprocedure)
union all select 'def submit_diagnostic', pg_get_functiondef('public.submit_diagnostic(jsonb)'::regprocedure)
-- 7. Políticas actuales de leads y diagnostics.
union all select 'politica ' || tablename || ': ' || policyname, cmd || ' ' || roles::text
  from pg_policies where schemaname = 'public' and tablename in ('leads', 'diagnostics');
