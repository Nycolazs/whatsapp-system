const express = require('express');
const { createResourceLimiter } = require('../middleware/rateLimiter');
const { validate, schemas } = require('../middleware/validation');
const { auditMiddleware } = require('../middleware/audit');

function createUsersRouter({
  db,
  hashPassword,
  requireAuth,
  requireAdmin,
  getAdminCount,
}) {
  const router = express.Router();

  router.get('/sellers', requireAdmin, (_req, res) => {
    try {
      const sellers = db.prepare('SELECT id, name, active, created_at FROM sellers ORDER BY name').all();
      return res.json(sellers);
    } catch (_error) {
      return res.status(500).json({ error: 'Erro ao listar vendedores' });
    }
  });

  // Lista de responsáveis para atribuição (inclui admins como sellers ativos)
  router.get('/assignees', requireAdmin, (_req, res) => {
    try {
      const admins = db.prepare("SELECT id, username as name FROM users WHERE role = 'admin' ORDER BY username").all();

      const findSeller = db.prepare('SELECT id, active FROM sellers WHERE name = ?');
      const insertSeller = db.prepare('INSERT INTO sellers (name, password, active) VALUES (?, ?, 1)');
      const activateSeller = db.prepare('UPDATE sellers SET active = 1 WHERE id = ?');

      for (const admin of admins) {
        const existing = findSeller.get(admin.name);
        if (existing && existing.id) {
          if (!existing.active) {
            try { activateSeller.run(existing.id); } catch (_) {}
          }
          continue;
        }

        try {
          const randomPass = Math.random().toString(36).slice(2);
          insertSeller.run(admin.name, randomPass);
        } catch (_e) {
          const fallback = findSeller.get(admin.name);
          if (fallback && fallback.id && !fallback.active) {
            try { activateSeller.run(fallback.id); } catch (_) {}
          }
        }
      }

      const assignees = db.prepare('SELECT id, name FROM sellers WHERE active = 1 ORDER BY name').all();
      return res.json(assignees);
    } catch (_error) {
      return res.status(500).json({ error: 'Erro ao listar responsáveis' });
    }
  });

  router.get('/users', requireAdmin, (_req, res) => {
    try {
      try {
        db.prepare('ALTER TABLE users ADD COLUMN created_at DATETIME DEFAULT CURRENT_TIMESTAMP').run();
      } catch (_) {}

      let admins;
      try {
        admins = db.prepare("SELECT id, username as name, created_at FROM users WHERE role = 'admin' ORDER BY username").all();
      } catch (_) {
        admins = db.prepare("SELECT id, username as name FROM users WHERE role = 'admin' ORDER BY username").all();
        admins.forEach(a => {
          a.created_at = null;
        });
      }

      const fallbackDate = new Date().toISOString().replace('T', ' ').slice(0, 19);
      try {
        const updateNullCreatedAt = db.prepare(
          "UPDATE users SET created_at = datetime('now') WHERE id = ? AND (created_at IS NULL OR created_at = '')"
        );
        for (const admin of admins) {
          const raw = admin.created_at;
          if (raw == null || String(raw).trim() === '') {
            try {
              updateNullCreatedAt.run(admin.id);
              const row = db.prepare('SELECT created_at FROM users WHERE id = ?').get(admin.id);
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

      const sellers = db.prepare('SELECT id, name, active, created_at FROM sellers ORDER BY name').all();

      const allUsers = [];

      for (const admin of admins) {
        const sellerInfo = db.prepare('SELECT active FROM sellers WHERE name = ?').get(admin.name);
        const createdAt = admin.created_at != null && String(admin.created_at).trim() !== '' ? admin.created_at : fallbackDate;
        allUsers.push({
          id: `admin_${admin.id}`,
          name: admin.name,
          isAdmin: true,
          isSeller: !!sellerInfo,
          sellerActive: sellerInfo ? sellerInfo.active : false,
          created_at: createdAt,
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
            created_at: seller.created_at != null ? seller.created_at : null,
          });
        }
      }

      res.set('Cache-Control', 'no-store');
      return res.json(allUsers);
    } catch (error) {
      // Mantém log para debug operacional
      console.error('GET /users error:', error);
      return res.status(500).json({ error: 'Erro ao listar usuários' });
    }
  });

  router.get('/sellers/active', requireAuth, (_req, res) => {
    try {
      const sellers = db.prepare('SELECT id, name FROM sellers WHERE active = 1 ORDER BY name').all();
      return res.json(sellers);
    } catch (_error) {
      return res.status(500).json({ error: 'Erro ao listar vendedores' });
    }
  });

  // Ranking de vendedores por tickets resolvidos
  router.get('/admin/ranking-sellers', requireAdmin, (req, res) => {
    try {
      const { startDate, endDate } = req.query;

      // Define datas padrão (últimos 30 dias)
      let start, end;
      const now = new Date();
      
      if (endDate) {
        // Parse date string (YYYY-MM-DD) e assume horário local
        const parts = endDate.split('-');
        end = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
        end.setHours(23, 59, 59, 999);
      } else {
        end = new Date(now);
        end.setHours(23, 59, 59, 999);
      }

      if (startDate) {
        // Parse date string (YYYY-MM-DD) e assume horário local
        const parts = startDate.split('-');
        start = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
        start.setHours(0, 0, 0, 0);
      } else {
        start = new Date(end);
        start.setDate(start.getDate() - 30);
        start.setHours(0, 0, 0, 0);
      }

      // Valida datas
      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        return res.status(400).json({ error: 'Datas inválidas' });
      }

      if (start > end) {
        return res.status(400).json({ error: 'Data inicial não pode ser maior que a data final' });
      }

      // Formata datas para SQLite (YYYY-MM-DD HH:MM:SS) - usa horário local
      const pad2 = (n) => String(n).padStart(2, '0');
      const formatSQLiteDate = (date) => {
        const year = date.getFullYear();
        const month = pad2(date.getMonth() + 1);
        const day = pad2(date.getDate());
        const hours = pad2(date.getHours());
        const minutes = pad2(date.getMinutes());
        const seconds = pad2(date.getSeconds());
        return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
      };

      const startStr = formatSQLiteDate(start);
      const endStr = formatSQLiteDate(end);

      console.log(`[RANKING] Buscando tickets resolvidos de ${startStr} até ${endStr}`);

      // Query para contar tickets resolvidos por vendedor
      const query = `
        SELECT 
          s.id as seller_id,
          s.name as seller_name,
          CAST(COUNT(CASE WHEN t.status = 'resolvido' THEN 1 END) AS INTEGER) as tickets_resolved
        FROM sellers s
        LEFT JOIN tickets t ON s.id = t.seller_id
          AND t.updated_at >= ?
          AND t.updated_at <= ?
        GROUP BY s.id, s.name
        ORDER BY tickets_resolved DESC, s.name ASC
      `;

      const ranking = db.prepare(query).all(startStr, endStr);

      console.log(`[RANKING] Resultado: ${ranking.length} vendedores encontrados`);
      console.log('[RANKING] Dados:', JSON.stringify(ranking, null, 2));

      return res.json({
        ranking,
        period: {
          startDate: start.toISOString().split('T')[0],
          endDate: end.toISOString().split('T')[0]
        }
      });
    } catch (error) {
      console.error('GET /admin/ranking-sellers error:', error);
      return res.status(500).json({ error: 'Erro ao buscar ranking de vendedores' });
    }
  });

  // Observação: hoje este endpoint não exige requireAdmin no código original.
  router.post(
    '/sellers',
    createResourceLimiter,
    validate(schemas.seller),
    auditMiddleware('create-seller'),
    async (req, res) => {
      const { name, password } = req.body;

      try {
        const hashedPassword = await hashPassword(password);
        const result = db.prepare('INSERT INTO sellers (name, password) VALUES (?, ?)').run(
          name,
          hashedPassword
        );

        return res.status(201).json({
          success: true,
          id: result.lastInsertRowid,
          name,
        });
      } catch (error) {
        if (error.message.includes('UNIQUE')) {
          return res.status(400).json({ error: 'Vendedor já existe' });
        }
        return res.status(500).json({ error: 'Erro ao criar vendedor' });
      }
    }
  );

  router.patch('/sellers/:id', requireAdmin, auditMiddleware('update-seller'), async (req, res) => {
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
        const hashedPassword = await hashPassword(password);
        params.push(hashedPassword);
      }

      query += ' WHERE id = ?';
      params.push(id);

      db.prepare(query).run(...params);
      return res.json({ success: true, message: 'Vendedor atualizado' });
    } catch (_error) {
      return res.status(500).json({ error: 'Erro ao atualizar vendedor' });
    }
  });

  router.delete('/sellers/:id', requireAdmin, (req, res) => {
    const { id } = req.params;

    try {
      db.prepare('UPDATE tickets SET seller_id = NULL WHERE seller_id = ?').run(id);
      db.prepare('DELETE FROM sellers WHERE id = ?').run(id);
      return res.json({ success: true, message: 'Vendedor deletado' });
    } catch (_error) {
      return res.status(500).json({ error: 'Erro ao deletar vendedor' });
    }
  });

  router.post('/sellers/:id/make-admin', requireAdmin, (req, res) => {
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

      return res.json({
        success: true,
        message: 'Vendedor promovido a admin. Ele pode fazer login e acessar a tela de administração.',
      });
    } catch (error) {
      if (error.message.includes('UNIQUE')) {
        return res.status(409).json({ error: 'Este vendedor já é admin' });
      }
      return res.status(500).json({ error: 'Erro ao promover vendedor' });
    }
  });

  router.get('/sellers/:id/is-admin', requireAdmin, (req, res) => {
    const { id } = req.params;

    try {
      const seller = db.prepare('SELECT * FROM sellers WHERE id = ?').get(id);
      if (!seller) {
        return res.status(404).json({ error: 'Vendedor não encontrado' });
      }

      const admin = db.prepare("SELECT * FROM users WHERE username = ? AND role = 'admin'").get(seller.name);
      return res.json({ isAdmin: !!admin });
    } catch (_error) {
      return res.status(500).json({ error: 'Erro ao verificar admin' });
    }
  });

  router.post('/sellers/:id/remove-admin', requireAdmin, (req, res) => {
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

      db.prepare('UPDATE sellers SET active = 1 WHERE id = ?').run(id);

      return res.json({ success: true, message: 'Admin removido com sucesso' });
    } catch (_error) {
      return res.status(500).json({ error: 'Erro ao remover admin' });
    }
  });

  router.post('/users/:id/make-seller', requireAdmin, (req, res) => {
    const { id } = req.params;

    try {
      const adminUser = db.prepare("SELECT * FROM users WHERE username = ? AND role = 'admin'").get(id);
      if (!adminUser) {
        return res.status(404).json({ error: 'Admin não encontrado' });
      }

      const seller = db.prepare('SELECT * FROM sellers WHERE name = ?').get(adminUser.username);
      if (seller) {
        return res.status(409).json({ error: 'Este admin já é vendedor' });
      }

      db.prepare('INSERT INTO sellers (name, password, active) VALUES (?, ?, ?)').run(
        adminUser.username,
        adminUser.password,
        1
      );

      return res.json({ success: true, message: 'Admin agora também é vendedor' });
    } catch (_error) {
      return res.status(500).json({ error: 'Erro ao tornar vendedor' });
    }
  });

  router.post('/users/:id/remove-seller', requireAdmin, (req, res) => {
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

      return res.json({ success: true, message: 'Vendedor removido com sucesso' });
    } catch (_error) {
      return res.status(500).json({ error: 'Erro ao remover vendedor' });
    }
  });

  router.post('/users/:name/revert-to-seller', requireAdmin, (req, res) => {
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

      return res.json({
        success: true,
        message: 'Usuário agora é apenas vendedor e pode fazer login na tela de vendedor.',
        sessionDestroyed: !!isSelf,
      });
    } catch (error) {
      console.error('revert-to-seller error:', error);
      return res.status(500).json({ error: error.message || 'Erro ao reverter para vendedor' });
    }
  });

  router.post('/users/:id/remove-seller-only', requireAdmin, (req, res) => {
    const { id } = req.params;

    try {
      const seller = db.prepare('SELECT * FROM sellers WHERE id = ?').get(id);
      if (!seller) {
        return res.status(404).json({ error: 'Vendedor não encontrado' });
      }

      db.prepare('UPDATE tickets SET seller_id = NULL WHERE seller_id = ?').run(id);
      db.prepare('DELETE FROM sellers WHERE id = ?').run(id);

      return res.json({ success: true, message: 'Vendedor deletado com sucesso' });
    } catch (_error) {
      return res.status(500).json({ error: 'Erro ao deletar vendedor' });
    }
  });

  // Alterar senha de um usuário (admin)
  router.post('/users/:id/change-password', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { newPassword } = req.body;

    console.log('[change-password] Iniciando alteração de senha. ID:', id, 'Password length:', newPassword?.length);

    if (!newPassword || String(newPassword).trim().length === 0) {
      console.log('[change-password] Erro: senha vazia');
      return res.status(400).json({ error: 'Nova senha é obrigatória' });
    }

    try {
      // Verifica se é um admin (formato: admin_X)
      const numericId = String(id).startsWith('admin_') ? id.replace('admin_', '') : id;
      console.log('[change-password] ID numérico extraído:', numericId);
      
      const user = db.prepare("SELECT id, username FROM users WHERE id = ?").get(numericId);
      console.log('[change-password] Usuário encontrado:', user ? `${user.username} (id: ${user.id})` : 'não encontrado');
      
      if (!user) {
        console.log('[change-password] Usuário não encontrado com ID:', numericId);
        return res.status(404).json({ error: 'Usuário não encontrado' });
      }

      const hashedPassword = await hashPassword(newPassword);
      const result = db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashedPassword, numericId);
      console.log('[change-password] UPDATE result:', result.changes, 'changes');

      return res.json({ success: true, message: 'Senha alterada com sucesso' });
    } catch (error) {
      console.error('[change-password] Erro ao alterar senha:', error);
      return res.status(500).json({ error: 'Erro ao alterar senha' });
    }
  });

  // Alterar senha de um vendedor (admin)
  router.post('/sellers/:id/change-password', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { newPassword } = req.body;

    console.log('[change-password-seller] Iniciando alteração de senha. ID:', id, 'Password length:', newPassword?.length);

    if (!newPassword || String(newPassword).trim().length === 0) {
      console.log('[change-password-seller] Erro: senha vazia');
      return res.status(400).json({ error: 'Nova senha é obrigatória' });
    }

    try {
      // Verifica se é um vendedor (formato: seller_X)
      const numericId = String(id).startsWith('seller_') ? id.replace('seller_', '') : id;
      console.log('[change-password-seller] ID numérico extraído:', numericId);
      
      const seller = db.prepare("SELECT id, name FROM sellers WHERE id = ?").get(numericId);
      console.log('[change-password-seller] Vendedor encontrado:', seller ? `${seller.name} (id: ${seller.id})` : 'não encontrado');
      
      if (!seller) {
        console.log('[change-password-seller] Vendedor não encontrado com ID:', numericId);
        return res.status(404).json({ error: 'Vendedor não encontrado' });
      }

      const hashedPassword = await hashPassword(newPassword);
      const result = db.prepare('UPDATE sellers SET password = ? WHERE id = ?').run(hashedPassword, numericId);
      console.log('[change-password-seller] UPDATE result:', result.changes, 'changes');

      return res.json({ success: true, message: 'Senha alterada com sucesso' });
    } catch (error) {
      console.error('[change-password-seller] Erro ao alterar senha:', error);
      return res.status(500).json({ error: 'Erro ao alterar senha' });
    }
  });

  return router;
}

module.exports = {
  createUsersRouter,
};
