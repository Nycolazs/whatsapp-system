# WhatsApp System 📱

Um sistema completo de atendimento ao cliente integrado com WhatsApp, permitindo gerenciamento de tickets, atribuição de vendedores e conversas em tempo real.

## 📋 Características

- ✅ **Integração WhatsApp**: Recebe mensagens do WhatsApp em tempo real
- ✅ **Sistema de Tickets**: Gerenciamento automático de conversas
- ✅ **Multi-Usuário**: Admin e múltiplos vendedores/agentes
- ✅ **Atribuição de Tickets**: Admin atribui tickets para vendedores
- ✅ **Blacklist**: Filtra números indesejados automaticamente
- ✅ **Mensagens Automáticas**: Resposta automática ao cliente
- ✅ **Status de Ticket**: Pendente → Em Atendimento → Resolvido
- ✅ **Suporte a Mídia**: Imagens, áudios e documentos
- ✅ **Interface Responsiva**: Funciona em desktop e mobile
- ✅ **Atualização em Tempo Real**: Atualiza lista de tickets a cada 500ms

## 🛠️ Tecnologias Utilizadas

### Backend
- **Node.js** - Runtime JavaScript
- **Express.js** - Framework web
- **Baileys** - Biblioteca WhatsApp
- **SQLite** - Banco de dados
- **better-sqlite3** - Driver SQLite

### Frontend
- **HTML5/CSS3** - Interface
- **JavaScript Vanilla** - Interatividade
- **Fetch API** - Comunicação com backend

## 📦 Requisitos

- Node.js 14+
- npm ou yarn
- Conexão com internet

## 🚀 Como Instalar e Subir

### 1. Clonar/Extrair o Projeto

```bash
cd /caminho/do/projeto/whatsapp-system
```

### 2. Instalar Dependências

```bash
npm install
```

### 3. Iniciar o Servidor

```bash
./start.sh
```

Ou diretamente:

```bash
node backend/index.js
```

O servidor iniciará na porta **3000**.

### Primeira Execução
- Admin padrão: `admin` / `admin`
- Vendedor 1: `João` / `123456`
- Vendedor 2: `Maria` / `123456`

## 💻 Acessar a Aplicação

### No Computador (Desktop)
```
http://localhost:3000
```

### Na Rede Local (Mobile/Outro Computador)
Primeiro, descubra o IP do seu computador:
```bash
ip addr show | grep "inet " | grep -v 127.0.0.1
```

Exemplo de saída: `192.168.1.100`

Acesse no navegador:
```
http://192.168.1.100:3000
```

## 🔐 Configuração Inicial

### 1. Login
Acesse a página de login e entre como:
- **Admin** para gerenciar vendedores e todos os tickets
- **Vendedor** para atender tickets atribuídos

### 2. Conectar WhatsApp
Ao iniciar o servidor, aparecerá um QR code no terminal. Escaneie com seu celular para conectar o WhatsApp.

### 3. Adicionar à Blacklist
Acesse `/blacklist-ui` para gerenciar números bloqueados. Apenas números na blacklist receberão atendimento.

### 4. Gerenciar Vendedores (Admin)
Acesse `/admin-sellers` para:
- Criar novos vendedores
- Editar dados de vendedores
- Desativar vendedores
- Atribuir tickets

## 📂 Estrutura do Projeto

```
whatsapp-system/
├── backend/
│   ├── index.js           # Servidor Express principal
│   ├── baileys.js         # Integração WhatsApp
│   ├── db.js              # Banco de dados SQLite
│   ├── auth.js            # Autenticação (se usado)
│   ├── routes.js          # Rotas (se separadas)
│   ├── auth/              # Credenciais WhatsApp
│   └── package.json       # Dependências
├── frontend/
│   ├── index.html         # Página de login
│   ├── agent.html         # Interface de atendimento
│   ├── admin-sellers.html # Gerenciamento de vendedores
│   ├── blacklist.html     # Gerenciamento de blacklist
│   └── admin.html         # Admin (deprecated)
├── data/
│   └── db.sqlite          # Banco de dados
├── media/
│   └── audios/            # Áudios recebidos
├── auth/                  # Sessões WhatsApp
├── start.sh               # Script de inicialização
├── package.json           # Dependências root
└── README.md              # Este arquivo
```

## 🔌 Endpoints da API

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

## 🎯 Fluxo de Uso

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

## 📱 Interface Mobile

A aplicação é totalmente responsiva:
- **Desktop (>768px)**: Painel duplo (lista + chat)
- **Tablet (480-768px)**: Modo alternado (clica para abrir/fechar)
- **Mobile (<480px)**: Stack vertical otimizado

Botão de voltar (←) aparece automaticamente em mobile.

## 🔒 Segurança

- ✅ Autenticação com sessão
- ✅ Senhas com hash SHA-256
- ✅ CORS configurado para rede local
- ✅ Validação de entrada
- ✅ Isolamento de dados por usuário

## ⚙️ Variáveis Importantes

### Backend (backend/index.js)
```javascript
const API_URL = 'http://localhost:3000';  // URL da API
const PORT = 3000;                         // Porta do servidor
```

### Frontend (Frontend HTML)
```javascript
const API_URL = `http://${window.location.hostname}:3000`;  // URL dinâmica
```

## 📊 Banco de Dados

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
# Escaneie o QR code com seu celular
```

### Porta 3000 já em uso
```bash
# Encontre o processo usando a porta
lsof -i :3000
# Mate o processo
kill -9 <PID>
```

### Banco de dados corrompido
```bash
# Limpe e recrie
rm data/db.sqlite
node backend/index.js
# Sistema recriará automaticamente
```

### Mensagens não aparecem
Verifique:
1. WhatsApp está conectado (status na interface)
2. Número está na blacklist
3. Aplicação está rodando (`./start.sh`)
4. Browser foi atualizado (F5)

## 🚀 Deploy em Produção

### Antes de fazer deploy:

1. **Alterar senha admin**
   ```sql
   sqlite3 data/db.sqlite
   UPDATE users SET password = 'sua_nova_senha' WHERE username = 'admin';
   .quit
   ```

2. **Removers logs de debug**
   ✅ Já removidos nesta versão

3. **Configurar CORS para domínio específico**
   ```javascript
   // backend/index.js
   app.use(cors({
     origin: 'seu-dominio.com',
     credentials: true
   }));
   ```

4. **Usar PM2 para manter o serviço rodando**
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
- Faça backup regular do `data/db.sqlite`
- Monitore a conexão WhatsApp regularmente
- Teste números na blacklist antes de usar em produção

## 📞 Suporte

Para problemas:
1. Verifique os logs do console
2. Teste a conectividade (GET /connection-status)
3. Limpe cache do navegador (Ctrl+Shift+Del)
4. Reinicie o servidor

## 📄 Licença

Este projeto é de uso interno. Direitos reservados.

---

**Última atualização**: Janeiro de 2026
**Versão**: 1.0.0
**Status**: Pronto para Produção ✅
