#!/usr/bin/env bash
# Avvia un Postgres 17 usa-e-getta pari a quello della CI, applica le
# migrazioni, esegue il controllo di allineamento e la suite. Non modifica
# .env: le variabili valgono solo per questa esecuzione.
#
# Due modi, scelti in automatico:
#  - Docker presente: container `postgres:17` sulla porta 5432 (o PORTA_PG);
#  - Docker assente: il PostgreSQL 17 di Homebrew, in un cluster temporaneo su
#    una porta libera.
# Quello che lo script avvia lo ferma e lo cancella alla fine (trap EXIT);
# quello che trovava già attivo lo lascia stare.
#
# Su macOS il cluster locale va avviato con LC_ALL=C: con il locale italiano il
# postmaster si spegne subito con «postmaster became multithreaded during
# startup». Non è un dettaglio cosmetico: senza, `pg_ctl start` fallisce.
set -euo pipefail

NOME="realindi-pg-test"
AVVIATO=0
MODO=""
DATADIR=""
URL=""

# Porta libera scelta dal sistema, per non scontrarsi con un Postgres già in
# ascolto (il 5432 dell'utente, per esempio).
porta_libera() {
  node -e 'const s = require("node:net").createServer(); s.listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); });'
}

pulisci() {
  case "$MODO" in
    docker)
      # Solo se l'abbiamo avviato noi: un container già attivo è di chi lo sta usando.
      if [ "$AVVIATO" = "1" ]; then
        docker rm -f "$NOME" >/dev/null 2>&1 || true
      fi
      ;;
    locale)
      if [ "$AVVIATO" = "1" ]; then
        LC_ALL=C LANG=C pg_ctl -D "$DATADIR/dati" stop -m fast >/dev/null 2>&1 || true
      fi
      # La cartella si rimuove anche se l'avvio è fallito a metà: è nostra,
      # creata con mktemp, e non deve restare in giro.
      if [ -n "$DATADIR" ] && [ -d "$DATADIR" ]; then
        rm -rf "$DATADIR"
        echo "Cluster temporaneo fermato e cancellato ($DATADIR)."
      fi
      ;;
  esac
}
trap pulisci EXIT

avvia_docker() {
  local porta="${PORTA_PG:-5432}"
  MODO="docker"

  if docker ps --format '{{.Names}}' | grep -qx "$NOME"; then
    echo "Postgres locale già attivo ($NOME): lo riuso e non lo fermo"
  else
    docker run --rm -d --name "$NOME" -p "${porta}:5432" \
      -e POSTGRES_PASSWORD=postgres \
      -e POSTGRES_DB=postgres \
      postgres:17 >/dev/null
    AVVIATO=1

    printf 'Attendo Postgres'
    local pronto=0
    for _ in $(seq 1 60); do
      # -h 127.0.0.1 forza il controllo via TCP: durante l'inizializzazione il
      # container avvia un server temporaneo che risponde solo sul socket locale,
      # e senza -h sembrerebbe pronto troppo presto.
      if docker exec "$NOME" pg_isready -h 127.0.0.1 -p 5432 -U postgres -d postgres >/dev/null 2>&1; then
        pronto=1
        break
      fi
      printf '.'
      sleep 1
    done
    echo
    if [ "$pronto" != "1" ]; then
      echo "Postgres non è diventato pronto in 60 secondi." >&2
      exit 1
    fi
  fi

  URL="postgresql://postgres:postgres@localhost:${porta}/postgres"
}

avvia_cluster_locale() {
  local binario
  for binario in initdb pg_ctl postgres; do
    if ! command -v "$binario" >/dev/null 2>&1; then
      cat >&2 <<'MESSAGGIO'
Docker non trovato e nemmeno PostgreSQL locale: serve uno dei due.
  - Docker (container postgres:17): https://docs.docker.com/get-docker/
  - PostgreSQL 17 di Homebrew: brew install postgresql@17
Senza, la suite può girare sul database indicato da DATABASE_URL_TEST.
MESSAGGIO
      exit 1
    fi
  done

  local versione
  versione="$(postgres --version | awk '{print $3}')"
  if [ "${versione%%.*}" != "17" ]; then
    echo "Serve PostgreSQL 17, quello della CI: trovato $versione." >&2
    exit 1
  fi

  local porta="${PORTA_PG:-$(porta_libera)}"

  # TMPDIR su macOS finisce con "/": senza toglierlo il percorso stampato
  # mostrerebbe una doppia barra.
  local base="${TMPDIR:-/tmp}"
  base="${base%/}"
  DATADIR="$(mktemp -d "$base/realindi-pg-test.XXXXXX")"
  MODO="locale"

  local pwfile="$DATADIR/password"
  printf 'postgres' > "$pwfile"
  # Locale C anche qui: initdb sceglierebbe quello dell'ambiente, che il server
  # potrebbe non saper usare.
  if ! LC_ALL=C LANG=C initdb -D "$DATADIR/dati" -U postgres \
    --auth-local=trust --auth-host=scram-sha-256 \
    --pwfile="$pwfile" --encoding=UTF8 --locale=C >"$DATADIR/initdb.log" 2>&1; then
    echo "initdb non è riuscito:" >&2
    tail -5 "$DATADIR/initdb.log" >&2
    exit 1
  fi
  rm -f "$pwfile"

  # LC_ALL=C è la riga che fa la differenza su macOS (vedi l'intestazione).
  # `-w` attende che il server accetti connessioni: se fallisce lo dice il
  # comando stesso, quindi non serve un secondo controllo di readiness.
  if ! LC_ALL=C LANG=C pg_ctl -D "$DATADIR/dati" -l "$DATADIR/postgres.log" \
    -o "-p $porta -h 127.0.0.1" -w start >/dev/null 2>&1; then
    echo "Postgres non è partito:" >&2
    tail -10 "$DATADIR/postgres.log" >&2
    exit 1
  fi
  AVVIATO=1

  echo "Cluster temporaneo pronto: 127.0.0.1:$porta (dati in $DATADIR)"
  URL="postgresql://postgres:postgres@127.0.0.1:${porta}/postgres"
}

if command -v docker >/dev/null 2>&1; then
  avvia_docker
else
  echo "Docker non trovato: uso il PostgreSQL 17 di Homebrew in un cluster temporaneo."
  avvia_cluster_locale
fi

# Anche DIRECT_URL: `db:migrate` e `db:check` la preferiscono a DATABASE_URL, e
# se nel .env ce n'è una (tipicamente l'endpoint diretto del cloud) i due comandi
# finirebbero sul database remoto invece che sul cluster usa-e-getta.
export DATABASE_URL="$URL"
export DATABASE_URL_TEST="$URL"
export DIRECT_URL="$URL"

npm run db:migrate
npm run db:check
npm test
