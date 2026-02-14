# WhatsApp System - Start rapido (Electron Only)

## Portas

- Backend API: `http://localhost:3001`
- Frontend interno: `http://127.0.0.1:8080` (somente Electron)

## Subir aplicacao desktop

```bash
npm run start
```

Esse comando sobe backend e abre o Electron.

## Controle por script

### Backend (`./start`)

```bash
./start start
./start stop
./start restart
./start status
./start tail
./start logs
./start reset
```

### Frontend interno (`./start-frontend`)

```bash
./start-frontend start
./start-frontend stop
./start-frontend restart
./start-frontend status
./start-frontend tail
./start-frontend logs
```

## Observacao importante

- Navegador comum nao e modo suportado.
- O frontend responde `403` fora do Electron.

## Builds desktop instalaveis

```bash
npm run electron:dist:mac
npm run electron:dist:win
```

Ou tudo em uma vez:

```bash
npm run electron:dist
```

Saida: `dist-electron/`

## Validacao pre-producao

```bash
npm run qa:smoke
```
