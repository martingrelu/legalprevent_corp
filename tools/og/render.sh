#!/usr/bin/env bash
# Regenera las imágenes de marca a partir de favicon.svg y og-template.html.
# Requisitos (solo en local, macOS): Google Chrome y sips. No forma parte del despliegue.
# Uso: tools/og/render.sh [version]   (por defecto v1 → assets/og/og-es-v1.jpg)
set -euo pipefail
cd "$(dirname "$0")/../.."
VERSION="${1:-v1}"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
shot() { # url ancho alto salida [fondo transparente]
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --window-size="$2,$3" --virtual-time-budget=5000 ${5:+--default-background-color=00000000} \
    --screenshot="$4" "$1" 2>/dev/null
}
ROOT="file://$PWD/tools/og"
for lang in es en; do
  shot "$ROOT/og-template.html?lang=$lang" 1200 630 "$TMP/og-$lang.png"
  sips -s format jpeg -s formatOptions 88 "$TMP/og-$lang.png" --out "assets/og/og-$lang-$VERSION.jpg" >/dev/null
done
for size in 16 32 48; do shot "$ROOT/icon.html" "$size" "$size" "$TMP/icon-$size.png" transparent; done
node tools/og/make-ico.mjs favicon.ico "$TMP/icon-16.png" "$TMP/icon-32.png" "$TMP/icon-48.png"
shot "$ROOT/apple-icon.html" 180 180 apple-touch-icon.png
ls -l assets/og/og-*-"$VERSION".jpg favicon.ico apple-touch-icon.png
