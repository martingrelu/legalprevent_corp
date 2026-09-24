#!/usr/bin/env bash
# Comprobaciones de despliegue de PR0 contra producción.
# NINGUNA comprobación crea, modifica ni borra datos ni envía emails:
#   - las llamadas a la función usan ids aleatorios que no existen o cuerpos
#     que la función rechaza antes de hacer nada;
#   - las llamadas a la base usan valores que fallan antes de insertar.
#
#   supabase/deploy/pr0-checks.sh pre               antes de empezar
#   supabase/deploy/pr0-checks.sh after-function    tras publicar la función
#   supabase/deploy/pr0-checks.sh after-migration   tras la migración
#   supabase/deploy/pr0-checks.sh after-web         tras publicar la web
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# Por defecto, producción. PR0_BASE / PR0_SITE / PR0_KEY permiten ejecutar las
# mismas comprobaciones contra el laboratorio (tests/lab/run.sh --serve).
BASE="${PR0_BASE:-https://wtpfrlsbfishvworjdtr.supabase.co}"
SITE="${PR0_SITE:-https://legalprevent.com}"
KEY="${PR0_KEY:-$(grep -oE 'ey[A-Za-z0-9._-]+' "$ROOT/supabase-config.js")}"
FN="$BASE/functions/v1/smooth-action"
RANDOM_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
fails=0

check() { # nombre esperado obtenido
  if [[ "$3" == $2 ]]; then echo "  ✔ $1"; else echo "  ✖ $1 (esperado: $2 · obtenido: $3)"; fails=$((fails + 1)); fi
}
status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
rest() { curl -s -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" "$@"; }
acao() { curl -s -D - -o /dev/null -X OPTIONS "$FN" -H "Origin: $1" -H "Access-Control-Request-Method: POST" | tr -d '\r' | awk -F': ' 'tolower($1)=="access-control-allow-origin"{print $2}'; }
preflight_status() { status -X OPTIONS "$FN" -H "Origin: $1" -H "Access-Control-Request-Method: POST"; }

case "${1:-}" in
  pre)
    echo "== Estado previo (producción sin PR0)"
    check "smooth-action existe" "200" "$(preflight_status "$SITE")"
    check "smooth-action aún con CORS '*' (versión antigua)" "\*" "$(acao "$SITE")"
    check "smooth-action no exige JWT (verify_jwt OFF)" "500" "$(status -X POST "$FN" -H 'Content-Type: application/json' -d 'x')"
    check "migración PR0 aún no aplicada (sin notified_at)" "400" "$(status -H "apikey: $KEY" -H "Authorization: Bearer $KEY" "$BASE/rest/v1/leads?select=notified_at&limit=0")"
    check "migración de embudo aplicada (lead_type existe)" "200" "$(status -H "apikey: $KEY" -H "Authorization: Bearer $KEY" "$BASE/rest/v1/leads?select=lead_type&limit=0")"
    check "request_lead_demo aún no existe" "404" "$(rest -o /dev/null -w '%{http_code}' -X POST "$BASE/rest/v1/rpc/request_lead_demo" -d "{\"p_lead_id\":\"$RANDOM_ID\"}")"
    for f in index.html script.js supabase-bridge.js diagnostico/diagnostico.js; do
      live="$(curl -s "$SITE/$f" | shasum | cut -c1-12)"; main="$(git -C "$ROOT" show "origin/main:$f" | shasum | cut -c1-12)"
      check "web publicada = origin/main ($f)" "$main" "$live"
    done
    ;;
  after-function)
    echo "== Tras publicar la función"
    check "preflight del dominio oficial devuelve su origen (versión nueva)" "$SITE" "$(acao "$SITE")"
    check "preflight de un origen no permitido: 403" "403" "$(preflight_status "https://evil.example")"
    if [[ "$(acao "$SITE")" == "$SITE" ]]; then
      check "destinatario arbitrario rechazado (400)" "400" "$(status -X POST "$FN" -H 'Content-Type: application/json' -H "Origin: $SITE" -d '{"lead":{"email":"sonda@example.invalid"},"to":"sonda@example.invalid"}')"
    else
      echo "  – se omite la sonda de destinatario: la función nueva no parece publicada"
    fi
    check "sin migración, la reclamación falla de forma controlada (500 genérico)" "500" "$(status -X POST "$FN" -H 'Content-Type: application/json' -H "Origin: $SITE" -d "{\"leadId\":\"$RANDOM_ID\"}")"
    ;;
  after-migration)
    echo "== Tras la migración"
    body="$(curl -s -X POST "$FN" -H 'Content-Type: application/json' -H "Origin: $SITE" -d "{\"leadId\":\"$RANDOM_ID\"}")"
    check "la función reclama contra la base: id inexistente -> notified:false" '*"notified":false*' "$body"
    demo_probe="$(rest -X POST "$BASE/rest/v1/rpc/request_lead_demo" -d "{\"p_lead_id\":\"$RANDOM_ID\"}")"
    check "request_lead_demo existe y no marca ids inexistentes" "false" "$demo_probe"
    check "anon ya no inserta directamente en leads (401)" "401" "$(rest -o /dev/null -w '%{http_code}' -X POST "$BASE/rest/v1/leads" -d '{"email":null}')"
    check "anon ya no inserta directamente en diagnostics (401)" "401" "$(rest -o /dev/null -w '%{http_code}' -X POST "$BASE/rest/v1/diagnostics" -d '{"email":null}')"
    check "anon ya no lee leads (401)" "401" "$(status -H "apikey: $KEY" -H "Authorization: Bearer $KEY" "$BASE/rest/v1/leads?select=id&limit=0")"
    # Solo si la migración está aplicada: con las funciones antiguas estas
    # llamadas SÍ insertarían un registro.
    if [[ "$demo_probe" == "false" ]]; then
      check "submit_lead exige privacidad" '*privacy_required*' "$(rest -X POST "$BASE/rest/v1/rpc/submit_lead" -d '{"p_payload":{"email":"sonda@example.invalid"}}')"
      check "submit_diagnostic exige privacidad" '*privacy_required*' "$(rest -X POST "$BASE/rest/v1/rpc/submit_diagnostic" -d '{"p_payload":{"email":"sonda@example.invalid"}}')"
    else
      echo "  ✖ migración no detectada: se omiten las sondas de privacidad para no crear registros"; fails=$((fails + 1))
    fi
    # PostgREST devuelve el error 42501 (permiso denegado); según la versión el
    # HTTP es 400/401, o 404 si oculta la función: cualquiera es correcto.
    claim_probe="$(rest -w ' HTTP%{http_code}' -X POST "$BASE/rest/v1/rpc/claim_lead_notification" -d "{\"p_lead_id\":\"$RANDOM_ID\",\"p_kind\":\"new_lead\",\"p_hourly_cap\":1}")"
    if [[ "$claim_probe" == *42501* || "$claim_probe" == *HTTP404* ]]; then claim_probe="denegado"; fi
    check "anon no puede reclamar avisos" "denegado" "$claim_probe"
    echo "  → Ejecuta ahora tests/sql/verify_pr0_migration.sql en el SQL Editor: debe mostrar 'OK: verificación PR0 superada'."
    ;;
  after-web)
    echo "== Tras publicar la web (GitHub Pages puede tardar ~10 min por la caché)"
    for f in index.html script.js supabase-bridge.js diagnostico/index.html diagnostico/diagnostico.js; do
      live="$(curl -s "$SITE/$f" | shasum | cut -c1-12)"; head="$(git -C "$ROOT" show "HEAD:$f" | shasum | cut -c1-12)"
      check "web publicada = rama PR0 ($f)" "$head" "$live"
    done
    ;;
  *)
    echo "Uso: $0 pre|after-function|after-migration|after-web" >&2; exit 2 ;;
esac

echo
if [[ $fails -eq 0 ]]; then echo "RESULTADO: todo correcto"; else echo "RESULTADO: $fails comprobaciones fallidas"; exit 1; fi
