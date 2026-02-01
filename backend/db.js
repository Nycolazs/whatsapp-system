const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '..', 'data', 'db');
const dbPath = path.join(dataDir, 'db.sqlite');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Migra banco legado (se existir) para a nova pasta data
if (!fs.existsSync(dbPath)) {
  const legacyPaths = [
    path.join(__dirname, 'db.sqlite'),
    path.join(__dirname, '..', 'db.sqlite'),
    path.join(__dirname, '..', 'data', 'db.sqlite')
  ];

  const legacyPath = legacyPaths.find(p => fs.existsSync(p));
  if (legacyPath) {
    try {
      fs.renameSync(legacyPath, dbPath);
    } catch (err) {
      fs.copyFileSync(legacyPath, dbPath);
      try {
        fs.unlinkSync(legacyPath);
      } catch (e) {
        // Ignora
      }
    }
  }
}

const db = new Database(dbPath);

// Garantias de persistência e integridade
try {
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
} catch (err) {
  // Erro ao configurar pragmas
}

// Limpa tickets inválidos (ex.: @lid ou não iniciado com 55)
try {
  db.exec(`
    BEGIN TRANSACTION;

    DELETE FROM messages
    WHERE ticket_id IN (
      SELECT id FROM tickets
      WHERE phone LIKE '%@%'
         OR phone NOT LIKE '55%'
         OR length(phone) < 12
         OR length(phone) > 13
    );

    DELETE FROM tickets
    WHERE phone LIKE '%@%'
       OR phone NOT LIKE '55%'
       OR length(phone) < 12
       OR length(phone) > 13;

    COMMIT;
  `);
} catch (err) {
  try { db.exec('ROLLBACK;'); } catch (e) {}
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
  const cols = db.prepare("PRAGMA table_info(users)").all();
  if (!cols.some(c => c.name === 'created_at')) {
    db.prepare('ALTER TABLE users ADD COLUMN created_at DATETIME DEFAULT CURRENT_TIMESTAMP').run();
  }
} catch (err) {
  // ignora se já existir
}

db.prepare(`
CREATE TABLE IF NOT EXISTS tickets (
id INTEGER PRIMARY KEY AUTOINCREMENT,
phone TEXT UNIQUE,
seller_id INTEGER,
status TEXT DEFAULT 'pendente',
contact_name TEXT,
created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
FOREIGN KEY (seller_id) REFERENCES sellers(id)
);
`).run();

// Migração: Remove a constraint UNIQUE da coluna phone
try {
  // Verifica se a constraint UNIQUE ainda existe
  const tableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tickets'").get();
  
  if (tableInfo && tableInfo.sql.includes('phone TEXT UNIQUE')) {
    // Verifica a estrutura atual da tabela
    const columns = db.prepare("PRAGMA table_info(tickets)").all();
    const hasAssignedTo = columns.some(col => col.name === 'assigned_to');
    const hasSellerId = columns.some(col => col.name === 'seller_id');
    
    // SQLite não permite ALTER COLUMN, então precisamos recriar a tabela
    db.exec(`
      PRAGMA foreign_keys=off;
      
      BEGIN TRANSACTION;
      
      -- Remove tabela temporária se existir
      DROP TABLE IF EXISTS tickets_new;
      
      -- Cria tabela temporária sem UNIQUE (com todas as colunas)
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
      
      -- Copia dados da tabela antiga
      INSERT INTO tickets_new SELECT * FROM tickets;
      
      -- Remove tabela antiga
      DROP TABLE tickets;
      
      -- Renomeia nova tabela
      ALTER TABLE tickets_new RENAME TO tickets;
      
      COMMIT;
      
      PRAGMA foreign_keys=on;
    `);
  } else {
    // Tabela tickets já está correta
  }
} catch (err) {
  // Erro na migração
}

// Migração: Adiciona a coluna seller_id se ela não existir
try {
  db.prepare('ALTER TABLE tickets ADD COLUMN seller_id INTEGER').run();
} catch (err) {
  // Coluna já existe, ignora o erro
  if (!err.message.includes('duplicate column')) {
    // Erro na migração
  }
}

// Migração: Remove coluna assigned_to se existir (substituída por seller_id)
try {
  const info = db.prepare("PRAGMA table_info(tickets)").all();
  if (info.some(col => col.name === 'assigned_to')) {
    // SQLite não suporta DROP COLUMN diretamente
  }
} catch (err) {
  // Ignora
}

// Migração: Adiciona a coluna contact_name se ela não existir
try {
  db.prepare('ALTER TABLE tickets ADD COLUMN contact_name TEXT').run();
} catch (err) {
  // Coluna já existe, ignora o erro
  if (!err.message.includes('duplicate column')) {
    // Erro na migração
  }
}


db.prepare(`
CREATE TABLE IF NOT EXISTS messages (
id INTEGER PRIMARY KEY AUTOINCREMENT,
ticket_id INTEGER,
sender TEXT,
content TEXT,
message_type TEXT DEFAULT 'text',
media_url TEXT,
created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
FOREIGN KEY (ticket_id) REFERENCES tickets(id)
);
`).run();

// Migração: Adiciona colunas de mídia se não existirem
try {
  db.prepare('ALTER TABLE messages ADD COLUMN message_type TEXT DEFAULT "text"').run();
} catch (err) {
  if (!err.message.includes('duplicate column')) {
    // Erro na migração
  }
}

try {
  db.prepare('ALTER TABLE messages ADD COLUMN media_url TEXT').run();
} catch (err) {
  if (!err.message.includes('duplicate column')) {
    // Erro na migração
  }
}

try {
  db.prepare('ALTER TABLE messages ADD COLUMN sender_name TEXT').run();
} catch (err) {
  if (!err.message.includes('duplicate column')) {
    // Erro na migração
  }
}


db.prepare(`
CREATE TABLE IF NOT EXISTS blacklist (
id INTEGER PRIMARY KEY AUTOINCREMENT,
phone TEXT UNIQUE,
reason TEXT,
created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`).run();

// Horários de funcionamento
db.prepare(`
CREATE TABLE IF NOT EXISTS business_hours (
day INTEGER PRIMARY KEY,
open_time TEXT,
close_time TEXT,
enabled INTEGER DEFAULT 1
);
`).run();

// Datas excepcionais (feriados, etc.)
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

// Configurações gerais
db.prepare(`
CREATE TABLE IF NOT EXISTS settings (
key TEXT PRIMARY KEY,
value TEXT
);
`).run();

// Controle de envio da mensagem fora do horário
db.prepare(`
CREATE TABLE IF NOT EXISTS out_of_hours_log (
phone TEXT PRIMARY KEY,
last_sent_at INTEGER
);
`).run();

// Seed inicial: horários padrão (se vazio)
try {
  const hoursCount = db.prepare('SELECT COUNT(*) as count FROM business_hours').get().count;
  if (hoursCount === 0) {
    const insertHour = db.prepare('INSERT INTO business_hours (day, open_time, close_time, enabled) VALUES (?, ?, ?, ?)');
    // 0=Domingo, 1=Segunda, ... 6=Sábado
    insertHour.run(0, '09:00', '18:00', 0);
    insertHour.run(1, '09:00', '18:00', 1);
    insertHour.run(2, '09:00', '18:00', 1);
    insertHour.run(3, '09:00', '18:00', 1);
    insertHour.run(4, '09:00', '18:00', 1);
    insertHour.run(5, '09:00', '18:00', 1);
    insertHour.run(6, '09:00', '18:00', 0);
  }
} catch (err) {
  // Ignora erros de seed
}

// Seed inicial: mensagem padrão fora do horário
try {
  const existing = db.prepare('SELECT value FROM settings WHERE key = ?').get('out_of_hours_message');
  if (!existing) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
      'out_of_hours_message',
      '🕒 Nosso horário de atendimento já encerrou. Retornaremos no próximo horário de funcionamento.'
    );
  }
} catch (err) {
  // Ignora erros de seed
}

function clearOperationalData() {
  try {
    db.exec(`
      BEGIN TRANSACTION;
      DELETE FROM out_of_hours_log;
      COMMIT;
    `);
  } catch (err) {
    try { db.exec('ROLLBACK;'); } catch (e) {}
  }
}

db.clearOperationalData = clearOperationalData;

function clearUserData() {
  try {
    db.exec(`
      BEGIN TRANSACTION;
      DELETE FROM sellers;
      DELETE FROM users;
      COMMIT;
    `);
  } catch (err) {
    try { db.exec('ROLLBACK;'); } catch (e) {}
  }
}

db.clearUserData = clearUserData;

function clearAllData() {
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
    try { db.exec('ROLLBACK;'); } catch (e) {}
  }
}

db.clearAllData = clearAllData;

module.exports = db;