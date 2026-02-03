const express = require('express');
const { validate, schemas } = require('../middleware/validation');
const { auditMiddleware } = require('../middleware/audit');

function createAuthRouter({ db, hashPassword, verifyPassword, getQrState }) {
  const router = express.Router();

  router.post(
    '/auth/login',
    validate(schemas.login),
    auditMiddleware('login'),
    async (req, res) => {
      const { username, password } = req.body;

      try {
        const adminUser = db.prepare('SELECT * FROM users WHERE username = ? AND role = ?').get(username, 'admin');
        if (adminUser) {
          const isValid = await verifyPassword(password, adminUser.password);
          if (isValid) {
            // Migração automática: se detectar hash legado, rehash com bcrypt
            const { isLegacyHash } = require('../security/password');
            if (isLegacyHash(adminUser.password)) {
              try {
                const newHash = await hashPassword(password);
                db.prepare('UPDATE users SET password = ? WHERE id = ?').run(newHash, adminUser.id);
              } catch (_) {}
            }

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
        }

        const seller = db.prepare('SELECT * FROM sellers WHERE name = ?').get(username);
        if (seller) {
          const isValid = await verifyPassword(password, seller.password);
          if (isValid) {
            if (!seller.active) {
              return res.status(401).json({ error: 'Vendedor desativado' });
            }

            // Migração automática para sellers
            const { isLegacyHash } = require('../security/password');
            if (isLegacyHash(seller.password)) {
              try {
                const newHash = await hashPassword(password);
                db.prepare('UPDATE sellers SET password = ? WHERE id = ?').run(newHash, seller.id);
              } catch (_) {}
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
        }

        return res.status(401).json({ error: 'Credenciais inválidas' });
      } catch (_error) {
        return res.status(500).json({ error: 'Erro ao fazer login' });
      }
    }
  );

  router.get('/auth/has-admin', (_req, res) => {
    try {
      const count = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin'").get().count;
      return res.json({ hasAdmin: count > 0 });
    } catch (_error) {
      return res.status(500).json({ error: 'Erro ao verificar admin' });
    }
  });

  router.post(
    '/auth/setup-admin',
    (req, res, next) => {
      console.log('[setup-admin] Requisição recebida:', {
        method: req.method,
        path: req.path,
        body: req.body,
        contentType: req.headers['content-type']
      });
      next();
    },
    validate(schemas.setupAdmin),
    auditMiddleware('setup-admin'),
    async (req, res) => {
      const { username, password } = req.body;

      try {
        const count = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin'").get().count;
        if (count > 0) {
          return res.status(409).json({ error: 'Admin já existe' });
        }

        const hashedPassword = await hashPassword(password);
        db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)').run(
          username,
          hashedPassword,
          'admin'
        );

        console.log('[setup-admin] Admin criado com sucesso');
        return res.json({ success: true });
      } catch (error) {
        console.error('Erro ao criar admin:', error);
        return res.status(500).json({ error: 'Erro ao criar admin: ' + error.message });
      }
    }
  );

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
