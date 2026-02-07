#!/bin/bash

echo "Iniciando WhatsApp System..."
echo "HTTP: http://localhost:3001"
echo "HTTPS: https://localhost:3443 (recomendado para áudio)"
cd "$(dirname "$0")/backend"

# Configura HTTPS se os certificados existirem
if [ -f "../key.pem" ] && [ -f "../cert.pem" ]; then
  export HTTPS_KEY_PATH="$PWD/../key.pem"
  export HTTPS_CERT_PATH="$PWD/../cert.pem"
  export HTTPS_PORT=3443
fi

node index.js
