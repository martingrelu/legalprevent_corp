# LegalPrevent CRM interno

CRM interno para gestionar leads, clientes, demos, oportunidades, tareas, propuestas, pagos, documentos, interacciones y actividad comercial de LegalPrevent.

## Como abrirlo

Abre `index.html` en el navegador. La aplicacion no necesita instalacion ni servidor: usa JavaScript modular, CSS y persistencia en `localStorage`.

## Que incluye

- Dashboard CRM con metricas, alertas, leads calientes, tareas y grafico simple.
- Gestion de leads con busqueda, filtros, validacion y formulario.
- Pipeline Kanban con drag and drop y selector de estado.
- Ficha individual de lead con historial, notas, tareas, documentos, propuestas y conversion a cliente.
- Gestion y ficha de clientes con datos fiscales, plan, pagos, documentos y revision legal.
- Sistema de tareas con vencimiento automatico.
- Registro de interacciones: llamadas, emails, WhatsApps, reuniones, demos, notas, propuestas y cambios de estado.
- Propuestas comerciales con estados y conversion automatica si se aceptan.
- Roles simulados: Administrador, Comercial, Abogado/Revisor y Soporte.
- Modelos de datos documentados dentro de la vista "Modelo y permisos".
- Datos demo: 10 leads, 5 clientes, 10 tareas, 10 interacciones y 5 propuestas.

## Automatizaciones internas

La capa de estado ejecuta estas reglas al iniciar y al guardar cambios:

- Marca tareas vencidas si la fecha limite ya paso y no estan completadas.
- Alerta si un lead lleva mas de 7 dias sin seguimiento.
- Alerta si una demo fue realizada y no hay propuesta enviada.
- Alerta si un cliente Premium tiene revision legal pendiente.
- Muestra leads calientes segun prioridad, fase, riesgo, valor estimado y actividad reciente.
- Muestra clientes con pagos pendientes o fallidos.

## Seguridad y RGPD

Esta primera version es frontend/local, pero deja preparada la estructura para backend:

- Validacion de campos clave.
- Sanitizacion basica de textos antes de guardar.
- Control de acceso por permisos de rol.
- Registro de actividad interna.
- Separacion clara de modelos para auditoria, documentos, pagos y notas.
- Preparada para incorporar consentimiento, retencion, exportacion y borrado de datos al conectarla a una base real.

## Integraciones futuras

La arquitectura deja puntos claros para conectar:

- Email.
- WhatsApp Business.
- Stripe.
- Calendario.
- Generacion de propuestas en PDF.
- IA para resumen de llamadas o notas.
- IA para scoring de leads.
- Firma electronica.

## Archivos principales

- `src/models.js`: catalogos, roles y esquema de modelos.
- `src/demoData.js`: datos iniciales realistas.
- `src/store.js`: persistencia, validaciones, permisos, automatizaciones y operaciones de negocio.
- `src/app.js`: vistas, formularios, eventos y navegacion.
- `src/styles.css`: sistema visual responsive.
