# Funcionalidade de Envio de Áudio no Chat

## Adições Implementadas

### Frontend (agent.html)

#### 1. **Estilos CSS**
- `.audio-button`: Botão verde com ícone de microfone
- `.audio-button.recording`: Animação pulsante quando gravando
- `@keyframes pulse`: Animação de pulse

#### 2. **HTML**
```html
<button class="audio-button" onclick="triggerAudioFile()" title="Enviar áudio">
  🎤 Áudio
</button>
<input type="file" id="audioFileInput" accept="audio/*" onchange="sendAudioFile(event)">
```

#### 3. **Funções JavaScript**
- `triggerAudioFile()`: Abre o diálogo de seleção de arquivo
- `sendAudioFile(event)`: Envia o arquivo de áudio para o servidor
  - Validações:
    - Tipo: apenas áudio
    - Tamanho: máximo 10MB
    - Ticket selecionado
    - WhatsApp conectado
  - Feedback visual durante envio

### Backend (index.js)

#### 1. **Dependências**
- `multer`: Para upload de arquivo de áudio

#### 2. **Configuração**
```javascript
const uploadAudio = multer({
  storage: multer.diskStorage({...}),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {...}
});
```

#### 3. **Endpoint POST `/tickets/:id/send-audio`**
- Recebe arquivo de áudio via multipart form-data
- Valida ticket e conexão WhatsApp
- Envia áudio como nota de voz (PTT) no WhatsApp
- Salva no banco com tipo `audio` e media_url
- Atualiza status e timestamp do ticket
- Remove arquivo se houver erro

## Como Usar

1. **Abrir chat** com um ticket
2. **Clicar no botão "🎤 Áudio"**
3. **Selecionar arquivo de áudio** (MP3, OGG, WAV, etc.)
4. **Aguardar upload e envio**
5. **Áudio aparece no chat** como mensagem do agente

## Características

- ✅ Suporta vários formatos de áudio
- ✅ Limite de 10MB por arquivo
- ✅ Envia como nota de voz (PTT) no WhatsApp
- ✅ Integra com histórico de mensagens
- ✅ Atualiza ticket automaticamente
- ✅ Mensagens de feedback ao usuário
- ✅ Tratamento de erros robusto

## Tecnologias

- **Frontend**: JavaScript vanilla, FormData
- **Backend**: Express.js, Multer
- **Armazenamento**: Sistema de arquivos (/media/audios)
- **WhatsApp**: Baileys (nota de voz PTT)
