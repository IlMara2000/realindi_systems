#!/usr/bin/env bash
# Scrive GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET nel .env del progetto.
# I valori si inseriscono in modo nascosto (read -s): non finiscono nella
# cronologia della shell, nei log o nella chat. Alla fine stampa solo le
# lunghezze, così si può verificare che siano stati scritti davvero.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "Nessun .env in $(pwd): interrotto, non creo nulla." >&2
  exit 1
fi

printf 'Google Client ID (…apps.googleusercontent.com): '
IFS= read -r -s client_id
echo
printf 'Google Client Secret (GOCSPX-…): '
IFS= read -r -s client_secret
echo

# Spazi e virgolette incollate per errore non fanno parte del valore.
client_id="${client_id//[[:space:]]/}"
client_id="${client_id//\"/}"
client_secret="${client_secret//[[:space:]]/}"
client_secret="${client_secret//\"/}"

if [ -z "$client_id" ] || [ -z "$client_secret" ]; then
  echo "Valore vuoto: il .env non è stato toccato." >&2
  exit 1
fi

tmp="$(mktemp .env.XXXXXX)"
trap 'rm -f "$tmp"' EXIT

# Si conserva tutto il resto del file, si sostituiscono solo le due righe.
grep -v -e '^GOOGLE_CLIENT_ID=' -e '^GOOGLE_CLIENT_SECRET=' .env > "$tmp"
printf 'GOOGLE_CLIENT_ID=%s\nGOOGLE_CLIENT_SECRET=%s\n' "$client_id" "$client_secret" >> "$tmp"
chmod 600 "$tmp"
mv "$tmp" .env
trap - EXIT

echo "Scritto in $(pwd)/.env"
echo "  GOOGLE_CLIENT_ID     ${#client_id} caratteri"
echo "  GOOGLE_CLIENT_SECRET ${#client_secret} caratteri"
