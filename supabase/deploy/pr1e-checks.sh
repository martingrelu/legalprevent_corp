#!/usr/bin/env bash
# Comprobaciones de despliegue de PR1e. Ninguna crea sesiones de pago: al
# checkout solo se envían preflights (OPTIONS) y un plan inexistente, que se
# rechaza antes de consultar límites o llamar a Stripe.
#
#   supabase/deploy/pr1e-checks.sh pre              antes
#   supabase/deploy/pr1e-checks.sh after-migration  tras la migración
#   supabase/deploy/pr1e-checks.sh after-function   tras desplegar super-api
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BASE="${PR0_BASE:-https://wtpfrlsbfishvworjdtr.supabase.co}"
KEY="${PR0_KEY:-$(grep -oE 'ey[A-Za-z0-9._-]+' "$ROOT/supabase-config.js")}"
fails=0
check() { if [[ "$3" == $2 ]]; then echo "  ✔ $1"; else echo "  ✖ $1 (esperado: $2 · obtenido: ${3:0:160})"; fails=$((fails + 1)); fi; }
rpc() { curl -s -X POST "$BASE/rest/v1/rpc/$1" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d "$2"; }
preflight() { curl -s -o /dev/null -D - -X OPTIONS "$BASE/functions/v1/super-api" -H "apikey: $KEY" -H "Origin: $1" -H "Access-Control-Request-Method: POST" | tr -d '\r'; }
status_of() { printf '%s' "$1" | awk 'NR==1 {print $2}'; }
acao_of() { printf '%s' "$1" | awk -F': ' 'tolower($1) == "access-control-allow-origin" {print $2}'; }
bad_plan() { curl -s -w ' %{http_code}' -X POST "$BASE/functions/v1/super-api" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -H "Origin: https://legalprevent.com" -d '{"plan":"sonda-no-existe"}'; }

case "${1:-}" in
  pre)
    echo "== Antes de PR1e"
    check "checkout_allow aún no existe" '*PGRST202*' "$(rpc checkout_allow '{"p_email":null}')"
    h="$(preflight https://evil.example)"
    check "super-api hoy acepta cualquier web (CORS *)" '\*' "$(acao_of "$h")"
    "$ROOT/supabase/deploy/pr1d-checks.sh" after-function >/dev/null && echo "  ✔ webhook de Stripe (PR1d) correcto" || { echo "  ✖ webhook de Stripe (PR1d)"; fails=$((fails + 1)); }
    ;;
  after-migration)
    echo "== Tras la migración de PR1e"
    check "anon no puede usar checkout_allow (42501)" '*42501*' "$(rpc checkout_allow '{"p_email":null}')"
    "$ROOT/supabase/deploy/pr1c-checks.sh" after-migration >/dev/null && echo "  ✔ PR1a, PR1b y PR1c siguen correctos" || { echo "  ✖ PR1a/PR1b/PR1c"; fails=$((fails + 1)); }
    echo "  → Ejecuta tests/sql/verify_pr1e_migration.sql en el SQL Editor: debe mostrar 'OK: verificación PR1e superada'."
    ;;
  after-function)
    echo "== Tras desplegar super-api"
    h="$(preflight https://evil.example)"
    check "otra web: preflight rechazado (403)" '403' "$(status_of "$h")"
    check "otra web: sin cabecera CORS" '' "$(acao_of "$h")"
    h="$(preflight https://legalprevent.com)"
    check "legalprevent.com: preflight aceptado (204)" '204' "$(status_of "$h")"
    check "legalprevent.com: CORS solo para su origen" 'https://legalprevent.com' "$(acao_of "$h")"
    check "plan inexistente: 400 sin detalles (no crea sesión)" '*Plan no v* 400' "$(bad_plan)"
    echo "  → Prueba real: en legalprevent.com/#precios pulsa un plan; debe abrir Stripe Checkout. Cierra sin pagar."
    ;;
  *) echo "Uso: $0 pre|after-migration|after-function" >&2; exit 2 ;;
esac

echo
if [[ $fails -eq 0 ]]; then echo "RESULTADO: todo correcto"; else echo "RESULTADO: $fails comprobaciones fallidas"; exit 1; fi
