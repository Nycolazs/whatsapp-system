# WhatsApp System

Sistema de atendimento WhatsApp com backend/API em Node.js e interface desktop em Electron.

## Diretriz de execucao

- O produto deve rodar somente no Electron.
- O servidor de frontend local (`127.0.0.1:8080`) esta em modo `electron-only`.
- Acesso via navegador comum retorna `403` por design.

## Arquitetura

- Backend API: `http://localhost:3001`
- Frontend interno do app: `http://127.0.0.1:8080` (uso interno do Electron)
- Banco: SQLite por conta
- Sessao WhatsApp: Baileys no backend

## Requisitos

- Node.js 18+
- npm
- macOS/Linux/Windows

## Instalacao

```bash
npm install
cd backend && npm install && cd ..
```

## Inicio rapido (Desktop)

Comando principal para abrir o app desktop:

```bash
npm run start
```

Esse comando:
1. sobe o backend em background
2. abre o Electron
3. sobe o frontend interno automaticamente quando necessario

## Scripts oficiais por servico

### Backend (script unico)

Arquivo: `./start`

```bash
./start start
./start stop
./start restart
./start status
./start tail
./start logs
./start reset
```

### Frontend local (script unico)

Arquivo: `./start-frontend`

```bash
./start-frontend start
./start-frontend stop
./start-frontend restart
./start-frontend status
./start-frontend tail
./start-frontend logs
```

Observacao:
- esse frontend e interno para o Electron
- em navegador comum, o acesso fica bloqueado

## Scripts npm mais usados

```bash
npm run start              # inicia backend e abre Electron
npm run stop               # para backend + frontend interno
npm run status             # status backend + frontend interno
npm run logs               # tail do backend
npm run logs:frontend      # tail do frontend interno
npm run electron:start     # igual ao start (desktop)
npm run qa:smoke           # smoke test completo (backend + frontend)
```

## Build desktop instalavel

Gerar instaladores/artefatos:

```bash
npm run electron:dist:mac
npm run electron:dist:win
```

Ou gerar macOS + Windows em uma vez:

```bash
npm run electron:dist
```

Saida em `dist-electron/`.

Artefatos esperados:
- macOS: `.dmg` e `.zip`
- Windows: instalador `.exe` (NSIS) e `.zip`

## Android (mantido)

```bash
npm run android:sync
npm run android:build:debug
npm run android:build:release
npm run android:bundle:release
npm run android:open
```

## Troubleshooting

Backend nao sobe:

```bash
./start status
./start tail
```

Frontend interno nao sobe:

```bash
./start-frontend status
./start-frontend tail
```

Validar release antes de producao:

```bash
npm run qa:smoke
```

Electron nao abre:

```bash
npm run electron:start
```
