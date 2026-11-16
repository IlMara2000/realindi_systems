#!/bin/bash
# Doppio clic: reimposta la password del workspace del gestionale.
# Non cancella dati: sostituisce la password, chiude le sessioni aperte e
# sblocca i tentativi di login falliti. La password digitata non viene mostrata.
cd "$(dirname "$0")" || exit 1

pause() {
  echo
  read -r -p 'Premi Invio per chiudere.' _
}

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js non trovato. Installalo da https://nodejs.org (versione 20 o successiva) e riprova."
  pause
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Dipendenze mancanti: nel Terminale, in questa cartella, esegui «npm install» e riprova."
  pause
  exit 1
fi

if [ ! -f .env ]; then
  echo "Manca il file .env: copia .env.example in .env e compila almeno DATABASE_URL."
  pause
  exit 1
fi

echo "Reimpostazione della password del workspace."
echo "Database: quello indicato da DATABASE_URL nel file .env (lo stesso che usa il gestionale)."
echo "La password che digiti non appare sullo schermo e non finisce nella cronologia."
echo

npm run password:reimposta
esito=$?

if [ "$esito" -ne 0 ]; then
  echo
  echo "Operazione non riuscita (codice $esito): leggi il messaggio qui sopra."
fi

pause
exit "$esito"
