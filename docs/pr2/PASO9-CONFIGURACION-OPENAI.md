# PR2 · Paso 9 (preparación): configuración de OpenAI y secretos

Lo hacéis vosotros en los paneles de OpenAI y Supabase. **Ninguna clave pasa por
el chat, por la terminal compartida ni por el repositorio.** No se hace ninguna
llamada real a OpenAI hasta autorizar la implementación del proveedor.

Referencias oficiales (consultadas el 30/09/2026): guías "Production best
practices", "Spend limits", "API Platform permissions (RBAC)", "Your data" y
"Moderation" de developers.openai.com.

## 0. Requisito previo: facturación de la organización

platform.openai.com → **Settings → Organization → Billing**: la organización
necesita un método de pago o saldo prepago. Para las pruebas basta un saldo
pequeño (p. ej. 10 $). Sin saldo, las llamadas fallarían (el agente respondería
con el fallback, sin coste).

## 1. Crear el proyecto `legalprevent-sales-agent`

1. platform.openai.com → selector de proyecto (arriba a la izquierda) →
   **Create project**.
2. Nombre: `legalprevent-sales-agent`.
3. **Región / geografía**: si al crear el proyecto aparece un campo de región,
   elegid **Europe** (EU). Si no aparece, la organización no tiene la residencia
   de datos habilitada (ver apartado 3); cread el proyecto igualmente y
   anotadlo.
4. Create.

## 2. Límite de gasto bajo para las pruebas

En el proyecto nuevo → **Settings (del proyecto) → Limits**:
1. **Spend → Edit spend limit** → **Monthly spend limit: 10 $** → activar
   **Enforce a hard limit** → Save. Al alcanzarlo, OpenAI responde 429
   (`project_spend_limit_exceeded`) y nuestro agente pasa al fallback.
   OpenAI advierte que el corte no es instantáneo: puede excederse ligeramente.
   Por eso mantenemos además nuestro límite interno de **5 €** en PostgreSQL.
2. Si existe una alerta de gasto, fijadla en **5 $**.
3. Si el proyecto permite restringir modelos (**Model usage / Allowed models**),
   permitid solo: `gpt-5.4-mini`, `gpt-5.6-luna`, `gpt-6-luna` y
   **`omni-moderation-latest`** (la moderación es gratuita pero usa ese modelo;
   si no se permite, el agente caería siempre al fallback).

## 3. Comprobar opciones reales de región UE y retención

Solo lectura; anotad lo que veáis y me lo contáis (sin capturas de claves):

1. **Residencia UE** — ¿apareció el campo de región al crear el proyecto y se
   pudo elegir Europe? Según OpenAI: se solicita a ventas
   (openai.com/contact-sales); para regiones fuera de EE. UU. exige aprobación
   de controles de abuso (Modified Abuse Monitoring o Zero Data Retention) y
   firmar una enmienda de retención; cuesta un 10 % más en modelos publicados
   desde el 5/03/2026; las peticiones van a `eu.api.openai.com`.
2. **Retención** → **Settings → Organization → Data controls** (o "Data
   retention"): ¿qué estado muestra? Por defecto: sin entrenamiento con datos de
   la API y registros de abuso hasta 30 días. "Zero Data Retention" o "Modified
   Abuse Monitoring" solo aparecen si OpenAI los ha aprobado.
3. **Compartir datos** → en la misma sección, comprobad que **no** está activada
   ninguna opción para compartir entradas/salidas con OpenAI (programas de
   mejora de modelos). Si lo está, desactivadla para la organización o el proyecto.
4. Si queréis la UE o ZDR: formulario de ventas de OpenAI indicando
   "EU data residency + Modified Abuse Monitoring (or ZDR) for project
   legalprevent-sales-agent (B2B sales assistant, Spain)". No bloquea las
   pruebas privadas si autorizáis `region = "global"` solo para el laboratorio.

Nuestra configuración: `private.settings.agent.region = "eu"` y
`models.<modelo>.eu = null`. Con eso la función **no llamará** a OpenAI hasta que
marquemos qué modelos tienen UE confirmada, o hasta que autoricéis `global`
para el modo privado. No hay cambio silencioso de región.

## 4. API key con el mínimo de permisos

En el proyecto → **API keys → Create new secret key**:
1. **Owned by**: *Service account* (la clave no depende de una persona), nombre
   `sales-agent-supabase`. Si solo existe la opción de usuario, vale.
2. **Project**: `legalprevent-sales-agent`.
3. **Permissions: Restricted**, y solo:
   - **Responses API** (`/v1/responses`): **Write**.
   - **Model capabilities** (incluye `/v1/moderations`): **Request** / Write.
   - Todo lo demás: **None**.
4. **Expiración**: 90 días, si el panel lo permite (rotación prevista).
5. Create → se muestra **una sola vez**: copiadla y pasad directamente al
   apartado 5. No la peguéis en ningún otro sitio.

Si más adelante una llamada devuelve un error de permisos insuficientes, lo
veremos en el panel de depuración (fallback `provider_error`) y ajustaremos el
permiso concreto.

## 5. Guardar los tres secretos en Supabase

Supabase → proyecto **legalprevent_corp** → **Edge Functions → Secrets → Add
new secret** (uno por uno):

| Nombre | Valor | Cómo obtenerlo sin exponerlo |
|---|---|---|
| `OPENAI_API_KEY` | La clave del apartado 4 | Pegar directamente desde el diálogo de OpenAI |
| `AGENT_STATE_SECRET` | Aleatorio de ≥ 48 bytes | En la app **Terminal de macOS** (no la terminal compartida de esta sesión): `openssl rand -base64 48 \| tr -d '\n' \| pbcopy` — no muestra nada; queda en el portapapeles → pegar en Supabase |
| `AGENT_PROVIDER` | `openai` | Texto literal |

Después:
1. Vaciad el portapapeles copiando cualquier otro texto.
2. Decidme "secretos guardados". Yo comprobaré en Supabase **solo** que los tres
   nombres existen y su fecha (el panel muestra una huella, nunca el valor).
3. Con el código actual, `AGENT_PROVIDER=openai` no llama a nadie: el proveedor
   real no existe todavía y la función `sales-agent` ni siquiera está
   desplegada.

## 6. Siguiente paso (requiere vuestra autorización expresa)

Implementar el proveedor real (Responses API con `store:false`, sin
herramientas, salida JSON estricta, `max_output_tokens`, timeout y moderación),
con pruebas que no llaman a OpenAI; después despliegue controlado como en PR1 y
primera conversación privada vuestra.

## En caso de fuga de la clave

platform.openai.com → proyecto → **API keys** → revocar la clave → crear otra
→ actualizar `OPENAI_API_KEY` en Supabase. El límite duro del proyecto y
nuestro límite de 5 € acotan el daño mientras tanto.
