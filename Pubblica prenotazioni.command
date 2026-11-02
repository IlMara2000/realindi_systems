#!/bin/bash
# Espone la pagina di prenotazione su un indirizzo HTTPS pubblico e condivisibile.
# Il link resta attivo finché questa finestra è aperta. Mai incollarlo su un sito pubblico se non vuoi prenotazioni indesiderate.
set -euo pipefail
cd "$(dirname "$0")"

PORT="${CRM_PORT:-8080}"
BASE="http://127.0.0.1:$PORT"
BIN="tools/cloudflared"
LOG="$(mktemp -t realindi-tunnel)"
APP_LOG="$(mktemp -t realindi-crm)"
APP_PID=""
TUNNEL_PID=""

cleanup() {
  [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null || true
  [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null || true
  .venv/bin/python manage.py public-url "" >/dev/null 2>&1 || true
  rm -f "$LOG" "$APP_LOG"
  echo
  echo "Tunnel chiuso: il link pubblico non è più attivo."
}
trap cleanup EXIT INT TERM

if [ ! -x .venv/bin/python ]; then
  echo "Manca l'ambiente Python. Esegui prima i passaggi di «Avvio» nel README."
  exit 1
fi

running() { curl -fsS -m 3 -o /dev/null "$BASE/api/session"; }

if ! running; then
  echo "Avvio del CRM…"
  nohup .venv/bin/python app.py >"$APP_LOG" 2>&1 &
  APP_PID=$!
  for _ in $(seq 1 40); do
    running && break
    sleep 0.5
  done
  if ! running; then
    echo "Il CRM non si è avviato. Dettagli:"
    tail -n 20 "$APP_LOG" || true
    exit 1
  fi
fi

if [ ! -x "$BIN" ]; then
  case "$(uname -m)" in
    arm64) asset="cloudflared-darwin-arm64.tgz" ;;
    x86_64) asset="cloudflared-darwin-amd64.tgz" ;;
    *) echo "Processore non supportato: $(uname -m)." ; exit 1 ;;
  esac
  echo "Scarico il client del tunnel (una sola volta, circa 40 MB)…"
  mkdir -p tools
  curl -fL --progress-bar -o "tools/$asset" "https://github.com/cloudflare/cloudflared/releases/latest/download/$asset"
  tar -xzf "tools/$asset" -C tools
  rm -f "tools/$asset"
  chmod +x "$BIN"
fi

echo "Apro il tunnel HTTPS…"
"$BIN" tunnel --url "$BASE" --no-autoupdate --logfile "$LOG" >/dev/null 2>&1 &
TUNNEL_PID=$!

URL=""
for _ in $(seq 1 60); do
  URL=$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" 2>/dev/null | head -1 || true)
  [ -n "$URL" ] && break
  kill -0 "$TUNNEL_PID" 2>/dev/null || break
  sleep 1
done
if [ -z "$URL" ]; then
  echo "Il tunnel non ha fornito un indirizzo. Dettagli:"
  grep -Ei 'error|failed' "$LOG" 2>/dev/null | tail -n 5 || true
  exit 1
fi

LINK=$(.venv/bin/python manage.py public-url "$URL")
API=$(printf '%s' "$LINK" | sed 's|/book/|/api/booking/|')
if ! curl -fsS -m 20 -o /dev/null "$API"; then
  echo "Il link non risponde ancora. Attendi qualche secondo e ricarica, oppure riprova."
  exit 1
fi

echo
echo "Link pubblico attivo:"
echo "  $LINK"
echo
echo "Condividilo con i clienti. Resta attivo finché questa finestra è aperta"
echo "e il Mac non va in sospensione. Premi Ctrl+C per chiudere."
echo

wait "$TUNNEL_PID"
