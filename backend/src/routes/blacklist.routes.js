const express = require('express');
const { validate, schemas } = require('../middleware/validation');
const { auditMiddleware } = require('../middleware/audit');

function createBlacklistRouter({ db, requireAdmin }) {
  const router = express.Router();

  router.get('/blacklist', requireAdmin, (req, res) => {
    const blacklist = db.prepare('SELECT * FROM blacklist').all();
    return res.json(blacklist);
  });

  router.post(
    '/blacklist',
    requireAdmin,
    (req, res, next) => {
      console.log('[BLACKLIST DEBUG] Request body:', req.body);
      next();
    },
    validate(schemas.blacklist),
    auditMiddleware('add-to-blacklist'),
    (req, res) => {
    const { phone, reason } = req.body;

    if (!phone) {
      return res.status(400).json({ error: 'Telefone é obrigatório' });
    }

    const cleanPhone = String(phone).split('@')[0];

    try {
      db.prepare('INSERT INTO blacklist (phone, reason) VALUES (?, ?)').run(
        cleanPhone,
        reason || 'Sem motivo especificado'
      );
      return res.status(201).json({ message: 'Número adicionado à blacklist', phone: cleanPhone });
    } catch (error) {
      if (error && error.message && error.message.includes('UNIQUE')) {
        return res.status(400).json({ error: 'Este número já está na blacklist' });
      }
      return res.status(500).json({ error: 'Erro ao adicionar à blacklist' });
    }
  });

  // Endpoint: adiciona via lid (mapeia e insere)
  router.post('/blacklist/by-lid', requireAdmin, (req, res) => {
    const { lid, reason } = req.body;
    if (!lid) return res.status(400).json({ error: 'lid é obrigatório' });

    const cleanPhone = String(lid).split('@')[0];

    try {
      db.prepare('INSERT INTO blacklist (phone, reason) VALUES (?, ?)').run(
        cleanPhone,
        reason || 'Sem motivo especificado'
      );
      return res.status(201).json({ message: 'Número adicionado via lid', phone: cleanPhone });
    } catch (error) {
      if (error && error.message && error.message.includes('UNIQUE')) {
        return res.status(400).json({ error: 'Este número já está na blacklist' });
      }
      return res.status(500).json({ error: 'Erro ao adicionar à blacklist' });
    }
  });

  router.delete('/blacklist/:phone', requireAdmin, auditMiddleware('remove-from-blacklist'), (req, res) => {
    const { phone } = req.params;

    const result = db.prepare('DELETE FROM blacklist WHERE phone = ?').run(phone);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Número não encontrado na blacklist' });
    }

    return res.json({ message: 'Número removido da blacklist', phone });
  });

  return router;
}

module.exports = {
  createBlacklistRouter,
};
