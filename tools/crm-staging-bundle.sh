#!/usr/bin/env bash
# Genera UN solo SQL para staging con el conjunto mínimo del CRM (LP-CRM-002).
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

{
  echo "-- LP-CRM-002 · instalación mínima en STAGING (proyecto $STAGING_REF)."
  echo "-- NO ejecutar en el proyecto de producción. Generado por tools/crm-staging-bundle.sh."
  echo "begin;"
  for f in "${FILES[@]}"; do
    echo ""
    echo "-- ===== $f ====="
    if [ "$f" = "supabase/migrations/20260927_retention_erasure.sql" ]; then
      # Corrección solo en este paquete: en funciones SQL, un parámetro de tipo fila
      # debe referenciarse como (l).columna. La migración original no se toca.
      python3 - "$ROOT/$f" <<'PY'
import sys
src = open(sys.argv[1], encoding="utf-8").read()
old = "greatest(l.created_at, l.updated_at, l.next_action_at, l.demo_at, l.demo_requested_at)"
new = "greatest((l).created_at, (l).updated_at, (l).next_action_at, (l).demo_at, (l).demo_requested_at)"
if src.count(old) != 1:
    sys.exit("La corrección no encaja: revisar la migración antes de generar el paquete.")
sys.stdout.write(src.replace(old, new))
PY
    else
      cat "$ROOT/$f"
    fi
  done
  echo ""
  echo "commit;"
} > "$OUT"

if grep -q "$PRODUCTION_REF" "$OUT"; then
  rm -f "$OUT"
  echo "Abortado: el paquete contiene la referencia de producción." >&2
  exit 1
fi
echo "Generado: $OUT ($(wc -l < "$OUT") líneas)"
