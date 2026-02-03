#!/bin/bash

echo "=========================================="
echo "Diagnóstico WhatsApp System"
echo "=========================================="
echo ""

# 1. Verifica se o servidor está rodando
echo "1. Verificando se o servidor está rodando..."
if pgrep -f "node.*backend/index.js" > /dev/null; then
    echo "✓ Servidor ESTÁ rodando"
    pgrep -f "node.*backend/index.js" | xargs ps -p
else
    echo "✗ Servidor NÃO está rodando"
    echo "  Execute: ./start-server.sh"
fi
echo ""

# 2. Verifica se a porta 3001 está escutando
echo "2. Verificando porta 3001..."
if ss -tuln 2>/dev/null | grep -q ":3001 " || netstat -tuln 2>/dev/null | grep -q ":3001 "; then
    echo "✓ Porta 3001 está ABERTA"
    ss -tuln 2>/dev/null | grep ":3001 " || netstat -tuln 2>/dev/null | grep ":3001 "
else
    echo "✗ Porta 3001 NÃO está escutando"
fi
echo ""

# 3. Testa conexão local
echo "3. Testando conexão localhost..."
if curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/health 2>/dev/null | grep -q "200"; then
    echo "✓ Servidor responde em localhost"
else
    echo "✗ Servidor NÃO responde em localhost"
fi
echo ""

# 4. Mostra IP da máquina
echo "4. IP desta máquina na rede local:"
ip addr show | grep "inet " | grep -v "127.0.0.1" | awk '{print "   " $2}' | head -3
echo ""

# 5. Verifica firewall
echo "5. Status do firewall:"
if command -v firewall-cmd &> /dev/null; then
    if sudo firewall-cmd --list-ports 2>/dev/null | grep -q "3001"; then
        echo "✓ Porta 3001 liberada no firewall"
    else
        echo "⚠ Porta 3001 pode estar bloqueada"
        echo "  Execute: sudo firewall-cmd --add-port=3001/tcp --permanent && sudo firewall-cmd --reload"
    fi
elif command -v ufw &> /dev/null; then
    if sudo ufw status 2>/dev/null | grep -q "3001"; then
        echo "✓ Porta 3001 liberada no UFW"
    else
        echo "⚠ Porta 3001 pode estar bloqueada"
        echo "  Execute: sudo ufw allow 3001/tcp"
    fi
else
    echo "  Firewall não detectado (firewalld/ufw)"
fi
echo ""

# 6. Testa API
echo "6. Testando endpoints da API..."
if curl -s http://localhost:3001/health 2>/dev/null | grep -q "ok"; then
    echo "✓ /health responde corretamente"
else
    echo "✗ /health não responde"
fi
echo ""

echo "=========================================="
echo "Resumo:"
echo "=========================================="
echo "Acesse no celular usando um dos IPs acima:"
echo "  http://SEU_IP:3001"
echo ""
echo "Se ainda não funcionar:"
echo "1. Libere a porta no firewall (veja item 5)"
echo "2. Verifique se está na mesma rede WiFi"
echo "=========================================="
