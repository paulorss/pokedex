#!/usr/bin/env bash
# Instalação + inicialização da Pokédex local (Linux / macOS)
set -e
cd "$(dirname "$0")"
if [ ! -d .venv ]; then
  python3 -m venv .venv
  .venv/bin/pip install --upgrade pip
  .venv/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu
  .venv/bin/pip install -r requirements.txt
fi
[ -f data/pokemon.json ] || .venv/bin/python scripts/build_data.py
exec .venv/bin/python run.py "$@"

