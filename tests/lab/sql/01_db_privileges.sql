-- Privilegios por defecto de Supabase en el esquema public (por base de datos):
-- ALL en tablas, funciones y secuencias para anon, authenticated y service_role.
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
