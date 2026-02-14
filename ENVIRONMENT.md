# Configuração de Variáveis de Ambiente

## 📁 Onde colocar as variáveis

### 1. **Para desenvolvimento local:**

```bash
# Na raiz do projeto, copie o exemplo:
cp .env.example .env

# Edite o arquivo .env com suas configurações:
nano .env  # ou use seu editor preferido
```

O Node.js carrega automaticamente via `require('dotenv').config()` (se instalar dotenv) ou você pode exportar manualmente:

```bash
export SESSION_SECRET="seu-secret-aqui"
export NODE_ENV=development
node backend/index.js
```

### 2. **Para produção (servidor Linux):**

**Opção A - Arquivo .env (mais simples):**
```bash
# No servidor, crie o arquivo .env
sudo nano /home/app/whatsapp-system/.env

# Cole as variáveis de produção:
NODE_ENV=production
SESSION_SECRET="gere-um-secret-forte-aqui"
CORS_ORIGIN="https://app.suaempresa.com"
# ... outras variáveis
```

**Opção B - Systemd service (mais seguro):**
```bash
# Crie o service file
sudo nano /etc/systemd/system/whatsapp-system.service

# Conteúdo:
[Unit]
Description=WhatsApp System
After=network.target

[Service]
Type=simple
User=app
WorkingDirectory=/home/app/whatsapp-system/backend
Environment="NODE_ENV=production"
Environment="SESSION_SECRET=seu-secret-aqui"
Environment="CORS_ORIGIN=https://app.suaempresa.com"
ExecStart=/usr/bin/node index.js
Restart=always

[Install]
WantedBy=multi-user.target
```

**Opção C - Docker (containerizado):**
```bash
# docker-compose.yml
version: '3.8'
services:
  whatsapp-system:
    build: .
    environment:
      - NODE_ENV=production
      - SESSION_SECRET=${SESSION_SECRET}
      - CORS_ORIGIN=${CORS_ORIGIN}
    env_file:
      - .env.production
```

### 3. **Para plataformas de cloud (Heroku, Render, etc):**

Configure via dashboard da plataforma:
- **Heroku**: Settings → Config Vars
- **Render**: Environment → Environment Variables
- **Railway**: Variables tab
- **Vercel**: Settings → Environment Variables

---

## 🔒 Valores críticos para produção

### Gere um SESSION_SECRET forte:
```bash
# Linux/Mac:
openssl rand -base64 32

# Node.js:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### Configuração mínima para produção:
```bash
NODE_ENV=production
SESSION_SECRET="<saída do comando acima>"
CORS_ORIGIN="https://seu-dominio.com"
```

---

## 🔌 Separar frontend e backend (API apenas)

Se você vai hospedar o frontend em outro domínio, configure o backend como **API-only** e ajuste CORS/cookies:

```bash
# Não servir arquivos do frontend pelo backend
SERVE_FRONTEND=0

# Domínios permitidos do frontend (separados por vírgula)
CORS_ORIGIN="https://app.suaempresa.com"

# Cookies de sessão para cross-site
COOKIE_SAMESITE=none
COOKIE_SECURE=1

# (Opcional) Para dev em HTTP sem HTTPS
# ALLOW_INSECURE_COOKIES=1
# COOKIE_SECURE=0
```

> Default recomendado: `SERVE_FRONTEND=0` (backend API-only).
> Para modo legado (monolítico), defina `SERVE_FRONTEND=1`.

### Frontend

Edite o arquivo [frontend/config.js](frontend/config.js) para definir a URL da API:

```js
window.API_BASE = 'https://api.suaempresa.com';
```

Servidor frontend local separado (porta 8080 por padrão):

```bash
./start-frontend start
# ou
npm run start:frontend
```

---

## 🚦 Rate limit (grande porte)

Por padrão, o backend usa rate limiting por **usuário autenticado (sessão)** e cai para **IP** quando não há sessão.
Em empresas grandes, o problema mais comum é o rate limit contar **assets do frontend** e/ou ser baixo demais para muitas abas e automações internas.

Variáveis principais:

```bash
# Janela do rate limit (padrão: 10s). Janelas menores evitam bloqueios longos após picos.
GENERAL_RATE_WINDOW_MS=10000

# Limites por janela (padrões pensados para alta concorrência)
AUTH_GENERAL_RATE_MAX_ATTEMPTS=1000
ANON_GENERAL_RATE_MAX_ATTEMPTS=200

# Compatibilidade (se setar esta, sobrescreve auth/anon)
# GENERAL_RATE_MAX_ATTEMPTS=1000

# Para rotas de criação (ex.: criar vendedor)
CREATE_RATE_WINDOW_MS=60000
CREATE_RATE_MAX_ATTEMPTS=30

# Desabilitar rate limit (use só para diagnóstico)
# DISABLE_RATE_LIMIT=1
```

### Rate limit distribuído (Redis)

Se você roda **mais de 1 instância** (PM2 cluster/Kubernetes/etc), configure Redis para que o rate limiting seja consistente entre instâncias:

```bash
RATE_LIMIT_REDIS_URL=redis://localhost:6379
# ou use REDIS_URL=...
```

---

## 🧠 Sessões (grande porte / múltiplas instâncias)

Por padrão, as sessões usam SQLite local. Para escalar horizontalmente (várias instâncias), use Redis:

```bash
SESSION_STORE=redis
SESSION_REDIS_URL=redis://localhost:6379
# ou use REDIS_URL=...
```

> Observação: atrás de proxy/load balancer, configure também `TRUST_PROXY=1` (ou o número de proxies) para o Express calcular IP/cookies corretamente.

---

## 📶 WhatsApp 24/7 (estabilidade máxima)

Para reduzir quedas e recuperar rápido após falhas de rede, ajuste:

```bash
# Backoff de reconexão
WA_RECONNECT_INITIAL_DELAY_MS=2000
WA_RECONNECT_MAX_DELAY_MS=30000
WA_RECONNECT_MAX_ATTEMPTS=10
WA_RECONNECT_BACKOFF_MULTIPLIER=1.5
WA_RECONNECT_JITTER_PCT=0.15

# Detecção de conexão travada
WA_CONNECTING_TIMEOUT_MS=45000
WA_HEARTBEAT_INTERVAL_MS=30000
WA_HEARTBEAT_MAX_MISSED=3
WA_WATCHDOG_INTERVAL_MS=60000
WA_WATCHDOG_STALE_THRESHOLD_MS=90000

# Conflito de sessão (quando outro dispositivo assume)
WA_MAX_CONFLICTS_BEFORE_LOGOUT=3

# Cache da versão do Baileys (evita falha por indisponibilidade temporária)
WA_VERSION_CACHE_MS=21600000
```

Recomendação prática para servidor:
- rode apenas **1 instância** do processo WhatsApp por número
- mantenha relógio/NTP sincronizado
- use supervisor (`systemd`/PM2) com restart automático

---

## ⚠️ Importante

- ✅ O arquivo `.env` está no `.gitignore` (nunca commite credenciais)
- ✅ Use `.env.example` como template (sem valores reais)
- ✅ Gere um `SESSION_SECRET` único por ambiente
- ✅ Em produção, sempre use `NODE_ENV=production`
- ✅ Configure `CORS_ORIGIN` com seus domínios reais

---

## 📝 Exemplo de .env completo para produção:

```bash
NODE_ENV=production
SESSION_SECRET="K8x7pQm3vZn2JdF9wRtY4hGbL6sNcA5e"
CORS_ORIGIN="https://app.suaempresa.com,https://admin.suaempresa.com"
BCRYPT_ROUNDS=12
LOG_LEVEL=warn

# Proxy/LB
TRUST_PROXY=1

# Rate limit (alta concorrência)
GENERAL_RATE_WINDOW_MS=10000
AUTH_GENERAL_RATE_MAX_ATTEMPTS=1000
ANON_GENERAL_RATE_MAX_ATTEMPTS=200

# Redis (recomendado para múltiplas instâncias)
SESSION_STORE=redis
REDIS_URL="redis://127.0.0.1:6379"
```
