# 🔐 HTTPS Configurado com Sucesso!

## ✅ O que foi feito:

1. **Certificados SSL gerados** (`key.pem` e `cert.pem`)
   - Certificado self-signed válido por 365 dias
   - Localizado na raiz do projeto

2. **Backend atualizado** para suportar HTTPS
   - Mantém HTTP na porta 3001
   - Adiciona HTTPS na porta 3443
   - Ativa automaticamente quando encontra certificados

3. **Scripts atualizados**:
   - `start.sh` - detecta certificados automaticamente
   - `start-server.sh` - força uso de HTTPS com variáveis de ambiente

4. **Arquivos de configuração**:
   - `.env.example` atualizado com configurações HTTPS
   - `.gitignore` atualizado para não versionar certificados

## 🚀 Como usar:

### Iniciar com HTTPS:
```bash
./start-server.sh
```

Ou diretamente:
```bash
cd backend
HTTPS_KEY_PATH=../key.pem HTTPS_CERT_PATH=../cert.pem HTTPS_PORT=3443 node index.js
```

### Acessar o sistema:
- **HTTP:** http://localhost:3001 ou http://SEU_IP:3001
- **HTTPS:** https://localhost:3443 ou https://SEU_IP:3443 ⭐ **(use este para áudio funcionar via IP)**

### ⚠️ Aviso sobre certificado self-signed:
No primeiro acesso via HTTPS, o navegador mostrará um aviso de segurança porque o certificado é auto-assinado. Clique em "Avançado" e "Prosseguir para o site" para aceitar.

## 🎤 Áudio agora funciona via IP!

Com HTTPS configurado, a gravação/envio de áudio funcionará mesmo acessando pelo IP da máquina (ex: https://192.168.1.100:3443).

## 📝 Certificado em produção:

Para usar em produção com certificado válido (Let's Encrypt):
```bash
# Obter certificado válido (Let's Encrypt)
sudo certbot certonly --standalone -d seudominio.com

# Configurar no .env
HTTPS_KEY_PATH=/etc/letsencrypt/live/seudominio.com/privkey.pem
HTTPS_CERT_PATH=/etc/letsencrypt/live/seudominio.com/fullchain.pem
```
