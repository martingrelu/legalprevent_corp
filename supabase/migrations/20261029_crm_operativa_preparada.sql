-- LP-CRM-002: persistencia de tareas, interacciones, propuestas y clientes del CRM.
--
-- ESTADO: PREPARADA, NO EJECUTADA. No aplicar en producción sin autorización expresa
-- y sin haber pasado antes la simulación de docs/crm-migracion-operativa.md.
--
-- Diseño:
-- - Una sola tabla con el registro completo en `payload`. Los identificadores locales
--   (`local_id`) se conservan tal cual, así que las relaciones existentes no cambian.
-- - `unique (kind, local_id)` impide duplicados al reimportar.
-- - Solo administradores del CRM (JWT con app_metadata.crm_role = 'admin') leen o escriben.
--   Depende de public.is_crm_admin(), creada en 20260925_crm_admin_policies.sql.
-- - Es aditiva: no modifica ni borra tablas existentes.

begin;

create table if not exists public.crm_records (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('client', 'task', 'interaction', 'proposal')),
  local_id text not null,
  related_type text,
  related_id text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_records_kind_local_id_key unique (kind, local_id)
);

create index if not exists crm_records_related_idx on public.crm_records (related_type, related_id);

alter table public.crm_records enable row level security;

revoke all on public.crm_records from anon;

drop policy if exists "crm admin acceso completo" on public.crm_records;
create policy "crm admin acceso completo"
  on public.crm_records
  for all
  to authenticated
  using (public.is_crm_admin())
  with check (public.is_crm_admin());

commit;
