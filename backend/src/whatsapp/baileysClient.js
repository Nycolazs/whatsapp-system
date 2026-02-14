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
let lastConnectionEventAt = Date.now();

let startInProgress = false;
let reconnectTimer = null;
let consecutiveConflicts = 0;
let heartbeatTimer = null;
let reconnectAttempts = 0;
let connectTimeoutTimer = null;
let nextReconnectAt = null;
let cachedBaileysVersion = null;
let cachedBaileysVersionAt = 0;

function parseEnvNumber(name, fallback, { min = null, max = null } = {}) {
  const raw = process.env[name];
  const parsed = Number(raw);
  let value = Number.isFinite(parsed) ? parsed : fallback;
  if (Number.isFinite(min)) value = Math.max(min, value);
  if (Number.isFinite(max)) value = Math.min(max, value);
  return value;
}

function parseEnvFloat(name, fallback, { min = null, max = null } = {}) {
  const raw = process.env[name];
  const parsed = Number(raw);
  let value = Number.isFinite(parsed) ? parsed : fallback;
  if (Number.isFinite(min)) value = Math.max(min, value);
  if (Number.isFinite(max)) value = Math.min(max, value);
  return value;
}

const MAX_CONSECUTIVE_CONFLICTS = parseEnvNumber('WA_MAX_CONFLICTS_BEFORE_LOGOUT', 3, { min: 1, max: 20 });
const WA_SOCKET_READY_STATE_OPEN = 1;
const BAILEYS_VERSION_CACHE_MS = parseEnvNumber('WA_VERSION_CACHE_MS', 6 * 60 * 60 * 1000, { min: 60 * 1000, max: 24 * 60 * 60 * 1000 });
const CONNECTING_TIMEOUT_MS = parseEnvNumber('WA_CONNECTING_TIMEOUT_MS', 45 * 1000, { min: 10 * 1000, max: 5 * 60 * 1000 });

// Configurações de estabilidade
const RECONNECT_CONFIG = {
  initialDelay: parseEnvNumber('WA_RECONNECT_INITIAL_DELAY_MS', 2_000, { min: 250, max: 60_000 }),
  maxDelay: parseEnvNumber('WA_RECONNECT_MAX_DELAY_MS', 30_000, { min: 2_000, max: 10 * 60 * 1000 }),
  maxAttemptsBeforeReset: parseEnvNumber('WA_RECONNECT_MAX_ATTEMPTS', 10, { min: 1, max: 10_000 }),
  backoffMultiplier: parseEnvFloat('WA_RECONNECT_BACKOFF_MULTIPLIER', 1.5, { min: 1.05, max: 4 }),
  jitterPct: parseEnvFloat('WA_RECONNECT_JITTER_PCT', 0.15, { min: 0, max: 0.5 }),
};
if (RECONNECT_CONFIG.maxDelay < RECONNECT_CONFIG.initialDelay) {
  RECONNECT_CONFIG.maxDelay = RECONNECT_CONFIG.initialDelay;
}

const HEARTBEAT_CONFIG = {
  intervalMs: parseEnvNumber('WA_HEARTBEAT_INTERVAL_MS', 30_000, { min: 10_000, max: 120_000 }),
  maxMissedChecks: parseEnvNumber('WA_HEARTBEAT_MAX_MISSED', 3, { min: 1, max: 20 }),
};

const WATCHDOG_CONFIG = {
  intervalMs: parseEnvNumber('WA_WATCHDOG_INTERVAL_MS', 60_000, { min: 10_000, max: 5 * 60 * 1000 }),
  staleThresholdMs: parseEnvNumber('WA_WATCHDOG_STALE_THRESHOLD_MS', 90_000, { min: 30_000, max: 30 * 60 * 1000 }),
};

function touchConnectionEvent() {
  lastConnectionEventAt = Date.now();
}

function clearReconnectTimer() {
  try {
    if (reconnectTimer) clearTimeout(reconnectTimer);
  } catch (_) {}
  reconnectTimer = null;
  nextReconnectAt = null;
}

function clearConnectTimeout() {
  try {
    if (connectTimeoutTimer) clearTimeout(connectTimeoutTimer);
  } catch (_) {}
  connectTimeoutTimer = null;
}

function stopSocket(sock) {
  if (!sock) return;
  try { sock.ev?.removeAllListeners?.(); } catch (_) {}
  try { sock.ws?.close?.(); } catch (_) {}
}

function isSocketOpen(sock) {
  if (!sock) return false;
  const readyState = Number(sock?.ws?.readyState);
  if (Number.isFinite(readyState)) {
    return readyState === WA_SOCKET_READY_STATE_OPEN;
  }
  // Fallback defensivo para versões onde ws.readyState não está disponível
  return typeof sock.sendMessage === 'function';
}

function resolveDisconnectCode(lastDisconnect) {
  const raw = Number(lastDisconnect?.error?.output?.statusCode);
  if (Number.isFinite(raw)) return raw;
  return null;
}

function resolveDisconnectReason(lastDisconnect) {
  try {
    return (
      lastDisconnect?.error?.output?.payload?.message ||
      lastDisconnect?.error?.message ||
      null
    );
  } catch (_) {
    return null;
  }
}

function isConflictDisconnect(code, reason) {
  if (code === DisconnectReason.connectionReplaced) return true;
  return !!(reason && String(reason).toLowerCase().includes('conflict'));
}

function isLogoutDisconnect(code) {
  return (
    code === DisconnectReason.loggedOut ||
    code === DisconnectReason.badSession ||
    code === DisconnectReason.multideviceMismatch ||
    code === 405
  );
}

function addJitter(baseDelay) {
  if (RECONNECT_CONFIG.jitterPct <= 0) return Math.floor(baseDelay);
  const variance = 1 + ((Math.random() * 2 - 1) * RECONNECT_CONFIG.jitterPct);
  const jittered = baseDelay * variance;
  return Math.max(RECONNECT_CONFIG.initialDelay, Math.floor(jittered));
}

function calculateNextDelay() {
  const cycleAttempt = reconnectAttempts % RECONNECT_CONFIG.maxAttemptsBeforeReset;
  const baseDelay = Math.min(
    RECONNECT_CONFIG.initialDelay * Math.pow(RECONNECT_CONFIG.backoffMultiplier, cycleAttempt),
    RECONNECT_CONFIG.maxDelay
  );
  reconnectAttempts += 1;
  return addJitter(baseDelay);
}

function scheduleReconnect(delayMs = null, reason = 'unknown') {
  clearReconnectTimer();
  touchConnectionEvent();

  const requestedDelay = Number(delayMs);
  const actualDelay = Number.isFinite(requestedDelay)
    ? Math.max(0, Math.floor(requestedDelay))
    : calculateNextDelay();

  nextReconnectAt = Date.now() + actualDelay;
  logger.info(
    `[RECONNECT] Agendado em ${actualDelay}ms (tentativa ${reconnectAttempts}, motivo: ${reason})`
  );

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    nextReconnectAt = null;

    if (startInProgress) {
      scheduleReconnect(RECONNECT_CONFIG.initialDelay, 'start-in-progress');
      return;
    }

    startBot().catch((err) => {
      logger.error('[RECONNECT] Falha ao reconectar WhatsApp:', err);
    });
  }, actualDelay);

  try {
    if (typeof reconnectTimer.unref === 'function') reconnectTimer.unref();
  } catch (_) {}
}

function scheduleConnectTimeout(sock) {
  clearConnectTimeout();
  connectTimeoutTimer = setTimeout(() => {
    if (sock !== currentSock) return;
    if (connectionState === 'open' || connectionState === 'qr') return;

    logger.warn(
      `[CONNECT_TIMEOUT] Conexão sem progresso por ${CONNECTING_TIMEOUT_MS}ms. Reiniciando socket.`
    );
    touchConnectionEvent();
    lastDisconnectedAt = Date.now();
    lastDisconnectCode = 'timeout';
    lastDisconnectReason = 'connecting_timeout';
    activeSock = null;
    if (currentSock === sock) currentSock = null;
    stopSocket(sock);
    connectionState = 'close';
    scheduleReconnect(RECONNECT_CONFIG.initialDelay, 'connect-timeout');
  }, CONNECTING_TIMEOUT_MS);

  try {
    if (typeof connectTimeoutTimer.unref === 'function') connectTimeoutTimer.unref();
  } catch (_) {}
}

function startHeartbeat(sock) {
  stopHeartbeat();
  let missedChecks = 0;

  heartbeatTimer = setInterval(() => {
    try {
      if (sock !== currentSock || connectionState !== 'open') {
        missedChecks = 0;
        return;
      }

      if (isSocketOpen(sock)) {
        missedChecks = 0;
        return;
      }

      missedChecks += 1;
      logger.warn(
        `[HEARTBEAT] Socket sem readyState OPEN (${missedChecks}/${HEARTBEAT_CONFIG.maxMissedChecks})`
      );

      if (missedChecks < HEARTBEAT_CONFIG.maxMissedChecks) return;

      touchConnectionEvent();
      lastDisconnectedAt = Date.now();
      lastDisconnectCode = 'heartbeat';
      lastDisconnectReason = 'heartbeat_stale';
      connectionState = 'close';
      activeSock = null;
      if (currentSock === sock) currentSock = null;
      stopSocket(sock);
      scheduleReconnect(null, 'heartbeat-stale');
    } catch (err) {
      logger.warn('[HEARTBEAT] Erro ao verificar conexão:', err && err.message ? err.message : err);
    }
  }, HEARTBEAT_CONFIG.intervalMs);

  try {
    if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
  } catch (_) {}
}

function stopHeartbeat() {
  try {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  } catch (e) {}
}

function startSelfHealWatchdog() {
  const timer = setInterval(() => {
    try {
      if (startInProgress) return;
      if (activeSock || currentSock || reconnectTimer) return;
      if (connectionState === 'open') return;

      const stalledForMs = Date.now() - lastConnectionEventAt;
      if (stalledForMs < WATCHDOG_CONFIG.staleThresholdMs) return;

      logger.warn(
        `[WATCHDOG] Estado parado em "${connectionState}" há ${stalledForMs}ms. Forçando reconexão.`
      );
      scheduleReconnect(RECONNECT_CONFIG.initialDelay, 'watchdog-stale-state');
    } catch (err) {
      logger.warn('[WATCHDOG] Falha no monitor de conexão:', err && err.message ? err.message : err);
    }
  }, WATCHDOG_CONFIG.intervalMs);

  try {
    if (typeof timer.unref === 'function') timer.unref();
  } catch (_) {}
}

async function resolveBaileysVersion() {
  const now = Date.now();
  if (
    Array.isArray(cachedBaileysVersion) &&
    cachedBaileysVersion.length > 0 &&
    (now - cachedBaileysVersionAt) < BAILEYS_VERSION_CACHE_MS
  ) {
    return cachedBaileysVersion;
  }

  try {
    const { version } = await fetchLatestBaileysVersion();
    if (Array.isArray(version) && version.length > 0) {
      cachedBaileysVersion = version;
      cachedBaileysVersionAt = now;
      return version;
    }
  } catch (err) {
    if (Array.isArray(cachedBaileysVersion) && cachedBaileysVersion.length > 0) {
      logger.warn('[BAILEYS] Falha ao buscar versão mais recente. Usando cache local.');
      return cachedBaileysVersion;
    }
    throw err;
  }

  if (Array.isArray(cachedBaileysVersion) && cachedBaileysVersion.length > 0) {
    return cachedBaileysVersion;
  }

  throw new Error('Não foi possível determinar a versão do Baileys');
}

startSelfHealWatchdog();

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

function normalizePhoneForBlacklist(phoneNumber) {
  if (!phoneNumber) return '';
  return String(phoneNumber).split('@')[0].replace(/\D/g, '');
}

function isPhoneInBlacklist(phoneNumber) {
  try {
    const normalized = normalizePhoneForBlacklist(phoneNumber);
    if (!normalized) return false;
    const row = db.prepare('SELECT 1 FROM blacklist WHERE phone = ? LIMIT 1').get(normalized);
    return !!row;
  } catch (_) {
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

  touchConnectionEvent();
  clearReconnectTimer();
  clearConnectTimeout();
  stopHeartbeat();

  // Limpa socket anterior se existir
  if (currentSock) {
    stopSocket(currentSock);
    currentSock = null;
  }
  activeSock = null;

  try {
    const version = await resolveBaileysVersion();
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
    connectionState = 'connecting';
    scheduleConnectTimeout(sock);

    sock.ev.on('creds.update', (...args) => {
      try {
        saveCreds(...args)
      } catch (err) {
        logger.warn('[creds.update] Falha ao salvar credenciais:', err)
      }
    })

    sock.ev.on('connection.update', (update) => {
      if (sock !== currentSock) return;
      touchConnectionEvent();

      try {
        const { connection, qr, lastDisconnect } = update

        if (connection === 'connecting') {
          connectionState = 'connecting'
        }

        if (qr) {
          latestQr = qr
          latestQrAt = Date.now()
          connectionState = 'qr'
          clearConnectTimeout();
          clearOperationalDataFor('disconnected')
        }

        if (connection === 'open') {
          clearConnectTimeout();
          clearReconnectTimer();
          activeSock = sock; // Atualiza o socket ativo
          latestQr = null
          connectionState = 'open'
          lastConnectedAt = Date.now();
          lastDisconnectCode = null;
          lastDisconnectReason = null;
          consecutiveConflicts = 0; // Reset conflitos ao conectar
          reconnectAttempts = 0; // Reset tentativas de reconexão
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
          clearConnectTimeout();
          activeSock = null; // Limpa o socket ativo
          stopHeartbeat(); // Para heartbeat
          connectionState = 'close'
          clearOperationalDataFor('disconnected')
          const code = resolveDisconnectCode(lastDisconnect);
          const reason = resolveDisconnectReason(lastDisconnect);

          lastDisconnectedAt = Date.now();
          lastDisconnectCode = code ?? null;
          lastDisconnectReason = reason;

          logger.warn(`[DISCONNECT] Conexão fechada. Código: ${code}, Motivo: ${reason}`);

          // Limpa socket anterior para evitar leak
          if (currentSock === sock) currentSock = null;
          stopSocket(sock);

          if (isLogoutDisconnect(code)) {
            logger.warn('[AUTH] Sessão inválida/logged out. Limpando credenciais para gerar novo QR.');
            try { accountManager.clearAuthDir(authPath); } catch (_) { clearAuthFiles() }
            reconnectAttempts = 0;
            consecutiveConflicts = 0;
            latestQr = null;
            latestQrAt = null;
            connectionState = 'qr';
            scheduleReconnect(RECONNECT_CONFIG.initialDelay, 'logged-out');
            return;
          }

          // Detecta conflito (outra sessão ativa)
          const isConflict = isConflictDisconnect(code, reason);

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
              latestQrAt = null;
              connectionState = 'qr';
              // Reinicia socket para gerar novo QR, sem deixar rejection sem tratamento
              scheduleReconnect(2_500, 'conflict-force-new-qr');
              return;
            }

            scheduleReconnect(null, 'conflict-disconnect');
            return;
          }

          consecutiveConflicts = 0; // Reset se não for conflito
          if (code === DisconnectReason.restartRequired) {
            scheduleReconnect(500, 'restart-required');
          } else if (code === DisconnectReason.unavailableService) {
            scheduleReconnect(RECONNECT_CONFIG.maxDelay, 'unavailable-service');
          } else {
            scheduleReconnect(null, `disconnect-${code || 'unknown'}`);
          }
        }
      } catch (err) {
        logger.error('[connection.update] Erro não tratado no handler:', err)
      }
    })

    sock.ev.on('messages.upsert', async ({ messages }) => {
      if (sock !== currentSock) return;
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
      const isBlacklistedForAutoMessages = isPhoneInBlacklist(phoneNumber)
      
      // Faz checagens rápidas em paralelo, sem aguardar
      setImmediate(() => {
        try {
          if (isBlacklistedForAutoMessages && !businessStatus.isOpen && isOutOfHoursEnabled()) {
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
      if (isBlacklistedForAutoMessages && businessStatus.isOpen && !welcomeQueuedForTicket.has(ticket.id) && shouldSendWelcomeMessage(ticket.id)) {
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
    touchConnectionEvent();
    clearConnectTimeout();
    stopHeartbeat();

    logger.error('[START] Falha ao iniciar WhatsApp. Tentando reconectar...', error)
    try {
      if (currentSock) {
        stopSocket(currentSock);
        currentSock = null;
      }
    } catch (e) {}

    activeSock = null;
    connectionState = 'close';
    lastDisconnectedAt = Date.now();
    lastDisconnectCode = 'start_error';
    lastDisconnectReason = error && error.message ? String(error.message) : 'start_error';
    scheduleReconnect(null, 'start-failure');
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
  connected: !!(activeSock && isSocketOpen(activeSock)),
  stableConnected: !!(activeSock && isSocketOpen(activeSock)) || (typeof lastConnectedAt === 'number' && (Date.now() - lastConnectedAt) < 15_000),
  lastConnectedAt,
  lastDisconnectedAt,
  lastDisconnectCode,
  lastDisconnectReason,
  reconnectAttempts,
  reconnectScheduledAt: nextReconnectAt,
});
module.exports.forceNewQr = async (allowWhenConnected = false) => {
  if (activeSock && !allowWhenConnected) {
    return { ok: false, reason: 'connected' };
  }

  clearReconnectTimer();
  clearConnectTimeout();
  stopHeartbeat();
  touchConnectionEvent();

  try {
    if (currentSock) {
      try { await currentSock.logout(); } catch (e) {}
      stopSocket(currentSock);
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
  reconnectAttempts = 0;
  consecutiveConflicts = 0;

  // Reinicia o bot após 1 segundo
  scheduleReconnect(1000, 'force-new-qr');

  return { ok: true };
};
