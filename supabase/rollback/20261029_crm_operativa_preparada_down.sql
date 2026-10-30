-- Reversión de 20261029_crm_operativa_preparada.sql.
-- ATENCIÓN: borra la tabla y todo lo guardado en ella. Ejecutar solo si la tabla
-- no contiene datos que no estén también en la copia exportada desde el navegador.
-- PREPARADA, NO EJECUTADA.

begin;

drop policy if exists "crm admin acceso completo" on public.crm_records;
drop table if exists public.crm_records;

commit;
