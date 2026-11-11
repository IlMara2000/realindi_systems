#!/usr/bin/env bash
# Rigenera le immagini Open Graph (1200×630) di home e link-in-bio.
#
# Il generatore è scripts/og-images.py e usa Pillow. Per non toccare il venv del
# progetto (che serve al CRM Python), la dipendenza viene installata in un venv
# temporaneo solo per questa esecuzione.
#
# Uso: bash scripts/og-images.sh
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"

if python3 -c "import PIL" >/dev/null 2>&1; then
  exec python3 "$root/scripts/og-images.py"
fi

venv="$(mktemp -d)/og-venv"
python3 -m venv "$venv"
"$venv/bin/pip" install --quiet --upgrade pip >/dev/null 2>&1 || true
"$venv/bin/pip" install --quiet pillow
"$venv/bin/python" "$root/scripts/og-images.py"
