const express = require('express');
const fs = require('fs');
const { validate, schemas } = require('../middleware/validation');
const { auditMiddleware } = require('../middleware/audit');

const DEBUG_TICKETS_REPLY = process.env.DEBUG_TICKETS_REPLY === '1';
const STATUS_LABELS = {
  pendente: 'Pendente',
  aguardando: 'Aguardando',
  em_atendimento: 'Em Atendimento',
  resolvido: 'Resolvido',
  encerrado: 'Encerrado',
};

function toSqliteUtc(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

function parseScheduledAt(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return null;
  return toSqliteUtc(date);
}

function createTicketsRouter({
  db,
  requireAuth,
  requireAdmin,
  getSocket,
  uploadAudio,
}) {
  const router = express.Router();

  function resolveAssignIdForUser(req) {
    if (req.userType === 'seller') return req.userId;
    if (req.userType === 'admin' && req.userName) {
      const s = db.prepare('SELECT id FROM sellers WHERE name = ?').get(req.userName);
      if (s && s.id) return s.id;
      try {
        const insert = db.prepare('INSERT INTO sellers (name, password, active) VALUES (?, ?, 1)');
        const randomPass = Math.random().toString(36).slice(2);
        const info = insert.run(req.userName, randomPass);
        if (info && info.lastInsertRowid) return info.lastInsertRowid;
      } catch (_e) {
        const fallback = db.prepare('SELECT id FROM sellers WHERE name = ?').get(req.userName);
        if (fallback && fallback.id) return fallback.id;
      }
    }
    return null;
  }

  function insertSystemMessage(ticketId, content) {
    try {
      db.prepare(
        'INSERT INTO messages (ticket_id, sender, content, message_type, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)'
      ).run(ticketId, 'system', content, 'system');
    } catch (_e) {}
  }

  function resolveTicketJid(ticket) {
    const fallback = ticket.phone && String(ticket.phone).includes('@')
      ? String(ticket.phone)
      : `${ticket.phone}@s.whatsapp.net`;

    try {
      const row = db.prepare(
        "SELECT whatsapp_key FROM messages WHERE ticket_id = ? AND sender = 'client' AND whatsapp_key IS NOT NULL ORDER BY id DESC LIMIT 1"
      ).get(ticket.id);
      if (!row || !row.whatsapp_key) return fallback;

      const key = JSON.parse(row.whatsapp_key);
      const remoteJid = key && typeof key.remoteJid === 'string' ? key.remoteJid.trim() : '';
      if (remoteJid && (remoteJid.endsWith('@lid') || remoteJid.endsWith('@s.whatsapp.net'))) {
        return remoteJid;
      }
    } catch (_) {}

    return fallback;
  }

  // Busca o ticket ativo de um contato (por phone)
  router.get('/contacts/:phone/active-ticket', requireAuth, (req, res) => {
    const phone = String(req.params.phone || '').split('@')[0];
    if (!phone) return res.status(400).json({ error: 'phone é obrigatório' });

    try {
      const ticket = db.prepare(
        "SELECT t.*, s.name as seller_name FROM tickets t LEFT JOIN sellers s ON t.seller_id = s.id WHERE t.phone = ? AND t.status NOT IN ('resolvido','encerrado') ORDER BY t.id DESC LIMIT 1"
      ).get(phone);
      return res.json(ticket || null);
    } catch (_error) {
      return res.status(500).json({ error: 'Erro ao buscar ticket ativo' });
    }
  });

  // Histórico de tickets de um contato (por phone)
  router.get('/contacts/:phone/tickets', requireAuth, (req, res) => {
    const phone = String(req.params.phone || '').split('@')[0];
    if (!phone) return res.status(400).json({ error: 'phone é obrigatório' });

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    try {
      const tickets = db.prepare(
        `
          SELECT t.*, s.name as seller_name,
                 COALESCE(COUNT(m.id), 0) AS unread_count
          FROM tickets t
          LEFT JOIN sellers s ON t.seller_id = s.id
          LEFT JOIN messages m
            ON m.ticket_id = t.id
           AND m.sender = 'client'
          WHERE t.phone = ?
          GROUP BY t.id
          ORDER BY t.id DESC
          LIMIT ? OFFSET ?
        `
      ).all(phone, limit, offset);

      return res.json(tickets);
    } catch (_error) {
      return res.status(500).json({ error: 'Erro ao listar histórico de tickets' });
    }
  });

  router.get('/tickets', requireAuth, (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const tickets = db.prepare(`
      SELECT
        t.*,
        COALESCE(COUNT(m.id), 0) AS unread_count
      FROM tickets t
      LEFT JOIN messages m
        ON m.ticket_id = t.id
       AND m.sender = 'client'
      WHERE (
        t.phone IS NOT NULL
        AND t.phone != ''
        AND t.phone NOT LIKE '%@%'
        AND t.phone NOT GLOB '*[^0-9]*'
        AND length(t.phone) BETWEEN 8 AND 25
      )
      GROUP BY t.id
      ORDER BY t.updated_at DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset);

    return res.json(tickets);
  });

  // Buscar ticket por id
  router.get('/tickets/:id', requireAuth, (req, res) => {
    const { id } = req.params;
    try {
      const ticket = db.prepare(
        `SELECT t.*, s.name as seller_name
         FROM tickets t
         LEFT JOIN sellers s ON t.seller_id = s.id
         WHERE t.id = ?`
      ).get(id);

      if (!ticket) return res.status(404).json({ error: 'Ticket não encontrado' });
      return res.json(ticket);
    } catch (_error) {
      return res.status(500).json({ error: 'Erro ao buscar ticket' });
    }
  });

  // Endpoint para obter uma mensagem específica (para reply preview)
  router.get('/messages/:id', requireAuth, (req, res) => {
    try {
      const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
      if (!message) {
        return res.status(404).json({ error: 'Mensagem não encontrada' });
      }
      return res.json(message);
    } catch (_error) {
      return res.status(500).json({ error: 'Erro ao obter mensagem' });
    }
  });

  router.get('/tickets/:id/messages', requireAuth, (req, res) => {
    const { id } = req.params;
    const { limit, before } = req.query;

    try {
      const params = [id];
      let query = 'SELECT * FROM messages WHERE ticket_id = ?';

      if (before) {
        query += ' AND created_at < ?';
        params.push(before);
      }

      // created_at pode empatar (resolução por segundo do SQLite). Usa id como tie-breaker.
      query += ' ORDER BY created_at DESC, id DESC';

      const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 0, 0), 1000);
      if (safeLimit > 0) {
        query += ' LIMIT ?';
        params.push(safeLimit);
      }

      const rows = db.prepare(query).all(...params);
      return res.json(rows.reverse());
    } catch (_error) {
      return res.status(500).json({ error: 'Erro ao listar mensagens' });
    }
  });

  // Endpoint para obter apenas novas mensagens (polling otimizado)
  router.get('/tickets/:id/messages/since/:timestamp', requireAuth, (req, res) => {
    const { id, timestamp } = req.params;
    const lastId = Number(req.query.lastId || 0);
    const messages = db.prepare(`
      SELECT *
      FROM messages
      WHERE ticket_id = ?
        AND (
          created_at > ?
          OR (created_at = ? AND id > ?)
          OR updated_at > ?
        )
      ORDER BY created_at ASC, id ASC
    `).all(id, timestamp, timestamp, lastId, timestamp);
    return res.json(messages);
  });

  // Criar lembrete para um ticket
  router.post(
    '/tickets/:id/reminders',
    requireAuth,
    validate(schemas.reminderCreate),
    auditMiddleware('create-reminder'),
    (req, res) => {
      const { id } = req.params;
      const { scheduled_at, note, message } = req.body;

      try {
        const ticket = db.prepare('SELECT id, seller_id FROM tickets WHERE id = ?').get(id);
        if (!ticket) return res.status(404).json({ error: 'Ticket não encontrado' });

        if (!ticket.seller_id) {
          return res.status(400).json({ error: 'Atribua o ticket a um vendedor antes de criar um lembrete' });
        }

        if (req.userType === 'seller' && Number(ticket.seller_id) !== Number(req.userId)) {
          return res.status(403).json({ error: 'Você não pode criar lembretes para este ticket' });
        }

        const scheduledAt = parseScheduledAt(scheduled_at);
        if (!scheduledAt) return res.status(400).json({ error: 'Data/hora inválida' });

        const info = db.prepare(
          `INSERT INTO ticket_reminders
            (ticket_id, seller_id, note, message, scheduled_at, status, created_by_user_id, created_by_type, updated_at)
           VALUES (?, ?, ?, ?, ?, 'scheduled', ?, ?, CURRENT_TIMESTAMP)`
        ).run(id, ticket.seller_id, note || null, message || null, scheduledAt, req.userId, req.userType);

        const reminder = db.prepare('SELECT * FROM ticket_reminders WHERE id = ?').get(info.lastInsertRowid);
        return res.status(201).json(reminder);
      } catch (_error) {
        return res.status(500).json({ error: 'Erro ao criar lembrete' });
      }
    }
  );

  // Listar lembretes de um ticket
  router.get('/tickets/:id/reminders', requireAuth, (req, res) => {
    const { id } = req.params;
    try {
      const ticket = db.prepare('SELECT id, seller_id FROM tickets WHERE id = ?').get(id);
      if (!ticket) return res.status(404).json({ error: 'Ticket não encontrado' });

      if (req.userType === 'seller' && Number(ticket.seller_id) !== Number(req.userId)) {
        return res.status(403).json({ error: 'Você não pode visualizar lembretes deste ticket' });
      }

      const reminders = db.prepare(
        `SELECT * FROM ticket_reminders
         WHERE ticket_id = ?
         ORDER BY scheduled_at ASC`
      ).all(id);

      return res.json(reminders);
    } catch (_error) {
      return res.status(500).json({ error: 'Erro ao listar lembretes' });
    }
  });

  // Editar lembrete
  router.patch(
    '/reminders/:id',
    requireAuth,
    validate(schemas.reminderUpdate),
    auditMiddleware('update-reminder'),
    (req, res) => {
      const { id } = req.params;
      const { scheduled_at, note, status, message } = req.body;

      try {
        const reminder = db.prepare('SELECT * FROM ticket_reminders WHERE id = ?').get(id);
        if (!reminder) return res.status(404).json({ error: 'Lembrete não encontrado' });

        if (req.userType === 'seller' && Number(reminder.seller_id) !== Number(req.userId)) {
          return res.status(403).json({ error: 'Você não pode editar este lembrete' });
        }

        let scheduledAt = reminder.scheduled_at;
        if (scheduled_at !== undefined) {
          const parsed = parseScheduledAt(scheduled_at);
          if (!parsed) return res.status(400).json({ error: 'Data/hora inválida' });
          scheduledAt = parsed;
        }

        const nextNote = note !== undefined ? note : reminder.note;
        const nextStatus = status || reminder.status;
        const nextMessage = message !== undefined ? message : reminder.message;

        db.prepare(
          'UPDATE ticket_reminders SET note = ?, message = ?, scheduled_at = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
        ).run(nextNote || null, nextMessage || null, scheduledAt, nextStatus, id);

        const updated = db.prepare('SELECT * FROM ticket_reminders WHERE id = ?').get(id);
        return res.json(updated);
      } catch (_error) {
        return res.status(500).json({ error: 'Erro ao atualizar lembrete' });
      }
    }
  );

  // Próximos lembretes do usuário
  router.get('/reminders/upcoming', requireAuth, (req, res) => {
    const withinHours = Math.min(Math.max(parseInt(req.query.withinHours, 10) || 168, 1), 720);
    const sellerId = req.userType === 'seller' ? req.userId : resolveAssignIdForUser(req);
    if (!sellerId) return res.json([]);

    try {
      const reminders = db.prepare(
        `SELECT r.*, t.phone, t.contact_name
         FROM ticket_reminders r
         JOIN tickets t ON t.id = r.ticket_id
         WHERE r.seller_id = ?
           AND r.status = 'scheduled'
           AND r.scheduled_at <= datetime('now', '+' || ? || ' hours')
         ORDER BY r.scheduled_at ASC`
      ).all(sellerId, withinHours);

      return res.json(reminders);
    } catch (_error) {
      return res.status(500).json({ error: 'Erro ao listar lembretes' });
    }
  });

  // Lembretes vencidos (para notificação) - marca notified_at
  router.get('/reminders/due', requireAuth, (req, res) => {
    const sellerId = req.userType === 'seller' ? req.userId : resolveAssignIdForUser(req);
    if (!sellerId) return res.json([]);

    try {
      const due = db.prepare(
        `SELECT r.*, t.phone, t.contact_name
         FROM ticket_reminders r
         JOIN tickets t ON t.id = r.ticket_id
         WHERE r.seller_id = ?
           AND r.status = 'scheduled'
           AND r.notified_at IS NULL
           AND r.scheduled_at <= datetime('now')
         ORDER BY r.scheduled_at ASC`
      ).all(sellerId);

      if (due.length) {
        const mark = db.prepare('UPDATE ticket_reminders SET notified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
        const tx = db.transaction((items) => {
          items.forEach((r) => mark.run(r.id));
        });
        tx(due);
      }

      return res.json(due);
    } catch (_error) {
      return res.status(500).json({ error: 'Erro ao buscar lembretes vencidos' });
    }
  });

  // Lembretes pendentes (vencidos) - não marca notified_at
  router.get('/reminders/pending', requireAuth, (req, res) => {
    const sellerId = req.userType === 'seller' ? req.userId : resolveAssignIdForUser(req);
    if (!sellerId) return res.json([]);

    try {
      const pending = db.prepare(
        `SELECT r.*, t.phone, t.contact_name
         FROM ticket_reminders r
         JOIN tickets t ON t.id = r.ticket_id
         WHERE r.seller_id = ?
           AND r.status = 'scheduled'
           AND r.scheduled_at <= datetime('now')
         ORDER BY r.scheduled_at ASC`
      ).all(sellerId);

      return res.json(pending);
    } catch (_error) {
      return res.status(500).json({ error: 'Erro ao buscar lembretes pendentes' });
    }
  });

  router.post(
    '/tickets/:id/send',
    requireAuth,
    validate(schemas.sendMessage),
    auditMiddleware('send-message'),
    async (req, res) => {
    const { id } = req.params;
    const { message, reply_to_id } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Mensagem é obrigatória' });
    }

    try {
      const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);

      if (!ticket) {
        return res.status(404).json({ error: 'Ticket não encontrado' });
      }

      if (ticket.status === 'resolvido' || ticket.status === 'encerrado') {
        return res.status(400).json({ error: 'Não é possível enviar mensagens em tickets encerrados' });
      }

      // Verifica se este é o ticket mais recente deste contato
      const latestTicket = db.prepare(
        "SELECT id FROM tickets WHERE phone = ? ORDER BY id DESC LIMIT 1"
      ).get(ticket.phone);
      
      if (latestTicket && String(latestTicket.id) !== String(ticket.id)) {
        return res.status(400).json({ error: 'Não é possível enviar mensagens em tickets antigos. Use o ticket mais recente.' });
      }

      const sock = getSocket();
      if (!sock) {
        return res.status(503).json({ error: 'WhatsApp não conectado. Por favor, aguarde a reconexão.' });
      }

      // Envia mensagem via WhatsApp com nome do agente
      const jid = resolveTicketJid(ticket);
      const messageWithSender = `*${req.userName}:*\n\n${message}`;

      // Se for reply, busca a mensagem original para incluir no envio
      const messageToSend = { text: messageWithSender };
      const sendOptions = {};

      if (reply_to_id) {
        try {
          const originalMsg = db.prepare('SELECT * FROM messages WHERE id = ?').get(reply_to_id);
          if (DEBUG_TICKETS_REPLY) {
            console.log(`[REPLY] Buscando msg original ID ${reply_to_id}:`, {
              existe: !!originalMsg,
              temKey: !!originalMsg?.whatsapp_key,
              temMessage: !!originalMsg?.whatsapp_message,
            });
          }

          if (originalMsg && originalMsg.whatsapp_key && originalMsg.whatsapp_message) {
            try {
              const parsedKey = JSON.parse(originalMsg.whatsapp_key);
              const parsedMessage = JSON.parse(originalMsg.whatsapp_message);

              // Construir o objeto quoted compatível com Baileys
              // quoted deve ter a estrutura: { key: WAMessageKey, message: WAMessageContent }
              sendOptions.quoted = {
                key: parsedKey,
                message: parsedMessage,
              };

              if (DEBUG_TICKETS_REPLY) {
                console.log('[REPLY] Quoted adicionado com sucesso:', {
                  keyId: parsedKey?.id,
                  messageType: Object.keys(parsedMessage || {})[0],
                });
              }
            } catch (parseErr) {
              console.error('Erro ao parsear quoted:', parseErr.message);
            }
          } else {
            if (DEBUG_TICKETS_REPLY) {
              console.warn('[REPLY] Mensagem original não tem whatsapp_key ou whatsapp_message');
            }
          }
        } catch (e) {
          console.error('Erro ao buscar mensagem para quote:', e.message);
        }
      }

      if (DEBUG_TICKETS_REPLY) {
        console.log('[SEND] Enviando mensagem com payload:', {
          temQuoted: !!sendOptions.quoted,
          replyToId: reply_to_id,
          sendOptions,
        });
      }

      await sock.sendMessage(jid, messageToSend, sendOptions);

      // Atribui ticket ao usuário que respondeu (admin sempre assume, seller apenas se aguardando ou sem vendedor)
      const assignId = resolveAssignIdForUser(req);
      if (assignId) {
        if (req.userType === 'admin') {
          if (ticket.seller_id !== assignId) {
            db.prepare('UPDATE tickets SET seller_id = ? WHERE id = ?').run(assignId, id);
          }
        } else if (ticket.status === 'aguardando' || !ticket.seller_id) {
          db.prepare('UPDATE tickets SET seller_id = ? WHERE id = ?').run(assignId, id);
        }
      }

      // Salva mensagem no banco com reply_to_id se fornecido
      if (reply_to_id) {
        db.prepare('INSERT INTO messages (ticket_id, sender, content, sender_name, reply_to_id, updated_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)').run(
          id,
          'agent',
          message,
          req.userName,
          reply_to_id
        );
      } else {
        db.prepare('INSERT INTO messages (ticket_id, sender, content, sender_name, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)').run(
          id,
          'agent',
          message,
          req.userName
        );
      }

      // Atualiza status e timestamp do ticket
      db.prepare('UPDATE tickets SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('em_atendimento', id);

      return res.json({ success: true, message: 'Mensagem enviada' });
    } catch (_error) {
      return res.status(500).json({ error: 'Erro ao enviar mensagem' });
    }
  });

  // Endpoint para enviar áudio
  router.post('/tickets/:id/send-audio', requireAuth, uploadAudio.single('audio'), async (req, res) => {
    const { id } = req.params;
    const { reply_to_id } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: 'Arquivo de áudio é obrigatório' });
    }

    try {
      const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);

      if (!ticket) {
        // Remove arquivo se ticket não existe
        fs.unlink(req.file.path, () => {});
        return res.status(404).json({ error: 'Ticket não encontrado' });
      }

      if (ticket.status === 'resolvido' || ticket.status === 'encerrado') {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: 'Não é possível enviar mensagens em tickets encerrados' });
      }

      // Verifica se este é o ticket mais recente deste contato
      const latestTicket = db.prepare(
        "SELECT id FROM tickets WHERE phone = ? ORDER BY id DESC LIMIT 1"
      ).get(ticket.phone);
      
      if (latestTicket && String(latestTicket.id) !== String(ticket.id)) {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: 'Não é possível enviar mensagens em tickets antigos. Use o ticket mais recente.' });
      }

      const sock = getSocket();
      if (!sock) {
        // Remove arquivo se não conseguir enviar
        fs.unlink(req.file.path, () => {});
        return res.status(503).json({ error: 'WhatsApp não conectado. Por favor, aguarde a reconexão.' });
      }

      // Envia áudio via WhatsApp
      const jid = resolveTicketJid(ticket);
      const audioPath = req.file.path;

      // Se for reply, busca a mensagem original para incluir no envio
      const audioMessageObj = {
        audio: { url: audioPath },
        mimetype: 'audio/ogg; codecs=opus',
        ptt: true,
      };

      const audioSendOptions = {};

      if (reply_to_id) {
        try {
          const originalMsg = db.prepare('SELECT * FROM messages WHERE id = ?').get(reply_to_id);
          if (originalMsg && originalMsg.whatsapp_key && originalMsg.whatsapp_message) {
            audioSendOptions.quoted = {
              key: JSON.parse(originalMsg.whatsapp_key),
              message: JSON.parse(originalMsg.whatsapp_message),
            };
          }
        } catch (e) {
          console.error('Erro ao buscar mensagem para quote de áudio:', e.message);
        }
      }

      try {
        await sock.sendMessage(jid, audioMessageObj, audioSendOptions);
      } catch (sendError) {
        console.error('Erro ao enviar áudio via WhatsApp:', sendError);
        // Tenta enviar sem PTT como fallback
        delete audioMessageObj.ptt;
        await sock.sendMessage(jid, audioMessageObj, audioSendOptions);
      }

      // Atribui ticket ao usuário que respondeu (admin sempre assume, seller apenas se aguardando ou sem vendedor)
      const assignId = resolveAssignIdForUser(req);
      if (assignId) {
        if (req.userType === 'admin') {
          if (ticket.seller_id !== assignId) {
            db.prepare('UPDATE tickets SET seller_id = ? WHERE id = ?').run(assignId, id);
          }
        } else if (ticket.status === 'aguardando' || !ticket.seller_id) {
          db.prepare('UPDATE tickets SET seller_id = ? WHERE id = ?').run(assignId, id);
        }
      }

      // Salva mensagem de áudio no banco com reply_to_id se fornecido
      const mediaUrl = `/media/audios/${req.file.filename}`;
      if (reply_to_id) {
        db.prepare('INSERT INTO messages (ticket_id, sender, content, message_type, media_url, sender_name, reply_to_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)').run(
          id,
          'agent',
          '🎤 Áudio',
          'audio',
          mediaUrl,
          req.userName,
          reply_to_id
        );
      } else {
        db.prepare('INSERT INTO messages (ticket_id, sender, content, message_type, media_url, sender_name, updated_at) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)').run(
          id,
          'agent',
          '🎤 Áudio',
          'audio',
          mediaUrl,
          req.userName
        );
      }

      // Atualiza status e timestamp do ticket
      db.prepare('UPDATE tickets SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('em_atendimento', id);

      return res.json({ success: true, message: 'Áudio enviado', audioUrl: mediaUrl });
    } catch (error) {
      // Remove arquivo em caso de erro
      if (req.file) {
        fs.unlink(req.file.path, () => {});
      }
      console.error('Erro ao enviar áudio:', error);
      return res.status(500).json({ error: 'Erro ao enviar áudio' });
    }
  });

  router.patch(
    '/tickets/:id/status',
    requireAuth,
    validate(schemas.ticketStatus),
    auditMiddleware('update-ticket-status'),
    async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    if (!['pendente', 'aguardando', 'em_atendimento', 'resolvido', 'encerrado'].includes(status)) {
      return res.status(400).json({ error: 'Status inválido' });
    }

    try {
      const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
      if (!ticket) {
        return res.status(404).json({ error: 'Ticket não encontrado' });
      }

      const previousStatus = ticket.status;

      if (status === 'pendente' && ticket.status !== 'pendente') {
        return res.status(400).json({ error: 'Não é permitido voltar para pendente' });
      }

      if (status === 'resolvido' || status === 'encerrado') {
        try {
          const sock = getSocket();
          if (sock) {
            const jid = resolveTicketJid(ticket);
            setImmediate(() => {
              sock.sendMessage(jid, {
                text: '✅ Seu atendimento foi encerrado. Obrigado por entrar em contato! Se precisar de ajuda novamente, é só enviar uma mensagem.',
              }).catch(() => {});
            });
          }
        } catch (_e) {
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
          const s = db.prepare('SELECT id FROM sellers WHERE name = ?').get(req.userName);
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

      if (previousStatus && previousStatus !== status) {
        const prevLabel = STATUS_LABELS[previousStatus] || previousStatus;
        const nextLabel = STATUS_LABELS[status] || status;
        const isReopen = ['resolvido', 'encerrado'].includes(previousStatus) && !['resolvido', 'encerrado'].includes(status);
        const content = isReopen
          ? `🔓 Conversa reaberta: ${prevLabel} → ${nextLabel}`
          : `🔔 Status alterado: ${prevLabel} → ${nextLabel}`;
        insertSystemMessage(id, content);
      }

      return res.json({ success: true, message: 'Status atualizado' });
    } catch (_error) {
      return res.status(500).json({ error: 'Erro ao atualizar status' });
    }
  });

  // Atribuir/transferir ticket a um vendedor (admin ou vendedor)
  router.post(
    '/tickets/:id/assign',
    requireAuth,
    validate(schemas.assignTicket),
    auditMiddleware('assign-ticket'),
    (req, res) => {
    const { id } = req.params;
    const { sellerId } = req.body;

    if (sellerId === undefined) {
      return res.status(400).json({ error: 'sellerId é obrigatório' });
    }

    const isUnassign = sellerId === null || sellerId === '' || sellerId === '0';

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

      if (isUnassign) {
        if (req.userType === 'seller') {
          return res.status(403).json({ error: 'Você não pode remover a atribuição deste ticket' });
        }
        db.prepare('UPDATE tickets SET seller_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
        db.prepare("UPDATE ticket_reminders SET status = 'canceled', updated_at = CURRENT_TIMESTAMP WHERE ticket_id = ? AND status = 'scheduled'").run(id);
        return res.json({ success: true, message: 'Ticket atribuição removida' });
      }

      const targetSellerId = Number(sellerId);
      if (Number.isNaN(targetSellerId)) {
        return res.status(400).json({ error: 'sellerId inválido' });
      }

      const targetSeller = db.prepare('SELECT id, active FROM sellers WHERE id = ?').get(targetSellerId);
      if (!targetSeller) {
        return res.status(404).json({ error: 'Vendedor não encontrado' });
      }
      if (!targetSeller.active) {
        return res.status(400).json({ error: 'Vendedor desativado' });
      }

      db.prepare('UPDATE tickets SET seller_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(targetSellerId, id);
      db.prepare('UPDATE ticket_reminders SET seller_id = ?, updated_at = CURRENT_TIMESTAMP WHERE ticket_id = ? AND status = "scheduled"').run(targetSellerId, id);
      return res.json({ success: true, message: 'Ticket atribuído' });
    } catch (_error) {
      return res.status(500).json({ error: 'Erro ao atribuir ticket' });
    }
  });

  // Buscar tickets (filtra por vendedor se não for admin)
  router.get('/tickets/seller/:sellerId', requireAuth, (req, res) => {
    const { sellerId } = req.params;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const includeClosed = String(req.query.includeClosed || '') === '1';

    try {
      const tickets = db.prepare(`
        SELECT t.*,
               s.name as seller_name,
               COALESCE(COUNT(m.id), 0) as unread_count
        FROM tickets t
        LEFT JOIN sellers s ON t.seller_id = s.id
        LEFT JOIN messages m ON m.ticket_id = t.id AND m.sender = 'client'
        WHERE (t.seller_id = ? OR t.seller_id IS NULL OR t.status = 'aguardando')
          ${includeClosed ? '' : "AND t.status != 'resolvido' AND t.status != 'encerrado'"}
          AND (
            t.phone IS NOT NULL
            AND t.phone != ''
            AND t.phone NOT LIKE '%@%'
            AND t.phone NOT GLOB '*[^0-9]*'
            AND length(t.phone) BETWEEN 8 AND 25
          )
        GROUP BY t.id
        ORDER BY t.updated_at DESC
        LIMIT ? OFFSET ?
      `).all(sellerId === '0' ? null : sellerId, limit, offset);

      return res.json(tickets);
    } catch (_error) {
      return res.status(500).json({ error: 'Erro ao listar tickets' });
    }
  });

  // Buscar todos os tickets com informações do vendedor (apenas admin)
  router.get('/admin/tickets', requireAdmin, (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
      const includeAll = String(req.query.includeAll || '') === '1';

      const tickets = db.prepare(`
        SELECT t.*,
               s.name as seller_name,
               COALESCE(COUNT(m.id), 0) as unread_count
        FROM tickets t
        LEFT JOIN sellers s ON t.seller_id = s.id
        LEFT JOIN messages m ON m.ticket_id = t.id AND m.sender = 'client'
        ${includeAll ? '' : "WHERE (t.phone IS NOT NULL AND t.phone != '' AND t.phone NOT LIKE '%@%' AND t.phone NOT GLOB '*[^0-9]*' AND length(t.phone) BETWEEN 8 AND 25)"}
        GROUP BY t.id
        ORDER BY t.updated_at DESC
        LIMIT ? OFFSET ?
      `).all(limit, offset);

      return res.json(tickets);
    } catch (_error) {
      return res.status(500).json({ error: 'Erro ao listar tickets' });
    }
  });

  return router;
}

module.exports = {
  createTicketsRouter,
};
