-- Campos de embudo comercial en leads, editables desde el CRM.
-- Las columnas ya existen en la base de producción: esta migración deja
-- constancia en el repo y es idempotente (no altera columnas existentes).
--
-- Valores esperados (validados en el CRM, crm/src/models.js):
--   lead_type:   pyme | gestoria | despacho | grupo | autonomo
--   lost_reason: precio | ya_tiene_asesor | no_lo_necesita | sin_tiempo | no_responde | otro
alter table public.leads add column if not exists lead_type text;
alter table public.leads add column if not exists zone text;
alter table public.leads add column if not exists demo_at timestamptz;
alter table public.leads add column if not exists next_action_at timestamptz;
alter table public.leads add column if not exists lost_reason text;
