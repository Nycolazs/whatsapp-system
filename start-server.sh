#!/bin/bash

# Para o servidor se estiver rodando
pkill -f "node.*backend/index.js" 2>/dev/null || true
sleep 1

# Vai para o diretório do backend
cd "$(dirname "$0")/backend" || exit 1

# Inicia o servidor
echo "Iniciando servidor WhatsApp System..."
echo "HTTP: http://localhost:3001 ou http://SEU_IP:3001"
echo "HTTPS: https://localhost:3443 ou https://SEU_IP:3443"
echo "Para áudio funcionar via IP, use HTTPS!"
echo ""

# Executa o servidor com HTTPS habilitado
HTTPS_KEY_PATH="$PWD/../key.pem" \
HTTPS_CERT_PATH="$PWD/../cert.pem" \
HTTPS_PORT=3443 \
NODE_ENV=development \
node index.js
