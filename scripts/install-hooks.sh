#!/bin/sh
# Abilita il controllo pre-commit versionato in .githooks/.
set -e
cd "$(git rev-parse --show-toplevel)"
git config core.hooksPath .githooks
echo "hook attivo: core.hooksPath=$(git config core.hooksPath)"
