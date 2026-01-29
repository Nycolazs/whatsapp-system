const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '..', 'data');
const dbPath = path.join(dataDir, 'db.sqlite');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Migra banco legado (se existir) para a nova pasta data
if (!fs.existsSync(dbPath)) {
  const legacyPaths = [
    path.join(__dirname, 'db.sqlite'),
    path.join(__dirname, '..', 'db.sqlite')
  ];

  const legacyPath = legacyPaths.find(p => fs.existsSync(p));
  if (legacyPath) {
    fs.copyFileSync(legacyPath, dbPath);
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
role TEXT
);
`).run();


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

// Seed inicial: Cria usuário admin e vendedores APENAS na primeira execução
// (quando tabelas estiverem completamente vazias)
const crypto = require('crypto');

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

try {
  const sellerCount = db.prepare('SELECT COUNT(*) as count FROM sellers').get().count;
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;

  // Só faz seed se AMBAS as tabelas estiverem vazias (primeira execução)
  if (sellerCount === 0 && userCount === 0) {
    // Cria admin
    db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)').run('admin', 'admin', 'admin');

    // Cria vendedores exemplo
    db.prepare('INSERT INTO sellers (name, email, password) VALUES (?, ?, ?)').run(
      'João',
      'joao@example.com',
      hashPassword('123456')
    );

    db.prepare('INSERT INTO sellers (name, email, password) VALUES (?, ?, ?)').run(
      'Maria',
      'maria@example.com',
      hashPassword('123456')
    );
  }
} catch (err) {
  // Ignora erros de seed (tabelas já populadas ou outros erros não críticos)
}

module.exports = db;