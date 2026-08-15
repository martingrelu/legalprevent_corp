-- Permite que usuarios autenticados del CRM creen leads manuales.
grant insert on public.leads to authenticated;

drop policy if exists "Authenticated users can create CRM leads" on public.leads;
create policy "Authenticated users can create CRM leads"
on public.leads
for insert
to authenticated
with check (true);
  
