#!/usr/bin/env bash
# Comprobaciones de despliegue de PR1d (solo lectura: ninguna llamada registra
# eventos; al webhook solo se envían peticiones con firma inválida, que rechaza
# antes de tocar la base).
#
#   supabase/deploy/pr1d-checks.sh pre              antes
#   supabase/deploy/pr1d-checks.sh after-migration  tras la migración
#   supabase/deploy/pr1d-checks.sh after-function   tras desplegar stripe-webhook
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BASE="${PR0_BASE:-https://wtpfrlsbfishvworjdtr.supabase.co}"
KEY="${PR0_KEY:-$(grep -oE 'ey[A-Za-z0-9._-]+' "$ROOT/supabase-config.js")}"
fails=0
check() { if [[ "$3" == $2 ]]; then echo "  ✔ $1"; else echo "  ✖ $1 (esperado: $2 · obtenido: ${3:0:160})"; fails=$((fails + 1)); fi; }
rpc() { curl -s -X POST "$BASE/rest/v1/rpc/$1" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d "$2"; }
# Petición sin JWT, como las de Stripe; firma deliberadamente inválida.
webhook() { curl -s -o /dev/null -w '%{http_code}' -X "$1" "$BASE/functions/v1/stripe-webhook" -H "Content-Type: application/json" -H "stripe-signature: t=$(date +%s),v1=$(printf '0%.0s' {1..64})" -d '{"id":"evt_sonda","type":"sonda","created":0}'; }
webhook_body() { curl -s -X POST "$BASE/functions/v1/stripe-webhook" -H "Content-Type: application/json" -H "stripe-signature: t=$(date +%s),v1=$(printf '0%.0s' {1..64})" -d '{"id":"evt_sonda","type":"sonda","created":0}'; }
RECORD_ARGS='{"p_event_id":"evt_sonda","p_type":"sonda","p_created":"2026-01-01T00:00:00Z","p_kind":"ignored","p_row":{}}'

case "${1:-}" in
  pre)
    echo "== Antes de PR1d"
    check "stripe_record_event aún no existe" '*PGRST202*' "$(rpc stripe_record_event "$RECORD_ARGS")"
    check "stripe-webhook aún no existe (404, lo que ve Stripe hoy)" '404' "$(webhook POST)"
    "$ROOT/supabase/deploy/pr1c-checks.sh" after-migration >/dev/null && echo "  ✔ PR1a, PR1b y PR1c siguen correctos" || { echo "  ✖ PR1a/PR1b/PR1c no están correctos"; fails=$((fails + 1)); }
    ;;
  after-migration)
    echo "== Tras la migración de PR1d"
    check "anon no puede registrar eventos de Stripe (42501)" '*42501*' "$(rpc stripe_record_event "$RECORD_ARGS")"
    "$ROOT/supabase/deploy/pr1c-checks.sh" after-migration >/dev/null && echo "  ✔ PR1a, PR1b y PR1c siguen correctos" || { echo "  ✖ PR1a/PR1b/PR1c no están correctos"; fails=$((fails + 1)); }
    echo "  → Ejecuta tests/sql/verify_pr1d_migration.sql en el SQL Editor: debe mostrar 'OK: verificación PR1d superada'."
    ;;
  after-function)
    echo "== Tras desplegar stripe-webhook"
    # 404 = no desplegada · 401 = verify_jwt activado · 500 = falta STRIPE_WEBHOOK_SECRET
    check "responde 400 a una firma inválida (desplegada, sin verify_jwt, con secreto)" '400' "$(webhook POST)"
    check "el 400 es de la función ('Firma no válida')" '*Firma no v*' "$(webhook_body)"
    check "solo acepta POST (405)" '405' "$(webhook GET)"
    ;;
  *) echo "Uso: $0 pre|after-migration|after-function" >&2; exit 2 ;;
esac

echo
if [[ $fails -eq 0 ]]; then echo "RESULTADO: todo correcto"; else echo "RESULTADO: $fails comprobaciones fallidas"; exit 1; fi
