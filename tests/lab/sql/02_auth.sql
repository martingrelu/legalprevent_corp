-- Emulación mínima del esquema `auth` de Supabase: auth.jwt() devuelve los
-- claims del JWT de la petición, que PostgREST publica en request.jwt.claims.
-- Lo usa public.is_crm_admin() (app_metadata.crm_role = 'admin').
create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

create or replace function auth.jwt()
returns jsonb
language sql
stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;

grant execute on function auth.jwt() to anon, authenticated, service_role;
