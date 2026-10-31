# LP-CRM-002 · Migraciones necesarias en producción

Estado: **preparado, no ejecutado**. No se ha tocado producción (`wtpfrlsbfishvworjdtr`). Aplicar cualquier cambio requiere autorización expresa.

## Qué necesita el CRM

Conjunto mínimo, en este orden. Todas son idempotentes y el conjunto completo se aplica sin error en un PostgreSQL 16 desechable (con la base mínima de `schema.sql` y stubs de `auth`).

| # | Migración | Para qué la necesita el CRM | Riesgo para la web pública |
|---|---|---|---|
| 1 | `20260815_enable_crm_manual_leads` | Alta de leads desde el CRM | Bajo |
| 2 | `20260923_add_lead_funnel_fields` | Campos del embudo (`lead_type`, `zone`, `demo_at`…). Según su cabecera ya existen en producción | Nulo |
| 3 | `20260924_lead_notification_claim` | `demo_requested_at`, que lee el CRM. Cierra el alta directa de `anon` (la web usa `submit_lead`) | **Medio**: cambia permisos de `anon` |
| 4 | `20260925_crm_admin_policies` | `is_crm_admin()` y políticas de administrador. Su cabecera indica que el control ya existe en producción | Bajo |
| 5 | `20260925_public_limits_consent` | Consentimiento con versión, `privacy_review_required`, `consent_events`. Redefine `submit_lead` / `submit_diagnostic` | **Medio**: altera el formulario público |
| 6 | `20260927_retention_erasure` | `crm_erase_contact`, `crm_withdraw_commercial_consent`, `retention_preview` | Bajo (conservación **desactivada**) |
| 7 | `20261029_crm_operativa_preparada` | Tabla `crm_records` con RLS de administrador | Nulo (aditiva) |

**No necesarias para el CRM** (no aplicar con este PR): `20260926_agent_budget`, `20260928_stripe_webhook`, `20260929_checkout_limits`, `20261001_agent_private_lab`, `20261002_agent_public_budget`. Se ha comprobado que ningún archivo del conjunto anterior referencia funciones de esas migraciones.

### Comprobaciones de compatibilidad con la web

- Las versiones de consentimiento que envía la web (`CONSENT_VERSIONS` = `2026-06-04`) coinciden con las activas en `private.consent_versions`.
- `submit_lead` acepta un alta válida con privacidad y consentimiento, y la rechaza con `privacy_required` si no hay aceptación de privacidad (prueba local en PG16).
- El paquete de staging ya superó la integración completa en GitHub Actions (run 41231999471).

## Comprobación previa (solo lectura, la ejecutas tú en producción)

Esta consulta no escribe nada. Indica qué partes del conjunto ya existen:

```sql
select
  to_regprocedure('public.is_crm_admin()') is not null                              as m4_is_crm_admin,
  to_regclass('private.consent_events') is not null                                 as m5_consent_events,
  to_regprocedure('public.submit_lead(jsonb)') is not null                          as m5_submit_lead,
  exists (select 1 from information_schema.columns where table_schema='public' and table_name='leads' and column_name='demo_requested_at')          as m3_demo_requested_at,
  exists (select 1 from information_schema.columns where table_schema='public' and table_name='leads' and column_name='privacy_review_required')   as m5_privacy_review,
  exists (select 1 from information_schema.columns where table_schema='public' and table_name='leads' and column_name='commercial_consent_withdrawn_at') as m6_withdrawn_at,
  to_regprocedure('public.crm_erase_contact(text,text)') is not null                as m6_erase,
  to_regprocedure('public.crm_withdraw_commercial_consent(uuid)') is not null       as m6_withdraw,
  to_regclass('public.crm_records') is not null                                     as m7_crm_records;
```

Regla: si una migración ya está aplicada según esta consulta, **no se vuelve a aplicar**. Si una parte del conjunto falta y otra posterior ya existe, parar y revisar antes de continuar.

Comprobar también el historial de migraciones del proyecto (`supabase_migrations.schema_migrations`, si se usa la CLI), porque puede haber migraciones aplicadas fuera del repositorio.

## Procedimiento (solo tras autorización)

1. Copia de seguridad completa del proyecto y exportación de la copia local del CRM (botón "Exportar copia" en cada navegador que use el CRM).
2. Aplicar **solo** las migraciones que falten, en el orden de la tabla, una a una. Parar ante cualquier error.
3. Comprobar con la consulta anterior que todo queda como se espera.
4. Verificar la web: enviar un diagnóstico y una solicitud de prueba desde el formulario público en un entorno controlado. Confirmar que se guardan y que una solicitud sin aceptación de privacidad se rechaza.
5. Asignar `crm_role = admin` solo a las cuentas que deban usar el CRM.
6. Mantener `retention.enabled = false` hasta la validación jurídica. `retention_run()` no borra nada mientras esté desactivada.

## Reversión

Los scripts `*_down.sql` están en `supabase/rollback/`. Aplicar en orden inverso solo lo que se haya aplicado en esta ronda.

- `20261029_crm_operativa_preparada_down.sql` borra `crm_records` y sus datos. Usarlo solo si la copia exportada cubre esos datos.
- Revertir `20260925_public_limits_consent` restaura el comportamiento anterior del formulario público. Revisar antes el impacto sobre la web.
