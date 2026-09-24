-- Elimina la sonda temporal de cabeceras de PR1a.
drop function if exists public.pr1a_header_probe();
select 'Sonda eliminada' as resultado;
