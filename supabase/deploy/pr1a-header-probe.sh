#!/usr/bin/env bash
# Llama a la sonda temporal de cabeceras dos veces (normal y con cabeceras de
# IP falseadas) y dice cuál de ellas no puede falsear el cliente.
# Solo lee las cabeceras de esta propia petición; no crea datos.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BASE="${PR0_BASE:-https://wtpfrlsbfishvworjdtr.supabase.co}"
KEY="${PR0_KEY:-$(grep -oE 'ey[A-Za-z0-9._-]+' "$ROOT/supabase-config.js")}"
probe() { curl -s -X POST "$BASE/rest/v1/rpc/pr1a_header_probe" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" "$@" -d '{}'; }

normal="$(probe)"
spoofed="$(probe -H 'X-Forwarded-For: 192.0.2.66' -H 'X-Real-IP: 192.0.2.67' -H 'CF-Connecting-IP: 192.0.2.68')"
python3 - "$normal" "$spoofed" <<'PY'
import json, sys, ipaddress
try:
    a, b = json.loads(sys.argv[1]), json.loads(sys.argv[2])
except Exception:
    print("La sonda no responde como se esperaba:", sys.argv[1][:200]); sys.exit(1)
print("Cabeceras recibidas por Postgres:", ", ".join(a.get("cabeceras") or []))
sentinels = {"192.0.2.66", "192.0.2.67", "192.0.2.68"}
def last(v): return (v or "").split(",")[-1].strip()
def first(v): return (v or "").split(",")[0].strip()
candidates = {
    "cf-connecting-ip": (a.get("cf-connecting-ip"), b.get("cf-connecting-ip")),
    "x-real-ip": (a.get("x-real-ip"), b.get("x-real-ip")),
    "x-forwarded-for-first": (first(a.get("x-forwarded-for")), first(b.get("x-forwarded-for"))),
    "x-forwarded-for-last": (last(a.get("x-forwarded-for")), last(b.get("x-forwarded-for"))),
}
fiables = []
for name, (n, s) in candidates.items():
    def valid(v):
        try: ipaddress.ip_address(v or ""); return True
        except ValueError: return False
    ok = valid(n) and n == s and s not in sentinels
    print(f"  {name:22} normal={'IP válida' if valid(n) else 'sin IP'}  falseada={'FALSEABLE' if s in sentinels else ('igual' if n == s else 'cambia')}  → {'FIABLE' if ok else 'no usar'}")
    if ok: fiables.append(name)
print()
print("Recomendación: client_ip_source =", f"'{fiables[0]}'" if fiables else "'none' (ninguna cabecera fiable)")
PY
