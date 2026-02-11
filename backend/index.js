const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const http = require('http');
const https = require('https');
const path = require('path');
const whatsappService = require('./src/whatsapp/whatsappService');
const { startBot, getSocket, getQrState } = whatsappService;
const baileys = whatsappService.raw;
const db = require('./db');
const accountContext = require('./accountContext');
const accountManager = require('./accountManager');
const { hashPassword, hashPasswordSync, verifyPassword, verifyPasswordSync } = require('./src/security/password');
const { requireAuth, requireAdmin } = require('./src/middleware/auth');
const { generalLimiter } = require('./src/middleware/rateLimiter');
const { createSystemRouter } = require('./src/routes/system.routes');
const { createWhatsAppRouter } = require('./src/routes/whatsapp.routes');
const { createAuthRouter } = require('./src/routes/auth.routes');
const { createUsersRouter } = require('./src/routes/users.routes');
const { createTicketsRouter } = require('./src/routes/tickets.routes');
const { createContactsRouter } = require('./src/routes/contacts.routes');
const { createBlacklistRouter } = require('./src/routes/blacklist.routes');
const { createHealthRouter } = require('./src/routes/health.routes');
const { createAdminConfigRouter } = require('./src/routes/admin-config.routes');
const { createEventsRouter } = require('./src/routes/events.routes');
const { createPagesRouter } = require('./src/routes/pages.routes');
const { startAutoAwaitJob } = require('./src/jobs/autoAwait');
const { installGracefulShutdown } = require('./src/server/gracefulShutdown');
const { createSessionMiddleware } = require('./src/session/createSessionMiddleware');
const { attachRealtimeWebSocket } = require('./src/server/realtime-ws');
const { createLogger } = require('./src/logger');
const multer = require('multer');
const fs = require('fs');

const logger = createLogger('backend');

process.on('unhandledRejection', (reason) => {
  try {
    logger.error('[process] unhandledRejection:', reason);
  } catch (_) {
    console.error('[process] unhandledRejection:', reason);
  }
});

process.on('uncaughtException', (err) => {
  try {
    logger.error('[process] uncaughtException:', err);
  } catch (_) {
    console.error('[process] uncaughtException:', err);
  }
  // Intencionalmente NÃO encerramos o processo aqui.
  // Preferimos manter a API de pé mesmo se o WhatsApp falhar.
});

const app = express();

const trustProxy = Number(process.env.TRUST_PROXY || 0);
if (trustProxy > 0) {
  app.set('trust proxy', trustProxy);
}

const isProduction = process.env.NODE_ENV === 'production';

app.disable('x-powered-by');

// Security headers
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        scriptSrcAttr: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:', 'https://pps.whatsapp.net'],
        connectSrc: ["'self'", '*'], // Permite conexões de qualquer origem em desenvolvimento
        mediaSrc: ["'self'", 'blob:'],
        // Não forçar upgrade para HTTPS em desenvolvimento (LAN/HTTP)
        upgradeInsecureRequests: isProduction ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    // Evita Strict-Transport-Security em HTTP/LAN (senão o browser força HTTPS e quebra tudo)
    hsts: isProduction,
  })
);

// compressão é opcional (só ativa se a dependência estiver instalada)
try {
  // eslint-disable-next-line import/no-extraneous-dependencies
  const compression = require('compression');
  app.use(compression());
} catch (_) {}

const corsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(s => s.trim()).filter(Boolean)
  : null;

const allowInsecureCookies = process.env.ALLOW_INSECURE_COOKIES === '1';
const defaultSameSite = process.env.COOKIE_SAMESITE || (corsOrigins ? 'none' : (isProduction ? 'strict' : 'lax'));

const cookieSecure = process.env.COOKIE_SECURE
  ? process.env.COOKIE_SECURE === '1'
  : (defaultSameSite === 'none' ? (allowInsecureCookies ? false : true) : (isProduction ? 'auto' : false));

const sessionManager = createSessionMiddleware({
  accountContext,
  accountManager,
  secret: process.env.SESSION_SECRET || 'whatsapp-system-secret-key-fixed-2024',
  cookie: {
    secure: cookieSecure,
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    sameSite: defaultSameSite,
  },
});
app.use(sessionManager.middleware);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (!corsOrigins) return cb(null, true);
    if (corsOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 200,
}));
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '1mb' }));

// Debug middleware para log de requisições
app.use((req, res, next) => {
  if (req.path.startsWith('/auth/')) {
    console.log(`[DEBUG] ${req.method} ${req.path}`, {
      contentType: req.headers['content-type'],
      body: req.body
    });
  }
  next();
});

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

app.use('/media', express.static(path.join(__dirname, '../media'), {
  maxAge: process.env.MEDIA_CACHE_MAXAGE || '30d',
  immutable: true,
}));
const serveFrontend = process.env.SERVE_FRONTEND !== '0';
const frontendDir = path.join(__dirname, '../frontend');

if (serveFrontend) {
  // Serve frontend assets (modo legado)
  app.use(express.static(frontendDir, {
    extensions: ['html', 'htm', 'css', 'js', 'json'],
    setHeaders: (res, path) => {
      if (path.endsWith('.css')) {
        res.setHeader('Content-Type', 'text/css; charset=utf-8');
      } else if (path.endsWith('.js')) {
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      }
    }
  }));
}

// Rate limit: aplicado apenas depois dos middlewares de static para não contar assets.
app.use(generalLimiter);

function getAdminCount() {
  try {
    return db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin'").get().count || 0;
  } catch (err) {
    return 0;
  }
}


app.use(createSystemRouter({ baileys }));
app.use(createWhatsAppRouter({ baileys, db, requireAdmin }));
app.use(createAuthRouter({ db, hashPassword, verifyPassword, getQrState }));
app.use(createUsersRouter({ db, hashPassword, requireAuth, requireAdmin, getAdminCount }));
app.use(createTicketsRouter({ db, requireAuth, requireAdmin, getSocket, uploadAudio }));
app.use(createBlacklistRouter({ db }));
app.use(createContactsRouter({ getSocket }));
app.use(createEventsRouter({ requireAuth }));
app.use(createHealthRouter({ getQrState, accountContext, db, getSessionsPath: () => sessionManager.getCurrentSessionDbPath() }));
app.use(createAdminConfigRouter({ db, requireAdmin, accountContext, accountManager }));

// Pages router deve ser o último para não interceptar rotas de API
if (serveFrontend) {
  app.use(createPagesRouter({ frontendDir, getQrState }));
}

// Error handler middleware - deve vir após todas as rotas
app.use((err, req, res, next) => {
  console.error('Erro não tratado:', err);
  
  // Se a requisição é para uma rota de API, retorna JSON
  if (req.path.startsWith('/api/') || req.path.startsWith('/auth/') || req.path.startsWith('/whatsapp/')) {
    return res.status(err.status || 500).json({ 
      error: err.message || 'Erro interno do servidor' 
    });
  }
  
  // Caso contrário, passa para o próximo handler
  next(err);
});

// Shutdown gracioso (evita corrupção/locks quando roda por muito tempo)
let server = null;
let httpsServer = null;
let autoAwaitJob = null;
installGracefulShutdown({
  getServer: () => server,
  onShutdown: () => {
    try { if (autoAwaitJob && typeof autoAwaitJob.stop === 'function') autoAwaitJob.stop(); } catch (_) {}
    try { if (httpsServer) httpsServer.close(); } catch (_) {}
    try { sessionManager.close(); } catch (_) {}
    try { db.close && db.close(); } catch (_) {}
    // Aguarda um pouco para garantir que os buffers sejam gravados
    return new Promise(resolve => setTimeout(resolve, 1000));
  },
});


startBot()
  .then(() => {
    // Bot iniciado
  })
  .catch((err) => {
    logger.error('[startBot] Falha ao iniciar WhatsApp:', err);
  });

autoAwaitJob = startAutoAwaitJob({ db });

const HTTP_PORT = Number(process.env.PORT || process.env.HTTP_PORT || 3001);
server = http.createServer(app);
server.listen(HTTP_PORT, '0.0.0.0', () => logger.info(`Servidor HTTP rodando na porta ${HTTP_PORT}`));
attachRealtimeWebSocket({
  server,
  sessionMiddleware: sessionManager.middleware,
  allowedOrigins: corsOrigins || null,
});

// HTTPS opcional (resolve limitações do navegador para microfone ao acessar por IP)
// Para ativar:
// - export HTTPS_KEY_PATH=/caminho/key.pem
// - export HTTPS_CERT_PATH=/caminho/cert.pem
// - export HTTPS_PORT=3443 (opcional)
try {
  const keyPath = process.env.HTTPS_KEY_PATH;
  const certPath = process.env.HTTPS_CERT_PATH;
  if (keyPath && certPath) {
    const key = fs.readFileSync(keyPath);
    const cert = fs.readFileSync(certPath);
    const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3443);
    httpsServer = https.createServer({ key, cert }, app);
    httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => logger.info(`Servidor HTTPS rodando na porta ${HTTPS_PORT}`));
    attachRealtimeWebSocket({
      server: httpsServer,
      sessionMiddleware: sessionManager.middleware,
      allowedOrigins: corsOrigins || null,
    });
  }
} catch (err) {
  logger.error('[https] Falha ao iniciar HTTPS:', err);
}

// Limpa recursos periodicamente para evitar memory leaks
setInterval(() => {
  try {
    if (global.gc) {
      global.gc();
    }
  } catch (_) {}
}, 5 * 60 * 1000); // A cada 5 minutos
