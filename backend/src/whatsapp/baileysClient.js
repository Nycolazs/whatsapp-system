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
const events = require('../server/events');

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

// Configurações de estabilidade
const RECONNECT_CONFIG = {
  initialDelay: 2000,      // Delay inicial de reconexão
  maxDelay: 30000,         // Delay máximo entre tentativas
  maxAttempts: 10,         // Tentativas máximas antes de resetar
  backoffMultiplier: 1.5,  // Multiplicador exponencial
};

let reconnectAttempts = 0;
let currentReconnectDelay = RECONNECT_CONFIG.initialDelay;
let heartbeatTimer = null;

function calculateNextDelay() {
  if (reconnectAttempts >= RECONNECT_CONFIG.maxAttempts) {
    reconnectAttempts = 0; // Reset após atingir máximo
    currentReconnectDelay = RECONNECT_CONFIG.initialDelay;
  }
  
  const delay = Math.min(
    RECONNECT_CONFIG.initialDelay * Math.pow(RECONNECT_CONFIG.backoffMultiplier, reconnectAttempts),
    RECONNECT_CONFIG.maxDelay
  );
  
  reconnectAttempts++;
  return Math.floor(delay);
}

function scheduleReconnect(delayMs = null) {
  try {
    if (reconnectTimer) clearTimeout(reconnectTimer);
  } catch (e) {}
  
  const actualDelay = delayMs !== null ? delayMs : calculateNextDelay();
  
  logger.info(`[RECONNECT] Reconectando em ${actualDelay}ms (tentativa ${reconnectAttempts}/${RECONNECT_CONFIG.maxAttempts})`);
  
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startBot().catch((err) => {
      logger.error('[RECONNECT] Falha ao reconectar WhatsApp:', err);
    });
  }, actualDelay);
}

function startHeartbeat(sock) {
  try {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  } catch (e) {}
  
  let missedChecks = 0;
  
  heartbeatTimer = setInterval(() => {
    try {
      // Verificação mais robusta - se activeSock existe e tem métodos de socket
      if (activeSock && typeof activeSock.query === 'function') {
        // Socket está ativo, reset counter
        missedChecks = 0;
      } else if (activeSock) {
        // Socket pode estar em transição, aguarda mais uma checagem
        missedChecks++;
        
        if (missedChecks >= 2) {
          logger.warn('[HEARTBEAT] WebSocket desconectado (miss count: ' + missedChecks + '), reconectando...');
          activeSock = null;
          missedChecks = 0;
          scheduleReconnect();
        }
      }
    } catch (err) {
      logger.warn('[HEARTBEAT] Erro ao verificar conexão:', err.message);
    }
  }, 45000); // Aumentado para 45 segundos para dar mais tempo
}

function stopHeartbeat() {
  try {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  } catch (e) {}
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

function isOutOfHoursEnabled() {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('out_of_hours_enabled');
    return row ? row.value !== '0' : true;
  } catch (_err) {
    return true;
  }
}

function getWelcomeMessage() {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('welcome_message');
    return row?.value || '👋 Olá! Seja bem-vindo(a)! Um de nossos atendentes já vai responder você. Por favor, aguarde um momento.';
  } catch (err) {
    return '👋 Olá! Seja bem-vindo(a)! Um de nossos atendentes já vai responder você. Por favor, aguarde um momento.';
  }
}

function shouldSendWelcomeMessage(ticketId) {
  try {
    // Verifica se já existe alguma mensagem do agente/sistema neste ticket
    const agentMessage = db.prepare('SELECT id FROM messages WHERE ticket_id = ? AND sender IN (?, ?) LIMIT 1').get(ticketId, 'agent', 'system');
    return !agentMessage; // Retorna true se não houver mensagem do agente/sistema ainda
  } catch (err) {
    return false;
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

function isLidJid(value) {
  if (!value) return false;
  return String(value).trim().endsWith('@lid');
}

function escapeSqlLike(value) {
  return String(value || '').replace(/[\\%_]/g, (m) => `\\${m}`);
}

function normalizeCandidateDigits(digits, { allowWide = false } = {}) {
  if (!digits) return null;
  const normalized = String(digits).replace(/\D/g, '');
  if (!normalized) return null;

  if (normalized.startsWith('55') && (normalized.length === 12 || normalized.length === 13)) {
    return normalized;
  }

  if (normalized.length >= 10 && normalized.length <= 15) {
    return normalized;
  }

  // Fallback para contatos que chegam apenas com identificador LID.
  if (allowWide && normalized.length >= 8 && normalized.length <= 25) {
    return normalized;
  }

  return null;
}

function findPhoneByKnownJid(remoteJid, participant) {
  const jidLookups = [
    { key: 'remoteJid', value: remoteJid },
    { key: 'participant', value: participant },
  ];

  for (const lookup of jidLookups) {
    if (!lookup.value) continue;
    try {
      const pattern = `%"${lookup.key}":"${escapeSqlLike(lookup.value)}"%`;
      const row = db.prepare(`
        SELECT t.phone
        FROM messages m
        JOIN tickets t ON t.id = m.ticket_id
        WHERE m.sender = 'client'
          AND m.whatsapp_key LIKE ? ESCAPE '\\'
        ORDER BY m.id DESC
        LIMIT 1
      `).get(pattern);

      const phone = normalizeCandidateDigits(row?.phone, { allowWide: true });
      if (phone) return phone;
    } catch (_) {}
  }

  return null;
}

function unwrapIncomingMessage(message) {
  if (!message || typeof message !== 'object') return null;
  let current = message;

  // Alguns tipos chegam encapsulados (ephemeral/view once/edited).
  // Desembrulhamos em cadeia para padronizar a leitura do conteúdo.
  for (let i = 0; i < 5; i++) {
    const next =
      current?.ephemeralMessage?.message ||
      current?.viewOnceMessage?.message ||
      current?.viewOnceMessageV2?.message ||
      current?.viewOnceMessageV2Extension?.message ||
      current?.editedMessage?.message ||
      null;

    if (!next || typeof next !== 'object') break;
    current = next;
  }

  return current;
}

function normalizePhoneFromMessage(msg) {
  const jid = msg?.key?.remoteJid || '';
  const senderPn = msg?.key?.senderPn || '';
  const participantPn = msg?.key?.participantPn || '';
  const participant = msg?.key?.participant || '';

  // Prioriza identificadores canônicos (senderPn/participantPn/JID não-LID).
  const preferredCandidates = [senderPn, participantPn, participant, jid].filter(Boolean);
  for (const value of preferredCandidates) {
    if (isLidJid(value)) continue;
    const raw = String(value).split('@')[0];
    const normalized = normalizeCandidateDigits(raw);
    if (normalized) return normalized;
  }

  // Quando chega só LID (sem senderPn), tenta resolver pelo histórico local.
  const phoneFromHistory = findPhoneByKnownJid(jid, participant);
  if (phoneFromHistory) {
    return phoneFromHistory;
  }

  // Último fallback: usa os dígitos do próprio LID para não perder o ticket.
  const lidCandidates = [jid, participant].filter(Boolean);
  for (const value of lidCandidates) {
    if (!isLidJid(value)) continue;
    const raw = String(value).split('@')[0];
    const normalized = normalizeCandidateDigits(raw, { allowWide: true });
    if (normalized) {
      return normalized;
    }
  }

  return null;
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

function getActiveAccountFromFileSafe() {
  try {
    const file = accountManager?.paths?.ACTIVE_ACCOUNT_FILE;
    if (!file || !fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const normalized = accountManager.normalizeAccountNumber
      ? accountManager.normalizeAccountNumber(raw?.account)
      : null;
    return normalized || null;
  } catch (_) {
    return null;
  }
}

function collectAuthDirsToClear() {
  const dirs = new Set();

  try {
    const authPath = accountManager.getAuthPathForStartup();
    if (authPath) dirs.add(path.resolve(authPath));
  } catch (_) {}

  try {
    if (accountManager?.paths?.STAGING_AUTH_DIR) {
      dirs.add(path.resolve(accountManager.paths.STAGING_AUTH_DIR));
    }
  } catch (_) {}

  try {
    if (accountManager?.paths?.LEGACY_AUTH_DIR_BACKEND) {
      dirs.add(path.resolve(accountManager.paths.LEGACY_AUTH_DIR_BACKEND));
    }
  } catch (_) {}

  // Compatibilidade com instalações antigas que criaram diretórios "wa-auth 2", etc.
  try {
    const activeAccount = getActiveAccountFromFileSafe();
    if (activeAccount) {
      const accountPaths = accountManager.getAccountPaths(activeAccount);
      if (accountPaths?.accountDir && fs.existsSync(accountPaths.accountDir)) {
        const entries = fs.readdirSync(accountPaths.accountDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          if (entry.name === 'wa-auth' || entry.name.startsWith('wa-auth ')) {
            dirs.add(path.resolve(path.join(accountPaths.accountDir, entry.name)));
          }
        }
      }
    }
  } catch (_) {}

  return Array.from(dirs);
}

function clearAllKnownAuthDirs() {
  const dirs = collectAuthDirsToClear();
  for (const authDir of dirs) {
    try {
      accountManager.clearAuthDir(authDir);
    } catch (_) {}
  }
  // Mantém limpeza do path legado local por compatibilidade.
  clearAuthFiles();
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
      keepAliveIntervalMs: 30_000,
      qrTimeout: 60_000,
      phoneNumberCountryCode: '55',
      emitOwnEvents: false,
    })
    currentSock = sock;

    sock.ev.on('creds.update', (...args) => {
      try {
        saveCreds(...args)
      } catch (err) {
        logger.warn('[creds.update] Falha ao salvar credenciais:', err)
      }
    })
    
    sock.ev.on('connection.update', (update) => {
      try {
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
          reconnectAttempts = 0; // Reset tentativas de reconexão
          currentReconnectDelay = RECONNECT_CONFIG.initialDelay; // Reset delay
          startHeartbeat(sock); // Inicia heartbeat
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
          stopHeartbeat(); // Para heartbeat
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
          
          logger.warn(`[DISCONNECT] Conexão fechada. Código: ${code}, Motivo: ${lastDisconnectReason}`);

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
          const isConflict = lastDisconnectReason && String(lastDisconnectReason).toLowerCase().includes('conflict');
          
          if (isConflict) {
            consecutiveConflicts++;
            logger.warn(`[CONFLICT] Conflito detectado (${consecutiveConflicts}/${MAX_CONSECUTIVE_CONFLICTS})`);
            
            // Se tiver muitos conflitos consecutivos, força logout
            if (consecutiveConflicts >= MAX_CONSECUTIVE_CONFLICTS) {
              logger.warn('[CONFLICT] Muitos conflitos. Limpando sessão. Escaneie novo QR.');
              try { accountManager.clearAuthDir(authPath); } catch (_) { clearAuthFiles() }
              consecutiveConflicts = 0;
              reconnectAttempts = 0; // Reset tentativas
              activeSock = null;
              currentSock = null;
              latestQr = null;
              connectionState = 'qr';
              // Reinicia socket para gerar novo QR, sem deixar rejection sem tratamento
              scheduleReconnect(5000);
              return;
            }
            
            scheduleReconnect(calculateNextDelay()); // Usa backoff exponencial
          } else {
            consecutiveConflicts = 0; // Reset se não for conflito
            scheduleReconnect(); // Usa próximo delay calculado
          }
        }
      } catch (err) {
        logger.error('[connection.update] Erro não tratado no handler:', err)
      }
    })

    sock.ev.on('messages.upsert', async ({ messages }) => {
      if (!messages || !Array.isArray(messages) || messages.length === 0) return;
      const welcomeQueuedForTicket = new Set();

      for (const msg of messages) {
        try {
          if (msg?.key?.fromMe) continue

          const jid = msg.key.remoteJid
          if (!jid || jid.includes('@g.us') || jid.includes('status@broadcast')) continue
          const phoneNumber = normalizePhoneFromMessage(msg)
          if (!phoneNumber) {
            const senderPn = msg?.key?.senderPn || msg?.key?.participantPn || ''
            const participant = msg?.key?.participant || ''
            logger.warn(`[INBOUND] Mensagem ignorada sem identificador de contato (jid=${jid}, senderPn=${senderPn}, participant=${participant})`)
            continue
          }
          const sendJid = jid || `${phoneNumber}@s.whatsapp.net`
          const parsedMessage = unwrapIncomingMessage(msg.message)

      // RESPOSTA AUTOMÁTICA SUPER RÁPIDA - Envia PRIMEIRO, processa depois
      const now = new Date()
      const businessStatus = getBusinessStatus(now)
      
      // Faz checagens rápidas em paralelo, sem aguardar
      setImmediate(() => {
        try {
          if (!businessStatus.isOpen && isOutOfHoursEnabled()) {
            if (shouldSendOutOfHours(phoneNumber, now)) {
              const outOfHoursMessage = getOutOfHoursMessage()
              if (outOfHoursMessage) {
                sock.sendMessage(sendJid, { text: outOfHoursMessage }).catch(err => {
                  logger.warn(`[AUTO_REPLY] Falha ao enviar mensagem fora do horário (${phoneNumber}): ${err?.message || err}`)
                })
              }
            }
          }
        } catch (e) {
          logger.error('[AUTO_REPLY] Erro:', e)
        }
      })

      // Detecta tipo de mensagem e conteúdo
      let messageContent = ''
      let messageType = 'text'
      let mediaUrl = null

      if (!parsedMessage) {
        // Fallback: em casos de falha de descriptografia (PreKey/Session),
        // ainda registramos no ticket para não perder o fluxo.
        messageContent = '[Mensagem recebida, mas não pôde ser descriptografada]'
        messageType = 'unknown'
      } else if (parsedMessage.conversation || parsedMessage.extendedTextMessage) {
        messageContent = parsedMessage.conversation || parsedMessage.extendedTextMessage?.text || ''
        messageType = 'text'
      } else if (parsedMessage.imageMessage) {
        messageContent = parsedMessage.imageMessage.caption || '[Imagem]'
        messageType = 'image'
        
        try {
          const buffer = await downloadMediaMessage(msg, 'buffer', {})
          const mime = parsedMessage.imageMessage?.mimetype || 'image/jpeg'
          const ext = mime.split('/')[1] || 'jpg'
          const timestamp = Date.now()
          const fileName = `img_${timestamp}.${ext}`
          const dir = path.join(__dirname, '..', '..', '..', 'media', 'images')
          
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
      } else if (parsedMessage.videoMessage || parsedMessage.ptvMessage) {
        const incomingVideo = parsedMessage.videoMessage || parsedMessage.ptvMessage
        messageContent = incomingVideo?.caption || '[Vídeo]'
        messageType = 'video'
        mediaUrl = 'loading'

        try {
          const buffer = await downloadMediaMessage(msg, 'buffer', {})
          const mime = incomingVideo?.mimetype || 'video/mp4'
          const extRaw = mime.split('/')[1] || 'mp4'
          const ext = String(extRaw).split(';')[0] || 'mp4'
          const timestamp = Date.now()
          const fileName = `video_${timestamp}.${ext}`
          const dir = path.join(__dirname, '..', '..', '..', 'media', 'videos')

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
      } else if (parsedMessage.audioMessage) {
        messageContent = '🎤 Áudio'
        messageType = 'audio'
        mediaUrl = 'loading' // Flag temporária (será substituída rapidamente)
      } else if (parsedMessage.documentMessage) {
        messageContent = `[Documento: ${parsedMessage.documentMessage.fileName || 'arquivo'}]`
        messageType = 'document'
      } else if (parsedMessage.stickerMessage) {
        messageContent = '[Figurinha]'
        messageType = 'sticker'
        
        try {
          const buffer = await downloadMediaMessage(msg, 'buffer', {})
          const mime = parsedMessage.stickerMessage?.mimetype || 'image/webp'
          const ext = 'webp'
          const timestamp = Date.now()
          const fileName = `sticker_${timestamp}.${ext}`
          const dir = path.join(__dirname, '..', '..', '..', 'media', 'stickers')
          
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

      // Busca o ticket ativo (não resolvido/encerrado) deste telefone.
      // Se não houver, SEMPRE cria um NOVO ticket (não reabre tickets antigos).
      // Usa transação para evitar corrida em caso de mensagens simultâneas.
      let ticket = null
      let isNewTicket = false
      let previousTicketStatus = null

      try {
        db.exec('BEGIN IMMEDIATE')

        ticket = db.prepare(
          "SELECT * FROM tickets WHERE phone = ? AND status NOT IN ('resolvido','encerrado') ORDER BY id DESC LIMIT 1"
        ).get(phoneNumber)

        if (!ticket) {
          const result = db.prepare('INSERT INTO tickets (phone, status, contact_name) VALUES (?, ?, ?)')
            .run(phoneNumber, 'pendente', contactName)
          ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(result.lastInsertRowid)
          isNewTicket = true

          // Se abriu um ticket novo, verifica o ticket anterior (se houver)
          // para registrar um marcador de contexto na timeline.
          try {
            const prev = db.prepare(
              "SELECT id, status FROM tickets WHERE phone = ? AND id < ? ORDER BY id DESC LIMIT 1"
            ).get(phoneNumber, ticket.id)
            previousTicketStatus = prev && prev.status ? String(prev.status) : null
          } catch (_) {
            previousTicketStatus = null
          }
        } else {
          // Atualiza nome do contato apenas no ticket ativo
          if (contactName && ticket.contact_name !== contactName) {
            db.prepare('UPDATE tickets SET contact_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
              .run(contactName, ticket.id)
            ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticket.id)
          }
        }

        db.exec('COMMIT')
      } catch (e) {
        try { db.exec('ROLLBACK') } catch (_) {}

        // Se caiu aqui por corrida (índice único de ticket ativo), pega o ticket ativo e segue.
        ticket = db.prepare(
          "SELECT * FROM tickets WHERE phone = ? AND status NOT IN ('resolvido','encerrado') ORDER BY id DESC LIMIT 1"
        ).get(phoneNumber)

        if (!ticket) {
          throw e
        }
      }

      if (isNewTicket) {
        try {
          events.emit('ticket', { ticketId: ticket.id, phone: ticket.phone, status: ticket.status });
        } catch (_) {}
      }

      // MENSAGEM DE BOAS-VINDAS quando estabelecimento está aberto
      if (businessStatus.isOpen && !welcomeQueuedForTicket.has(ticket.id) && shouldSendWelcomeMessage(ticket.id)) {
        welcomeQueuedForTicket.add(ticket.id);
        setImmediate(() => {
          try {
            const welcomeMessage = getWelcomeMessage()
            if (welcomeMessage) {
              sock.sendMessage(sendJid, { text: welcomeMessage }).then(() => {
                // Registra a mensagem de boas-vindas no banco como mensagem do sistema
                try {
                  db.prepare(`
                    INSERT INTO messages (ticket_id, sender, content, message_type, updated_at)
                    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
                  `).run(ticket.id, 'system', welcomeMessage, 'text')
                } catch (_) {}
              }).catch(err => {
                logger.warn(`[WELCOME] Falha ao enviar mensagem de boas-vindas (${phoneNumber}): ${err?.message || err}`)
              })
            }
          } catch (e) {
            logger.error('[WELCOME] Erro:', e)
          }
        })
      }

      // Verifica se a mensagem é uma resposta (quoted message)
      let reply_to_id = null
      if (parsedMessage?.extendedTextMessage?.contextInfo?.stanzaId) {
        // Tenta encontrar a mensagem original pelo stanzaId do WhatsApp
        const quotedStanzaId = parsedMessage.extendedTextMessage.contextInfo.stanzaId
        // Por enquanto, não vamos vincular automaticamente (WhatsApp usa IDs diferentes)
        // Mas podemos armazenar a informação se necessário
      }

      const whatsappKeyStr = JSON.stringify(msg.key);
      const whatsappMessageStr = JSON.stringify(msg.message);

      // Se este ticket foi criado agora por causa de um contato que já tinha ticket resolvido/encerrado,
      // insere uma mensagem de sistema na timeline para deixar claro que é um novo atendimento.
      if (isNewTicket && (previousTicketStatus === 'resolvido' || previousTicketStatus === 'encerrado')) {
        try {
          const statusLabel = previousTicketStatus === 'resolvido' ? 'resolvido' : 'encerrado'
          const systemText = `Ticket anterior foi ${statusLabel}. Um novo ticket foi iniciado.`
          db.prepare(`
            INSERT INTO messages (ticket_id, sender, content, message_type, updated_at)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
          `).run(ticket.id, 'system', systemText, 'system')
        } catch (_) {}
      }
      
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

      try {
        events.emit('message', {
          ticketId: ticket.id,
          phone: ticket.phone,
          messageId: inserted?.lastInsertRowid,
          ts: Date.now(),
        });
      } catch (_) {}

      const messageId = inserted?.lastInsertRowid

      // Áudio: processa imediatamente (evita ficar preso em "Processando áudio")
      if (mediaUrl === 'loading' && messageType === 'audio' && messageId) {
        try {
          const buffer = await downloadMediaMessage(msg, 'buffer', {})
          const timestamp = Date.now()
          const fileName = `audio_${timestamp}.ogg`
          const dir = path.join(__dirname, '..', '..', '..', 'media', 'audios')

          await writeMediaFile(dir, fileName, buffer)

          const audioUrl = `/media/audios/${fileName}`
          db.prepare("UPDATE messages SET media_url = ?, updated_at = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = ?").run(audioUrl, messageId)
        } catch (error) {
          try {
            db.prepare("UPDATE messages SET media_url = NULL, content = ?, updated_at = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = ?").run('[Áudio - erro ao carregar]', messageId)
          } catch (e) {}
        }
      }

          // Auto-reply já foi enviado no início (antes de processar mídia)
          // Nada mais a fazer aqui
        } catch (err) {
          logger.error('[messages.upsert] Erro não tratado no handler:', err)
        }
      }
    })

    return sock
  } catch (error) {
    logger.error('[START] Falha ao iniciar WhatsApp. Tentando reconectar...', error)
    try {
      if (currentSock) {
        try { currentSock.ev.removeAllListeners(); } catch (_) {}
        try { currentSock.ws?.close(); } catch (_) {}
        currentSock = null;
      }
    } catch (e) {}
    scheduleReconnect();
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

  try {
    if (currentSock) {
      try { await currentSock.logout(); } catch (e) {}
      try { currentSock.ev?.removeAllListeners?.(); } catch (e) {}
      try { currentSock.ws?.close(); } catch (e) {}
    }
  } catch (e) {}

  clearAllKnownAuthDirs();

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
