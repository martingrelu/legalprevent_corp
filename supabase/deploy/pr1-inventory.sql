-- Inventario previo a PR1 (SOLO LECTURA: no modifica nada).
select * from (
  -- 1. Tablas de public: RLS y privilegios efectivos.
  select 1 as orden, 'tabla ' || c.relname as item,
    'rls=' || c.relrowsecurity
    || ' anon=' || coalesce(nullif(concat_ws(',',
         case when has_table_privilege('anon', c.oid, 'SELECT') then 'S' end,
         case when has_table_privilege('anon', c.oid, 'INSERT') then 'I' end,
         case when has_table_privilege('anon', c.oid, 'UPDATE') then 'U' end,
         case when has_table_privilege('anon', c.oid, 'DELETE') then 'D' end), ''), '-')
    || ' auth=' || coalesce(nullif(concat_ws(',',
         case when has_table_privilege('authenticated', c.oid, 'SELECT') then 'S' end,
         case when has_table_privilege('authenticated', c.oid, 'INSERT') then 'I' end,
         case when has_table_privilege('authenticated', c.oid, 'UPDATE') then 'U' end,
         case when has_table_privilege('authenticated', c.oid, 'DELETE') then 'D' end), ''), '-')
    || ' filas~' || c.reltuples::bigint as valor
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
  union all
  -- 2. Políticas RLS (con su condición).
  select 2, 'politica ' || tablename || ': ' || policyname,
    cmd || ' ' || roles::text || ' using(' || coalesce(qual, '') || ') check(' || coalesce(with_check, '') || ')'
  from pg_policies where schemaname = 'public'
  union all
  -- 3. Funciones de public ejecutables por anon.
  select 3, 'funcion ' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
    'anon=' || has_function_privilege('anon', p.oid, 'EXECUTE') || ' definer=' || p.prosecdef
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prokind = 'f'
    and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  union all
  -- 4. Extensiones útiles para PR1.
  select 4, 'extension ' || name, coalesce('instalada ' || installed_version, 'disponible')
  from pg_available_extensions where name in ('pg_cron', 'pg_net', 'pgcrypto')
  union all
  -- 5. Uso real tras PR0 (desde el despliegue, 2026-09-24 19:00 UTC).
  select 5, 'leads nuevos desde PR0', count(*)::text from public.leads where created_at >= '2026-09-24 19:00+00'
  union all select 5, 'leads de prueba pr0 restantes', count(*)::text from public.leads where email like 'martingreluu+prueba-pr0%'
  union all select 5, 'diagnostics totales', count(*)::text from public.diagnostics
  -- La web nueva envía privacyAccepted dentro del payload guardado; la antigua no.
  union all select 5, 'diagnostics web antigua (compatibilidad temporal) desde PR0',
    count(*)::text from public.diagnostics where not (payload ? 'privacyAccepted') and created_at >= '2026-09-24 19:00+00'
  union all select 5, 'diagnostics web nueva desde PR0',
    count(*)::text from public.diagnostics where payload ? 'privacyAccepted' and created_at >= '2026-09-24 19:00+00'
  union all select 5, 'leads totales', count(*)::text from public.leads
  union all select 5, 'leads sin privacidad registrada', count(*)::text from public.leads where not privacy_accepted
  union all select 5, 'lead más antiguo', min(created_at)::text from public.leads
  union all select 5, 'leads por estado', string_agg(status || '=' || n, ', ') from (select status, count(*) n from public.leads group by status) s
  union all select 5, 'subscriptions con lead_id', count(*)::text from public.subscriptions where lead_id is not null
) inventario
order by orden, item;
