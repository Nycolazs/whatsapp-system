const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  downloadMediaMessage
} = require('@whiskeysockets/baileys')

const pino = require('pino')
const db = require('../../db')
const fs = require('fs')
const path = require('path')
const accountManager = require('../../accountManager');
const { createLogger } = require('../logger');

const logger = createLogger('whatsapp');

const DEBUG_MEDIA_LOGS = process.env.DEBUG_MEDIA_LOGS === '1';
const DEBUG_RECEIVE_LOGS = process.env.DEBUG_RECEIVE_LOGS === '1';

const fsp = fs.promises

let activeSock = null; // Socket ativo para exportar
let currentSock = null;
let latestQr = null;
let latestQrAt = null;
let connectionState = 'starting';
let lastClearedState = null;

let lastConnectedAt = null;
let lastDisconnectedAt = null;
let lastDisconnectCode = null;
let lastDisconnectReason = null;

let startInProgress = false;
let reconnectTimer = null;
let consecutiveConflicts = 0;
const MAX_CONSECUTIVE_CONFLICTS = 1; // Força logout no primeiro conflito

function scheduleReconnect(delayMs = 2000) {
  try {
    if (reconnectTimer) clearTimeout(reconnectTimer);
  } catch (e) {}
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startBot();
  }, delayMs);
}

function clearMediaFiles() {
  const mediaDirs = [
    path.join(__dirname, '..', 'media', 'images'),
    path.join(__dirname, '..', 'media', 'videos'),
    path.join(__dirname, '..', 'media', 'audios'),
    path.join(__dirname, '..', 'media', 'stickers')
  ];

  for (const dir of mediaDirs) {
    try {
      if (fs.existsSync(dir)) {
        fs.readdirSync(dir).forEach(file => {
          fs.unlinkSync(path.join(dir, file));
        });
      }
    } catch (e) {
      // Ignora erros ao deletar mídias
    }
  }
}

function clearOperationalDataFor(state) {
  if (lastClearedState === state) return;
  try {
    if (state === 'disconnected') {
      // Em desconexões transitórias, não apaga usuários/tickets.
      // NÃO apaga mídias por padrão (isso degrada muito em produção).
      db.clearOperationalData();
      if (process.env.CLEAR_MEDIA_ON_DISCONNECT === '1') {
        clearMediaFiles();
      }
    } else {
      // Em outros estados, limpa apenas operacional
      db.clearOperationalData();
    }
    lastClearedState = state;
  } catch (err) {
    // Ignora
  }
}

async function writeMediaFile(dir, fileName, buffer) {
  await fsp.mkdir(dir, { recursive: true })
  const filePath = path.join(dir, fileName)
  await fsp.writeFile(filePath, buffer)
  return filePath
}

const OUT_OF_HOURS_COOLDOWN_MINUTES = 120;

function formatDateLocal(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseTimeToMinutes(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return null;
  const [h, m] = timeStr.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return (h * 60) + m;
}

function isWithinHours(date, openTime, closeTime) {
  const openMinutes = parseTimeToMinutes(openTime);
  const closeMinutes = parseTimeToMinutes(closeTime);
  if (openMinutes === null || closeMinutes === null) return false;

  const nowMinutes = (date.getHours() * 60) + date.getMinutes();
  if (openMinutes === closeMinutes) return false;

  // Horário normal
  if (closeMinutes > openMinutes) {
    return nowMinutes >= openMinutes && nowMinutes < closeMinutes;
  }

  // Horário que atravessa meia-noite
  return nowMinutes >= openMinutes || nowMinutes < closeMinutes;
}

function getOutOfHoursMessage() {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('out_of_hours_message');
    return row?.value || '🕒 Nosso horário de atendimento já encerrou. Retornaremos no próximo horário de funcionamento.';
  } catch (err) {
    return '🕒 Nosso horário de atendimento já encerrou. Retornaremos no próximo horário de funcionamento.';
  }
}

function getBusinessStatus(date) {
  try {
    const dateStr = formatDateLocal(date);
    const exception = db.prepare('SELECT closed, open_time, close_time FROM business_exceptions WHERE date = ?').get(dateStr);
    if (exception) {
      if (exception.closed) {
        return { isOpen: false, reason: 'exception' };
      }
      if (exception.open_time && exception.close_time) {
        return { isOpen: isWithinHours(date, exception.open_time, exception.close_time), reason: 'exception' };
      }
      return { isOpen: false, reason: 'exception' };
    }

    const hours = db.prepare('SELECT open_time, close_time, enabled FROM business_hours WHERE day = ?').get(date.getDay());
    if (!hours || !hours.enabled) {
      return { isOpen: false, reason: 'closed' };
    }

    const isOpen = isWithinHours(date, hours.open_time, hours.close_time);
    return { isOpen, reason: isOpen ? 'open' : 'closed' };
  } catch (err) {
    return { isOpen: true, reason: 'error' };
  }
}

function shouldSendOutOfHours(phoneNumber, now) {
  try {
    const row = db.prepare('SELECT last_sent_at FROM out_of_hours_log WHERE phone = ?').get(phoneNumber);
    if (row && row.last_sent_at) {
      const lastSent = Number(row.last_sent_at);
      if (!Number.isNaN(lastSent)) {
        const diffMinutes = (now.getTime() - lastSent) / 60000;
        if (diffMinutes < OUT_OF_HOURS_COOLDOWN_MINUTES) {
          return false;
        }
      }
    }

    db.prepare(`
      INSERT INTO out_of_hours_log (phone, last_sent_at)
      VALUES (?, ?)
      ON CONFLICT(phone) DO UPDATE SET last_sent_at = excluded.last_sent_at
    `).run(phoneNumber, now.getTime());

    return true;
  } catch (err) {
    return false;
  }
}

function normalizePhoneFromMessage(msg) {
  const jid = msg?.key?.remoteJid || '';
  const senderPn = msg?.key?.senderPn || '';

  if (jid.includes('@lid') && !senderPn) {
    return null;
  }

  const raw = (senderPn || jid).split('@')[0];
  if (!raw) return null;

  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;

  let normalized = digits;
  if (!normalized.startsWith('55')) {
    if (normalized.length >= 10) {
      normalized = `55${normalized}`;
    } else {
      return null;
    }
  }

  if (normalized.length < 12 || normalized.length > 13) {
    return null;
  }

  return normalized;
}

function clearAuthFiles() {
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

async function startBot() {
  if (startInProgress) {
    return currentSock;
  }
  startInProgress = true;
  
  // Limpa socket anterior se existir
  if (currentSock) {
    try {
      currentSock.ev.removeAllListeners();
      currentSock.ws?.close();
    } catch (_) {}
    currentSock = null;
  }
  
  try {
    const { version } = await fetchLatestBaileysVersion()
    const authPath = accountManager.getAuthPathForStartup();
    const { state, saveCreds } = await useMultiFileAuthState(authPath)
    const sock = makeWASocket({
      auth: state,
      version,
      logger: pino({ level: 'warn' }),
      browser: ['Baileys', 'Chrome', '120.0'],
      syncFullHistory: false,
      defaultQueryTimeoutMs: 60_000,
      retryRequestDelayMs: 500,
    })
    currentSock = sock;

    sock.ev.on('creds.update', saveCreds)
    
    sock.ev.on('connection.update', (update) => {
      const { connection, qr, lastDisconnect } = update
      if (connection === 'connecting') {
        connectionState = 'connecting'
      }
      
      if (qr) {
        latestQr = qr
        latestQrAt = Date.now()
        connectionState = 'qr'
        clearOperationalDataFor('disconnected')
      }
      
      if (connection === 'open') {
        activeSock = sock; // Atualiza o socket ativo
        latestQr = null
        connectionState = 'open'
        lastConnectedAt = Date.now();
        lastDisconnectCode = null;
        lastDisconnectReason = null;
        consecutiveConflicts = 0; // Reset conflitos ao conectar
        logger.info('[CONNECTED] WhatsApp conectado com sucesso');

        // Ativa conta por número (isola DB/sessions/auth por WhatsApp)
        try {
          const num = accountManager.extractNumberFromBaileysUser(sock.user);
          if (num) {
            const result = accountManager.activateAccountFromConnectedWhatsApp(num, authPath);
            if (result && result.changed) {
              // Garante que o proxy do DB aponte para a conta atual imediatamente
              try { db.switchToActiveAccount && db.switchToActiveAccount(); } catch (_) {}
            }
          }
        } catch (_) {}

        clearOperationalDataFor('connected')
      }
      
      if (connection === 'close') {
        activeSock = null; // Limpa o socket ativo
        connectionState = 'close'
        clearOperationalDataFor('disconnected')
        const code = lastDisconnect?.error?.output?.statusCode

        lastDisconnectedAt = Date.now();
        lastDisconnectCode = code ?? null;
        try {
          lastDisconnectReason = lastDisconnect?.error?.output?.payload?.message || lastDisconnect?.error?.message || null;
        } catch (e) {
          lastDisconnectReason = null;
        }

        // Limpa socket anterior para evitar leak
        if (currentSock && currentSock !== sock) {
          try {
            currentSock.ev.removeAllListeners();
            currentSock.ws?.close();
          } catch (_) {}
        }
        currentSock = null;

        if (code === 401 || code === 405) {
          // Credenciais inválidas: limpa o auth em uso (staging ou conta)
          try { accountManager.clearAuthDir(authPath); } catch (_) { clearAuthFiles() }
        }

        // Detecta conflito (outra sessão ativa)
        const isConflict = lastDisconnectReason && lastDisconnectReason.includes('conflict');
        
        if (isConflict) {
          consecutiveConflicts++;
          logger.warn(`[CONFLICT] Conflito detectado (${consecutiveConflicts}/${MAX_CONSECUTIVE_CONFLICTS})`);
          
          // Se tiver muitos conflitos consecutivos, força logout
          if (consecutiveConflicts >= MAX_CONSECUTIVE_CONFLICTS) {
            logger.warn('[CONFLICT] Muitos conflitos. Limpando sessão. Escaneie novo QR.');
            try { accountManager.clearAuthDir(authPath); } catch (_) { clearAuthFiles() }
            consecutiveConflicts = 0;
            activeSock = null;
            currentSock = null;
            latestQr = null;
            connectionState = 'qr';
            // Não reconecta automaticamente - aguarda usuário escanear novo QR
            setTimeout(() => startBot(), 3000);
            return;
          }
          
          scheduleReconnect(10000); // 10s em conflito
        } else {
          consecutiveConflicts = 0; // Reset se não for conflito
          scheduleReconnect(2000);
        }
      }
    })

    sock.ev.on('messages.upsert', async ({ messages }) => {
      const msg = messages[0]
      if (!msg.message || msg.key.fromMe) return

      const jid = msg.key.remoteJid
      if (jid.includes('@g.us') || jid.includes('status@broadcast')) return

      const phoneNumber = normalizePhoneFromMessage(msg)
      if (!phoneNumber) return

      // Processa mensagem ANTES de checar blacklist para resposta rápida
      // A blacklist é apenas para filtrar respostas automáticas, não para ignorar mensagens

      const now = new Date()
      const businessStatus = getBusinessStatus(now)
      const outOfHoursMessage = businessStatus.isOpen ? null : getOutOfHoursMessage()

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
        
        try {
          const buffer = await downloadMediaMessage(msg, 'buffer', {})
          const mime = msg.message.imageMessage?.mimetype || 'image/jpeg'
          const ext = mime.split('/')[1] || 'jpg'
          const timestamp = Date.now()
          const fileName = `img_${timestamp}.${ext}`
          const dir = path.join(__dirname, '..', 'media', 'images')
          
          try {
            await writeMediaFile(dir, fileName, buffer)
            mediaUrl = `/media/images/${fileName}`
            if (DEBUG_MEDIA_LOGS) {
              logger.debug(`[IMAGE] Imagem salva em arquivo: ${mediaUrl}`)
            }
          } catch (fsError) {
            // Não usa base64 no DB (explode payload/DB). Marca como erro.
            if (DEBUG_MEDIA_LOGS) {
              logger.debug(`[IMAGE] Erro ao salvar arquivo: ${fsError.message}`)
            }
            mediaUrl = null
            messageContent = '[Imagem - erro ao salvar]'
          }
        } catch (error) {
          mediaUrl = null
          messageContent = '[Imagem - erro ao carregar]'
          logger.error(`[IMAGE ERROR] Erro ao processar imagem de ${phoneNumber}:`, error)
        }
      } else if (msg.message.videoMessage) {
        messageContent = msg.message.videoMessage.caption || '[Vídeo]'
        messageType = 'video'
        mediaUrl = 'loading'

        try {
          const buffer = await downloadMediaMessage(msg, 'buffer', {})
          const mime = msg.message.videoMessage?.mimetype || 'video/mp4'
          const ext = mime.split('/')[1] || 'mp4'
          const timestamp = Date.now()
          const fileName = `video_${timestamp}.${ext}`
          const dir = path.join(__dirname, '..', 'media', 'videos')

          try {
            await writeMediaFile(dir, fileName, buffer)
            mediaUrl = `/media/videos/${fileName}`
            if (DEBUG_MEDIA_LOGS) {
              logger.debug(`[VIDEO] Vídeo salvo em arquivo: ${mediaUrl}`)
            }
          } catch (fsError) {
            if (DEBUG_MEDIA_LOGS) {
              logger.debug(`[VIDEO] Erro ao salvar arquivo: ${fsError.message}`)
            }
            mediaUrl = null
            messageContent = '[Vídeo - erro ao salvar]'
          }
        } catch (error) {
          mediaUrl = null
          messageContent = '[Vídeo - erro ao carregar]'
          logger.error(`[VIDEO ERROR] Erro ao processar vídeo de ${phoneNumber}:`, error)
        }
      } else if (msg.message.audioMessage) {
        messageContent = '🎤 Áudio'
        messageType = 'audio'
        mediaUrl = 'loading' // Flag temporária (será substituída rapidamente)
      } else if (msg.message.documentMessage) {
        messageContent = `[Documento: ${msg.message.documentMessage.fileName || 'arquivo'}]`
        messageType = 'document'
      } else if (msg.message.stickerMessage) {
        messageContent = '[Figurinha]'
        messageType = 'sticker'
        
        try {
          const buffer = await downloadMediaMessage(msg, 'buffer', {})
          const mime = msg.message.stickerMessage?.mimetype || 'image/webp'
          const ext = 'webp'
          const timestamp = Date.now()
          const fileName = `sticker_${timestamp}.${ext}`
          const dir = path.join(__dirname, '..', 'media', 'stickers')
          
          try {
            await writeMediaFile(dir, fileName, buffer)
            mediaUrl = `/media/stickers/${fileName}`
            if (DEBUG_MEDIA_LOGS) {
              logger.debug(`[STICKER] Figurinha salva em arquivo: ${mediaUrl}`)
            }
          } catch (fsError) {
            if (DEBUG_MEDIA_LOGS) {
              logger.debug(`[STICKER] Erro ao salvar arquivo: ${fsError.message}`)
            }
            mediaUrl = null
            messageContent = '[Figurinha - erro ao salvar]'
          }
        } catch (error) {
          mediaUrl = null
          messageContent = '[Figurinha - erro ao carregar]'
          logger.error(`[STICKER ERROR] Erro ao processar figurinha de ${phoneNumber}:`, error)
        }
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

      // Verifica se a mensagem é uma resposta (quoted message)
      let reply_to_id = null
      if (msg.message.extendedTextMessage?.contextInfo?.stanzaId) {
        // Tenta encontrar a mensagem original pelo stanzaId do WhatsApp
        const quotedStanzaId = msg.message.extendedTextMessage.contextInfo.stanzaId
        // Por enquanto, não vamos vincular automaticamente (WhatsApp usa IDs diferentes)
        // Mas podemos armazenar a informação se necessário
      }

      const whatsappKeyStr = JSON.stringify(msg.key);
      const whatsappMessageStr = JSON.stringify(msg.message);
      
      if (DEBUG_RECEIVE_LOGS) {
        logger.debug(`[RECEIVE] Salvando mensagem de ${phoneNumber}:`, {
          tipo: messageType,
          temKey: !!msg.key,
          temMessage: !!msg.message,
          keySize: whatsappKeyStr.length,
          messageSize: whatsappMessageStr.length
        });
      }

      const inserted = db.prepare(`
        INSERT INTO messages (ticket_id, sender, content, message_type, media_url, reply_to_id, whatsapp_key, whatsapp_message, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(
        ticket.id,
        'client',
        messageContent,
        messageType,
        mediaUrl,
        reply_to_id,
        whatsappKeyStr,
        whatsappMessageStr
      )
      
      if (DEBUG_RECEIVE_LOGS) {
        logger.debug(`[RECEIVE] Mensagem salva com ID:`, inserted?.lastInsertRowid);
      }

      // Atualiza timestamp do ticket para manter ordenação correta
      try {
        db.prepare('UPDATE tickets SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(ticket.id)
      } catch (_) {}

      const messageId = inserted?.lastInsertRowid

      // Áudio: processa imediatamente (evita ficar preso em "Processando áudio")
      if (mediaUrl === 'loading' && messageType === 'audio' && messageId) {
        try {
          const buffer = await downloadMediaMessage(msg, 'buffer', {})
          const timestamp = Date.now()
          const fileName = `audio_${timestamp}.ogg`
          const dir = path.join(__dirname, '..', 'media', 'audios')

          await writeMediaFile(dir, fileName, buffer)

          const audioUrl = `/media/audios/${fileName}`
          db.prepare("UPDATE messages SET media_url = ?, updated_at = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = ?").run(audioUrl, messageId)
        } catch (error) {
          try {
            db.prepare("UPDATE messages SET media_url = NULL, content = ?, updated_at = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = ?").run('[Áudio - erro ao carregar]', messageId)
          } catch (e) {}
        }
      }

      // Check blacklist AFTER saving message (non-blocking for message reception)
      let blacklistEntry = null
      try {
        // Query otimizada sem LIKE para melhor performance na blacklist
        blacklistEntry = db.prepare('SELECT * FROM blacklist WHERE phone = ?').get(phoneNumber)
      } catch (e) {}

      // Só envia respostas automáticas se não estiver na blacklist
      if (blacklistEntry) {
        if (!businessStatus.isOpen) {
          if (shouldSendOutOfHours(phoneNumber, now) && outOfHoursMessage) {
            await sock.sendMessage(jid, { text: outOfHoursMessage })
          }
        } else if (isNewTicket) {
          await sock.sendMessage(jid, { text: '👋 Olá! Recebi sua mensagem, um atendente já vai te responder.' })
        }
      }
    })

    return sock
  } catch (error) {
    scheduleReconnect(3001)
    return null;
  } finally {
    startInProgress = false;
  }
}

// Exporta a função de inicialização e função para obter socket ativo
module.exports = startBot;
module.exports.getSocket = () => activeSock;
module.exports.getQrState = () => ({
  qr: latestQr,
  qrAt: latestQrAt,
  connectionState,
  connected: activeSock !== null,
  stableConnected: (activeSock !== null) || (typeof lastConnectedAt === 'number' && (Date.now() - lastConnectedAt) < 15_000),
  lastConnectedAt,
  lastDisconnectedAt,
  lastDisconnectCode,
  lastDisconnectReason,
});
module.exports.forceNewQr = async (allowWhenConnected = false) => {
  if (activeSock && !allowWhenConnected) {
    return { ok: false, reason: 'connected' };
  }

  clearAuthFiles();

  try {
    if (currentSock) {
      try { await currentSock.logout(); } catch (e) {}
      try { currentSock.ws?.close(); } catch (e) {}
    }
  } catch (e) {}

  activeSock = null;
  currentSock = null;
  latestQr = null;
  latestQrAt = null;
  connectionState = 'close';
  lastDisconnectedAt = Date.now();
  lastDisconnectCode = 'forced';
  lastDisconnectReason = 'forceNewQr';

  // Reinicia o bot após 1 segundo
  scheduleReconnect(1000);

  return { ok: true };
};
