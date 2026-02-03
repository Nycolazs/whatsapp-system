#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DATA_DIR="$ROOT_DIR/data"
DB_DIR="$DATA_DIR/db"
MEDIA_DIR="$ROOT_DIR/media"
AUTH_DIR_BACKEND="$ROOT_DIR/backend/auth"
ACCOUNTS_DIR="$DATA_DIR/accounts"
STAGING_DIR="$DATA_DIR/staging"

# Cores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

print_header() {
  echo -e "${YELLOW}========================================${NC}"
  echo -e "${YELLOW}$1${NC}"
  echo -e "${YELLOW}========================================${NC}"
}

print_success() {
  echo -e "${GREEN}[OK]${NC} $1"
}

print_error() {
  echo -e "${RED}[ERROR]${NC} $1"
}

# Menu de opções
show_menu() {
  print_header "WhatsApp System - Reset Utility"
  echo "Escolha uma opção:"
  echo "1) Reset completo (banco, sessões, auth, mídias)"
  echo "2) Reset somente banco de dados (manter auth)"
  echo "3) Reset somente WhatsApp (manter banco)"
  echo "4) Reset somente mídias"
  echo "5) Reset somente sessões"
  echo "0) Cancelar"
  read -r -p "Opção: " CHOICE
}

reset_all() {
  echo "Isso vai apagar:"
  echo "  - Banco de dados principal"
  echo "  - Sessões de usuários"
  echo "  - Autenticação do WhatsApp"
  echo "  - Todas as mídias"
  echo "  - Dados de todas as contas"
  read -r -p "Confirmar reset total? (digite 'RESET'): " CONFIRM
  if [[ "$CONFIRM" != "RESET" ]]; then
    echo "Cancelado."
    return 1
  fi

  reset_database
  reset_sessions
  reset_auth
  reset_media
  print_success "Reset completo concluído"
}

reset_database() {
  if [[ -d "$DB_DIR" ]]; then
    rm -f "$DB_DIR/db.sqlite" "$DB_DIR/db.sqlite-shm" "$DB_DIR/db.sqlite-wal"
    print_success "Banco de dados removido"
  fi
}

reset_sessions() {
  # Sessões na raiz
  if [[ -d "$DATA_DIR" ]]; then
    find "$DATA_DIR" -name "sessions.db*" -delete 2>/dev/null || true
    print_success "Sessões removidas"
  fi
}

reset_auth() {
  # Auth do backend
  if [[ -d "$AUTH_DIR_BACKEND" ]]; then
    rm -rf "$AUTH_DIR_BACKEND"
    print_success "Autenticação WhatsApp removida"
  fi

  # Auth das contas
  if [[ -d "$ACCOUNTS_DIR" ]]; then
    find "$ACCOUNTS_DIR" -type d -name "wa-auth" -exec rm -rf {} + 2>/dev/null || true
    print_success "Autenticações das contas removidas"
  fi

  # Auth do staging
  if [[ -d "$STAGING_DIR/wa-auth" ]]; then
    rm -rf "$STAGING_DIR/wa-auth"
    print_success "Autenticação de staging removida"
  fi
}

reset_media() {
  if [[ -d "$MEDIA_DIR" ]]; then
    rm -rf "$MEDIA_DIR/images"/* "$MEDIA_DIR/videos"/* "$MEDIA_DIR/audios"/* "$MEDIA_DIR/stickers"/* 2>/dev/null || true
    print_success "Mídias removidas"
  fi
}

reset_accounts() {
  if [[ -d "$ACCOUNTS_DIR" ]]; then
    read -r -p "Apagar dados de TODAS as contas? (digite 'DELETE'): " CONFIRM
    if [[ "$CONFIRM" == "DELETE" ]]; then
      rm -rf "$ACCOUNTS_DIR"
      rm -f "$DATA_DIR/active-account.json"
      print_success "Dados de contas removidos"
    fi
  fi
}

# Main
case "${1:-menu}" in
  all)
    reset_all
    ;;
  db)
    reset_database
    print_success "Banco de dados resetado"
    ;;
  sessions)
    reset_sessions
    print_success "Sessões resetadas"
    ;;
  auth)
    reset_auth
    print_success "Autenticações resetadas"
    ;;
  media)
    reset_media
    print_success "Mídias resetadas"
    ;;
  accounts)
    reset_accounts
    ;;
  menu)
    show_menu
    case "$CHOICE" in
      1) reset_all ;;
      2) reset_database && print_success "Banco de dados resetado" ;;
      3) reset_auth && print_success "Autenticação resetada" ;;
      4) reset_media && print_success "Mídias resetadas" ;;
      5) reset_sessions && print_success "Sessões resetadas" ;;
      0) echo "Cancelado." ;;
      *) print_error "Opção inválida" ;;
    esac
    ;;
  *)
    print_error "Uso: $0 {all|db|sessions|auth|media|accounts|menu}"
    echo "Exemplos:"
    echo "  $0 all         # Reset completo"
    echo "  $0 db          # Reset só do banco"
    echo "  $0 auth        # Reset só do WhatsApp"
    echo "  $0 media       # Reset só de mídias"
    echo "  $0 menu        # Menu interativo"
    exit 1
    ;;
esac

echo ""
print_header "Reset concluído"
echo "Próximos passos:"
echo "1. Inicie o backend: ./start.sh"
echo "2. Reconecte o WhatsApp e escaneie o QR code"
echo "3. O sistema recriará o banco de dados automaticamente"
