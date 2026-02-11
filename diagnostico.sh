#!/bin/bash

echo "=========================================="
echo "Diagnóstico WhatsApp System"
echo "=========================================="
echo ""

# 1. Verifica se o servidor está rodando
echo "1. Verificando se o servidor está rodando..."
if pgrep -f "node.*backend/index.js" > /dev/null; then
    echo "✓ Backend ESTÁ rodando"
    pgrep -f "node.*backend/index.js" | xargs ps -p
else
    echo "✗ Backend NÃO está rodando"
    echo "  Execute: npm run start:backend"
fi
echo ""

# 2. Verifica se a porta 3001 está escutando
echo "2. Verificando backend (porta 3001)..."
if ss -tuln 2>/dev/null | grep -q ":3001 " || netstat -tuln 2>/dev/null | grep -q ":3001 "; then
    echo "✓ Porta 3001 está ABERTA (backend)"
    ss -tuln 2>/dev/null | grep ":3001 " || netstat -tuln 2>/dev/null | grep ":3001 "
else
    echo "✗ Porta 3001 NÃO está escutando"
fi
echo ""

# 3. Verifica se a porta 8080 está escutando
echo "3. Verificando frontend (porta 8080)..."
if ss -tuln 2>/dev/null | grep -q ":8080 " || netstat -tuln 2>/dev/null | grep -q ":8080 "; then
    echo "✓ Porta 8080 está ABERTA (frontend)"
    ss -tuln 2>/dev/null | grep ":8080 " || netstat -tuln 2>/dev/null | grep ":8080 "
else
    echo "✗ Porta 8080 NÃO está escutando"
    echo "  Execute: npm run start:frontend"
fi
echo ""

# 4. Testa conexão local (API)
echo "4. Testando conexão API localhost..."
if curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/healthz 2>/dev/null | grep -q "200"; then
    echo "✓ API responde em localhost"
else
    echo "✗ API NÃO responde em localhost"
fi
echo ""

# 5. Testa conexão local (frontend)
echo "5. Testando frontend localhost..."
if curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/login 2>/dev/null | grep -q "200"; then
    echo "✓ Frontend responde em localhost"
else
    echo "✗ Frontend NÃO responde em localhost"
fi
echo ""

# 6. Mostra IP da máquina
echo "6. IP desta máquina na rede local:"
ip addr show | grep "inet " | grep -v "127.0.0.1" | awk '{print "   " $2}' | head -3
echo ""

# 7. Verifica firewall
echo "7. Status do firewall:"
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

# 8. Testa API
echo "8. Testando endpoints da API..."
if curl -s http://localhost:3001/healthz 2>/dev/null | grep -q "\"ok\":true"; then
    echo "✓ /healthz responde corretamente"
else
    echo "✗ /healthz não responde"
fi
echo ""

echo "=========================================="
echo "Resumo:"
echo "=========================================="
echo "Acesse no celular usando um dos IPs acima:"
echo "  Frontend: http://SEU_IP:8080"
echo "  API:      http://SEU_IP:3001"
echo ""
echo "Se ainda não funcionar:"
echo "1. Libere as portas 8080 e 3001 no firewall (veja item 7)"
echo "2. Verifique se está na mesma rede WiFi"
echo "=========================================="
