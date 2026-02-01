#!/usr/bin/env node

const Database = require('better-sqlite3');
const path = require('path');

// Conecta ao banco de dados (mesmo caminho usado no backend)
const primaryDbPath = path.join(__dirname, 'data', 'db', 'db.sqlite');
const legacyPaths = [
  path.join(__dirname, 'backend', 'db.sqlite'),
  path.join(__dirname, 'db.sqlite'),
  path.join(__dirname, 'data', 'db.sqlite')
];

let dbPath = primaryDbPath;
if (!require('fs').existsSync(dbPath)) {
  const legacy = legacyPaths.find(p => require('fs').existsSync(p));
  if (legacy) dbPath = legacy;
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

console.log('🔍 Testando a funcionalidade de Aguardando Automático...\n');

// 1. Verifica configuração atual
console.log('1️⃣  Verificando configuração...');
let currentMinutes = 0;
try {
  const configRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('await_minutes');
  currentMinutes = configRow ? parseInt(configRow.value || '0', 10) : 0;
  console.log(`   ➜ Timeout configurado: ${currentMinutes} minutos\n`);
} catch (err) {
  console.log('   ⚠️  Não foi possível ler a tabela settings.');
  console.log(`   ➜ Erro: ${err.message}`);
  console.log('   ➜ Certifique-se de que o backend já inicializou o banco.\n');
}

if (currentMinutes <= 0) {
  console.log('⚠️  AVISO: Aguardando automático está DESATIVADO (0 minutos)');
  console.log('   Para ativar, configure um valor maior que 0 na tela de admin\n');
}

// 2. Lista tickets em "em_atendimento"
console.log('2️⃣  Tickets em "em_atendimento"...');
const tickets = db.prepare(`
  SELECT 
    id,
    phone,
    contact_name,
    status,
    updated_at,
    seller_id
  FROM tickets 
  WHERE status = 'em_atendimento'
  ORDER BY updated_at DESC
`).all();

if (tickets.length === 0) {
  console.log('   ➜ Nenhum ticket em atendimento\n');
} else {
  console.log(`   ➜ Total: ${tickets.length} ticket(s)\n`);
  tickets.forEach(t => {
    const lastUpdate = new Date(t.updated_at);
    const minutesAgo = Math.floor((Date.now() - lastUpdate.getTime()) / 60000);
    const shouldMove = currentMinutes > 0 && minutesAgo >= currentMinutes;
    const icon = shouldMove ? '🔴' : '🟢';
    console.log(`   ${icon} ID: ${t.id} | ${t.contact_name || t.phone}`);
    console.log(`      Status: ${t.status} | Atualizado há ${minutesAgo}min | Vendedor: ${t.seller_id || 'N/A'}`);
    if (shouldMove) {
      console.log(`      ⚠️  SERÁ MOVIDO PARA "AGUARDANDO" (timeout: ${currentMinutes}min)\n`);
    } else {
      console.log('');
    }
  });
}

// 3. Simula o processamento automático
if (currentMinutes > 0) {
  console.log('3️⃣  Simulando processamento automático...');
  const cutoff = new Date(Date.now() - currentMinutes * 60000).toISOString().replace('T', ' ').slice(0, 19);
  console.log(`   Cutoff time: ${cutoff}`);
  
  const result = db.prepare(`
    UPDATE tickets 
    SET status = 'aguardando', seller_id = NULL, updated_at = CURRENT_TIMESTAMP 
    WHERE status = 'em_atendimento' AND updated_at <= ?
  `).run(cutoff);
  
  console.log(`   ➜ Tickets movidos: ${result.changes}\n`);
  
  if (result.changes > 0) {
    console.log('✅ Processamento completado com sucesso!\n');
    console.log('Tickets atualizados:');
    const updated = db.prepare(`
      SELECT id, phone, contact_name 
      FROM tickets 
      WHERE status = 'aguardando' 
      ORDER BY updated_at DESC 
      LIMIT ?
    `).all(result.changes);
    updated.forEach(t => {
      console.log(`   ✓ ID: ${t.id} | ${t.contact_name || t.phone}`);
    });
  }
} else {
  console.log('3️⃣  ⏭️  Pulando teste de processamento (aguardando automático desativado)\n');
}

// 4. Resumo
console.log('\n📊 RESUMO:');
const total = db.prepare('SELECT COUNT(*) as count FROM tickets').get();
const pendente = db.prepare("SELECT COUNT(*) as count FROM tickets WHERE status = 'pendente'").get();
const em_atendimento = db.prepare("SELECT COUNT(*) as count FROM tickets WHERE status = 'em_atendimento'").get();
const aguardando = db.prepare("SELECT COUNT(*) as count FROM tickets WHERE status = 'aguardando'").get();
const resolvido = db.prepare("SELECT COUNT(*) as count FROM tickets WHERE status = 'resolvido'").get();

console.log(`   Total de tickets: ${total.count}`);
console.log(`   ├─ Pendente: ${pendente.count}`);
console.log(`   ├─ Em Atendimento: ${em_atendimento.count}`);
console.log(`   ├─ Aguardando: ${aguardando.count}`);
console.log(`   └─ Resolvido: ${resolvido.count}`);

console.log('\n' + '='.repeat(50));
console.log('💡 Para testar manualmente:');
console.log('   1. Configure o timeout na tela de admin (ex: 1 minuto)');
console.log('   2. Marque um ticket como "em_atendimento"');
console.log('   3. Aguarde o tempo configurado');
console.log('   4. O ticket deve aparecer em "Aguardando" automaticamente');
console.log('='.repeat(50) + '\n');

db.close();
