#!/usr/bin/env bash
# Comprobaciones de despliegue de PR2 (modo privado). Ninguna llama a OpenAI:
# sin sesión de administrador la función responde 403 antes de reservar
# presupuesto o llamar al modelo.
#
#   supabase/deploy/pr2-checks.sh pre              antes
#   supabase/deploy/pr2-checks.sh after-migration  tras la migración
#   supabase/deploy/pr2-checks.sh after-function   tras desplegar sales-agent
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BASE="${PR0_BASE:-https://wtpfrlsbfishvworjdtr.supabase.co}"
KEY="${PR0_KEY:-$(grep -oE 'ey[A-Za-z0-9._-]+' "$ROOT/supabase-config.js")}"
FN="$BASE/functions/v1/sales-agent"
fails=0
check() { if [[ "$3" == $2 ]]; then echo "  ✔ $1"; else echo "  ✖ $1 (esperado: $2 · obtenido: ${3:0:160})"; fails=$((fails + 1)); fi; }
rpc() { curl -s -X POST "$BASE/rest/v1/rpc/$1" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d "$2"; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

case "${1:-}" in
  pre)
    echo "== Antes de PR2"
    check "agent_runtime_config aún no existe" '*PGRST202*' "$(rpc agent_runtime_config '{}')"
    check "sales-agent aún no existe (404)" '404' "$(code -X OPTIONS "$FN" -H "Origin: https://legalprevent.com")"
    "$ROOT/supabase/deploy/pr1c-checks.sh" after-migration >/dev/null && echo "  ✔ PR1a, PR1b y PR1c siguen correctos" || { echo "  ✖ PR1a/PR1b/PR1c"; fails=$((fails + 1)); }
    ;;
  after-migration)
    echo "== Tras la migración de PR2"
    check "anon no lee la configuración del agente (42501)" '*42501*' "$(rpc agent_runtime_config '{}')"
    check "anon no reserva presupuesto de pruebas (42501)" '*42501*' "$(rpc agent_preview_reserve '{"p_conversation_id":"sonda-pr2-000000001","p_model":"gpt-6-luna","p_max_input_tokens":1,"p_max_output_tokens":1}')"
    check "anon no ve el laboratorio (42501)" '*42501*' "$(rpc agent_lab_summary '{}')"
    check "anon no guarda turnos (42501)" '*42501*' "$(rpc agent_preview_log_turn '{"p_turn":{}}')"
    "$ROOT/supabase/deploy/pr1c-checks.sh" after-migration >/dev/null && echo "  ✔ PR1a, PR1b y PR1c siguen correctos" || { echo "  ✖ PR1a/PR1b/PR1c"; fails=$((fails + 1)); }
    echo "  → Ejecuta tests/sql/verify_pr2_migration.sql en el SQL Editor: debe mostrar 'OK: verificación PR2 superada'."
    ;;
  after-function)
    echo "== Tras desplegar sales-agent (modo privado)"
    check "otra web: rechazada (403)" '403' "$(code -X OPTIONS "$FN" -H "Origin: https://evil.example" -H "Access-Control-Request-Method: POST")"
    check "legalprevent.com: preflight aceptado (204)" '204' "$(code -X OPTIONS "$FN" -H "Origin: https://legalprevent.com" -H "Access-Control-Request-Method: POST")"
    check "sin JWT: rechazada por Supabase (401, verify_jwt activo)" '401' "$(code -X POST "$FN" -H "Content-Type: application/json" -d '{"message":"sonda","model":"gpt-6-luna"}')"
    body="$(curl -s -X POST "$FN" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -H "Origin: https://legalprevent.com" -d '{"message":"sonda","model":"gpt-6-luna"}')"
    check "clave pública (visitante): 403, modo público apagado, sin llamar a OpenAI" '*no está disponible*' "$body"
    check "la respuesta no expone configuración ni claves" '' "$(printf '%s' "$body" | grep -oiE 'sk-|openai_api_key|service_role|LP-CANARY' | head -1)"
    ;;
  *) echo "Uso: $0 pre|after-migration|after-function" >&2; exit 2 ;;
esac

echo
if [[ $fails -eq 0 ]]; then echo "RESULTADO: todo correcto"; else echo "RESULTADO: $fails comprobaciones fallidas"; exit 1; fi
