-- PR1a (1/2): incorpora al repositorio el control de acceso del CRM que ya
-- existe en producción (inventario del 2026-09-24) y que schema.sql no refleja.
--
-- Solo los usuarios autenticados con `app_metadata.crm_role = 'admin'` en su
-- JWT pueden leer y editar leads, diagnósticos y datos de facturación. El rol
-- se asigna desde el dashboard de Supabase (Authentication → Users → raw app
-- metadata) y el usuario no puede modificarlo.
--
-- En producción no cambia nada: recrea las mismas políticas con la misma
-- condición y elimina las antiguas de schema.sql, que allí no existen.
-- Idempotente y en una única transacción.
begin;

create or replace function public.is_crm_admin()
returns boolean
language sql
stable
as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'crm_role') = 'admin', false)
$$;

-- Políticas antiguas de schema.sql (cualquier usuario autenticado).
drop policy if exists "Authenticated users can read leads" on public.leads;
drop policy if exists "Authenticated users can update leads" on public.leads;
drop policy if exists "Authenticated users can create CRM leads" on public.leads;
drop policy if exists "Authenticated users can read diagnostics" on public.diagnostics;
drop policy if exists "Authenticated users can read checkout sessions" on public.checkout_sessions;
drop policy if exists "Authenticated users can read subscriptions" on public.subscriptions;
drop policy if exists "Authenticated users can read payments" on public.payments;

-- Políticas vigentes en producción.
drop policy if exists "CRM admin read leads" on public.leads;
create policy "CRM admin read leads" on public.leads
  for select to authenticated using (public.is_crm_admin());

drop policy if exists "CRM admin update leads" on public.leads;
create policy "CRM admin update leads" on public.leads
  for update to authenticated using (public.is_crm_admin()) with check (public.is_crm_admin());

drop policy if exists "CRM admin create leads" on public.leads;
create policy "CRM admin create leads" on public.leads
  for insert to authenticated with check (public.is_crm_admin());

drop policy if exists "CRM admin read diagnostics" on public.diagnostics;
create policy "CRM admin read diagnostics" on public.diagnostics
  for select to authenticated using (public.is_crm_admin());

drop policy if exists "CRM admin read checkout sessions" on public.checkout_sessions;
create policy "CRM admin read checkout sessions" on public.checkout_sessions
  for select to authenticated using (public.is_crm_admin());

drop policy if exists "CRM admin read subscriptions" on public.subscriptions;
create policy "CRM admin read subscriptions" on public.subscriptions
  for select to authenticated using (public.is_crm_admin());

drop policy if exists "CRM admin read payments" on public.payments;
create policy "CRM admin read payments" on public.payments
  for select to authenticated using (public.is_crm_admin());

commit;
