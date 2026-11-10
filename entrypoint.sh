#!/usr/bin/env bash
set -e

echo "=========================================="
echo "⚡ Inicializando Pokédex no Docker/Dokploy"
echo "=========================================="

# Cria pastas necessárias caso volumes persistentes estejam vazios
mkdir -p model data/raw data/user_samples web/img/artwork web/img/sprites

# Se os pesos do classificador não existirem no volume, baixa automaticamente
if [ ! -f "model/pokedex.safetensors" ]; then
    echo "• Pesos do modelo não encontrados. Baixando modelo oficial do Hugging Face..."
    python -c "
import urllib.request
print('Baixando pokedex.safetensors...')
urllib.request.urlretrieve(
    'https://huggingface.co/RogerKoala/gen1-pokemon-classifier/resolve/main/pokedex.safetensors',
    'model/pokedex.safetensors'
)
print('Baixando Pokemons.txt...')
urllib.request.urlretrieve(
    'https://huggingface.co/spaces/RogerKoala/Pokedex/raw/main/Pokemons.txt',
    'model/Pokemons.txt'
)
print('Download concluído!')
"
fi

# Define porta (Dokploy injeta PORT automaticamente se configurado, ou usa 8000)
PORT="${PORT:-8000}"

if [ -n "${APP_PASSWORD}" ] || [ -n "${POKEDEX_PASSWORD}" ] || [ -n "${ACCESS_CODE}" ]; then
    echo "🔒 Proteção por senha ATIVADA via variável de ambiente."
else
    echo "🔓 Modo livre (sem senha configurada)."
fi

echo "• Iniciando servidor na porta ${PORT}..."
exec python -m uvicorn app.server:app --host 0.0.0.0 --port "${PORT}"

