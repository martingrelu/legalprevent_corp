#!/usr/bin/env bash
# Comprueba (solo lectura) que los archivos publicados en legalprevent.com son
# idénticos a los de HEAD. GitHub Pages puede tardar unos minutos tras el merge.
#
#   supabase/deploy/web-checks.sh index.html script.js supabase-bridge.js ...
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SITE="${PR0_SITE:-https://legalprevent.com}"
[[ $# -gt 0 ]] || { echo "Uso: $0 archivo [archivo...]" >&2; exit 2; }
fails=0
for f in "$@"; do
  path="${f%index.html}"
  live="$(curl -s "$SITE/$path?nocache=$RANDOM$RANDOM" | shasum | cut -c1-12)"
  head="$(git -C "$ROOT" show "HEAD:$f" | shasum | cut -c1-12)"
  if [[ "$live" == "$head" ]]; then echo "  ✔ web publicada = HEAD ($f)"; else echo "  ✖ web publicada ≠ HEAD ($f)"; fails=$((fails + 1)); fi
done
echo
if [[ $fails -eq 0 ]]; then echo "RESULTADO: todo correcto"; else echo "RESULTADO: $fails archivos distintos"; exit 1; fi
