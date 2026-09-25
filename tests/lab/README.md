# Laboratorio local (PR0, PR1)

Reproduce en local, sin tocar producción, el entorno de captación de leads:

- **Postgres 17** (como producción) con los roles y privilegios por defecto de Supabase
  (`anon`, `authenticated`, `service_role`, `authenticator`).
- **Dos bases**: `lab_old` (esquema publicado en `origin/main` más los cambios
  que ya existen en producción y aún no estaban en el repositorio —`PROD_DRIFT`
  en `run.sh`—: reproduce producción) y `lab` (`lab_old` + las migraciones de la
  rama). Comparado con el inventario real (`supabase/deploy/pr1-inventory.sql`):
  0 diferencias en tablas, permisos, políticas y funciones.
- **`auth.jwt()` emulado** (`sql/02_auth.sql`): las políticas "CRM admin" y
  `is_crm_admin()` se comportan como en producción (`app_metadata.crm_role`).
- **PostgREST** para cada base, como la API REST de Supabase.
- **Gateway** con las mismas URLs que Supabase (`/rest/v1`, `/functions/v1/smooth-action`)
  que ejecuta la función nueva (del repo) o la publicada (del git ref), y un
  **Resend simulado** con idempotencia que registra los emails en lugar de enviarlos.

## Requisitos

- Docker en marcha.
- Node.js ≥ 22.6 (ejecuta TypeScript sin compilar).
- `git fetch` reciente: la versión publicada se toma de `origin/main`.

## Uso

```bash
tests/lab/run.sh
```

Reconstruye todo desde cero (elimina contenedores anteriores), ejecuta las
pruebas unitarias y las del laboratorio y lo elimina al terminar. Sale con
error si alguna prueba falla.

```bash
tests/lab/run.sh --serve
```

Igual, pero deja el entorno en marcha para probar en el navegador:

- Web nueva: <http://127.0.0.1:8766/> · Web publicada: <http://127.0.0.1:8767/>
  (su `supabase-config.js` apunta al gateway local).
- Cambiar de escenario: `http://127.0.0.1:54321/__lab/mode?fn=new|published&db=new|old&resend=ok|fail500|accept-then-timeout&cap=20`
- Ver los emails simulados: `http://127.0.0.1:54321/__lab/emails`
- CRM: abre `/crm/` e introduce en la consola del navegador una sesión de
  laboratorio (`sessionStorage.setItem("lp_supabase_session", ...)`) con un
  JWT `authenticated` firmado con el `LAB_JWT_SECRET` de esa ejecución.

```bash
tests/lab/run.sh --down
```

Elimina contenedores y red.

## Qué se prueba

| Fichero | Contenido |
|---|---|
| `sql.lab.mjs` | Verificadores de PR0 y PR1a (sobre la réplica de producción) y de la rama, migraciones reaplicables, 6 mutaciones de seguridad que el verificador debe detectar y matriz de permisos de `anon`/`authenticated`. |
| `limits.lab.mjs` | Límites de altas públicas con 100 peticiones simultáneas: por email, global, cierre de emergencia, por IP (incluida la cabecera falseada), sin IP configurada y sin datos parciales al rechazar. |
| `concurrency.lab.mjs` | Avisos internos: reclamaciones simultáneas, tope horario (y prueba de que sin advisory lock se supera), sesiones `psql` independientes, idempotencia ante fallos de Resend, plazos, CORS y destinatarios arbitrarios. |
| `flows.lab.mjs` | Web nueva: demo con/sin comunicaciones comerciales, diagnóstico + demo sobre el mismo lead, privacidad obligatoria, nada en el navegador. |
| `compat.lab.mjs` | Web publicada contra la base de la rama, límite superado con la web antigua y la nueva, web nueva sobre la base sin migrar (orden de despliegue) y rollback con reaplicación. |
| `crm.lab.mjs` | CRM nuevo y publicado con usuario administrador: sincronización, edición sin alterar consentimiento ni avisos, alta manual; usuario sin rol: sin acceso. |
| `budget.lab.mjs` | Contabilidad del agente (PR1b): 200 reservas simultáneas sin superar el presupuesto (y prueba de que sin advisory lock se supera), liquidaciones y liberaciones concurrentes al céntimo, alertas únicas, límites por sesión y por día, apagado, permisos y eventos sin datos personales. |
| `privacy.lab.mjs` | PR1c de extremo a extremo con el CRM real: supresión (leads, diagnósticos y consentimientos, registro sin email), usuario sin rol, retirada del consentimiento, vista previa y ejecución de la conservación, CRM publicado. |
| `stripe.lab.mjs` | Webhook (service role) sigue escribiendo; `anon` sin acceso; el CRM administrador solo lee. |

Con `--serve` también se pueden ensayar las comprobaciones de despliegue
(`supabase/deploy/pr0-checks.sh`) en cada estado, cambiando el escenario con
`/__lab/mode` (la salida de `--serve` indica la orden exacta).

## Limitaciones

- Es una emulación de Supabase: no incluye GoTrue (auth), el runtime Deno de
  Edge Functions ni el pooler. La función se ejecuta con Node usando las
  mismas APIs web estándar.
- Resend está simulado según su semántica de idempotencia documentada.
- Los flujos de pantalla (formularios, botones) de `script.js` y
  `diagnostico.js` se prueban a mano con `--serve`; las pruebas automáticas
  reproducen los datos exactos que esos scripts envían al bridge.

## Seguridad

No contiene credenciales: el secreto JWT y la contraseña de Postgres se
generan al azar en cada ejecución, los contenedores solo escuchan en
`127.0.0.1` y los datos de prueba usan dominios `example.com` / `lab.invalid`.
