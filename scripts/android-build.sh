#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID_DIR="$ROOT_DIR/android"

if [[ ! -d "$ANDROID_DIR" ]]; then
  echo "Erro: diretório Android não encontrado em $ANDROID_DIR" >&2
  echo "Execute primeiro: npx cap add android" >&2
  exit 1
fi

TASK="${1:-assembleDebug}"
shift || true

if [[ -z "${JAVA_HOME:-}" ]]; then
  if command -v /usr/libexec/java_home >/dev/null 2>&1; then
    JAVA_HOME="$(/usr/libexec/java_home -v 21 2>/dev/null || true)"
  fi
fi

if [[ -z "${JAVA_HOME:-}" && -d "/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home" ]]; then
  JAVA_HOME="/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home"
fi

if [[ -n "${JAVA_HOME:-}" ]]; then
  export JAVA_HOME
  export PATH="$JAVA_HOME/bin:$PATH"
fi

if ! command -v java >/dev/null 2>&1; then
  echo "Erro: Java não encontrado. Instale JDK 21 e configure JAVA_HOME." >&2
  exit 1
fi

JAVA_MAJOR="$(java -version 2>&1 | awk -F '[\".]' '/version/ {print $2; exit}')"
if [[ "${JAVA_MAJOR:-0}" -lt 21 ]]; then
  echo "Erro: JDK 21+ é obrigatório (detectado: $JAVA_MAJOR)." >&2
  exit 1
fi

if [[ -z "${ANDROID_SDK_ROOT:-}" ]]; then
  for candidate in "/opt/homebrew/share/android-commandlinetools" "$HOME/Library/Android/sdk"; do
    if [[ -d "$candidate" ]]; then
      ANDROID_SDK_ROOT="$candidate"
      break
    fi
  done
fi

if [[ -n "${ANDROID_SDK_ROOT:-}" ]]; then
  export ANDROID_SDK_ROOT
  export ANDROID_HOME="${ANDROID_HOME:-$ANDROID_SDK_ROOT}"
fi

cd "$ANDROID_DIR"
./gradlew "$TASK" "$@"
