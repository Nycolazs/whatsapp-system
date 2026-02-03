#!/bin/bash

# Para o servidor se estiver rodando
pkill -f "node.*backend/index.js" 2>/dev/null || true
sleep 1

# Vai para o diretório do backend
cd "$(dirname "$0")/backend" || exit 1

# Inicia o servidor
echo "Iniciando servidor WhatsApp System na porta 3001..."
echo "Acesse via: http://localhost:3001 ou http://SEU_IP:3001"
echo ""

# Executa o servidor
NODE_ENV=development node index.js
