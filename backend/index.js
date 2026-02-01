const express = require('express');
const cors = require('cors');
const path = require('path');
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);
const Database = require('better-sqlite3');
const startBot = require('./baileys');
const { getSocket, getQrState, forceNewQr } = require('./baileys');
const db = require('./db');
const crypto = require('crypto');
const qrcode = require('qrcode');

const app = express();

// Configurar sessões com armazenamento persistente
const sessionDb = new Database(path.join(__dirname, '..', 'data', 'db', 'sessions.db'));
app.use(session({
  store: new SqliteStore({
    client: sessionDb,
    expired: {
      clear: true,
      intervalMs: 900000 // 15 minutos
    }
  }),
  secret: 'whatsapp-system-secret-key-fixed-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: false, // mudar para true em produção com HTTPS
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 dias
  }
}));

app.use(cors({
  origin: true,
  credentials: true
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, '../')));
app.use('/media', express.static(path.join(__dirname, '../media')));

const frontendDir = path.join(__dirname, '../frontend');

// Rotas amigáveis para as telas (sem /frontend/...)
app.get('/', (req, res) => {
  return res.sendFile(path.join(frontendDir, 'index.html'));
});
app.get('/login', (req, res) => {
  return res.sendFile(path.join(frontendDir, 'index.html'));
});
app.get('/agent', (req, res) => res.sendFile(path.join(frontendDir, 'agent.html')));
app.get('/admin-sellers', (req, res) => res.sendFile(path.join(frontendDir, 'admin-sellers.html')));
app.get('/whatsapp-qr', (req, res) => res.sendFile(path.join(frontendDir, 'whatsapp-qr.html')));
app.get('/setup-admin', (req, res) => res.sendFile(path.join(frontendDir, 'setup-admin.html')));

const fs = require('fs')
const authDir = path.join(__dirname, 'auth')

// Função para hash de password
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function getAdminCount() {
  try {
    return db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin'").get().count || 0;
  } catch (err) {
    return 0;
  }
}

// Middleware para verificar autenticação via sessão
function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Não autenticado' });
  }
  
  req.userId = req.session.userId;
  req.userType = req.session.userType;
  req.userName = req.session.userName;
  next();
}

// Middleware para verificar se é admin
function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Não autenticado' });
  }
  
  if (req.session.userType !== 'admin') {
    return res.status(403).json({ error: 'Acesso negado. Apenas admin.' });
  }
  
  req.userId = req.session.userId;
  req.userType = req.session.userType;
  req.userName = req.session.userName;
  next();
}


// � Endpoint para verificar status da conexão
app.get('/connection-status', (req, res) => {
  const sock = getSocket();
  res.json({ 
    connected: sock !== null,
    message: sock ? 'WhatsApp conectado' : 'WhatsApp desconectado'
  });
});

// 📱 Endpoint para obter QR code do WhatsApp (para exibir no browser)
app.get('/whatsapp/qr', async (req, res) => {
  try {
    const qrState = getQrState();

    if (qrState.connected) {
      return res.json({
        connected: true,
        connectionState: qrState.connectionState,
        qrAt: qrState.qrAt,
        qrDataUrl: null
      });
    }

    if (!qrState.qr) {
      return res.json({
        connected: false,
        connectionState: qrState.connectionState,
        qrAt: qrState.qrAt,
        qrDataUrl: null
      });
    }

    const qrDataUrl = await qrcode.toDataURL(qrState.qr, { margin: 2, scale: 6 });
    res.json({
      connected: false,
      connectionState: qrState.connectionState,
      qrAt: qrState.qrAt,
      qrDataUrl
    });
  } catch (error) {
    res.status(500).json({
      connected: false,
      connectionState: 'error',
      qrAt: null,
      qrDataUrl: null
    });
  }
});

// 🔄 Endpoint para forçar novo QR
app.post('/whatsapp/qr/refresh', async (req, res) => {
  try {
    const result = await forceNewQr();
    if (!result.ok) {
      return res.status(409).json({ error: 'WhatsApp já está conectado' });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao atualizar QR' });
  }
});

// 🔌 Endpoint para desconectar WhatsApp (admin)
app.post('/whatsapp/logout', requireAdmin, async (req, res) => {
  try {
    await forceNewQr(true);
    db.clearAllData();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao desconectar WhatsApp' });
  }
});


// �📋 Endpoints para Tickets
app.get('/tickets', requireAuth, (req, res) => {
  const tickets = db.prepare(`
    SELECT t.*, 
           (SELECT COUNT(*) FROM messages WHERE ticket_id = t.id AND sender = 'client') as unread_count
    FROM tickets t 
    WHERE t.phone LIKE '55%'
      AND t.phone NOT LIKE '%@%'
      AND length(t.phone) BETWEEN 12 AND 13
    ORDER BY updated_at DESC
  `).all();
  res.json(tickets);
});

app.get('/tickets/:id/messages', requireAuth, (req, res) => {
  const { id } = req.params;
  const { limit, before } = req.query;

  try {
    const params = [id];
    let query = 'SELECT * FROM messages WHERE ticket_id = ?';

    if (before) {
      query += ' AND created_at < ?';
      params.push(before);
    }

    query += ' ORDER BY created_at DESC';

    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 0, 0), 1000);
    if (safeLimit > 0) {
      query += ' LIMIT ?';
      params.push(safeLimit);
    }

    const rows = db.prepare(query).all(...params);
    res.json(rows.reverse());
  } catch (error) {
    res.status(500).json({ error: 'Erro ao listar mensagens' });
  }
});

// 🔔 Endpoint para obter apenas novas mensagens (polling otimizado)
app.get('/tickets/:id/messages/since/:timestamp', requireAuth, (req, res) => {
  const { id, timestamp } = req.params;
  const messages = db.prepare('SELECT * FROM messages WHERE ticket_id = ? AND created_at > ? ORDER BY created_at ASC').all(id, timestamp);
  res.json(messages);
});

app.post('/tickets/:id/send', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { message } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'Mensagem é obrigatória' });
  }

  try {
    const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
    
    if (!ticket) {
      return res.status(404).json({ error: 'Ticket não encontrado' });
    }

    const sock = getSocket();
    if (!sock) {
      return res.status(503).json({ error: 'WhatsApp não conectado. Por favor, aguarde a reconexão.' });
    }

    // Envia mensagem via WhatsApp com nome do agente
    const jid = ticket.phone.includes('@') ? ticket.phone : `${ticket.phone}@s.whatsapp.net`;
    const messageWithSender = `*${req.userName}:*\n\n${message}`;
    await sock.sendMessage(jid, { text: messageWithSender });

    // Se o ticket estiver em 'aguardando' ou não tiver seller_id e o usuário é vendedor, atribui ao vendedor que respondeu
    if (req.userType === 'seller' && (ticket.status === 'aguardando' || !ticket.seller_id)) {
      db.prepare('UPDATE tickets SET seller_id = ? WHERE id = ?').run(req.userId, id);
    }

    // Salva mensagem no banco
    db.prepare('INSERT INTO messages (ticket_id, sender, content, sender_name) VALUES (?, ?, ?, ?)').run(
      id,
      'agent',
      message,
      req.userName
    );

    // Atualiza status e timestamp do ticket
    db.prepare('UPDATE tickets SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('em_atendimento', id);

    res.json({ success: true, message: 'Mensagem enviada' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao enviar mensagem' });
  }
});

app.patch('/tickets/:id/status', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!['pendente', 'aguardando', 'em_atendimento', 'resolvido'].includes(status)) {
    return res.status(400).json({ error: 'Status inválido' });
  }

  try {
    // Busca o ticket atual
    const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
    if (!ticket) {
      return res.status(404).json({ error: 'Ticket não encontrado' });
    }

    // Não é permitido voltar um ticket para 'pendente' depois que ele saiu desse estado inicial
    if (status === 'pendente' && ticket.status !== 'pendente') {
      return res.status(400).json({ error: 'Não é permitido voltar para pendente' });
    }

    // Se está marcando como resolvido, envia mensagem de encerramento ao cliente
    if (status === 'resolvido') {
      try {
        const sock = getSocket();
        if (sock) {
          const jid = ticket.phone.includes('@') ? ticket.phone : `${ticket.phone}@s.whatsapp.net`;
          await sock.sendMessage(jid, {
            text: '✅ Seu atendimento foi encerrado. Obrigado por entrar em contato! Se precisar de ajuda novamente, é só enviar uma mensagem.'
          });
        }
      } catch (e) {
        // ignora erro de envio
      }
    }
    
    if (status === 'aguardando') {
      db.prepare('UPDATE tickets SET status = ?, seller_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, id);
    } else if (status === 'em_atendimento') {
      // Quando alguém marca como 'em_atendimento', atribui ao usuário.
      // - Se for seller, usa req.userId
      // - Se for admin, procura um seller com o mesmo nome e atribui se existir
      let assignId = null;
      if (req.userType === 'seller') {
        assignId = req.userId;
      } else if (req.userType === 'admin' && req.userName) {
        let s = db.prepare('SELECT id FROM sellers WHERE name = ?').get(req.userName);
        if (s && s.id) {
          assignId = s.id;
        } else {
          // cria um seller automaticamente para esse admin e atribui
          try {
            const insert = db.prepare('INSERT INTO sellers (name, password, active) VALUES (?, ?, 1)');
            const randomPass = Math.random().toString(36).slice(2);
            const info = insert.run(req.userName, randomPass);
            if (info && info.lastInsertRowid) {
              assignId = info.lastInsertRowid;
            }
          } catch (e) {
            // se falhar por conflito ou outro motivo, tenta recuperar
            const fallback = db.prepare('SELECT id FROM sellers WHERE name = ?').get(req.userName);
            if (fallback && fallback.id) assignId = fallback.id;
          }
        }
      }

      if (assignId) {
        db.prepare('UPDATE tickets SET status = ?, seller_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, assignId, id);
      } else {
        db.prepare('UPDATE tickets SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, id);
      }
    } else {
      db.prepare('UPDATE tickets SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, id);
    }
    res.json({ success: true, message: 'Status atualizado' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao atualizar status' });
  }
});


// 🚫 Endpoints para Blacklist
app.get('/blacklist', (req, res) => {
  const blacklist = db.prepare('SELECT * FROM blacklist').all();
  res.json(blacklist);
});

app.post('/blacklist', (req, res) => {
  const { phone, reason } = req.body;
  
  if (!phone) {
    return res.status(400).json({ error: 'Telefone é obrigatório' });
  }
  
  // Extrai apenas o número (remove @s.whatsapp.net e outros sufixos)
  const cleanPhone = phone.split('@')[0];

  try {
    db.prepare('INSERT INTO blacklist (phone, reason) VALUES (?, ?)').run(
      cleanPhone,
      reason || 'Sem motivo especificado'
    );
    res.status(201).json({ message: 'Número adicionado à blacklist', phone: cleanPhone });
  } catch (error) {
    if (error.message.includes('UNIQUE')) {
      return res.status(400).json({ error: 'Este número já está na blacklist' });
    }
    res.status(500).json({ error: 'Erro ao adicionar à blacklist' });
  }
});


// Endpoint: adiciona via lid (mapeia e insere)
app.post('/blacklist/by-lid', (req, res) => {
  const { lid, reason } = req.body;
  if (!lid) return res.status(400).json({ error: 'lid é obrigatório' });
  
  // Extrai apenas o número (remove @lid e outros sufixos)
  const cleanPhone = lid.split('@')[0];
  
  try {
    db.prepare('INSERT INTO blacklist (phone, reason) VALUES (?, ?)').run(
      cleanPhone,
      reason || 'Sem motivo especificado'
    );
    res.status(201).json({ message: 'Número adicionado via lid', phone: cleanPhone });
  } catch (error) {
    if (error.message.includes('UNIQUE')) {
      return res.status(400).json({ error: 'Este número já está na blacklist' });
    }
    res.status(500).json({ error: 'Erro ao adicionar à blacklist' });
  }
});

app.delete('/blacklist/:phone', (req, res) => {
  const { phone } = req.params;
  
  const result = db.prepare('DELETE FROM blacklist WHERE phone = ?').run(phone);
  
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Número não encontrado na blacklist' });
  }
  
  res.json({ message: 'Número removido da blacklist', phone });
});


// 📸 Endpoint para obter foto de perfil
app.get('/profile-picture/:phone', async (req, res) => {
  const { phone } = req.params;
  
  const sock = getSocket();
  if (!sock) {
    return res.json({ url: null }); // Retorna null ao invés de erro para não quebrar a UI
  }

  try {
    const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
    const profilePicUrl = await sock.profilePictureUrl(jid, 'image');
    res.json({ url: profilePicUrl });
  } catch (error) {
    // Se não houver foto de perfil, retorna null
    res.json({ url: null });
  }
});

// 📇 Endpoint para obter nome do contato
app.get('/contact-name/:phone', async (req, res) => {
  const { phone } = req.params;
  
  const sock = getSocket();
  if (!sock) {
    return res.json({ name: null }); // Retorna null ao invés de erro
  }

  try {
    const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
    
    // Busca informações do contato
    const contact = await sock.onWhatsApp(jid);
    
    if (contact && contact[0]) {
      // Tenta buscar o nome salvo
      const contactInfo = await sock.getBusinessProfile(jid).catch(() => null);
      
      // Tenta buscar do store de contatos
      if (sock.store && sock.store.contacts && sock.store.contacts[jid]) {
        const name = sock.store.contacts[jid].name || sock.store.contacts[jid].notify;
        if (name) {
          return res.json({ name });
        }
      }
      
      // Retorna o pushname se disponível
      if (contact[0].notify) {
        return res.json({ name: contact[0].notify });
      }
    }
    
    // Se não encontrar nome, retorna null
    res.json({ name: null });
  } catch (error) {
    res.json({ name: null });
  }
});


// 👨‍💼 ENDPOINTS PARA VENDEDORES (SELLERS)

// Login do vendedor
app.post('/auth/login', (req, res) => {
  const { username, password, isAdmin } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Usuário e senha obrigatórios' });
  }
  
  try {
    // Verifica se é admin (verifica ambas as tabelas)
    const adminUser = db.prepare('SELECT * FROM users WHERE username = ? AND role = ?').get(username, 'admin');
    if (adminUser && adminUser.password === hashPassword(password)) {
      req.session.userId = adminUser.id;
      req.session.userName = adminUser.username;
      req.session.userType = 'admin';
      
      return res.json({
        success: true,
        userId: adminUser.id,
        userType: 'admin',
        userName: adminUser.username
      });
    }
    
    // Verifica se é vendedor
    const seller = db.prepare('SELECT * FROM sellers WHERE name = ?').get(username);
    if (seller && seller.password === hashPassword(password)) {
      if (!seller.active) {
        return res.status(401).json({ error: 'Vendedor desativado' });
      }
      
      req.session.userId = seller.id;
      req.session.userName = seller.name;
      req.session.userType = 'seller';
      
      return res.json({
        success: true,
        userId: seller.id,
        userType: 'seller',
        userName: seller.name
      });
    }
    
    // Nenhum usuário encontrado
    return res.status(401).json({ error: 'Credenciais inválidas' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao fazer login' });
  }
});

// 🔧 Verifica se já existe admin
app.get('/auth/has-admin', (req, res) => {
  try {
    const count = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin'").get().count;
    res.json({ hasAdmin: count > 0 });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao verificar admin' });
  }
});

// 🔧 Cria admin (somente se não existir)
app.post('/auth/setup-admin', (req, res) => {
  const qrState = getQrState();
  if (!qrState.connected) {
    return res.status(403).json({ error: 'WhatsApp não conectado.' });
  }

  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Usuário e senha obrigatórios' });
  }

  try {
    const count = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin'").get().count;
    if (count > 0) {
      return res.status(409).json({ error: 'Admin já existe' });
    }

    db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)').run(username, hashPassword(password), 'admin');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao criar admin' });
  }
});

// 🔐 Endpoint para verificar sessão
app.get('/auth/session', (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ authenticated: false });
  }
  
  return res.json({
    authenticated: true,
    userId: req.session.userId,
    userName: req.session.userName,
    userType: req.session.userType
  });
});

// 🔐 Endpoint de logout
app.post('/auth/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Erro ao fazer logout' });
    }
    res.clearCookie('connect.sid');
    return res.json({ success: true });
  });
});

// Listar vendedores (apenas admin)
app.get('/sellers', requireAdmin, (req, res) => {
  try {
    const sellers = db.prepare('SELECT id, name, active, created_at FROM sellers ORDER BY name').all();
    res.json(sellers);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao listar vendedores' });
  }
});

// Listar todos os usuários (admins + vendedores)
app.get('/users', requireAdmin, (req, res) => {
  try {
    try { db.prepare('ALTER TABLE users ADD COLUMN created_at DATETIME DEFAULT CURRENT_TIMESTAMP').run(); } catch (_) {}

    let admins;
    try {
      admins = db.prepare("SELECT id, username as name, created_at FROM users WHERE role = 'admin' ORDER BY username").all();
    } catch (_) {
      admins = db.prepare("SELECT id, username as name FROM users WHERE role = 'admin' ORDER BY username").all();
      admins.forEach(a => { a.created_at = null; });
    }

    const fallbackDate = new Date().toISOString().replace('T', ' ').slice(0, 19);
    try {
      const updateNullCreatedAt = db.prepare("UPDATE users SET created_at = datetime('now') WHERE id = ? AND (created_at IS NULL OR created_at = '')");
      for (const admin of admins) {
        const raw = admin.created_at;
        if (raw == null || String(raw).trim() === '') {
          try {
            updateNullCreatedAt.run(admin.id);
            const row = db.prepare("SELECT created_at FROM users WHERE id = ?").get(admin.id);
            admin.created_at = (row && row.created_at) ? row.created_at : fallbackDate;
          } catch (_) {
            admin.created_at = fallbackDate;
          }
        }
      }
    } catch (_) {
      for (const admin of admins) {
        if (admin.created_at == null || String(admin.created_at).trim() === '') {
          admin.created_at = fallbackDate;
        }
      }
    }

    const sellers = db.prepare("SELECT id, name, active, created_at FROM sellers ORDER BY name").all();
    
    const allUsers = [];
    
    for (const admin of admins) {
      const sellerInfo = db.prepare("SELECT active FROM sellers WHERE name = ?").get(admin.name);
      const createdAt = admin.created_at != null && String(admin.created_at).trim() !== '' ? admin.created_at : fallbackDate;
      allUsers.push({
        id: `admin_${admin.id}`,
        name: admin.name,
        isAdmin: true,
        isSeller: !!sellerInfo,
        sellerActive: sellerInfo ? sellerInfo.active : false,
        created_at: createdAt
      });
    }
    
    for (const seller of sellers) {
      const adminInfo = db.prepare("SELECT id FROM users WHERE username = ? AND role = 'admin'").get(seller.name);
      if (!adminInfo) {
        allUsers.push({
          id: `seller_${seller.id}`,
          name: seller.name,
          isAdmin: false,
          isSeller: true,
          sellerActive: seller.active,
          created_at: seller.created_at != null ? seller.created_at : null
        });
      }
    }
    
    res.set('Cache-Control', 'no-store');
    res.json(allUsers);
  } catch (error) {
    console.error('GET /users error:', error);
    res.status(500).json({ error: 'Erro ao listar usuários' });
  }
});

// Listar vendedores ativos (admin e vendedores)
app.get('/sellers/active', requireAuth, (req, res) => {
  try {
    const sellers = db.prepare('SELECT id, name FROM sellers WHERE active = 1 ORDER BY name').all();
    res.json(sellers);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao listar vendedores' });
  }
});

// Criar Novo Usuário (apenas admin)
app.post('/sellers', (req, res) => {
  const { name, password } = req.body;
  
  if (!name || !password) {
    return res.status(400).json({ error: 'Nome e senha são obrigatórios' });
  }
  
  try {
    const result = db.prepare('INSERT INTO sellers (name, password) VALUES (?, ?)').run(
      name,
      hashPassword(password)
    );
    
    res.status(201).json({
      success: true,
      id: result.lastInsertRowid,
      name
    });
  } catch (error) {
    if (error.message.includes('UNIQUE')) {
      return res.status(400).json({ error: 'Vendedor já existe' });
    }
    res.status(500).json({ error: 'Erro ao criar vendedor' });
  }
});

// Atualizar vendedor (apenas admin)
app.patch('/sellers/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  const { name, active, password } = req.body;
  
  try {
    let query = 'UPDATE sellers SET updated_at = CURRENT_TIMESTAMP';
    const params = [];
    
    if (name) {
      query += ', name = ?';
      params.push(name);
    }
    if (active !== undefined) {
      query += ', active = ?';
      params.push(active ? 1 : 0);
    }
    if (password) {
      query += ', password = ?';
      params.push(hashPassword(password));
    }
    
    query += ' WHERE id = ?';
    params.push(id);
    
    db.prepare(query).run(...params);
    res.json({ success: true, message: 'Vendedor atualizado' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao atualizar vendedor' });
  }
});

// Deletar vendedor (apenas admin)
app.delete('/sellers/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  
  try {
    // Remove todas as atribuições de tickets deste vendedor
    db.prepare('UPDATE tickets SET seller_id = NULL WHERE seller_id = ?').run(id);
    
    // Deleta o vendedor
    db.prepare('DELETE FROM sellers WHERE id = ?').run(id);
    
    res.json({ success: true, message: 'Vendedor deletado' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao deletar vendedor' });
  }
});

// Promover vendedor a admin (vendedor deixa de existir na tabela sellers e vira só admin)
app.post('/sellers/:id/make-admin', requireAdmin, (req, res) => {
  const id = req.params.id;
  
  try {
    const seller = db.prepare('SELECT * FROM sellers WHERE id = ?').get(id);
    if (!seller) {
      return res.status(404).json({ error: 'Vendedor não encontrado' });
    }

    const insertUser = db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)');
    const updateTickets = db.prepare('UPDATE tickets SET seller_id = NULL WHERE seller_id = ?');
    const deleteSeller = db.prepare('DELETE FROM sellers WHERE id = ?');

    const run = db.transaction(() => {
      const existingAdmin = db.prepare("SELECT id FROM users WHERE username = ? AND role = 'admin'").get(seller.name);
      if (!existingAdmin) {
        insertUser.run(seller.name, seller.password, 'admin');
      }
      updateTickets.run(id);
      deleteSeller.run(id);
    });
    run();

    res.json({ success: true, message: 'Vendedor promovido a admin. Ele pode fazer login e acessar a tela de administração.' });
  } catch (error) {
    if (error.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Este vendedor já é admin' });
    }
    res.status(500).json({ error: 'Erro ao promover vendedor' });
  }
});

// Verificar se vendedor é admin
app.get('/sellers/:id/is-admin', requireAdmin, (req, res) => {
  const { id } = req.params;
  
  try {
    const seller = db.prepare('SELECT * FROM sellers WHERE id = ?').get(id);
    if (!seller) {
      return res.status(404).json({ error: 'Vendedor não encontrado' });
    }

    const admin = db.prepare("SELECT * FROM users WHERE username = ? AND role = 'admin'").get(seller.name);
    res.json({ isAdmin: !!admin });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao verificar admin' });
  }
});

// Remover admin de um vendedor
app.post('/sellers/:id/remove-admin', requireAdmin, (req, res) => {
  const { id } = req.params;
  
  try {
    const seller = db.prepare('SELECT * FROM sellers WHERE id = ?').get(id);
    if (!seller) {
      return res.status(404).json({ error: 'Vendedor não encontrado' });
    }

    const adminCount = getAdminCount();
    if (adminCount <= 1) {
      return res.status(409).json({ error: 'Não é permitido remover o último admin do sistema.' });
    }

    const result = db.prepare("DELETE FROM users WHERE username = ? AND role = 'admin'").run(seller.name);
    
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Este vendedor não é admin' });
    }

    // Reativa o vendedor para que possa fazer login novamente
    db.prepare('UPDATE sellers SET active = 1 WHERE id = ?').run(id);

    res.json({ success: true, message: 'Admin removido com sucesso' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao remover admin' });
  }
});

// Fazer um admin também ser vendedor
app.post('/users/:id/make-seller', requireAdmin, (req, res) => {
  const { id } = req.params;
  
  try {
    const adminUser = db.prepare("SELECT * FROM users WHERE username = ? AND role = 'admin'").get(id);
    if (!adminUser) {
      return res.status(404).json({ error: 'Admin não encontrado' });
    }

    // Verifica se já é vendedor
    const seller = db.prepare('SELECT * FROM sellers WHERE name = ?').get(adminUser.username);
    if (seller) {
      return res.status(409).json({ error: 'Este admin já é vendedor' });
    }

    // Cria entrada de vendedor com a mesma senha
    db.prepare('INSERT INTO sellers (name, password, active) VALUES (?, ?, ?)').run(
      adminUser.username,
      adminUser.password,
      1
    );

    res.json({ success: true, message: 'Admin agora também é vendedor' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao tornar vendedor' });
  }
});

// Remover vendedor de um admin
app.post('/users/:id/remove-seller', requireAdmin, (req, res) => {
  const { id } = req.params;
  
  try {
    const adminUser = db.prepare("SELECT * FROM users WHERE username = ? AND role = 'admin'").get(id);
    if (!adminUser) {
      return res.status(404).json({ error: 'Admin não encontrado' });
    }

    const result = db.prepare('DELETE FROM sellers WHERE name = ?').run(adminUser.username);
    
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Este admin não é vendedor' });
    }

    res.json({ success: true, message: 'Vendedor removido com sucesso' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao remover vendedor' });
  }
});

// Tornar admin de volta apenas vendedor (remove admin e cria vendedor; deixa de ser admin)
app.post('/users/:name/revert-to-seller', requireAdmin, (req, res) => {
  const name = decodeURIComponent(req.params.name || '').trim();
  
  try {
    const adminUser = db.prepare("SELECT * FROM users WHERE username = ? AND role = 'admin'").get(name);
    if (!adminUser) {
      return res.status(404).json({ error: 'Admin não encontrado' });
    }

    const adminCount = getAdminCount();
    if (adminCount <= 1) {
      return res.status(409).json({ error: 'Não é permitido remover o último admin do sistema.' });
    }

    const existingSeller = db.prepare('SELECT id FROM sellers WHERE name = ?').get(name);
    const deleteAdmin = db.prepare("DELETE FROM users WHERE username = ? AND role = 'admin'");

    if (existingSeller) {
      deleteAdmin.run(name);
      db.prepare('UPDATE sellers SET active = 1 WHERE name = ?').run(name);
    } else {
      const insertSeller = db.prepare('INSERT INTO sellers (name, password, active) VALUES (?, ?, ?)');
      const run = db.transaction(() => {
        insertSeller.run(name, adminUser.password, 1);
        deleteAdmin.run(name);
      });
      run();
    }

    const isSelf = req.session && req.session.userName === name;
    if (isSelf) {
      req.session.destroy(() => {});
    }

    res.json({
      success: true,
      message: 'Usuário agora é apenas vendedor e pode fazer login na tela de vendedor.',
      sessionDestroyed: !!isSelf
    });
  } catch (error) {
    console.error('revert-to-seller error:', error);
    res.status(500).json({ error: error.message || 'Erro ao reverter para vendedor' });
  }
});

// Remover vendedor (deletar completamente)
app.post('/users/:id/remove-seller-only', requireAdmin, (req, res) => {
  const { id } = req.params;
  
  try {
    const seller = db.prepare('SELECT * FROM sellers WHERE id = ?').get(id);
    if (!seller) {
      return res.status(404).json({ error: 'Vendedor não encontrado' });
    }

    // Remove todas as atribuições de tickets
    db.prepare('UPDATE tickets SET seller_id = NULL WHERE seller_id = ?').run(id);
    
    // Deleta o vendedor
    db.prepare('DELETE FROM sellers WHERE id = ?').run(id);

    res.json({ success: true, message: 'Vendedor deletado com sucesso' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao deletar vendedor' });
  }
});

// Atribuir/transferir ticket a um vendedor (admin ou vendedor)
app.post('/tickets/:id/assign', requireAuth, (req, res) => {
  const { id } = req.params;
  const { sellerId } = req.body;

  if (sellerId === undefined || sellerId === null || sellerId === '') {
    return res.status(400).json({ error: 'sellerId é obrigatório' });
  }

  const targetSellerId = Number(sellerId);
  if (Number.isNaN(targetSellerId)) {
    return res.status(400).json({ error: 'sellerId inválido' });
  }

  try {
    const ticket = db.prepare('SELECT id, seller_id FROM tickets WHERE id = ?').get(id);
    if (!ticket) {
      return res.status(404).json({ error: 'Ticket não encontrado' });
    }

    // Vendedor só pode transferir se o ticket estiver com ele ou sem vendedor
    if (req.userType === 'seller') {
      if (ticket.seller_id && ticket.seller_id !== req.userId) {
        return res.status(403).json({ error: 'Você não pode transferir este ticket' });
      }
    }

    const targetSeller = db.prepare('SELECT id, active FROM sellers WHERE id = ?').get(targetSellerId);
    if (!targetSeller) {
      return res.status(404).json({ error: 'Vendedor não encontrado' });
    }
    if (!targetSeller.active) {
      return res.status(400).json({ error: 'Vendedor desativado' });
    }

    db.prepare('UPDATE tickets SET seller_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(targetSellerId, id);
    res.json({ success: true, message: 'Ticket atribuído' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao atribuir ticket' });
  }
});

// Buscar tickets (filtra por vendedor se não for admin)
app.get('/tickets/seller/:sellerId', requireAuth, (req, res) => {
  const { sellerId } = req.params;
  
  try {
    const tickets = db.prepare(`
      SELECT t.*, 
             s.name as seller_name,
             (SELECT COUNT(*) FROM messages WHERE ticket_id = t.id AND sender = 'client') as unread_count
      FROM tickets t 
      LEFT JOIN sellers s ON t.seller_id = s.id
      WHERE (t.seller_id = ? OR t.seller_id IS NULL OR t.status = 'aguardando')
        AND t.status != 'resolvido'
        AND t.phone LIKE '55%'
        AND t.phone NOT LIKE '%@%'
        AND length(t.phone) BETWEEN 12 AND 13
      ORDER BY updated_at DESC
    `).all(sellerId === '0' ? null : sellerId);
    
    res.json(tickets);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao listar tickets' });
  }
});

// Buscar todos os tickets com informações do vendedor (apenas admin)
app.get('/admin/tickets', requireAdmin, (req, res) => {
  try {
    const tickets = db.prepare(`
      SELECT t.*, 
             s.name as seller_name,
             (SELECT COUNT(*) FROM messages WHERE ticket_id = t.id AND sender = 'client') as unread_count
      FROM tickets t 
      LEFT JOIN sellers s ON t.seller_id = s.id
      WHERE t.phone LIKE '55%'
        AND t.phone NOT LIKE '%@%'
        AND length(t.phone) BETWEEN 12 AND 13
      ORDER BY updated_at DESC
    `).all();
    
    res.json(tickets);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao listar tickets' });
  }
});

// 🗓️ Endpoints de Horários de Funcionamento (admin)
app.get('/business-hours', requireAdmin, (req, res) => {
  try {
    const hours = db.prepare('SELECT day, open_time, close_time, enabled FROM business_hours ORDER BY day ASC').all();
    res.json(hours);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao carregar horários' });
  }
});

app.put('/business-hours', requireAdmin, (req, res) => {
  const payload = Array.isArray(req.body) ? req.body : req.body.hours;
  if (!Array.isArray(payload)) {
    return res.status(400).json({ error: 'Formato inválido. Envie uma lista de horários.' });
  }

  try {
    const upsert = db.prepare(`
      INSERT INTO business_hours (day, open_time, close_time, enabled)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(day) DO UPDATE SET
        open_time = excluded.open_time,
        close_time = excluded.close_time,
        enabled = excluded.enabled
    `);

    const tx = db.transaction((rows) => {
      rows.forEach(row => {
        const day = Number(row.day);
        if (!Number.isInteger(day) || day < 0 || day > 6) {
          throw new Error('Dia inválido');
        }
        upsert.run(day, row.open_time || null, row.close_time || null, row.enabled ? 1 : 0);
      });
    });

    tx(payload);
    res.json({ success: true, message: 'Horários atualizados' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao salvar horários' });
  }
});

app.get('/business-exceptions', requireAdmin, (req, res) => {
  try {
    const exceptions = db.prepare('SELECT id, date, closed, open_time, close_time, reason FROM business_exceptions ORDER BY date DESC').all();
    res.json(exceptions);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao carregar exceções' });
  }
});

app.post('/business-exceptions', requireAdmin, (req, res) => {
  const { date, closed, open_time, close_time, reason } = req.body;

  if (!date) {
    return res.status(400).json({ error: 'Data é obrigatória' });
  }

  try {
    const result = db.prepare(`
      INSERT INTO business_exceptions (date, closed, open_time, close_time, reason)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET
        closed = excluded.closed,
        open_time = excluded.open_time,
        close_time = excluded.close_time,
        reason = excluded.reason
    `).run(
      date,
      closed ? 1 : 0,
      open_time || null,
      close_time || null,
      reason || null
    );

    res.status(201).json({
      success: true,
      id: result.lastInsertRowid,
      date,
      closed: closed ? 1 : 0,
      open_time: open_time || null,
      close_time: close_time || null,
      reason: reason || null
    });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao salvar exceção' });
  }
});

app.delete('/business-exceptions/:id', requireAdmin, (req, res) => {
  const { id } = req.params;

  try {
    const result = db.prepare('DELETE FROM business_exceptions WHERE id = ?').run(id);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Exceção não encontrada' });
    }
    res.json({ success: true, message: 'Exceção removida' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao remover exceção' });
  }
});

app.get('/business-message', requireAdmin, (req, res) => {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('out_of_hours_message');
    res.json({ message: row?.value || '' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao carregar mensagem' });
  }
});

app.put('/business-message', requireAdmin, (req, res) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: 'Mensagem é obrigatória' });
  }

  try {
    db.prepare(`
      INSERT INTO settings (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run('out_of_hours_message', message);

    res.json({ success: true, message: 'Mensagem atualizada' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao salvar mensagem' });
  }
});

// ===== API: configuração do Await (mover de 'em_atendimento' -> 'aguardando') =====
app.get('/admin/await-config', requireAdmin, (req, res) => {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('await_minutes');
    const minutes = row ? parseInt(row.value || '0', 10) : 0;
    res.json({ minutes: Number.isFinite(minutes) ? minutes : 0 });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao carregar configuração' });
  }
});

app.put('/admin/await-config', requireAdmin, (req, res) => {
  const { minutes } = req.body;
  const m = parseInt(minutes, 10);
  if (Number.isNaN(m) || m < 0) {
    return res.status(400).json({ error: 'Valor inválido para minutes' });
  }

  try {
    db.prepare(`
      INSERT INTO settings (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run('await_minutes', String(m));

    res.json({ success: true, minutes: m });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao salvar configuração' });
  }
});

startBot().then(() => {
  // Bot iniciado
});

// Job periódico: verifica tickets em 'em_atendimento' e move para 'aguardando' se ultrapassar o timeout configurado
function processAutoAwait() {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('await_minutes');
    const minutes = row ? parseInt(row.value || '0', 10) : 0;
    if (!minutes || minutes <= 0) return;

    const cutoff = new Date(Date.now() - minutes * 60000).toISOString().replace('T', ' ').slice(0, 19);
    const result = db.prepare("UPDATE tickets SET status = 'aguardando', seller_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE status = 'em_atendimento' AND updated_at <= ?").run(cutoff);
    if (result && result.changes > 0) {
      console.log(`Auto-await: moved ${result.changes} tickets to 'aguardando' (timeout ${minutes} min)`);
    }
  } catch (err) {
    console.error('Error processing auto-await:', err);
  }
}

// Roda a cada 60 segundos
setInterval(processAutoAwait, 60 * 1000);

const server = app.listen(3001, '0.0.0.0', () => console.log('🚀 Servidor rodando na porta 3001'));

// Encerramento gracioso para garantir flush do SQLite
function shutdown() {
  try {
    server.close(() => {
      try { db.close(); } catch (e) {}
      process.exit(0);
    });
  } catch (err) {
    try { db.close(); } catch (e) {}
    process.exit(0);
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);