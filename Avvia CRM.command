#!/bin/zsh
cd -- "${0:A:h}"
if [[ ! -x .venv/bin/python ]]; then
  print 'Prima installa le dipendenze seguendo README.md (ambiente .venv).'
  read '?Premi Invio per chiudere.'
  exit 1
fi
.venv/bin/python app.py
