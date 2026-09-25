#!/usr/bin/env bash
# Comprobaciones de despliegue de PR1c (solo lectura: ninguna llamada borra,
# retira consentimientos ni ejecuta la conservación).
#
#   supabase/deploy/pr1c-checks.sh pre              antes
#   supabase/deploy/pr1c-checks.sh after-web        tras publicar la web (CRM)
#   supabase/deploy/pr1c-checks.sh after-migration  tras la migración
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BASE="${PR0_BASE:-https://wtpfrlsbfishvworjdtr.supabase.co}"
SITE="${PR0_SITE:-https://legalprevent.com}"
KEY="${PR0_KEY:-$(grep -oE 'ey[A-Za-z0-9._-]+' "$ROOT/supabase-config.js")}"
fails=0
check() { if [[ "$3" == $2 ]]; then echo "  ✔ $1"; else echo "  ✖ $1 (esperado: $2 · obtenido: ${3:0:160})"; fails=$((fails + 1)); fi; }
rpc() { curl -s -X POST "$BASE/rest/v1/rpc/$1" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d "$2"; }

case "${1:-}" in
  pre)
    echo "== Antes de PR1c"
    check "crm_erase_contact aún no existe" '*PGRST202*' "$(rpc crm_erase_contact '{"p_email":"sonda@example.invalid","p_reason":"sonda"}')"
    "$ROOT/supabase/deploy/pr1b-checks.sh" after-migration >/dev/null && echo "  ✔ PR1a y PR1b siguen correctos" || { echo "  ✖ PR1a/PR1b no están correctos"; fails=$((fails + 1)); }
    ;;
  after-web)
    echo "== Tras publicar la web (GitHub Pages puede tardar unos minutos)"
    for f in supabase-bridge.js crm/index.html crm/src/app.js crm/src/store.js crm/src/styles.css; do
      live="$(curl -s "$SITE/$f?nocache=$RANDOM$RANDOM" | shasum | cut -c1-12)"; head="$(git -C "$ROOT" show "HEAD:$f" | shasum | cut -c1-12)"
      check "web publicada = rama PR1c ($f)" "$head" "$live"
    done
    ;;
  after-migration)
    echo "== Tras la migración de PR1c"
    # anon no tiene permiso: ninguna de estas llamadas llega a ejecutarse.
    check "anon no puede suprimir contactos (42501)" '*42501*' "$(rpc crm_erase_contact '{"p_email":"sonda@example.invalid","p_reason":"sonda"}')"
    check "anon no puede retirar consentimientos (42501)" '*42501*' "$(rpc crm_withdraw_commercial_consent '{"p_lead_id":"00000000-0000-4000-8000-000000000000"}')"
    check "anon no ve la conservación (42501)" '*42501*' "$(rpc retention_preview '{}')"
    check "anon no ejecuta la conservación (42501)" '*42501*' "$(rpc retention_run '{}')"
    "$ROOT/supabase/deploy/pr1b-checks.sh" after-migration >/dev/null && echo "  ✔ PR1a y PR1b siguen correctos" || { echo "  ✖ PR1a/PR1b no están correctos"; fails=$((fails + 1)); }
    echo "  → Ejecuta tests/sql/verify_pr1c_migration.sql en el SQL Editor: debe mostrar 'OK: verificación PR1c superada'."
    ;;
  *) echo "Uso: $0 pre|after-web|after-migration" >&2; exit 2 ;;
esac

echo
if [[ $fails -eq 0 ]]; then echo "RESULTADO: todo correcto"; else echo "RESULTADO: $fails comprobaciones fallidas"; exit 1; fi
