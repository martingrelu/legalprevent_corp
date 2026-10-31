# Agente comercial como copiloto del CRM: propuesta técnica mínima

Estado: propuesta. El agente sigue **privado**, sin acceso nuevo a datos reales, sin acciones automáticas y sin llamadas de pago.

## Punto de partida (verificado en el repositorio)

- `supabase/functions/sales-agent/` atiende el laboratorio privado y el modo público. El modo público está apagado (`public_enabled = false`).
- El proveedor se llama **sin herramientas**. El agente no lee ninguna tabla del CRM: solo usa la base de conocimiento fija de `kb.ts`.
- Las acciones son una lista cerrada de enlaces y formularios (`actions.ts`). Ninguna ejecuta nada en el servidor.
- Hay redacción de datos personales (`redact.ts`), detección de inyección (`guard.ts`) y presupuesto de pruebas.

## Propuesta mínima

1. **Acceso de solo lectura, en el servidor.** Una acción nueva del agente, `resumen_prospecto`, que lee un único registro del CRM con el JWT del administrador que hace la petición. No se da al modelo acceso directo a tablas.
2. **Datos mínimos.** Solo los campos necesarios (empresa, sector, estado, última interacción, próxima acción). Se redactan los datos personales antes de enviarlos al modelo, con `redact.ts`.
3. **Salida sugerida, no ejecutada.** El agente propone una próxima acción o un borrador. Nunca envía, nunca cambia estados y nunca escribe en la base de datos.
4. **Presupuesto y registro.** Reutilizar el presupuesto de pruebas. Cada consulta queda registrada.
5. **Activación.** Solo en el laboratorio privado, con autorización expresa. El modo público no se toca.

## Qué no incluye

- Búsqueda de prospectos ni envío de mensajes.
- Acceso a datos de clientes de pago sin una acción explícita del administrador.
- Nuevos proveedores o dependencias.
