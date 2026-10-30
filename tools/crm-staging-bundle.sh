#!/usr/bin/env bash
# Genera UN solo SQL para el proyecto de STAGING con el conjunto mínimo del CRM (LP-CRM-002).
# No toca ninguna base de datos. Las migraciones originales no se modifican.
#   tools/crm-staging-bundle.sh  ->  supabase/staging/crm-staging-install.sql
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/supabase/staging/crm-staging-install.sql"
PRODUCTION_REF="wtpfrlsbfishvworjdtr"
STAGING_REF="ubyopnnfmajmrqhkapjk"

# Orden verificado en un PostgreSQL 16 desechable (ver docs/crm-staging-integracion.md).
FILES=(
  supabase/schema.sql
  supabase/migrations/20260815_enable_crm_manual_leads.sql
  supabase/migrations/20260923_add_lead_funnel_fields.sql
  supabase/migrations/20260924_lead_notification_claim.sql
  supabase/migrations/20260925_crm_admin_policies.sql
  supabase/migrations/20260925_public_limits_consent.sql
  supabase/migrations/20260927_retention_erasure.sql
  supabase/migrations/20261029_crm_operativa_preparada.sql
)

for f in "${FILES[@]}"; do
  [ -f "$ROOT/$f" ] || { echo "Falta $f" >&2; exit 1; }
done

# Guarda: aborta (y revierte toda la transacción) si existe cualquier dato en public o private.
# Solo se permiten las tablas de configuración que las propias migraciones siembran.
GUARD=$(cat <<'SQL'
-- Protección: el paquete solo se instala en un proyecto de staging VACÍO.
do $guard$
declare
  r record;
  n bigint;
  busy text[] := '{}';
begin
  for r in select schemaname, tablename from pg_tables where schemaname in ('public', 'private') loop
    continue when r.schemaname = 'private' and r.tablename in ('settings', 'consent_versions');
    execute format('select count(*) from %I.%I', r.schemaname, r.tablename) into n;
    if n > 0 then
      busy := busy || format('%I.%I (%s filas)', r.schemaname, r.tablename, n);
    end if;
  end loop;
  if array_length(busy, 1) > 0 then
    raise exception 'Protección: la base contiene datos existentes (%). Este paquete solo se instala en un proyecto de staging vacío.', array_to_string(busy, ', ');
  end if;
end
$guard$;
SQL
)

{
  echo "-- LP-CRM-002 · instalación mínima SOLO para el proyecto de staging $STAGING_REF."
  echo "-- No ejecutar en ningún otro proyecto. Generado por tools/crm-staging-bundle.sh."
  echo "begin;"
  echo ""
  echo "$GUARD"
  for f in "${FILES[@]}"; do
    echo ""
    echo "-- ===== $f ====="
    case "$f" in
      supabase/migrations/20260927_retention_erasure.sql)
        # Corrección solo en el paquete: en funciones SQL, un parámetro de tipo fila se referencia (l).columna.
        python3 - "$ROOT/$f" <<'PY'
import sys
src = open(sys.argv[1], encoding="utf-8").read()
old = "greatest(l.created_at, l.updated_at, l.next_action_at, l.demo_at, l.demo_requested_at)"
new = "greatest((l).created_at, (l).updated_at, (l).next_action_at, (l).demo_at, (l).demo_requested_at)"
if src.count(old) != 1:
    sys.exit("La corrección no encaja: revisar la migración antes de generar el paquete.")
sys.stdout.write(src.replace(old, new))
PY
        ;;
      supabase/migrations/20260925_public_limits_consent.sql)
        # Se elimina el backfill de datos históricos (solo tiene sentido en producción).
        python3 - "$ROOT/$f" <<'PY'
import sys
src = open(sys.argv[1], encoding="utf-8").read()
marker = "-- 5. Datos existentes"
end_text = "   and not privacy_review_required;\n"
if src.count(marker) != 1 or src.count(end_text) != 1:
    sys.exit("El bloque de backfill no encaja: revisar la migración antes de generar el paquete.")
idx = src.index(marker)
start = src.rfind("\n-- ----", 0, idx) + 1
end = src.index(end_text) + len(end_text)
sys.stdout.write(src[:start] + "-- Backfill de datos históricos omitido en el paquete de staging.\n" + src[end:])
PY
        ;;
      *)
        cat "$ROOT/$f"
        ;;
    esac
  done
  echo ""
  echo "commit;"
} > "$OUT"

if grep -q "$PRODUCTION_REF" "$OUT"; then
  rm -f "$OUT"
  echo "Abortado: el paquete contiene la referencia de producción." >&2
  exit 1
fi
if [ "$(grep -c "$STAGING_REF" "$OUT")" -lt 1 ]; then
  echo "Abortado: el paquete no identifica el proyecto de staging." >&2
  exit 1
fi
echo "Generado: $OUT ($(wc -l < "$OUT") líneas)"
