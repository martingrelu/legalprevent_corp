-- Roles de la API de Supabase (globales del clúster) y rol de PostgREST.
-- Solo para el laboratorio local: la contraseña no es un secreto real y el
-- contenedor solo escucha en 127.0.0.1.
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role authenticator login password 'authenticator-lab' noinherit;
grant anon, authenticated, service_role to authenticator;
-- En Supabase, postgres puede asumir los roles de la API (lo usa el script
-- de verificación con `set local role`).
grant anon, authenticated, service_role to postgres;
