#!/usr/bin/env bash
# Verificación local de la migración crm_records (LP-CRM-002) en un clúster
# PostgreSQL desechable. No usa Supabase, producción ni credenciales reales.
#
#   tests/lab/crm-operativa-rls.sh
#
# Requiere initdb/pg_ctl/psql de PostgreSQL 16 (en Ubuntu: /usr/lib/postgresql/16/bin).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
PSQL="${PSQL:-psql}"
WORK="${LAB_WORK:-${SCRATCH:-$(mktemp -d)}}/crm-rls-$$"
PORT="${LAB_PG_PORT:-55499}"
DATA="$WORK/data"
SOCK="$WORK"

mkdir -p "$WORK"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" -m immediate stop >/dev/null 2>&1 || true; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres --auth=trust >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $SOCK -c listen_addresses=''" -w -l "$WORK/pg.log" start >/dev/null

run() { "$PSQL" -X -q -v ON_ERROR_STOP=1 -h "$SOCK" -p "$PORT" -U postgres -d lab "$@"; }
as_role() { # as_role <rol> <claims-json> <sql>
  local role="$1" claims="$2" sql="$3"
  run -c "begin; set local role $role; select set_config('request.jwt.claims', '$claims', true); $sql; commit;"
}
expect_fail() { # expect_fail <descripcion> <rol> <claims> <sql>
  local desc="$1"; shift
  if as_role "$@" >/dev/null 2>&1; then
    echo "FALLO: se esperaba rechazo ($desc)"; exit 1
  fi
  echo "ok: rechazado ($desc)"
}
expect_ok() { # expect_ok <descripcion> <rol> <claims> <sql>
  local desc="$1"; shift
  as_role "$@" >/dev/null || { echo "FALLO: se esperaba éxito ($desc)"; exit 1; }
  echo "ok: permitido ($desc)"
}
count_as() { # count_as <rol> <claims> <sql-consulta>
  local role="$1" claims="$2" sql="$3"
  "$PSQL" -X -A -t -v ON_ERROR_STOP=1 -h "$SOCK" -p "$PORT" -U postgres -d lab \
    -c "set role $role; select set_config('request.jwt.claims', '$claims', false); $sql" | tail -1
}

ADMIN='{"app_metadata":{"crm_role":"admin"}}'
SALES='{"app_metadata":{"crm_role":"sales"}}'
NOROLE='{"sub":"x"}'

# Base de datos y entorno parecido a Supabase.
"$PSQL" -X -q -h "$SOCK" -p "$PORT" -U postgres -d postgres -c "create database lab;"
run -f "$ROOT/tests/lab/sql/00_roles.sql" 2>/dev/null || true
run -f "$ROOT/tests/lab/sql/02_auth.sql"
run -c "alter default privileges in schema public grant all on tables to anon, authenticated, service_role;"
run -c "grant usage on schema public to anon, authenticated, service_role;"
# is_crm_admin() exactamente como en producción (20260925_crm_admin_policies.sql).
run -c "create or replace function public.is_crm_admin() returns boolean language sql stable as \$\$ select coalesce((auth.jwt() -> 'app_metadata' ->> 'crm_role') = 'admin', false) \$\$;"

run -f "$ROOT/supabase/migrations/20261029_crm_operativa_preparada.sql"
echo "migración aplicada en base desechable"

# Anónimo: sin acceso.
expect_fail "anon lee" anon "$NOROLE" "select count(*) from public.crm_records"
expect_fail "anon inserta" anon "$NOROLE" "insert into public.crm_records (kind, local_id) values ('task','t-anon')"

# Usuario autenticado sin rol CRM: filas invisibles y escritura rechazada.
run -c "insert into public.crm_records (kind, local_id, payload) values ('client','c-real-1','{\"businessName\":\"Real SL\"}');"
n=$(count_as authenticated "$NOROLE" "select count(*) from public.crm_records")
[ "$n" = "0" ] || { echo "FALLO: sin rol ve $n filas"; exit 1; }
echo "ok: autenticado sin rol no ve filas"
expect_fail "autenticado sin rol inserta" authenticated "$NOROLE" "insert into public.crm_records (kind, local_id) values ('task','t-x')"

# Rol de ventas no es administrador: sin acceso.
n=$(count_as authenticated "$SALES" "select count(*) from public.crm_records")
[ "$n" = "0" ] || { echo "FALLO: rol sales ve $n filas"; exit 1; }
echo "ok: rol sales no ve filas"

# Administrador: lectura, escritura, upsert sin duplicados.
n=$(count_as authenticated "$ADMIN" "select count(*) from public.crm_records")
[ "$n" = "1" ] || { echo "FALLO: admin debería ver 1 fila y ve $n"; exit 1; }
echo "ok: admin ve sus registros"
expect_ok "admin inserta tarea" authenticated "$ADMIN" "insert into public.crm_records (kind, local_id, related_type, related_id, payload) values ('task','t-1','client','c-real-1','{\"title\":\"Llamar\"}')"
expect_ok "admin upsert idempotente" authenticated "$ADMIN" "insert into public.crm_records (kind, local_id, payload) values ('task','t-1','{\"title\":\"Llamar hoy\"}') on conflict (kind, local_id) do update set payload = excluded.payload, updated_at = now()"
expect_ok "admin importación sin sobrescribir (ignore-duplicates)" authenticated "$ADMIN" "insert into public.crm_records (kind, local_id, payload) values ('task','t-1','{\"title\":\"Copia antigua\"}') on conflict (kind, local_id) do nothing"
t=$(count_as authenticated "$ADMIN" "select payload->>'title' from public.crm_records where kind='task' and local_id='t-1'")
[ "$t" = "Llamar hoy" ] || { echo "FALLO: la importación sobrescribió un registro existente ($t)"; exit 1; }
echo "ok: la importación no sobrescribe registros existentes"
expect_fail "duplicado sin upsert" authenticated "$ADMIN" "insert into public.crm_records (kind, local_id) values ('task','t-1')"
expect_fail "tipo no permitido" authenticated "$ADMIN" "insert into public.crm_records (kind, local_id) values ('lead','l-1')"

echo "RESULTADO: todas las comprobaciones de RLS pasan"
