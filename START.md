# WhatsApp System - Guia de Inicialização

## 🚀 Como usar

### Modo Interativo (Menu)
```bash
./start
```

Abre um menu onde você pode escolher:
1. Iniciar servidor
2. Parar servidor
3. Reiniciar servidor
4. Ver status
5. Resetar banco de dados
6. Limpar logs

### Modo Linha de Comando
```bash
./start start      # Iniciar
./start stop       # Parar
./start restart    # Reiniciar
./start status     # Ver status
./start reset      # Resetar banco (CUIDADO!)
./start logs       # Limpar logs
./start tail       # Ver logs em tempo real
```

### Via npm (raiz do projeto)
```bash
npm start          # Inicia em background (equivalente a ./start start)
npm run stop       # Para o servidor
npm run restart    # Reinicia
npm run status     # Status
npm run logs       # Ver logs em tempo real
```

## 📍 Acesso

Após iniciar o servidor:
- **Local**: http://localhost:3001
- **Rede**: http://seu-ip:3001

## 📋 Requisitos

- Node.js 14+
- npm
- Bash

## 🔄 Como funciona

O script automáticamente:
- ✅ Para qualquer servidor anterior (se rodando)
- ✅ Inicia o servidor em background
- ✅ Guarda o PID para controle
- ✅ Mostra o status e acessos
- ✅ Mantém logs centralizados

## 🛠️ Troubleshooting

**Servidor não inicia?**
```bash
./start logs    # Limpar logs antigos
./start restart # Reiniciar
```

**Quer ver o log em tempo real?**
```bash
tail -f server.log
```

**Kill forçado (último recurso)?**
```bash
pkill -f "node.*backend"
```
