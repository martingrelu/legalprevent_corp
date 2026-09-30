#!/usr/bin/env bash
# Genera el archivo único que se pega en el editor de Supabase para la función
# sales-agent (10 módulos → 1 archivo, sin dependencias) y lo prueba con la
# misma batería del proveedor real (OpenAI simulado, sin llamadas reales).
# esbuild se ejecuta con versión fija vía npx; no se añade al proyecto.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/supabase/functions/sales-agent/dist/sales-agent.bundle.js"
mkdir -p "$(dirname "$OUT")"
npx --yes esbuild@0.24.0 "$ROOT/supabase/functions/sales-agent/index.ts" \
  --bundle --format=esm --platform=neutral --target=es2022 --legal-comments=none --log-level=warning --outfile="$OUT"
if grep -qE '^import |require\(' "$OUT"; then echo "El paquete tiene dependencias externas" >&2; exit 1; fi
CHECK="$ROOT/tests/.bundle-check.test.ts"
trap 'rm -f "$CHECK"' EXIT
sed "s#\.\./supabase/functions/sales-agent/index\.ts#$OUT#" "$ROOT/tests/openai-provider.test.ts" > "$CHECK"
(cd "$ROOT" && node --test "$CHECK" >/dev/null) && echo "  ✔ el paquete supera las pruebas del proveedor real"
echo "  archivo: supabase/functions/sales-agent/dist/sales-agent.bundle.js"
echo "  SHA-256: $(shasum -a 256 "$OUT" | cut -d' ' -f1)"
