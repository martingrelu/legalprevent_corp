#!/usr/bin/env bash
# Comprobaciones de despliegue de PR1a. Ninguna crea, modifica ni borra datos
# ni envía emails: los ids son aleatorios e inexistentes y las altas de prueba
# fallan en la validación (antes de contar límites o insertar).
#
#   supabase/deploy/pr1a-checks.sh pre              antes de empezar
#   supabase/deploy/pr1a-checks.sh after-web        tras publicar la web (paso 1)
#   supabase/deploy/pr1a-checks.sh after-migration  tras las migraciones (paso 2)
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BASE="${PR0_BASE:-https://wtpfrlsbfishvworjdtr.supabase.co}"
SITE="${PR0_SITE:-https://legalprevent.com}"
KEY="${PR0_KEY:-$(grep -oE 'ey[A-Za-z0-9._-]+' "$ROOT/supabase-config.js")}"
RANDOM_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
fails=0

check() { if [[ "$3" == $2 ]]; then echo "  ✔ $1"; else echo "  ✖ $1 (esperado: $2 · obtenido: ${3:0:160})"; fails=$((fails + 1)); fi; }
rest() { curl -s -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" "$@"; }
code42501() { local out; out="$("$@")"; [[ "$out" == *42501* ]] && echo "42501" || echo "$out"; }

case "${1:-}" in
  pre)
    echo "== Antes de PR1a"
    "$ROOT/supabase/deploy/pr0-checks.sh" after-migration | grep -E "✔|✖" | sed 's/^/  (PR0)/'
    "$ROOT/supabase/deploy/pr0-checks.sh" after-migration >/dev/null || fails=$((fails + 1))
    check "anon aún puede consultar payments (permiso previo a PR1a)" "200" "$(rest -o /dev/null -w '%{http_code}' "$BASE/rest/v1/payments?select=id&limit=0")"
    ;;
  after-web)
    echo "== Tras publicar la web (GitHub Pages puede tardar unos minutos)"
    for f in index.html script.js supabase-bridge.js diagnostico/index.html diagnostico/diagnostico.js crm/index.html crm/src/app.js crm/src/store.js crm/src/styles.css; do
      live="$(curl -s "$SITE/$f?nocache=$RANDOM_ID" | shasum | cut -c1-12)"; head="$(git -C "$ROOT" show "HEAD:$f" | shasum | cut -c1-12)"
      check "web publicada = rama PR1a ($f)" "$head" "$live"
    done
    ;;
  after-migration)
    echo "== Tras las migraciones de PR1a"
    for t in payments subscriptions checkout_sessions; do
      check "anon ya no lee $t (42501)" "42501" "$(code42501 rest "$BASE/rest/v1/$t?select=id&limit=0")"
    done
    check "anon no ejecuta is_crm_admin (42501)" "42501" "$(code42501 rest -X POST "$BASE/rest/v1/rpc/is_crm_admin" -d '{}')"
    check "el esquema private no está expuesto por la API" '*PGRST106*' "$(rest -H 'Accept-Profile: private' "$BASE/rest/v1/settings?select=key")"
    check "submit_lead sigue exigiendo privacidad" '*privacy_required*' "$(rest -X POST "$BASE/rest/v1/rpc/submit_lead" -d '{"p_payload":{"email":"sonda@example.invalid"}}')"
    # Solo con la migración aplicada: con la compatibilidad temporal de PR0
    # todavía activa, esta llamada SÍ crearía un diagnóstico.
    if [[ "$(code42501 rest "$BASE/rest/v1/payments?select=id&limit=0")" == "42501" ]]; then
      check "submit_diagnostic sin compatibilidad temporal" '*privacy_required*' "$(rest -X POST "$BASE/rest/v1/rpc/submit_diagnostic" -d '{"p_payload":{"email":"sonda@example.invalid","payload":{"payload":{"company":{"privacy":"on"}}}}}')"
    else
      echo "  ✖ migración no detectada: se omite la sonda de compatibilidad para no crear registros"; fails=$((fails + 1))
    fi
    check "request_lead_demo sigue sin marcar ids inexistentes" "false" "$(rest -X POST "$BASE/rest/v1/rpc/request_lead_demo" -d "{\"p_lead_id\":\"$RANDOM_ID\"}")"
    echo "  → Ejecuta tests/sql/verify_pr1a_migration.sql en el SQL Editor: debe mostrar 'OK: verificación PR1a superada'."
    ;;
  *)
    echo "Uso: $0 pre|after-web|after-migration" >&2; exit 2 ;;
esac

echo
if [[ $fails -eq 0 ]]; then echo "RESULTADO: todo correcto"; else echo "RESULTADO: $fails comprobaciones fallidas"; exit 1; fi
