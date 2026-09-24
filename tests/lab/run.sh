#!/usr/bin/env bash
# Laboratorio local de PR0: reconstruye desde cero Postgres + PostgREST con los
# roles y privilegios por defecto de Supabase, aplica el esquema publicado y la
# migración de PR0, y ejecuta todas las pruebas.
#
#   tests/lab/run.sh            reconstruye, prueba y lo detiene todo
#   tests/lab/run.sh --serve    además deja el entorno y las dos webs en marcha
#                               para pruebas manuales en el navegador
#   tests/lab/run.sh --down     elimina contenedores y red del laboratorio
#
# Variables opcionales: PUBLISHED_REF (git ref publicado, por defecto
# origin/main), LAB_PG_PORT, LAB_REST_PORT, LAB_REST_OLD_PORT, LAB_GATEWAY_PORT.
# No usa ni necesita credenciales reales: nada sale de 127.0.0.1.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LAB="$ROOT/tests/lab"
PUBLISHED_REF="${PUBLISHED_REF:-origin/main}"
# Misma versión mayor que producción (PostgreSQL 17.6, captura previa del 2026-09-24).
PG_IMAGE="${LAB_PG_IMAGE:-postgres:17-alpine}"
REST_IMAGE="postgrest/postgrest:v12.2.3"
NET="lp-lab"
PG="lp-lab-pg"
export LAB_PG_CONTAINER="$PG"
export LAB_PG_PORT="${LAB_PG_PORT:-55432}"
export LAB_REST_PORT="${LAB_REST_PORT:-53000}"
export LAB_REST_OLD_PORT="${LAB_REST_OLD_PORT:-53001}"
export LAB_GATEWAY_PORT="${LAB_GATEWAY_PORT:-54321}"

down() {
  docker rm -f "$PG" lp-lab-rest lp-lab-rest-old >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
if [[ "${1:-}" == "--down" ]]; then down; echo "Laboratorio eliminado."; exit 0; fi

command -v docker >/dev/null || { echo "Falta Docker." >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker no está en marcha." >&2; exit 1; }
command -v node >/dev/null || { echo "Falta Node.js (>= 22.6)." >&2; exit 1; }

WORK="$(mktemp -d)"
GATEWAY_PID=""
cleanup() {
  [[ -n "$GATEWAY_PID" ]] && kill "$GATEWAY_PID" 2>/dev/null || true
  rm -rf "$WORK"
  [[ "${SERVE:-0}" == "1" ]] || down
}
trap cleanup EXIT
SERVE=0; [[ "${1:-}" == "--serve" ]] && SERVE=1

# Secreto JWT aleatorio y efímero (solo para este laboratorio).
export LAB_JWT_SECRET="$(openssl rand -hex 32)"

echo "== Reconstruyendo el laboratorio desde cero"
down
docker network create "$NET" >/dev/null
docker run -d --name "$PG" --network "$NET" -e POSTGRES_PASSWORD="$(openssl rand -hex 16)" \
  -p "127.0.0.1:$LAB_PG_PORT:5432" "$PG_IMAGE" >/dev/null
for _ in $(seq 1 60); do docker exec "$PG" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
sleep 2

psql_run() { docker exec -i "$PG" psql -U postgres -d "$1" -v ON_ERROR_STOP=1 -q >/dev/null; }

echo "== Web y función publicadas ($PUBLISHED_REF)"
git -C "$ROOT" rev-parse --verify -q "$PUBLISHED_REF" >/dev/null || { echo "No existe $PUBLISHED_REF (haz git fetch)." >&2; exit 1; }
mkdir -p "$WORK/published"
git -C "$ROOT" archive "$PUBLISHED_REF" | tar -x -C "$WORK/published"
export LAB_PUBLISHED_DIR="$WORK/published"
cp "$WORK/published/supabase/functions/send-lead-email/index.ts" "$WORK/published-function.ts"
export LAB_PUBLISHED_FUNCTION="$WORK/published-function.ts"
export LAB_NEW_FUNCTION="$ROOT/supabase/functions/send-lead-email/index.ts"

# Cambios que ya existen en producción pero se incorporan al repositorio
# después (inventario del 2026-09-24): se aplican también a lab_old para que
# reproduzca producción fielmente.
PROD_DRIFT=("20260925_crm_admin_policies.sql")

echo "== Bases de datos: lab_old (producción actual) y lab (producción + rama)"
psql_run postgres < "$LAB/sql/00_roles.sql"
for db in lab_old lab; do
  docker exec "$PG" psql -U postgres -qc "create database $db" >/dev/null
  psql_run "$db" < "$LAB/sql/01_db_privileges.sql"
  psql_run "$db" < "$LAB/sql/02_auth.sql"
  psql_run "$db" < "$WORK/published/supabase/schema.sql"
  psql_run "$db" < "$WORK/published/supabase/stripe-schema.sql"
  for m in "$WORK/published/supabase/migrations/"*.sql; do psql_run "$db" < "$m"; done
  for m in "${PROD_DRIFT[@]}"; do psql_run "$db" < "$ROOT/supabase/migrations/$m"; done
done
# lab: además, las migraciones de la rama que aún no están publicadas.
for m in "$ROOT/supabase/migrations/"*.sql; do
  name="$(basename "$m")"
  [[ -e "$WORK/published/supabase/migrations/$name" ]] && continue
  [[ " ${PROD_DRIFT[*]} " == *" $name "* ]] && continue
  echo "   + $name"
  psql_run lab < "$m"
done

echo "== PostgREST"
for pair in "lp-lab-rest:lab:$LAB_REST_PORT" "lp-lab-rest-old:lab_old:$LAB_REST_OLD_PORT"; do
  IFS=: read -r name db port <<<"$pair"
  docker run -d --name "$name" --network "$NET" -p "127.0.0.1:$port:3000" \
    -e PGRST_DB_URI="postgres://authenticator:authenticator-lab@$PG:5432/$db" \
    -e PGRST_DB_SCHEMAS=public -e PGRST_DB_ANON_ROLE=anon -e PGRST_DB_POOL=20 \
    -e PGRST_JWT_SECRET="$LAB_JWT_SECRET" "$REST_IMAGE" >/dev/null
done
for port in "$LAB_REST_PORT" "$LAB_REST_OLD_PORT"; do
  for _ in $(seq 1 30); do curl -s -o /dev/null "http://127.0.0.1:$port/" && break; sleep 1; done
done

echo "== Gateway"
if [[ "$SERVE" == "1" ]]; then
  export LAB_SITES="[{\"port\":8766,\"dir\":\"$ROOT\"},{\"port\":8767,\"dir\":\"$WORK/published\"}]"
fi
node "$LAB/gateway.mjs" &
GATEWAY_PID=$!
for _ in $(seq 1 30); do curl -s -o /dev/null "http://127.0.0.1:$LAB_GATEWAY_PORT/__lab/mode" && break; sleep 0.5; done

echo "== Pruebas unitarias"
(cd "$ROOT" && node --test tests/*.test.ts tests/*.test.mjs)

echo "== Pruebas del laboratorio"
(cd "$ROOT" && node --test --test-concurrency=1 tests/lab/*.lab.mjs)

if [[ "$SERVE" == "1" ]]; then
  echo
  echo "Laboratorio en marcha (Ctrl+C para detenerlo):"
  echo "  web nueva:     http://127.0.0.1:8766/"
  echo "  web publicada: http://127.0.0.1:8767/"
  echo "  escenario:     http://127.0.0.1:$LAB_GATEWAY_PORT/__lab/mode?fn=new|published&db=new|old"
  echo "  emails:        http://127.0.0.1:$LAB_GATEWAY_PORT/__lab/emails"
  echo
  echo "JWT efímeros de esta ejecución (solo válidos en este laboratorio):"
  (cd "$LAB" && node -e 'import("./jwt.mjs").then((j) => console.log(`  anon:          ${j.ANON}\n  authenticated: ${j.AUTHENTICATED}`))')
  echo
  echo "Comprobaciones de despliegue contra el laboratorio:"
  echo "  PR0_BASE=http://127.0.0.1:$LAB_GATEWAY_PORT PR0_SITE=http://127.0.0.1:8766 PR0_KEY=<anon> supabase/deploy/pr0-checks.sh after-migration"
  wait "$GATEWAY_PID"
fi
