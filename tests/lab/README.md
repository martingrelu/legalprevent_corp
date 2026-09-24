# Laboratorio local de PR0

Reproduce en local, sin tocar producción, el entorno de captación de leads:

- **Postgres 17** (como producción) con los roles y privilegios por defecto de Supabase
  (`anon`, `authenticated`, `service_role`, `authenticator`).
- **Dos bases**: `lab_old` (esquema publicado, igual que producción antes de
  PR0) y `lab` (esquema publicado + migración de PR0).
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
| `sql.lab.mjs` | Migración reaplicable, `tests/sql/verify_pr0_migration.sql` (10 bloques), 4 mutaciones de seguridad que el verificador debe detectar y permisos efectivos de `anon`. |
| `concurrency.lab.mjs` | Reclamaciones simultáneas, tope horario con peticiones concurrentes (y prueba de que sin el advisory lock se supera), sesiones `psql` independientes, idempotencia ante fallos de Resend, plazos, CORS y destinatarios arbitrarios. |
| `flows.lab.mjs` | Web nueva: demo con/sin comunicaciones comerciales, diagnóstico + demo sobre el mismo lead, privacidad obligatoria, nada en el navegador. |
| `compat.lab.mjs` | Web y función publicadas: línea base (vulnerabilidad reproducida), despliegue paso a paso en el orden recomendado, compatibilidad temporal del diagnóstico y rollback con reaplicación. |
| `crm.lab.mjs` | CRM nuevo y publicado: sincronización, edición de un lead web sin alterar los campos de PR0 y alta manual. |

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
