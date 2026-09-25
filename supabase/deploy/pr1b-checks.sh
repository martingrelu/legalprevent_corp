#!/usr/bin/env bash
# Comprobaciones de despliegue de PR1b (solo lectura: ninguna llamada
# reserva presupuesto, registra eventos ni modifica datos).
#
#   supabase/deploy/pr1b-checks.sh pre              antes de la migración
#   supabase/deploy/pr1b-checks.sh after-migration  después
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BASE="${PR0_BASE:-https://wtpfrlsbfishvworjdtr.supabase.co}"
KEY="${PR0_KEY:-$(grep -oE 'ey[A-Za-z0-9._-]+' "$ROOT/supabase-config.js")}"
fails=0

check() { if [[ "$3" == $2 ]]; then echo "  ✔ $1"; else echo "  ✖ $1 (esperado: $2 · obtenido: ${3:0:160})"; fails=$((fails + 1)); fi; }
rpc() { curl -s -X POST "$BASE/rest/v1/rpc/$1" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d "$2"; }
# Argumentos válidos pero que, aun ejecutándose, no alterarían nada: la
# sesión no es válida para agent_reserve y el evento no es de un tipo permitido.
RESERVE='{"p_session_id":"x","p_max_input_tokens":0,"p_max_output_tokens":0}'
EVENT='{"p_event":{"event_type":"no-valido","session_id":"x"}}'

case "${1:-}" in
  pre)
    echo "== Antes de PR1b"
    check "agent_reserve aún no existe" '*PGRST202*' "$(rpc agent_reserve "$RESERVE")"
    "$ROOT/supabase/deploy/pr1a-checks.sh" after-migration >/dev/null && echo "  ✔ PR1a sigue correcto" || { echo "  ✖ PR1a no está correcto"; fails=$((fails + 1)); }
    ;;
  after-migration)
    echo "== Tras la migración de PR1b"
    check "anon no puede reservar presupuesto (42501)" '*42501*' "$(rpc agent_reserve "$RESERVE")"
    check "anon no puede registrar eventos (42501)" '*42501*' "$(rpc agent_track_event "$EVENT")"
    check "anon no ve métricas (42501)" '*42501*' "$(rpc agent_metrics '{"p_days":1}')"
    check "anon no puede liquidar ni liberar (42501)" '*42501*' "$(rpc agent_release '{"p_reservation_id":"00000000-0000-4000-8000-000000000000"}')"
    "$ROOT/supabase/deploy/pr1a-checks.sh" after-migration >/dev/null && echo "  ✔ PR1a sigue correcto" || { echo "  ✖ PR1a no está correcto"; fails=$((fails + 1)); }
    echo "  → Ejecuta tests/sql/verify_pr1b_migration.sql en el SQL Editor: debe mostrar 'OK: verificación PR1b superada'."
    ;;
  *)
    echo "Uso: $0 pre|after-migration" >&2; exit 2 ;;
esac

echo
if [[ $fails -eq 0 ]]; then echo "RESULTADO: todo correcto"; else echo "RESULTADO: $fails comprobaciones fallidas"; exit 1; fi
