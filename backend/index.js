const express = require('express');
const cors = require('cors');
const path = require('path');
const session = require('express-session');
const startBot = require('./baileys');
const { getSocket } = require('./baileys');
const db = require('./db');
const crypto = require('crypto');

const app = express();

// Configurar sessões
app.use(session({
  secret: 'whatsapp-system-secret-key-' + Math.random().toString(36),
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: false, // mudar para true em produção com HTTPS
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 horas
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
app.get('/', (req, res) => res.sendFile(path.join(frontendDir, 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(frontendDir, 'index.html')));
app.get('/agent', (req, res) => res.sendFile(path.join(frontendDir, 'agent.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(frontendDir, 'admin.html')));
app.get('/admin-sellers', (req, res) => res.sendFile(path.join(frontendDir, 'admin-sellers.html')));
app.get('/blacklist-ui', (req, res) => res.sendFile(path.join(frontendDir, 'blacklist.html')));

const fs = require('fs')
const authDir = path.join(__dirname, 'auth')

// Função para hash de password
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
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


// �📋 Endpoints para Tickets
app.get('/tickets', requireAuth, (req, res) => {
  const tickets = db.prepare(`
    SELECT t.*, 
           (SELECT COUNT(*) FROM messages WHERE ticket_id = t.id AND sender = 'client') as unread_count
    FROM tickets t 
    ORDER BY updated_at DESC
  `).all();
  res.json(tickets);
});

app.get('/tickets/:id/messages', requireAuth, (req, res) => {
  const { id } = req.params;
  const messages = db.prepare('SELECT * FROM messages WHERE ticket_id = ? ORDER BY created_at ASC').all(id);
  res.json(messages);
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

    // Se o ticket não tem seller_id e o usuário não é admin, atribui ao vendedor que respondeu
    if (!ticket.seller_id && req.userType === 'seller') {
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

  if (!['pendente', 'em_atendimento', 'resolvido'].includes(status)) {
    return res.status(400).json({ error: 'Status inválido' });
  }

  try {
    // Se está marcando como resolvido, envia mensagem de encerramento ao cliente
    if (status === 'resolvido') {
      const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
      
      if (ticket) {
        const sock = getSocket();
        if (sock) {
          const jid = ticket.phone.includes('@') ? ticket.phone : `${ticket.phone}@s.whatsapp.net`;
          await sock.sendMessage(jid, { 
            text: '✅ Seu atendimento foi encerrado. Obrigado por entrar em contato! Se precisar de ajuda novamente, é só enviar uma mensagem.' 
          });
        }
      }
    }
    
    db.prepare('UPDATE tickets SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, id);
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
    if (isAdmin) {
      // Login como admin (usuário padrão)
      const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
      
      if (!user || user.password !== password) {
        return res.status(401).json({ error: 'Credenciais inválidas' });
      }
      
      // Criar sessão
      req.session.userId = user.id;
      req.session.userName = user.username;
      req.session.userType = 'admin';
      
      res.json({
        success: true,
        userId: user.id,
        userType: 'admin',
        userName: user.username
      });
    } else {
      // Login como vendedor
      const seller = db.prepare('SELECT * FROM sellers WHERE name = ?').get(username);
      
      if (!seller || seller.password !== hashPassword(password)) {
        return res.status(401).json({ error: 'Credenciais inválidas' });
      }
      
      if (!seller.active) {
        return res.status(401).json({ error: 'Vendedor desativado' });
      }
      
      // Criar sessão
      req.session.userId = seller.id;
      req.session.userName = seller.name;
      req.session.userType = 'seller';
      
      res.json({
        success: true,
        userId: seller.id,
        userType: 'seller',
        userName: seller.name
      });
    }
  } catch (error) {
    res.status(500).json({ error: 'Erro ao fazer login' });
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

// Criar novo vendedor (apenas admin)
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

// Atribuir ticket a um vendedor (apenas admin)
app.post('/tickets/:id/assign', requireAdmin, (req, res) => {
  const { id } = req.params;
  const { sellerId } = req.body;
  
  try {
    db.prepare('UPDATE tickets SET seller_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(sellerId || null, id);
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
      WHERE (t.seller_id = ? OR t.seller_id IS NULL) AND t.status != 'resolvido'
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
      ORDER BY updated_at DESC
    `).all();
    
    res.json(tickets);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao listar tickets' });
  }
});

startBot().then(() => {
  // Bot iniciado
});

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