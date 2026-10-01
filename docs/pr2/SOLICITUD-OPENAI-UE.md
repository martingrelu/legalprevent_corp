# Borrador · Solicitud a OpenAI de residencia de datos en la UE

> **Estado:** BORRADOR, no enviado. No se ha cambiado ningún proyecto ni ninguna configuración de OpenAI.
> Revísalo antes de enviarlo. Los campos entre [corchetes] los completas tú.
> **Canal previsto:** formulario de ventas o soporte de OpenAI (platform.openai.com → Help, o el contacto de ventas), con la cuenta de la organización de LegalPrevent.

---

**Asunto:** Solicitud de residencia de datos en Europa (Modified Abuse Monitoring o Zero Data Retention) para un asistente comercial de LegalPrevent

Hola:

Escribo en nombre de LegalPrevent ([razón social], [CIF]), plataforma española de cumplimiento normativo para pymes (legalprevent.com).

**Qué queremos lanzar**
- Un asistente comercial con IA en nuestra web pública.
- Solo en español.
- Responde a preguntas sobre planes, precios publicados, el diagnóstico gratuito y las demos.
- El asistente se identifica como IA.

**Uso técnico**
- Responses API, con `store: false` en todas las peticiones.
- Sin tools, web search, file search ni acceso a datos de clientes.
- Moderación previa con `omni-moderation-latest`.
- Antes de cada envío eliminamos los datos personales (emails, teléfonos, DNI/NIF, IBAN).
- Volumen previsto: bajo. Presupuesto limitado a unos 25 € al mes; las conversaciones son cortas, de un máximo de 400 tokens de salida.
- Modelos que estamos evaluando: `gpt-6-luna`, `gpt-5.6-luna` y `gpt-5.4-mini`.

**Qué solicitamos**
1. Habilitar la residencia de datos en Europa para nuestra organización, para crear un proyecto con región Europa y usar `eu.api.openai.com`.
2. La aprobación de **Modified Abuse Monitoring** o, si procede, **Zero Data Retention** para ese proyecto, según vuestra documentación sobre los requisitos para procesar en la UE.
3. Confirmar qué modelos de la lista anterior están disponibles con residencia europea, y si Moderation también se procesa en la UE.
4. Confirmar si se aplica algún recargo o precio adicional al procesamiento regional en Europa y, en su caso, cuál.
5. Confirmar que podemos firmar o aceptar vuestro Data Processing Addendum (DPA) con cláusulas contractuales tipo como encargado del tratamiento.

**Por qué lo necesitamos**
Somos responsables del tratamiento bajo el RGPD. Los visitantes de nuestra web están en España y queremos que el procesamiento y la retención ocurran en la UE, con la retención mínima posible, antes de abrir el asistente al público.

**Contacto**
- Organización de OpenAI: [ID de organización, formato org-…; no incluyas claves API]
- Persona de contacto: [nombre, cargo]
- Correo: legal@legalprevent.com

Gracias,
[Nombre]
[Cargo] · LegalPrevent

---

## Notas internas (no enviar)

- **Estado actual:** el proyecto actual tiene residencia **Global**, que no se puede cambiar. Por eso la prueba en la UE del 30/09/2026 devolvió 401. Con la aprobación habrá que crear un proyecto **nuevo** con región Europa y una clave nueva. Esa clave la guardas tú en Supabase → Edge Functions → Secrets; yo no la veo.
- **Pasos después de la aprobación (cada uno necesita tu autorización):**
  1. Marcar `eu: true` en los modelos confirmados.
  2. Mantener `region: 'eu'` (ya restaurada el 30/09/2026).
  3. Hacer una prueba controlada con cupo 1.
- **Antes del lanzamiento público:** actualizar la política de privacidad (pendiente de validación jurídica) y mencionar a OpenAI como encargado y la región de procesamiento.
- **ZDR:** no damos por hecho que la tendremos. Si solo aprueban MAM, la documentación debe decir MAM.
