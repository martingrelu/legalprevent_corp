-- SONDA TEMPORAL de cabeceras (PR1a, requiere autorización expresa).
--
-- Crea una función que devuelve a quien la llama sus PROPIAS cabeceras de IP
-- (no lee ni escribe datos). Sirve para decidir qué cabecera es fiable para el
-- límite por IP. Ejecuta después supabase/deploy/pr1a-header-probe.sh y, en
-- cuanto termine, pr1a-header-probe-drop.sql. No la dejes creada.
create or replace function public.pr1a_header_probe()
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'cabeceras', (select jsonb_agg(k order by k) from jsonb_object_keys(h) k),
    'x-forwarded-for', h ->> 'x-forwarded-for',
    'x-real-ip', h ->> 'x-real-ip',
    'cf-connecting-ip', h ->> 'cf-connecting-ip'
  )
  from (select coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb as h) s
$$;
revoke all on function public.pr1a_header_probe() from public, authenticated;
grant execute on function public.pr1a_header_probe() to anon;
