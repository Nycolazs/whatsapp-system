const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  downloadMediaMessage
} = require('@whiskeysockets/baileys')

const pino = require('pino')
const db = require('./db')
const qrcode = require('qrcode-terminal')
const fs = require('fs')
const path = require('path')

let activeSock = null; // Socket ativo para exportar

async function startBot() {
  try {
    const { version } = await fetchLatestBaileysVersion()
    const { state, saveCreds } = await useMultiFileAuthState('auth')
    const sock = makeWASocket({
      auth: state,
      version,
      logger: pino({ level: 'warn' }),
      browser: ['Baileys', 'Chrome', '120.0'],
      syncFullHistory: false,
      defaultQueryTimeoutMs: 60_000,
    })

    sock.ev.on('creds.update', saveCreds)
    
    sock.ev.on('connection.update', (update) => {
      const { connection, qr, lastDisconnect } = update
      
      if (qr) {
        qrcode.generate(qr, { small: true })
      }
      
      if (connection === 'open') {
        activeSock = sock; // Atualiza o socket ativo
      }
      
      if (connection === 'close') {
        activeSock = null; // Limpa o socket ativo
        const code = lastDisconnect?.error?.output?.statusCode

        if (code === 401 || code === 405) {
          const authDir = path.join(__dirname, 'auth')
          try {
            if (fs.existsSync(authDir)) {
              fs.readdirSync(authDir).forEach(file => {
                fs.unlinkSync(path.join(authDir, file))
              })
            }
          } catch (e) {
            // Ignora
          }
        }

        setTimeout(startBot, 2000)
      }
    })

    sock.ev.on('messages.upsert', async ({ messages }) => {
      const msg = messages[0]
      if (!msg.message || msg.key.fromMe) return

      const jid = msg.key.remoteJid
      if (jid.includes('@g.us') || jid.includes('status@broadcast')) return

      const phoneNumber = (msg.key.senderPn || jid).split('@')[0]

      let blacklistEntry = null
      try {
        blacklistEntry = db.prepare('SELECT * FROM blacklist WHERE phone LIKE ?').get(`%${phoneNumber}%`)
      } catch (e) {}

      if (!blacklistEntry) {
        return
      }

      // Detecta tipo de mensagem e conteúdo
      let messageContent = ''
      let messageType = 'text'
      let mediaUrl = null

      if (msg.message.conversation || msg.message.extendedTextMessage) {
        messageContent = msg.message.conversation || msg.message.extendedTextMessage?.text || ''
        messageType = 'text'
      } else if (msg.message.imageMessage) {
        messageContent = msg.message.imageMessage.caption || '[Imagem]'
        messageType = 'image'
        
        // Primeiro, insere uma mensagem temporária de "carregando"
        const phoneNumber = msg.key.remoteJid.replace('@s.whatsapp.net', '')
        let tempTicket = db.prepare('SELECT * FROM tickets WHERE phone = ?').get(phoneNumber)
        
        if (!tempTicket) {
          const contactName = msg.pushName || null
          const result = db.prepare('INSERT INTO tickets (phone, status, contact_name) VALUES (?, ?, ?)').run(phoneNumber, 'pendente', contactName)
          tempTicket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(result.lastInsertRowid)
        }
        
        // Insere mensagem temporária
        const tempMessageResult = db.prepare('INSERT INTO messages (ticket_id, sender, content, message_type) VALUES (?, ?, ?, ?)').run(
          tempTicket.id,
          'client',
          '⏳ Carregando imagem...',
          'text'
        )
        const tempMessageId = tempMessageResult.lastInsertRowid
        
        try {
          // Baixa a imagem
          const buffer = await downloadMediaMessage(msg, 'buffer', {})
          const base64 = buffer.toString('base64')
          const mimeType = msg.message.imageMessage.mimetype || 'image/jpeg'
          mediaUrl = `data:${mimeType};base64,${base64}`
          
          // Remove a mensagem temporária
          db.prepare('DELETE FROM messages WHERE id = ?').run(tempMessageId)
        } catch (error) {
          messageContent = '[Imagem - erro ao carregar]'
          // Remove a mensagem temporária
          db.prepare('DELETE FROM messages WHERE id = ?').run(tempMessageId)
        }
      } else if (msg.message.videoMessage) {
        messageContent = '[Vídeo]'
        messageType = 'video'
      } else if (msg.message.audioMessage) {
        messageContent = '🎤 Áudio'
        messageType = 'audio'
        mediaUrl = 'loading' // Flag temporária
      } else if (msg.message.documentMessage) {
        messageContent = `[Documento: ${msg.message.documentMessage.fileName || 'arquivo'}]`
        messageType = 'document'
      } else {
        messageContent = '[Mídia não suportada]'
        messageType = 'other'
      }

      const contactName = msg.pushName || null

      // Busca o último ticket ativo (não resolvido) deste telefone
      let ticket = db.prepare('SELECT * FROM tickets WHERE phone = ? AND status != ? ORDER BY id DESC LIMIT 1').get(phoneNumber, 'resolvido')
      let isNewTicket = false

      // Se não há ticket ativo, verifica se existe algum ticket para este número
      if (!ticket) {
        // Verifica se já existe algum ticket (mesmo resolvido) para este telefone
        const existingTicket = db.prepare('SELECT * FROM tickets WHERE phone = ? ORDER BY id DESC LIMIT 1').get(phoneNumber)
        
        if (existingTicket) {
          // Reabre o ticket existente e reinicia o fluxo
          db.prepare('UPDATE tickets SET status = ?, contact_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('pendente', contactName, existingTicket.id)
          ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(existingTicket.id)
          isNewTicket = true
        } else {
          // Cria um novo ticket
          const result = db.prepare('INSERT INTO tickets (phone, status, contact_name) VALUES (?, ?, ?)').run(phoneNumber, 'pendente', contactName)
          ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(result.lastInsertRowid)
          isNewTicket = true
        }
      } else {
        if (contactName && ticket.contact_name !== contactName) {
          db.prepare('UPDATE tickets SET contact_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(contactName, ticket.id)
        }
      }

      db.prepare('INSERT INTO messages (ticket_id, sender, content, message_type, media_url) VALUES (?, ?, ?, ?, ?)').run(
        ticket.id, 
        'client', 
        messageContent, 
        messageType, 
        mediaUrl
      )

      // Se for áudio com loading, processa em background
      if (messageType === 'audio' && mediaUrl === 'loading') {
        const ticketId = ticket.id
        const msgToProcess = msg
        
        setImmediate(async () => {
          try {
            const buffer = await downloadMediaMessage(msgToProcess, 'buffer', {})
            const timestamp = Date.now()
            const fileName = `audio_${timestamp}.ogg`
            const audioDir = path.join(__dirname, '..', 'media', 'audios')
            
            if (!fs.existsSync(audioDir)) {
              fs.mkdirSync(audioDir, { recursive: true })
            }
            
            const filePath = path.join(audioDir, fileName)
            fs.writeFileSync(filePath, buffer)
            
            const audioUrl = `/media/audios/${fileName}`
            
            // Atualiza a mensagem no banco com o URL real
            db.prepare('UPDATE messages SET media_url = ? WHERE ticket_id = ? AND media_url = ? AND message_type = ? ORDER BY id DESC LIMIT 1')
              .run(audioUrl, ticketId, 'loading', 'audio')
          } catch (error) {
            // Erro ao processar áudio
          }
        })
      }

      if (isNewTicket) {
        await sock.sendMessage(jid, { text: '👋 Olá! Recebi sua mensagem, um atendente já vai te responder.' })
      }
    })

    return sock
  } catch (error) {
    setTimeout(startBot, 3001)
  }
}

// Exporta a função de inicialização e função para obter socket ativo
module.exports = startBot;
module.exports.getSocket = () => activeSock;
