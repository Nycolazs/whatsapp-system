const express = require('express');
const { validate, schemas } = require('../middleware/validation');
const { auditMiddleware } = require('../middleware/audit');

function createAdminConfigRouter({ db, requireAdmin, accountContext, accountManager }) {
  const router = express.Router();

  // Conta ativa / backup (admin)
  router.get('/admin/account', requireAdmin, (req, res) => {
    return res.json({
      account: (accountContext.getActiveAccount && accountContext.getActiveAccount()) || null,
      dbPath: (db.getPath && db.getPath()) || null,
    });
  });

  router.post('/admin/account/switch', requireAdmin, (req, res) => {
    const account = accountManager.normalizeAccountNumber(req.body?.account);
    if (!account) return res.status(400).json({ error: 'account inválido' });
    accountManager.ensureAccount(account);
    accountManager.migrateLegacyToAccount(account);
    accountManager.activateAccountFromConnectedWhatsApp(account, null);
    try {
      db.switchToActiveAccount && db.switchToActiveAccount();
    } catch (_) {}
    return res.json({ ok: true, account });
  });

  router.post('/admin/account/snapshot', requireAdmin, (req, res) => {
    const account =
      accountManager.normalizeAccountNumber(req.body?.account) ||
      (accountContext.getActiveAccount && accountContext.getActiveAccount());
    if (!account) return res.status(400).json({ error: 'Nenhuma conta ativa' });
    const dir = accountManager.snapshotAccount(account, req.body?.reason || 'manual');
    return res.json({ ok: true, account, snapshotDir: dir });
  });

  // Endpoints de horários de funcionamento (admin)
  router.get('/business-hours', requireAdmin, (req, res) => {
    try {
      const rows = db
        .prepare('SELECT day, open_time, close_time, enabled FROM business_hours ORDER BY day ASC')
        .all();
      const hours = rows.map((row) => ({
        day: Number(row.day),
        open_time: row.open_time || null,
        close_time: row.close_time || null,
        enabled: row.enabled === 1 || row.enabled === true,
      }));
      return res.json(hours);
    } catch (_error) {
      return res.status(500).json({ error: 'Erro ao carregar horários' });
    }
  });

  router.put(
    '/business-hours',
    requireAdmin,
    validate(schemas.businessHours),
    auditMiddleware('update-business-hours'),
    (req, res) => {
      const payload = req.body;

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
        rows.forEach((row) => {
          const day = Number(row.day);
          if (!Number.isInteger(day) || day < 0 || day > 6) {
            throw new Error('Dia inválido');
          }
          upsert.run(day, row.open_time || null, row.close_time || null, row.enabled ? 1 : 0);
        });
      });

      tx(payload);
      return res.json({ success: true, message: 'Horários atualizados' });
    } catch (_error) {
      return res.status(500).json({ error: 'Erro ao salvar horários' });
    }
  });

  router.get('/business-exceptions', requireAdmin, (req, res) => {
    try {
      const rows = db
        .prepare(
          'SELECT id, date, closed, open_time, close_time, reason FROM business_exceptions ORDER BY date DESC'
        )
        .all();
      const exceptions = rows.map((row) => ({
        ...row,
        closed: row.closed === 1 || row.closed === true,
      }));
      return res.json(exceptions);
    } catch (_error) {
      return res.status(500).json({ error: 'Erro ao carregar exceções' });
    }
  });

  router.post(
    '/business-exceptions',
    requireAdmin,
    validate(schemas.businessException),
    auditMiddleware('create-business-exception'),
    (req, res) => {
      const { date, closed, open_time, close_time, reason } = req.body;

    try {
      const result = db
        .prepare(`
          INSERT INTO business_exceptions (date, closed, open_time, close_time, reason)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(date) DO UPDATE SET
            closed = excluded.closed,
            open_time = excluded.open_time,
            close_time = excluded.close_time,
            reason = excluded.reason
        `)
        .run(
          date,
          closed ? 1 : 0,
          open_time || null,
          close_time || null,
          reason || null
        );

      return res.status(201).json({
        success: true,
        id: result.lastInsertRowid,
        date,
        closed: closed ? 1 : 0,
        open_time: open_time || null,
        close_time: close_time || null,
        reason: reason || null,
      });
    } catch (_error) {
      return res.status(500).json({ error: 'Erro ao salvar exceção' });
    }
  });

  router.delete('/business-exceptions/:id', requireAdmin, (req, res) => {
    const { id } = req.params;

    try {
      const result = db.prepare('DELETE FROM business_exceptions WHERE id = ?').run(id);
      if (result.changes === 0) {
        return res.status(404).json({ error: 'Exceção não encontrada' });
      }
      return res.json({ success: true, message: 'Exceção removida' });
    } catch (_error) {
      return res.status(500).json({ error: 'Erro ao remover exceção' });
    }
  });

  router.get('/business-message', requireAdmin, (req, res) => {
    try {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('out_of_hours_message');
      const enabledRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('out_of_hours_enabled');
      const enabled = enabledRow ? enabledRow.value === '1' : true;
      return res.json({ message: row?.value || '', enabled });
    } catch (_error) {
      return res.status(500).json({ error: 'Erro ao carregar mensagem' });
    }
  });

  router.put('/business-message', requireAdmin, (req, res) => {
    const { message, enabled } = req.body;
    const hasEnabled = typeof enabled === 'boolean';
    const hasMessage = typeof message === 'string';
    if (!hasMessage && !hasEnabled) {
      return res.status(400).json({ error: 'Informe mensagem ou configuração' });
    }
    if (hasMessage && message.trim().length === 0 && enabled !== false) {
      return res.status(400).json({ error: 'Mensagem é obrigatória' });
    }

    try {
      if (hasMessage) {
        db.prepare(
          `
            INSERT INTO settings (key, value)
            VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
          `
        ).run('out_of_hours_message', message.trim());
      }

      if (hasEnabled) {
        db.prepare(
          `
            INSERT INTO settings (key, value)
            VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
          `
        ).run('out_of_hours_enabled', enabled ? '1' : '0');
      }

      return res.json({ success: true, message: 'Mensagem atualizada' });
    } catch (_error) {
      return res.status(500).json({ error: 'Erro ao salvar mensagem' });
    }
  });

  // ===== API: configuração do Await (mover de 'em_atendimento' -> 'aguardando') =====
  router.get('/admin/await-config', requireAdmin, (req, res) => {
    try {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('await_minutes');
      const minutes = row ? parseInt(row.value || '0', 10) : 0;
      return res.json({ minutes: Number.isFinite(minutes) ? minutes : 0 });
    } catch (_error) {
      return res.status(500).json({ error: 'Erro ao carregar configuração' });
    }
  });

  router.put('/admin/await-config', requireAdmin, (req, res) => {
    const { minutes } = req.body;
    const m = parseInt(minutes, 10);
    if (Number.isNaN(m) || m < 0) {
      return res.status(400).json({ error: 'Valor inválido para minutes' });
    }

    try {
      db.prepare(
        `
          INSERT INTO settings (key, value)
          VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `
      ).run('await_minutes', String(m));

      return res.json({ success: true, minutes: m });
    } catch (_error) {
      return res.status(500).json({ error: 'Erro ao salvar configuração' });
    }
  });

  return router;
}

module.exports = {
  createAdminConfigRouter,
};
