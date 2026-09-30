# Runbook de despliegue · PR2 (agente comercial, SOLO modo privado)

Despliega el laboratorio privado del agente: migración, función `sales-agent`
y página `/crm/#/agente`. **El modo público queda apagado** (`public_enabled =
false`) y, además, la función no tiene modo público en PR2: sin sesión de
administrador del CRM responde 403 antes de reservar presupuesto o llamar a
OpenAI. No hay widget público.

Cada paso requiere autorización expresa. Tú pulsas Run/Deploy; yo preparo y
verifico (huellas SHA-256) y ejecuto las comprobaciones de solo lectura.

## 0. Preparación
- [ ] `tests/lab/run.sh` en verde (85 unitarias + 89 laboratorio).
- [ ] `supabase/deploy/pr2-bundle.sh` → "el paquete supera las pruebas" y anota la SHA-256.
- [ ] `supabase/deploy/pr2-checks.sh pre` → `todo correcto`.
- [ ] Supabase → Edge Functions → Secrets: existen `OPENAI_API_KEY`,
      `AGENT_STATE_SECRET`, `AGENT_PROVIDER` (solo nombres).
- [ ] Decisión de región: opción C (§5).

## 1. Rama y PR
Commit → push → PR (sin merge todavía).

## 2. Migración y verificación
1. SQL Editor → `supabase/migrations/20261001_agent_private_lab.sql` → Run.
2. SQL Editor → `tests/sql/verify_pr2_migration.sql` → `OK: verificación PR2 superada` (ROLLBACK).
3. `supabase/deploy/pr2-checks.sh after-migration` → `todo correcto`.

## 3. Función `sales-agent`
1. Edge Functions → **Deploy a new function → Via Editor**.
2. Nombre: **`sales-agent`**.
3. Sustituir el contenido de `index.ts` por
   `supabase/functions/sales-agent/dist/sales-agent.bundle.js` (un único
   archivo, sin dependencias; comprobaré su SHA-256 en el editor) → Deploy.
4. **Mantener "Verify JWT" ACTIVADO** (por defecto): Supabase rechaza
   peticiones sin JWT y la función exige además rol de administrador.
5. `supabase/deploy/pr2-checks.sh after-function` → `todo correcto`
   (403 otra web, 401 sin JWT, 403 con la clave pública; ninguna llama a OpenAI).

## 4. Web (página privada del CRM)
Merge del PR → GitHub Pages publica `/crm/#/agente` (visible solo con sesión
de administrador; los archivos son estáticos y no contienen secretos) →
`supabase/deploy/web-checks.sh crm/index.html crm/src/app.js crm/src/agent-lab.js supabase-bridge.js`.
La web pública no cambia salvo la versión del conector (`?v=20261001-1`).

## 5. Prueba controlada en la UE (opción C elegida el 30/09/2026)

Estado tras el despliegue: `region = "eu"`, ningún modelo con `eu = true` y
**`real_call_allowance = 0`** → la función no contacta con OpenAI.

La prueba es **un único mensaje** con `gpt-6-luna` en `eu.api.openai.com`, que
produce como máximo dos peticiones: moderación (gratuita) y, si la moderación
responde, la generación (Responses con `store:false`, sin herramientas, JSON
estricto, `reasoning.effort: none`, datos personales redactados).

1. (Autorización expresa) SQL Editor — habilita la UE solo para `gpt-6-luna` y
   concede **un** mensaje real:
   ```sql
   update private.settings
      set value = jsonb_set(jsonb_set(value, '{models,gpt-6-luna,eu}', 'true'), '{real_call_allowance}', '1'),
          updated_at = now()
    where key = 'agent';
   ```
2. CRM → "Agente IA (privado)" → modelo `gpt-6-luna` → un mensaje sin datos
   personales (p. ej. "¿Cuánto cuesta el plan Pyme?").
3. El cupo baja a 0 de forma atómica al reservar: cualquier segundo mensaje
   recibe el fallback `allowance_exhausted` **sin contactar con OpenAI**.
4. Resultado:
   - **UE no habilitada** → fallback `provider_error` con `provider_error:
     {status, code}` en la depuración (moderación o generación). **Fin de la
     prueba**: no hay reintento ni cambio a `global`. Volver a `eu = null`:
     ```sql
     update private.settings set value = jsonb_set(value, '{models,gpt-6-luna,eu}', 'null'), updated_at = now() where key = 'agent';
     ```
   - **Parámetro no admitido** (p. ej. `reasoning.effort`) → `provider_error`
     400 con su código: se corrige y se pide nueva autorización.
   - **Éxito** → `provider: openai`, endpoint UE, tokens reales (entrada,
     caché, salida, razonamiento = 0), coste liquidado; comparar con Usage de
     OpenAI. Parámetros confirmados en la API real.
5. Cualquier llamada adicional (otros modelos, batería) necesita nueva
   autorización y un nuevo cupo (`real_call_allowance`).

## Recuperación
| Síntoma | Acción |
|---|---|
| Impedir cualquier llamada real al instante | `update private.settings set value = jsonb_set(value, '{real_call_allowance}', '0') where key = 'agent';` |
| Apagar el laboratorio al instante | `update private.settings set value = jsonb_set(value, '{preview_enabled}', 'false') where key = 'agent';` |
| Cortar OpenAI sin tocar nada más | Supabase → Secrets → `AGENT_PROVIDER` = `disabled` (todo pasa a fallback) |
| Fuga o sospecha sobre la clave | Revocar en OpenAI → nueva clave → actualizar `OPENAI_API_KEY` |
| La función falla | Borrar la función `sales-agent` (el CRM mostrará un error en la página privada; nada público depende de ella) |
| La migración da error | No se aplica nada (transacción) |
| `verify_pr2` con `FALLO` | `supabase/rollback/20261001_agent_private_lab_down.sql` |
| La página del CRM falla | `git revert -m 1 <merge>` |
