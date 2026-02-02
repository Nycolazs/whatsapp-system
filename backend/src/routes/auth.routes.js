const express = require('express');

function createAuthRouter({ db, hashPassword, getQrState }) {
  const router = express.Router();

  router.post('/auth/login', (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Usuário e senha obrigatórios' });
    }

    try {
      const adminUser = db.prepare('SELECT * FROM users WHERE username = ? AND role = ?').get(username, 'admin');
      if (adminUser && adminUser.password === hashPassword(password)) {
        req.session.userId = adminUser.id;
        req.session.userName = adminUser.username;
        req.session.userType = 'admin';

        return res.json({
          success: true,
          userId: adminUser.id,
          userType: 'admin',
          userName: adminUser.username,
        });
      }

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
          userName: seller.name,
        });
      }

      return res.status(401).json({ error: 'Credenciais inválidas' });
    } catch (_error) {
      return res.status(500).json({ error: 'Erro ao fazer login' });
    }
  });

  router.get('/auth/has-admin', (_req, res) => {
    try {
      const count = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin'").get().count;
      return res.json({ hasAdmin: count > 0 });
    } catch (_error) {
      return res.status(500).json({ error: 'Erro ao verificar admin' });
    }
  });

  router.post('/auth/setup-admin', (req, res) => {
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

      db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)').run(
        username,
        hashPassword(password),
        'admin'
      );

      return res.json({ success: true });
    } catch (_error) {
      return res.status(500).json({ error: 'Erro ao criar admin' });
    }
  });

  router.get('/auth/session', (req, res) => {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ authenticated: false });
    }

    return res.json({
      authenticated: true,
      userId: req.session.userId,
      userName: req.session.userName,
      userType: req.session.userType,
    });
  });

  router.post('/auth/logout', (req, res) => {
    req.session.destroy((err) => {
      if (err) {
        return res.status(500).json({ error: 'Erro ao fazer logout' });
      }
      res.clearCookie('connect.sid');
      return res.json({ success: true });
    });
  });

  return router;
}

module.exports = {
  createAuthRouter,
};
