# Imagem base oficial do Python (versão slim para manter a imagem leve)
FROM python:3.11-slim

# Evita criação de arquivos .pyc e faz logs aparecerem imediatamente
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    KERAS_BACKEND=torch \
    HF_HUB_DISABLE_SYMLINKS_WARNING=1 \
    PORT=8000

WORKDIR /app

# Instala dependências mínimas do sistema operacional (necessárias para Pillow e rede)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Atualiza pip e instala PyTorch versão CPU (muito mais leve, sem os gigabytes do CUDA)
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu

# Copia e instala dependências Python do projeto
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && \
    pip install --no-cache-dir kagglehub transformers

# Copia o código da aplicação e scripts
COPY app/ ./app/
COPY web/ ./web/
COPY scripts/ ./scripts/
COPY data/labels.json ./data/labels.json
COPY data/pokemon.json ./data/pokemon.json
COPY run.py .
COPY entrypoint.sh .

# Garante permissão de execução no entrypoint
RUN chmod +x entrypoint.sh

# Porta padrão exposta
EXPOSE 8000

# Healthcheck nativo para o Dokploy / Docker Swarm
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:${PORT}/api/health || exit 1

# Ponto de entrada que baixa dados ausentes na primeira vez e sobe o Uvicorn
ENTRYPOINT ["./entrypoint.sh"]
