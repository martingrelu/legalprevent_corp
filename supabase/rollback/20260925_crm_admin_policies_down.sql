-- ROLLBACK de 20260925_crm_admin_policies.sql (PR1a).
--
-- No hay nada que deshacer en producción: esa migración solo recrea las
-- políticas "CRM admin" y is_crm_admin() que ya existían allí (inventario del
-- 2026-09-24). No restaures las políticas antiguas de schema.sql
-- ("Authenticated users can …"): darían acceso al CRM a cualquier usuario
-- autenticado.
select 'Nada que deshacer: 20260925_crm_admin_policies.sql no cambia producción' as resultado;
