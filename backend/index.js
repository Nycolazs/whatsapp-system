const express = require('express');
const cors = require('cors');
const path = require('path');
const whatsappService = require('./src/whatsapp/whatsappService');
const { startBot, getSocket, getQrState } = whatsappService;
const baileys = whatsappService.raw;
const db = require('./db');
const accountContext = require('./accountContext');
const accountManager = require('./accountManager');
const { hashPassword } = require('./src/security/password');
const { requireAuth, requireAdmin } = require('./src/middleware/auth');
const { createSystemRouter } = require('./src/routes/system.routes');
const { createWhatsAppRouter } = require('./src/routes/whatsapp.routes');
const { createAuthRouter } = require('./src/routes/auth.routes');
const { createUsersRouter } = require('./src/routes/users.routes');
const { createTicketsRouter } = require('./src/routes/tickets.routes');
const { createContactsRouter } = require('./src/routes/contacts.routes');
const { createBlacklistRouter } = require('./src/routes/blacklist.routes');
const { createHealthRouter } = require('./src/routes/health.routes');
const { createAdminConfigRouter } = require('./src/routes/admin-config.routes');
const { createPagesRouter } = require('./src/routes/pages.routes');
const { startAutoAwaitJob } = require('./src/jobs/autoAwait');
const { installGracefulShutdown } = require('./src/server/gracefulShutdown');
const { createSessionMiddleware } = require('./src/session/createSessionMiddleware');
const { createLogger } = require('./src/logger');
const multer = require('multer');
const fs = require('fs');

const logger = createLogger('backend');

const app = express();

app.disable('x-powered-by');

// compressão é opcional (só ativa se a dependência estiver instalada)
try {
  // eslint-disable-next-line import/no-extraneous-dependencies
  const compression = require('compression');
  app.use(compression());
} catch (_) {}

const sessionManager = createSessionMiddleware({
  accountContext,
  accountManager,
  secret: process.env.SESSION_SECRET || 'whatsapp-system-secret-key-fixed-2024',
  cookie: {
    secure: false,
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
});
app.use(sessionManager.middleware);

const corsOrigin = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(s => s.trim()).filter(Boolean)
  : true;

app.use(cors({
  origin: corsOrigin,
  credentials: true
}));
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '1mb' }));

// Configuração do multer para upload de áudio
const audioDir = path.join(__dirname, '../media/audios');
if (!fs.existsSync(audioDir)) {
  fs.mkdirSync(audioDir, { recursive: true });
}

const uploadAudio = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, audioDir);
    },
    filename: (req, file, cb) => {
      const timestamp = Date.now();
      const ext = 'ogg'; // Padrão para áudio
      cb(null, `audio_${timestamp}.${ext}`);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('audio/')) {
      cb(null, true);
    } else {
      cb(new Error('Apenas arquivos de áudio são permitidos'));
    }
  }
});

app.use(express.static(path.join(__dirname, '../')));
app.use('/media', express.static(path.join(__dirname, '../media'), {
  maxAge: process.env.MEDIA_CACHE_MAXAGE || '30d',
  immutable: true,
}));

const frontendDir = path.join(__dirname, '../frontend');

app.use(createPagesRouter({ frontendDir, getQrState }));

function getAdminCount() {
  try {
    return db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin'").get().count || 0;
  } catch (err) {
    return 0;
  }
}


app.use(createSystemRouter({ baileys }));
app.use(createWhatsAppRouter({ baileys, db, requireAdmin }));
app.use(createAuthRouter({ db, hashPassword, getQrState }));
app.use(createUsersRouter({ db, hashPassword, requireAuth, requireAdmin, getAdminCount }));
app.use(createTicketsRouter({ db, requireAuth, requireAdmin, getSocket, uploadAudio }));
app.use(createBlacklistRouter({ db }));
app.use(createContactsRouter({ getSocket }));
app.use(createHealthRouter({ getQrState, accountContext, db, getSessionsPath: () => sessionManager.getCurrentSessionDbPath() }));
app.use(createAdminConfigRouter({ db, requireAdmin, accountContext, accountManager }));

// Shutdown gracioso (evita corrupção/locks quando roda por muito tempo)
let server = null;
let autoAwaitJob = null;
installGracefulShutdown({
  getServer: () => server,
  onShutdown: () => {
    try { if (autoAwaitJob && typeof autoAwaitJob.stop === 'function') autoAwaitJob.stop(); } catch (_) {}
    try { sessionManager.close(); } catch (_) {}
    try { db.close && db.close(); } catch (_) {}
  },
});


startBot().then(() => {
  // Bot iniciado
});

autoAwaitJob = startAutoAwaitJob({ db });

server = app.listen(3001, '0.0.0.0', () => logger.info('Servidor rodando na porta 3001'));