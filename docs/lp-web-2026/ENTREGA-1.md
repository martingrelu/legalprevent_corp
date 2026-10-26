# LP-WEB-2026 — Primera entrega preparada

Fecha: 26/10/2026. Base: `7a0959d6a5990db43f9703b5e41e9fd74dc85a9d`.
Rama: `lp-web-2026/entrega-1`. Pendiente de aprobación para cualquier PR, merge o despliegue.

## Cambios

- Inicio ES/EN: se retiran logos de clientes ficticios, testimonios sin acreditación, estadísticas de resultados sin fuente y el bloque de sanciones. Se sustituyen las promesas absolutas del titular, metadatos y proceso por apoyo, orientación y revisión.
- El panel conserva su función ilustrativa y sus valores de ejemplo, identificados visiblemente como datos ficticios. En Partner se sustituyen nombres aparentes de clientes por «Empresa de ejemplo».
- Business deja de anunciar soporte profesional ampliado. Su alcance se remite a consulta, porque la base comercial lo tiene pendiente de definición. La validación jurídica se presenta como servicio adicional de contratación específica.
- Diagnóstico gratuito como CTA principal de Inicio y demo como alternativa. Titulares más compactos. Partner prioriza la gestión de cartera, visibiliza las condiciones temporales y enlaza a las condiciones completas.
- Las solicitudes de demo se crean como «Nuevo», prioridad «Media», sin plan recomendado y con riesgo nulo. Se mantiene `demo_requested` como origen. El CRM reconoce estas solicitudes sin transformarlas en citas.
- El CRM distingue riesgo nulo de riesgo cero, muestra «Sin evaluar» y no asigna 50 por defecto a nuevos contactos o importaciones. Guardar «Demo agendada», también desde el selector rápido o arrastrando una tarjeta, exige una fecha y hora válida introducida por el operador; la fecha no verifica por sí sola la aceptación del invitado.
- Se mantienen los nombres de planes históricos del CRM para no modificar registros previos. No se corrigen datos históricos ni se ejecutan migraciones.
- Se regeneran las páginas EN y el diccionario de ejecución con el generador existente; se renuevan las versiones de caché de los recursos afectados.

## Respaldo de afirmaciones nuevas

Fuente controlada: `supabase/functions/sales-agent/kb.ts` en la revisión base, sin modificaciones.

| Mensaje | Evidencia | Límite |
|---|---|---|
| Apoyo al cumplimiento, obligaciones y documentación | `KB.empresa.que_es` | No garantiza cumplimiento o ausencia de sanciones |
| Resultados orientativos y revisión | `KB.empresa.que_no_es` | No es asesoramiento individualizado |
| Validación jurídica adicional y separada | `KB.empresa.validacion_juridica` | No se publican precios ni se incluye en Business |
| Consultar alcance del soporte Business | `KB.planes[business].nota_interna`, `kbParaModelo()` | Alcance pendiente; no se inventan prestaciones |
| Escudito informa de planes, diagnóstico y Partner | `KB.planes`, `KB.diagnostico`, `KB.partner_fundador_2026`; saludo de `agent-widget.js` | Sin afirmar disponibilidad permanente ni respuesta operativa comprobada |
| Diagnóstico gratuito | `KB.diagnostico` | Orientativo, no auditoría completa |
| El equipo revisa solicitudes de demo y contacta con los próximos pasos | `KB.demo.hechos` | Sin plazo, duración o cita confirmada |
| Gestión de cartera en un entorno | `KB.planes[partner].descripcion` | Condiciones y precios existentes intactos |
| Sin límite numérico hasta 31/12/2026 | `KB.partner_fundador_2026.hechos` y condiciones Partner | Sin prometer condiciones de 2027 |

Las cifras que permanecen en paneles están etiquetadas como ficticias y no se presentan como resultados de clientes. No se añaden afirmaciones sobre Academy, Intelligence, certificaciones ni nuevas capacidades.

## Verificación focalizada

121 pruebas aprobadas, cero fallos, cancelaciones u omisiones. Comando reproducible:

```sh
node --test tests/lp-web-delivery.test.mjs tests/supabase-bridge.test.mjs tests/no-local-lead-storage.test.mjs tests/crm-store.test.mjs tests/i18n.test.mjs tests/seo-meta.test.mjs tests/agent-widget.test.ts tests/sales-agent-public.test.ts tests/sales-agent.test.ts tests/sales-agent-scope.test.ts tests/send-lead-email.test.ts
```

Las seis pruebas nuevas ejercitan el manejador real de envío con transporte sustituido, errores y límite de solicitudes, la semántica CRM y la retirada de contenido no acreditado. Las pruebas existentes cubren consentimientos, transporte del formulario, avisos por identificador, fallo de notificación, separación público/privado de Escudito, alcance comercial, enlaces y SEO/i18n. Todo el transporte de estas pruebas está simulado: no se consulta ni modifica la base real ni se envían emails.

`git diff --check` correcto. Comprobados enlaces internos y recursos de Inicio y Partner ES/EN, existencia de los 41 archivos publicables, condiciones Partner y destinos de contratación idénticos a la base. Sin dependencias ni páginas nuevas. Blog, branding oficial, sitemap, allowlist, workflows, secretos, configuración y backend sin cambios.

Inspección visual local: portada ES y Partner EN en navegador de escritorio. Los estilos adaptativos existentes se mantienen; no se ha realizado una revisión visual independiente en dispositivos móviles.

## Comprobación pública segura y límites

- GET de Inicio, Partner e Inicio EN: HTTP 200.
- Escudito público: botón, apertura, saludo, aviso IA/privacidad y enlace a contacto comprobados en navegador. Abrir no envía conversación.
- OPTIONS de `/functions/v1/sales-agent` y `/functions/v1/smooth-action`: HTTP 204, origen permitido `https://legalprevent.com`, métodos `POST, OPTIONS`.
- No se han enviado preguntas, formularios, altas, compras, notificaciones ni consultas de datos reales. No se ha consumido el proveedor IA.

**Pendiente de acreditación operativa:** respuesta real de IA, alta efectiva de demo y recepción del aviso en el buzón. El saludo y OPTIONS no acreditan estos resultados. Las pruebas simuladas verifican el código y sus errores, no la configuración efectiva del proveedor, RPC o correo de producción. La prueba completa requiere un entorno aislado con datos sintéticos y correo de pruebas, o autorización específica para un recorrido controlado. Esta entrega no modifica producción para habilitarlo.

Si el alta se acepta pero falla el aviso interno, el comportamiento existente conserva la solicitud y confirma su recepción; la prueba cubre este caso. No se promete entrega de email al visitante: el aviso es interno.

## Revisión y aprobación

Revisar el diff desde la base, los textos ES/EN y el límite operativo anterior. Ninguna PR, fusión ni publicación se ha autorizado en esta entrega. El workflow de Pages solo se activa con push a `main` o ejecución manual; preparar la rama no publica el sitio. No ejecutar el workflow manualmente.
