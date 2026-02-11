# WhatsApp System - Guia de Inicialização (Frontend + Backend Separados)

## Portas padrão

- Frontend: `http://localhost:8080`
- Backend (API): `http://localhost:3001`

## Subir tudo

```bash
npm start
```

Isso inicia:
- backend em background (`./start`)
- frontend em background (`./start-frontend`)

## Comandos por serviço

### Backend (3001)
```bash
npm run start:backend
npm run stop:backend
npm run restart:backend
npm run status:backend
npm run logs
```

### Frontend (8080)
```bash
npm run start:frontend
npm run stop:frontend
npm run restart:frontend
npm run status:frontend
npm run logs:frontend
```

## Comandos gerais

```bash
npm run status   # status dos dois serviços
npm run stop     # para os dois serviços
npm run restart  # reinicia os dois serviços
```

## Troubleshooting rápido

Se o frontend não abrir:
```bash
npm run status:frontend
npm run logs:frontend
```

Se a API não responder:
```bash
npm run status:backend
npm run logs
```

