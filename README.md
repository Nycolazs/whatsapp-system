# WhatsApp System

Sistema de atendimento ao cliente via WhatsApp, com gestão de tickets, múltiplos usuários (admin/agentes) e interface web simples.

Este repositório foi organizado para execução local e também como base para evoluções de produção (segurança, observabilidade e estrutura de código).

## Sumário

- [Visão Geral](#visão-geral)
- [Principais Funcionalidades](#principais-funcionalidades)
- [Tecnologias](#tecnologias)
- [Arquitetura e Pastas](#arquitetura-e-pastas)
- [Como Rodar Localmente](#como-rodar-localmente)
- [Configuração Inicial](#configuração-inicial)
- [Acessar a Aplicação](#acessar-a-aplicação)
- [Endpoints da API](#endpoints-da-api)
- [Banco de Dados](#banco-de-dados)
- [Segurança (Notas e Próximos Passos)](#segurança-notas-e-próximos-passos)
- [Troubleshooting](#troubleshooting)
- [Deploy (Diretrizes)](#deploy-diretrizes)
- [Licença](#licença)

## Visão Geral

O backend mantém uma sessão com o WhatsApp (via Baileys) e expõe uma API HTTP consumida pelo frontend (HTML/CSS/JS). Quando um cliente envia mensagem:

1. o sistema cria/reabre um ticket
2. armazena mensagens no SQLite
3. permite que admin/agentes respondam pela interface web

## Principais Funcionalidades

- Integração com WhatsApp (QR Code e status de conexão)
- Sistema de tickets e mensagens
- Multiusuário (admin e agentes/vendedores)
- Atribuição de tickets (admin → agente)
- Blacklist de números
- Suporte a mídia (ex.: áudio)
- Configurações administrativas (ex.: horário comercial e auto-await)

## Tecnologias

**Backend**
- Node.js
- Express
- Baileys
- SQLite (better-sqlite3)
- express-session com store em SQLite

**Frontend**
- HTML/CSS
- JavaScript (vanilla)
- Fetch API

## Arquitetura e Pastas

```
whatsapp-system/
├── backend/
│   ├── index.js           # Entry-point do backend (Express + rotas)
│   ├── baileys.js         # Integração com WhatsApp
│   ├── db.js              # Persistência SQLite e migrações
│   ├── auth/              # Credenciais do WhatsApp (Baileys)
│   └── package.json
├── frontend/
│   ├── index.html         # Página de login
│   ├── agent.html         # Interface de atendimento
│   └── admin-sellers.html # Painel admin (vendedores, blacklist e horários)
├── data/
│   ├── active-account.json
│   ├── accounts/          # Dados por conta (db, sessions, wa-auth, backups)
│   └── staging/
├── media/
│   └── audios/            # Áudios recebidos
├── start.sh               # Script de inicialização
├── package.json           # Dependências root
└── README.md              # Este arquivo
```

## Como Rodar Localmente

### Requisitos

- Node.js 14+
- npm

### Instalação

Na raiz do projeto:

```bash
npm install
```

No backend (dependências específicas do backend):

```bash
cd backend
npm install
```

### Subir o servidor

Pela raiz do projeto:

```bash
./start.sh
```

Ou diretamente:

```bash
node backend/index.js
```

Por padrão, o servidor inicia na porta **3001**.

## Configuração Inicial

1. Inicie o backend.
2. Conecte o WhatsApp (escaneie o QR Code).
   - Se preferir exibir no navegador, use a tela de QR ou o endpoint de QR.
3. Crie o primeiro admin via tela de setup:
   - Acesse `/setup-admin` após o WhatsApp estar conectado.
4. No painel admin (`/admin-sellers`), cadastre agentes/vendedores e comece a atribuir tickets.

Observação: alguns ambientes podem ter usuários já existentes (ex.: bases antigas). O fluxo recomendado para um ambiente novo é sempre `/setup-admin`.

## Acessar a Aplicação

### No computador (desktop)

`http://localhost:3001`

### Na rede local (mobile/outro computador)

Descubra o IP do seu computador:

```bash
ip addr show | grep "inet " | grep -v 127.0.0.1
```

Depois acesse:

`http://SEU_IP:3001`

## Endpoints da API

### Autenticação
- `POST /auth/login` - Fazer login
- `GET /auth/session` - Verificar sessão
- `POST /auth/logout` - Fazer logout

### Tickets
- `GET /tickets` - Listar tickets do usuário autenticado
- `GET /admin/tickets` - Listar todos (apenas admin)
- `GET /tickets/:id/messages` - Mensagens de um ticket
- `POST /tickets/:id/send` - Enviar mensagem
- `PATCH /tickets/:id/status` - Atualizar status
- `POST /tickets/:id/assign` - Atribuir a vendedor

### Vendedores
- `GET /sellers` - Listar vendedores (admin)
- `POST /sellers` - Criar vendedor
- `PATCH /sellers/:id` - Editar vendedor
- `DELETE /sellers/:id` - Deletar vendedor

### Blacklist
- `GET /blacklist` - Listar números bloqueados
- `POST /blacklist` - Adicionar número
- `DELETE /blacklist/:phone` - Remover número

### Conexão WhatsApp
- `GET /connection-status` - Status da conexão

## Fluxo de Uso

1. **Cliente envia mensagem no WhatsApp**
   ↓
2. **Sistema recebe e cria/reabre ticket**
   ↓
3. **Envia resposta automática ao cliente**
   ↓
4. **Apareça no painel de atendimento**
   ↓
5. **Vendedor/Admin responde**
   ↓
6. **Marca como resolvido**
   ↓
7. **Conversa fecha e some da lista**

## Interface Mobile

A aplicação é totalmente responsiva:
- **Desktop (>768px)**: Painel duplo (lista + chat)
- **Tablet (480-768px)**: Modo alternado (clica para abrir/fechar)
- **Mobile (<480px)**: Stack vertical otimizado

Botão de voltar (←) aparece automaticamente em mobile.

## Segurança (Notas e Próximos Passos)

O projeto já possui autenticação baseada em sessão e armazenamento persistente. Para uso profissional, considere:

- **Segredos em variáveis de ambiente**: mover o `session secret` para `SESSION_SECRET`.
- **CORS restrito**: permitir apenas origens confiáveis em produção.
- **Cookies seguros**: habilitar `secure` atrás de HTTPS e ajustar `sameSite`.
- **Rate limiting**: proteger endpoints de autenticação e envio.
- **Senha**: hoje há hash SHA-256 em alguns fluxos; uma evolução recomendada é migrar para `bcrypt` com re-hash gradual.

Esses itens podem ser feitos sem quebrar o comportamento atual, desde que implementados com defaults compatíveis (dev permissivo, prod restrito).

Variáveis úteis:

- `SESSION_SECRET`: segredo do `express-session`.
- `CORS_ORIGIN`: lista separada por vírgula de origens permitidas (ex.: `https://app.suaempresa.com,https://admin.suaempresa.com`).
- `LOG_LEVEL`: nível do logger (`error`, `warn`, `info`, `debug`, `trace`). Default: `info`.
- `DEBUG_TICKETS_REPLY`: quando `1`, habilita logs extras ao enviar respostas em tickets.
- `DEBUG_MEDIA_LOGS`: quando `1`, habilita logs extras ao salvar mídias recebidas do WhatsApp.
- `DEBUG_RECEIVE_LOGS`: quando `1`, habilita logs extras ao persistir mensagens recebidas.

## Banco de Dados

Tabelas criadas automaticamente:

- **sellers** - Vendedores/agentes
- **users** - Usuários admin
- **tickets** - Conversas/tickets
- **messages** - Mensagens
- **blacklist** - Números bloqueados

## 🐛 Troubleshooting

### WhatsApp não conecta
```bash
# Limpe as credenciais e tente novamente
rm -rf backend/auth/*
node backend/index.js
```

### Porta 3001 já em uso
```bash
# Encontre o processo usando a porta
lsof -i :3001
# Mate o processo
kill -9 <PID>
```

### Banco de dados corrompido
```bash
# Limpe e recrie (bases legadas)
rm -f data/db/db.sqlite
node backend/index.js
```

### Mensagens não aparecem
Verifique:
1. WhatsApp está conectado (status na interface)
2. Número está na blacklist
3. Aplicação está rodando (`./start.sh`)
4. Browser foi atualizado (F5)

## Deploy (Diretrizes)

Em produção, priorize:

1. Rodar atrás de HTTPS (reverse proxy como Nginx/Caddy).
2. Definir `SESSION_SECRET` e restringir CORS.
3. Usar um process manager (PM2 ou systemd).

Exemplo com PM2:

```bash
npm install -g pm2
pm2 start backend/index.js --name "whatsapp-system"
pm2 startup
pm2 save
```

## 📝 Logs e Monitoramento

Os logs são exibidos no console durante execução. Para production:

```bash
./start.sh > logs.txt 2>&1 &
tail -f logs.txt
```

## 💡 Dicas

- Mantenha o servidor rodando continuamente para receber mensagens
- Use PM2 ou systemd para auto-reiniciar em caso de falha
- Faça backup regular do `data/db/db.sqlite`
- Monitore a conexão WhatsApp regularmente
- Teste números na blacklist antes de usar em produção

## 📞 Suporte

Para problemas:
1. Verifique os logs do console
2. Teste a conectividade (GET /connection-status)
3. Limpe cache do navegador (Ctrl+Shift+Del)
4. Reinicie o servidor

## 📄 Licença

Este projeto está como “uso interno” no momento. Se a intenção for apresentação pública, considere definir uma licença (MIT, Apache-2.0 etc.) e ajustar o texto.

---

**Última atualização**: Fevereiro de 2026
**Versão**: 1.0.0
