# Runbook de despliegue · PR1b

Contabilidad del agente comercial: consumo, presupuesto mensual con reserva
atómica y eventos anónimos. **No cambia nada visible**: prepara lo que usará la
Edge Function del agente (PR2). Una sola migración.

Todas las comprobaciones de `pr1b-checks.sh` son de solo lectura.

## 0. Preparación
- [ ] `tests/lab/run.sh` en verde en la rama.
- [ ] Revisa <https://status.supabase.com>.
- [ ] `supabase/deploy/pr1b-checks.sh pre` → `todo correcto`.

## 1. Migración y verificación
1. SQL Editor → `supabase/migrations/20260926_agent_budget.sql` → Run (una transacción).
2. SQL Editor → `tests/sql/verify_pr1b_migration.sql` → `OK: verificación PR1b superada`
   (termina en ROLLBACK: no deja datos ni cambia la configuración).
3. `supabase/deploy/pr1b-checks.sh after-migration` → `todo correcto`.
4. Merge del PR en `main` (solo añade migración, pruebas y documentación).

## Configuración inicial (`private.settings`, clave `agent`)

| Parámetro | Valor |
|---|---|
| `monthly_budget_eur` | 25 |
| `alert_thresholds_pct` | 50, 80, 100 (cada aviso una vez al mes) |
| `max_messages_per_session` | 12 (en 24 h) |
| `max_calls_per_day` | 600 (día natural en Madrid) |
| `model` | `gpt-4.1-mini` |
| `price_input_eur_per_mtok` / `price_output_eur_per_mtok` | 0,37 / 1,48 — **provisionales: confirmar con el proyecto de OpenAI antes de PR2** |
| `reservation_ttl_minutes` | 10 |
| `enabled` | true (false → el agente responderá sin IA) |

```sql
-- Cambiar un parámetro (ejemplo: precios reales o apagar el agente)
update private.settings
   set value = value || '{"price_input_eur_per_mtok": 0.37, "price_output_eur_per_mtok": 1.48}'::jsonb,
       updated_at = now()
 where key = 'agent';

-- Consumo del mes (Madrid)
select month, spent_eur, reserved_eur, alerts_sent from private.agent_budget_months order by month desc limit 3;
```

## Recuperación
| Síntoma | Acción |
|---|---|
| La migración da error | No se aplica nada (transacción). Guarda el mensaje. |
| `verify_pr1b` con `FALLO` | `supabase/rollback/20260926_agent_budget_down.sql` (retira las funciones, conserva tablas y configuración). Sin efecto visible: aún no hay agente. |
