#!/usr/bin/env bash
# Avvia un Postgres 17 pari a quello della CI, applica le migrazioni, esegue il
# controllo di allineamento e la suite. Non modifica .env: le variabili valgono
# solo per questa esecuzione.
set -euo pipefail

NOME="realindi-pg-test"
PORTA="${PORTA_PG:-5432}"
URL="postgresql://postgres:postgres@localhost:${PORTA}/postgres"
AVVIATO=0

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker non trovato. Serve per avere in locale lo stesso Postgres 17 della CI." >&2
  echo "Senza Docker, la suite può girare sul database indicato da DATABASE_URL_TEST." >&2
  exit 1
fi

pulisci() {
  # Solo se l'abbiamo avviato noi: un container già attivo è di chi lo sta usando.
  if [ "$AVVIATO" = "1" ]; then
    docker rm -f "$NOME" >/dev/null 2>&1 || true
  fi
}
trap pulisci EXIT

if docker ps --format '{{.Names}}' | grep -qx "$NOME"; then
  echo "Postgres locale già attivo ($NOME): lo riuso e non lo fermo"
else
  docker run --rm -d --name "$NOME" -p "${PORTA}:5432" \
    -e POSTGRES_PASSWORD=postgres \
    -e POSTGRES_DB=postgres \
    postgres:17 >/dev/null
  AVVIATO=1

  printf 'Attendo Postgres'
  PRONTO=0
  for _ in $(seq 1 60); do
    # -h 127.0.0.1 forza il controllo via TCP: durante l'inizializzazione il
    # container avvia un server temporaneo che risponde solo sul socket locale,
    # e senza -h sembrerebbe pronto troppo presto.
    if docker exec "$NOME" pg_isready -h 127.0.0.1 -p 5432 -U postgres -d postgres >/dev/null 2>&1; then
      PRONTO=1
      break
    fi
    printf '.'
    sleep 1
  done
  echo
  if [ "$PRONTO" != "1" ]; then
    echo "Postgres non è diventato pronto in 60 secondi." >&2
    exit 1
  fi
fi

export DATABASE_URL="$URL"
export DATABASE_URL_TEST="$URL"

npm run db:migrate
npm run db:check
npm test
