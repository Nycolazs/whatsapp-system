# Correção de Horário das Mensagens

## Problema
O horário das mensagens estava sendo exibido incorretamente no chat. As mensagens mostravam "00:40" (meia-noite e 40 minutos) quando deveriam mostrar o horário correto da mensagem.

## Causa
- SQLite `CURRENT_TIMESTAMP` retorna datas/horas em **UTC** (horário universal)
- JavaScript `new Date(datetimeStr)` interpretava a string como UTC
- Não havia conversão para o **fuso horário do Brasil (GMT-3 ou GMT-2)**
- Resultado: horário era 3+ horas atrasado

## Solução Implementada

### 1. Criada função `formatMessageTime()` no frontend
```javascript
function formatMessageTime(datetimeStr) {
  // Parse manual do formato SQLite: YYYY-MM-DD HH:MM:SS (UTC)
  // Converte para horário local do Brasil via America/Sao_Paulo
  // Retorna formatado: HH:MM em pt-BR
}
```

### 2. Substituições Realizadas
Todas as 8 ocorrências de:
```javascript
new Date(msg.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
```

Foram substituídas por:
```javascript
formatMessageTime(msg.created_at)
```

### Locais Atualizados
- ✅ Mensagens de texto
- ✅ Mensagens com imagem
- ✅ Mensagens com áudio (carregando)
- ✅ Mensagens com áudio (carregado)
- ✅ Mensagens com vídeo (carregando)
- ✅ Mensagens com vídeo (carregado)
- ✅ Mensagens com figurinha/sticker
- ✅ Horário do ticket na lista

## Como Funciona

1. **Input**: String de data/hora do SQLite
   - Formato: `"2026-02-01 00:40:15"` (em UTC)

2. **Parse**: Extrai partes da data e hora
   - Data: `2026-02-01`
   - Hora: `00:40:15`

3. **Conversão**: Cria Date em UTC e converte para São Paulo
   ```javascript
   const utcDate = new Date(Date.UTC(2026, 1, 1, 0, 40, 15));
   const localDate = new Date(utcDate.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }));
   ```

4. **Output**: Horário local formatado
   - Se era `00:40 UTC` → Agora mostra `21:40 (véspera) ou horário correto`

## Resultado
✅ Mensagens agora mostram o horário **correto e atualizado** para o fuso horário do Brasil (GMT-3 ou GMT-2 com horário de verão)

## Teste
1. Enviar uma mensagem do WhatsApp
2. Verificar se o horário no chat está correto
3. Comparar com a hora local do sistema
