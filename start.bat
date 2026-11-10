@echo off
REM Instalação + inicialização da Pokédex local (Windows)
cd /d "%~dp0"
if not exist .venv (
  echo Criando ambiente virtual...
  python -m venv .venv
  .venv\Scripts\python -m pip install --upgrade pip
  .venv\Scripts\pip install torch --index-url https://download.pytorch.org/whl/cpu
  .venv\Scripts\pip install -r requirements.txt
)
if not exist data\pokemon.json (
  echo Baixando base de dados, modelo e imagens...
  .venv\Scripts\python scripts\build_data.py || exit /b 1
)
.venv\Scripts\python run.py %*

