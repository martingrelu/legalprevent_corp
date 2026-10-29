# CRM: migración de tareas, interacciones, propuestas y clientes a Supabase

Estado: **preparado, no ejecutado**. No se ha aplicado ninguna migración sobre producción.

## Qué se prepara

- `supabase/migrations/20261029_crm_operativa_preparada.sql`: tabla `crm_records` con RLS de administrador. Es aditiva y no toca las tablas existentes.
- `supabase/rollback/20261029_crm_operativa_preparada_down.sql`: reversión. Borra la tabla y sus datos, así que solo se usa si no hay datos que no estén en una copia.
- `tools/crm-migracion-simulacion.mjs`: simulación de solo lectura sobre una copia exportada.

## Procedimiento

1. **Copia de seguridad en cada navegador que use el CRM.** Botón "Exportar copia". Guardar el fichero fuera del repositorio.
2. **Simulación.** `node tools/crm-migracion-simulacion.mjs <copia.json>`. Informa de cuántos registros se importarían, de duplicados, identificadores vacíos y relaciones huérfanas. Si `blocking` es `true`, no se continúa.
3. **Staging.** Aplicar la migración en un proyecto de prueba de Supabase. Comprobar que un usuario sin `crm_role = admin` no puede leer ni escribir (`select` debe devolver cero filas).
4. **Importación en staging.** Subir la copia con el importador (pendiente de implementar) y comparar los recuentos con la simulación.
5. **Producción.** Solo con autorización expresa. Repetir los pasos 2 y 4 sobre una copia más reciente del navegador.
6. **Transición.** Durante la transición, `localStorage` sigue siendo la copia de trabajo. No se borra nada local hasta comprobar en Supabase los mismos recuentos.

## Salvaguardas

- Identificadores locales conservados (`local_id`), así que las relaciones no cambian.
- `unique (kind, local_id)`: reimportar no duplica.
- `clearDemoData` y `reset-demo` crean una copia previa antes de actuar y cancelan si no pueden copiarla.
- Si el estado local está dañado, se guarda su contenido en una clave aparte antes de reemplazarlo, y el guardado queda bloqueado mientras tanto.

## Pendiente antes de producción

- Importador desde la copia exportada.
- Sincronización de escrituras del CRM hacia `crm_records`.
- Pruebas de RLS contra un proyecto de prueba (no se han ejecutado).
