const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const accountContext = require('./accountContext');
const accountManager = require('./accountManager');

function ensureDir(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch (_) {}
}

function configurePragmas(db) {
  try {
    db.pragma('journal_mode = WAL');
    db.pragma(`synchronous = ${process.env.SQLITE_SYNCHRONOUS || 'NORMAL'}`);
    db.pragma('foreign_keys = ON');
    db.pragma(`busy_timeout = ${Number(process.env.SQLITE_BUSY_TIMEOUT_MS || 5000)}`);
    db.pragma('temp_store = MEMORY');
    db.pragma(`cache_size = ${Number(process.env.SQLITE_CACHE_KB || -20000)}`);
    db.pragma(`wal_autocheckpoint = ${Number(process.env.SQLITE_WAL_AUTOCHECKPOINT || 1000)}`);
  } catch (_) {}
}

function initSchema(db) {
  // Limpa tickets inválidos (ex.: @lid ou não iniciado com 55)
  try {
    db.exec(`
      BEGIN TRANSACTION;

      DELETE FROM messages
      WHERE ticket_id IN (
        SELECT id FROM tickets
        WHERE (phone LIKE '%@%' AND phone NOT LIKE '%@lid')
          OR (phone NOT LIKE '%@%' AND (length(phone) < 10 OR length(phone) > 15 OR phone GLOB '*[^0-9]*'))
      );

      DELETE FROM tickets
      WHERE (phone LIKE '%@%' AND phone NOT LIKE '%@lid')
        OR (phone NOT LIKE '%@%' AND (length(phone) < 10 OR length(phone) > 15 OR phone GLOB '*[^0-9]*'));

      COMMIT;
    `);
  } catch (err) {
    try { db.exec('ROLLBACK;'); } catch (_) {}
  }

  db.prepare(`
    CREATE TABLE IF NOT EXISTS sellers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      email TEXT UNIQUE,
      password TEXT NOT NULL,
      active BOOLEAN DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT,
      password TEXT,
      role TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `).run();

  // Migração: adiciona created_at na tabela users se não existir (bancos antigos)
  try {
    const cols = db.prepare('PRAGMA table_info(users)').all();
    if (!cols.some(c => c.name === 'created_at')) {
      db.prepare('ALTER TABLE users ADD COLUMN created_at DATETIME DEFAULT CURRENT_TIMESTAMP').run();
    }
  } catch (_) {}

  db.prepare(`
    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT,
      seller_id INTEGER,
      status TEXT DEFAULT 'pendente',
      contact_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (seller_id) REFERENCES sellers(id)
    );
  `).run();

  // Migração: Remove a constraint UNIQUE da coluna phone (bancos antigos)
  try {
    const tableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tickets'").get();
    if (tableInfo && tableInfo.sql && tableInfo.sql.includes('phone TEXT UNIQUE')) {
      const columns = db.prepare('PRAGMA table_info(tickets)').all();
      const hasAssignedTo = columns.some(col => col.name === 'assigned_to');
      const hasSellerId = columns.some(col => col.name === 'seller_id');

      db.exec(`
        PRAGMA foreign_keys=off;

        BEGIN TRANSACTION;

        DROP TABLE IF EXISTS tickets_new;

        CREATE TABLE tickets_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          phone TEXT,
          ${hasAssignedTo ? 'assigned_to INTEGER,' : ''}
          status TEXT DEFAULT 'pendente',
          contact_name TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          ${hasSellerId ? ', seller_id INTEGER' : ''}
        );

        INSERT INTO tickets_new SELECT * FROM tickets;
        DROP TABLE tickets;
        ALTER TABLE tickets_new RENAME TO tickets;

        COMMIT;

        PRAGMA foreign_keys=on;
      `);
    }
  } catch (_) {}

  // Migração: Adiciona a coluna seller_id se ela não existir
  try {
    db.prepare('ALTER TABLE tickets ADD COLUMN seller_id INTEGER').run();
  } catch (err) {
    if (!String(err.message || '').includes('duplicate column')) {}
  }

  // Migração: Adiciona a coluna contact_name se ela não existir
  try {
    db.prepare('ALTER TABLE tickets ADD COLUMN contact_name TEXT').run();
  } catch (err) {
    if (!String(err.message || '').includes('duplicate column')) {}
  }

  db.prepare(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER,
      sender TEXT,
      content TEXT,
      message_type TEXT DEFAULT 'text',
      media_url TEXT,
      sender_name TEXT,
      reply_to_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (ticket_id) REFERENCES tickets(id),
      FOREIGN KEY (reply_to_id) REFERENCES messages(id)
    );
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS ticket_reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL,
      seller_id INTEGER NOT NULL,
      note TEXT,
      scheduled_at DATETIME NOT NULL,
      status TEXT DEFAULT 'scheduled',
      notified_at DATETIME,
      created_by_user_id INTEGER,
      created_by_type TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (ticket_id) REFERENCES tickets(id),
      FOREIGN KEY (seller_id) REFERENCES sellers(id)
    );
  `).run();

  // Migração: adiciona colunas de lembretes se não existirem
  try { db.prepare('ALTER TABLE ticket_reminders ADD COLUMN notified_at DATETIME').run(); } catch (err) { if (!String(err.message || '').includes('duplicate column')) {} }
  try { db.prepare('ALTER TABLE ticket_reminders ADD COLUMN created_by_user_id INTEGER').run(); } catch (err) { if (!String(err.message || '').includes('duplicate column')) {} }
  try { db.prepare('ALTER TABLE ticket_reminders ADD COLUMN created_by_type TEXT').run(); } catch (err) { if (!String(err.message || '').includes('duplicate column')) {} }

  // Migração: Adiciona colunas se não existirem
  try { db.prepare('ALTER TABLE messages ADD COLUMN message_type TEXT DEFAULT "text"').run(); } catch (err) { if (!String(err.message || '').includes('duplicate column')) {} }
  try { db.prepare('ALTER TABLE messages ADD COLUMN media_url TEXT').run(); } catch (err) { if (!String(err.message || '').includes('duplicate column')) {} }
  try { db.prepare('ALTER TABLE messages ADD COLUMN sender_name TEXT').run(); } catch (err) { if (!String(err.message || '').includes('duplicate column')) {} }
  try { db.prepare('ALTER TABLE messages ADD COLUMN reply_to_id INTEGER').run(); } catch (err) { if (!String(err.message || '').includes('duplicate column')) {} }
  try { db.prepare('ALTER TABLE messages ADD COLUMN updated_at DATETIME').run(); } catch (err) { if (!String(err.message || '').includes('duplicate column')) {} }
  try { db.prepare('ALTER TABLE messages ADD COLUMN whatsapp_key TEXT').run(); } catch (err) { if (!String(err.message || '').includes('duplicate column')) {} }
  try { db.prepare('ALTER TABLE messages ADD COLUMN whatsapp_message TEXT').run(); } catch (err) { if (!String(err.message || '').includes('duplicate column')) {} }

  // Backfill: se updated_at estiver nulo, usa created_at
  try { db.prepare('UPDATE messages SET updated_at = created_at WHERE updated_at IS NULL').run(); } catch (_) {}

  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tickets_updated_at ON tickets(updated_at);
      CREATE INDEX IF NOT EXISTS idx_tickets_status_updated_at ON tickets(status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_tickets_seller_updated_at ON tickets(seller_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_tickets_phone ON tickets(phone);

      -- Garante apenas 1 ticket ativo por contato (phone)
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_ticket_per_phone
        ON tickets(phone)
        WHERE phone IS NOT NULL
          AND phone != ''
          AND status NOT IN ('resolvido', 'encerrado');

      CREATE INDEX IF NOT EXISTS idx_messages_ticket_created_at ON messages(ticket_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_ticket_updated_at ON messages(ticket_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_messages_ticket_sender ON messages(ticket_id, sender);
      CREATE INDEX IF NOT EXISTS idx_messages_reply_to_id ON messages(reply_to_id);

      CREATE INDEX IF NOT EXISTS idx_reminders_ticket_id ON ticket_reminders(ticket_id);
      CREATE INDEX IF NOT EXISTS idx_reminders_seller_id ON ticket_reminders(seller_id);
      CREATE INDEX IF NOT EXISTS idx_reminders_scheduled_at ON ticket_reminders(scheduled_at);
      CREATE INDEX IF NOT EXISTS idx_reminders_status ON ticket_reminders(status);
      
      CREATE INDEX IF NOT EXISTS idx_blacklist_phone ON blacklist(phone);
    `);
  } catch (_) {}

  try { db.pragma('optimize'); } catch (_) {}

  db.prepare(`
    CREATE TABLE IF NOT EXISTS blacklist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT UNIQUE,
      reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS business_hours (
      day INTEGER PRIMARY KEY,
      open_time TEXT,
      close_time TEXT,
      enabled INTEGER DEFAULT 1
    );
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS business_exceptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT UNIQUE,
      closed INTEGER DEFAULT 1,
      open_time TEXT,
      close_time TEXT,
      reason TEXT
    );
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS out_of_hours_log (
      phone TEXT PRIMARY KEY,
      last_sent_at INTEGER
    );
  `).run();

  // Seeds
  try {
    const hoursCount = db.prepare('SELECT COUNT(*) as count FROM business_hours').get().count;
    if (hoursCount === 0) {
      const insertHour = db.prepare('INSERT INTO business_hours (day, open_time, close_time, enabled) VALUES (?, ?, ?, ?)');
      insertHour.run(0, '09:00', '18:00', 0);
      insertHour.run(1, '09:00', '18:00', 1);
      insertHour.run(2, '09:00', '18:00', 1);
      insertHour.run(3, '09:00', '18:00', 1);
      insertHour.run(4, '09:00', '18:00', 1);
      insertHour.run(5, '09:00', '18:00', 1);
      insertHour.run(6, '09:00', '18:00', 0);
    }
  } catch (_) {}

  try {
    const existing = db.prepare('SELECT value FROM settings WHERE key = ?').get('out_of_hours_message');
    if (!existing) {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
        'out_of_hours_message',
        '🕒 Nosso horário de atendimento já encerrou. Retornaremos no próximo horário de funcionamento.'
      );
    }
  } catch (_) {}

  try {
    const existingEnabled = db.prepare('SELECT value FROM settings WHERE key = ?').get('out_of_hours_enabled');
    if (!existingEnabled) {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('out_of_hours_enabled', '1');
    }
  } catch (_) {}

  try {
    const existingAwait = db.prepare('SELECT value FROM settings WHERE key = ?').get('await_minutes');
    if (!existingAwait) {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('await_minutes', '0');
    }
  } catch (_) {}

  try {
    const existingWelcome = db.prepare('SELECT value FROM settings WHERE key = ?').get('welcome_message');
    if (!existingWelcome) {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
        'welcome_message',
        '👋 Olá! Seja bem-vindo(a)! Um de nossos atendentes já vai responder você. Por favor, aguarde um momento.'
      );
    }
  } catch (_) {}
}

function attachHelpers(db) {
  db.clearOperationalData = function clearOperationalData() {
    try {
      db.exec(`
        BEGIN TRANSACTION;
        DELETE FROM out_of_hours_log;
        COMMIT;
      `);
    } catch (err) {
      try { db.exec('ROLLBACK;'); } catch (_) {}
    }
  };

  db.clearUserData = function clearUserData() {
    try {
      db.exec(`
        BEGIN TRANSACTION;
        DELETE FROM sellers;
        DELETE FROM users;
        COMMIT;
      `);
    } catch (err) {
      try { db.exec('ROLLBACK;'); } catch (_) {}
    }
  };

  db.clearAllData = function clearAllData() {
    try {
      db.exec(`
        BEGIN TRANSACTION;
        DELETE FROM messages;
        DELETE FROM tickets;
        DELETE FROM sellers;
        DELETE FROM users;
        DELETE FROM blacklist;
        DELETE FROM out_of_hours_log;
        COMMIT;
      `);
    } catch (err) {
      try { db.exec('ROLLBACK;'); } catch (_) {}
    }
  };

  return db;
}

function openDbForPath(dbFilePath) {
  ensureDir(path.dirname(dbFilePath));
  const db = new Database(dbFilePath);
  configurePragmas(db);
  initSchema(db);
  attachHelpers(db);
  return db;
}

let currentDbPath = null;
let currentDb = null;

function ensureCurrentDb() {
  const desiredPath = accountManager.getDbPathForActiveOrDefault();
  if (currentDb && currentDbPath === desiredPath) return currentDb;

  if (currentDb) {
    try { currentDb.close(); } catch (_) {}
    currentDb = null;
  }

  currentDbPath = desiredPath;
  currentDb = openDbForPath(desiredPath);
  return currentDb;
}

function switchToActiveAccount() {
  ensureCurrentDb();
}

try {
  accountContext.emitter.on('changed', () => {
    switchToActiveAccount();
  });
} catch (_) {}

module.exports = new Proxy({}, {
  get(_target, prop) {
    if (prop === '__isDbProxy') return true;
    if (prop === 'getPath') return () => currentDbPath || accountManager.getDbPathForActiveOrDefault();
    if (prop === 'switchToActiveAccount') return () => switchToActiveAccount();
    if (prop === 'close') return () => {
      if (currentDb) {
        try { currentDb.close(); } catch (_) {}
      }
      currentDb = null;
      currentDbPath = null;
    };

    const db = ensureCurrentDb();
    const v = db[prop];
    if (typeof v === 'function') return v.bind(db);
    return v;
  },
  set(_target, prop, value) {
    const db = ensureCurrentDb();
    db[prop] = value;
    return true;
  }
});