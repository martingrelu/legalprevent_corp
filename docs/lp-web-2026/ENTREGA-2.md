# LP-WEB-2026 · Entrega 2 · Implementación

Fecha: 26 de octubre de 2026. Rama: `lp-web-2026/entrega-2`.
Base corporativa: `5406db895286e956e566616966af7d8dd0bdd208`.
Estado: implementación preparada para revisión. Sin PR, fusión ni despliegue.

## Alcance entregado

Ocho páginas originales, con sus ocho espejos generados en inglés:

- `/intelligence/`: datos declarados, catálogo publicado, aplicabilidad, fuentes, reglas versionadas, seguimiento e histórico. Ejemplo sintético identificado; aplicabilidad y cumplimiento se distinguen expresamente.
- `/academy/`: asignación, progreso, evaluación, intentos y acreditación PDF de realización. Consulta previa de disponibilidad.
- `/escudito/`: orientación comercial automatizada, límites, privacidad y contacto humano; separado del asistente interno del SaaS.
- `/recursos/normas/`: índice de guías originales.
- Cuatro fichas: `une-19601`, `iso-37301`, `iso-27001`, `iso-42001` bajo `/recursos/normas/`.

Cabecera con Plataforma y Recursos mediante controles HTML nativos, Partner, Precios y Diagnóstico. Integración en Inicio, Partner y Diagnóstico; bloques de capacidades antes del contacto/cierre comercial de Inicio y Partner. Se mantienen las anclas anteriores. Logotipo, colores e identidad existentes reutilizados; sin fotografía nueva ni imágenes de clientes. Diseño editorial con tarjetas, jerarquía tipográfica y ejemplo textual sintético.

Se reutilizan el contacto y la demostración existentes, el diagnóstico y el acceso a planes/contratación. No se incorporan formularios, servicios, rastreadores ni dependencias. Las páginas nuevas no son una nueva suscripción ni cambian los derechos de acceso.

## Evidencia y decisiones comerciales

Informe de partida leído íntegramente: `LP-WEB-2026-ENTREGA-2.md`, en la carpeta original facilitada por el usuario. La copia original carecía de Git y no contenía todos los archivos de Entrega 1; se clonó el repositorio actual en `entrega-2-workspace`, sin sobreescribirla.

Contraste adicional exclusivamente de lectura en `production-baseline-local/lp-sec-003-workspace`:

| Mensaje | Evidencia | Reserva aplicada |
| --- | --- | --- |
| Evaluación y seguimiento Intelligence | `app/(dashboard)/dashboard/intelligence/page.tsx`, `lib/intelligence/domain.ts` | La ruta contempla activación pendiente y catálogo vacío. No se afirma catálogo activo ni cobertura universal. |
| Datos ausentes y resultados | Estados `APLICABLE`, `NO_APLICABLE`, `PENDIENTE_DATOS` y reglas versionadas en `domain.ts` | Pendiente no significa exención; aplicable no significa cumplido. |
| Acreditación formativa | `lib/training/certificate-domain.ts`, `certificate-service.ts` | Emisión exige asignación completada y resultado registrado. Sin homologación, título oficial ni certificación ISO/UNE. |
| Orientación comercial Escudito | `agent-widget.js`, `supabase/functions/sales-agent/kb.ts` corporativos, e informe de partida | Widget intacto; no se ofrece acceso al expediente, acciones autónomas, disponibilidad permanente ni respuesta inmediata garantizada. |

Capacidades implementadas se describen con disponibilidad sujeta a catálogo y acceso. No se anuncian cursos específicos, horas, bonificación, matrícula inmediata, generación ilimitada o publicación automática de contenidos. No se convierten borradores en oferta activa. No se anuncian desarrollos futuros como operativos.

Siguen sin acreditar una respuesta real del proveedor de IA y la persistencia de una nueva solicitud de demo junto a recepción del aviso interno. No se han intentado cerrar con pruebas reales, credenciales nuevas o infraestructura. Los CTA solicitan contacto; no confirman cita ni plazo de respuesta.

## Guías y fuentes oficiales

Textos divulgativos originales, preguntas propias, edición de referencia, autoría corporativa y fecha de revisión editorial de esta entrega. No se atribuye una revisión jurídica a una persona no acreditada. Las guías no reproducen cláusulas, tablas, anexos ni traducciones del estándar. Tampoco constituyen una implantación, auditoría o evaluación de conformidad.

- UNE 19601:2025: [catálogo UNE](https://www.une.org/encuentra-tu-norma/busca-tu-norma?k=%28i%3A0310002%29) y [artículo oficial UNE sobre la nueva edición](https://revista.une.org/80/nueva-norma-une-de-prevencion-de-delitos.html). El catálogo devolvió 403 al lector automático; la edición se contrastó en la publicación oficial UNE y su referencia comercial AENOR, sin descargar el texto protegido.
- [ISO 37301:2021](https://www.iso.org/standard/75080.html).
- [ISO/IEC 27001:2022](https://www.iso.org/standard/27001).
- [ISO/IEC 42001:2023](https://webstore.iec.ch/en/publication/90574).

Las fichas remiten al documento oficial y sus modificaciones. UNE 19601 conserva el ámbito español también en inglés. ISO 37001, UNE 19602 e ISO 9001 quedan fuera de esta entrega, conforme a la prioridad del informe. No se hacen afirmaciones sobre sus ediciones ni transiciones.

## Validación focalizada

Recorrido: cabecera/Inicio/Partner → páginas y guías ES/EN → diagnóstico, contacto, precios y referencias oficiales. No hay API ni datos nuevos que validar.

- `node --test tests/commercial-pages.test.mjs tests/i18n.test.mjs tests/seo-meta.test.mjs tests/lp-web-delivery.test.mjs`: **21 pruebas superadas**. Enlaces locales y anclas de las 16 páginas nuevas, allowlist, canonical, alternates recíprocos, un H1 por página, metadatos, sitemap, traducción, controles sintéticos de demo y diagnóstico. Las operaciones externas de esas pruebas están sustituidas.
- `node tools/build-i18n.mjs --check`: generación reproducible, sin diferencias.
- `git diff --check`: sin errores.
- Comparación con la base: sección de precios, condiciones Partner y formulario de Inicio idénticos. Los archivos del widget, scripts de formulario, blog, workflows, backend y SaaS no se modifican.
- Navegador local: ocho páginas ES y ocho EN a 390 px y 1280 px, además de Inicio, Partner y Diagnóstico ES; sin desbordamiento horizontal. Inspección visual de Intelligence, Academy y biblioteca, incluyendo guía EN. Cabecera EN comprobada a 768 px. Apertura de Plataforma por teclado en escritorio y recorrido menú móvil → Academy comprobados. Sin errores/avisos en la consola de la vista final de Intelligence.
- Colores principales conservados; texto oscuro sobre blanco y llamadas azules con texto blanco. No se afirma una auditoría completa WCAG ni pruebas en todos los navegadores/dispositivos.
- Evidencias PNG y mediciones guardadas fuera del repositorio en `../entrega-2-evidence/`; no incluidas en la allowlist ni publicadas.

La expectativa antigua del test de sitemap se amplió para incluir las rutas nuevas. No se ejecutó la suite completa, compras, IA real, correo, migraciones ni pruebas de producción. No se acredita recepción de leads ni entrega de mensajes por estas comprobaciones locales.

## Publicación y controles

Se extiende el generador ES/EN existente, el diccionario, sitemap y allowlist únicamente con las 16 páginas públicas. Los documentos internos y pruebas quedan fuera de la allowlist. Se conserva la política existente: el widget se carga en ES y se omite en EN.

El workflow Pages solo publica por push a `main` o ejecución manual. No se modifica el workflow, no se ejecuta manualmente ni se cambia `main`. La autorización de esta entrega comprende commit y push de una única rama; se requiere aprobación posterior antes de abrir PR, fusionar o publicar.

## Archivos incorporados o modificados

- `.github/pages-allowlist.txt`
- `academy/index.html`
- `diagnostico/index.html`
- `docs/lp-web-2026/ENTREGA-2.md`
- `en/academy/index.html`
- `en/diagnostico/index.html`
- `en/escudito/index.html`
- `en/index.html`
- `en/intelligence/index.html`
- `en/partner/index.html`
- `en/recursos/normas/index.html`
- `en/recursos/normas/iso-27001/index.html`
- `en/recursos/normas/iso-37301/index.html`
- `en/recursos/normas/iso-42001/index.html`
- `en/recursos/normas/une-19601/index.html`
- `escudito/index.html`
- `i18n/en-runtime.js`
- `i18n/en.json`
- `index.html`
- `intelligence/index.html`
- `partner/index.html`
- `recursos/normas/index.html`
- `recursos/normas/iso-27001/index.html`
- `recursos/normas/iso-37301/index.html`
- `recursos/normas/iso-42001/index.html`
- `recursos/normas/une-19601/index.html`
- `sitemap.xml`
- `styles.css`
- `tests/commercial-pages.test.mjs`
- `tests/seo-meta.test.mjs`
- `tools/build-i18n.mjs`
