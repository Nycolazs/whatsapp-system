# 🌐 Como Acessar de Outro Computador

## ✅ Servidor está funcionando!

O servidor está rodando e acessível em:
- **Neste computador**: http://localhost:3001
- **Na rede local**: http://192.168.0.75:3001

---

## 📱 Para acessar de OUTRO computador na mesma rede:

### 1. Verifique se estão na mesma rede WiFi/LAN
Ambos os computadores devem estar conectados à mesma rede (mesmo roteador).

### 2. No outro computador, abra o navegador e digite:
```
http://192.168.0.75:3001
```

### 3. Se não funcionar, teste:

#### A) Verifique o firewall deste computador (servidor):
```bash
# Verificar se firewall está bloqueando
sudo firewall-cmd --list-all 2>/dev/null || sudo iptables -L -n | grep 3001 || echo "Sem firewall ativo"

# Se necessário, liberar a porta (apenas uma vez):
sudo firewall-cmd --permanent --add-port=3001/tcp && sudo firewall-cmd --reload
# OU para iptables:
sudo iptables -I INPUT -p tcp --dport 3001 -j ACCEPT
```

#### B) Teste de conectividade do outro PC:
No outro computador, abra o terminal/cmd e teste:
```bash
# Windows (cmd):
ping 192.168.0.75

# Linux/Mac:
ping -c 4 192.168.0.75
curl http://192.168.0.75:3001
```

#### C) Verifique o IP atual:
O IP pode mudar se você se conectar a outra rede. Para ver o IP atual:
```bash
./start status
```

---

## 🔍 Troubleshooting

### O IP mudou?
Execute `./start status` para ver o IP atualizado.

### Firewall bloqueando?
```bash
# Fedora/RHEL/CentOS:
sudo firewall-cmd --permanent --add-port=3001/tcp
sudo firewall-cmd --reload

# Ubuntu/Debian (se tiver ufw):
sudo ufw allow 3001/tcp
sudo ufw reload

# Verificar se porta está aberta:
sudo ss -ltnp | grep :3001
```

### Testou tudo e não funciona?
- Ambos estão na MESMA rede WiFi?
- Há firewall no roteador bloqueando comunicação interna?
- O outro PC tem firewall bloqueando saída para 3001?

---

## 📞 Testado e Funcionando

✅ Servidor ouvindo em: `0.0.0.0:3001` (todas as interfaces)  
✅ Responde localmente: `http://127.0.0.1:3001` → OK  
✅ Responde pelo IP: `http://192.168.0.75:3001` → OK

Se o teste acima passou, o problema não é no servidor, é na rede/firewall entre os computadores.
