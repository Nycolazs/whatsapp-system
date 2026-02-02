#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DB_DIR="$ROOT_DIR/data/db"
MEDIA_DIR="$ROOT_DIR/media"
AUTH_DIR_ROOT="$ROOT_DIR/auth"
AUTH_DIR_BACKEND="$ROOT_DIR/backend/auth"

echo "⚠️  Isso vai apagar o banco, sessões e auth do WhatsApp."
read -r -p "Confirmar reset total? (digite RESET): " CONFIRM
if [[ "$CONFIRM" != "RESET" ]]; then
  echo "Cancelado."
  exit 0
fi

# Banco e sessões (remove também arquivos WAL do SQLite)
if [[ -d "$DB_DIR" ]]; then
  rm -f "$DB_DIR/db.sqlite" "$DB_DIR/db.sqlite-shm" "$DB_DIR/db.sqlite-wal"
  rm -f "$DB_DIR/sessions.db" "$DB_DIR/sessions.db-shm" "$DB_DIR/sessions.db-wal"
fi

# Auth do WhatsApp
if [[ -d "$AUTH_DIR_ROOT" ]]; then
  rm -rf "$AUTH_DIR_ROOT"
fi
if [[ -d "$AUTH_DIR_BACKEND" ]]; then
  rm -rf "$AUTH_DIR_BACKEND"
fi

# Mídias salvas (opcional, mas ajuda a limpar tudo)
if [[ -d "$MEDIA_DIR" ]]; then
  rm -rf "$MEDIA_DIR/images"/* "$MEDIA_DIR/videos"/* "$MEDIA_DIR/audios"/* "$MEDIA_DIR/stickers"/* 2>/dev/null || true
fi

echo "✅ Reset concluído. Inicie o backend e reconecte o WhatsApp."
