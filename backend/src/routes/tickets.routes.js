const express = require('express');
const fs = require('fs');

const DEBUG_TICKETS_REPLY = process.env.DEBUG_TICKETS_REPLY === '1';

function createTicketsRouter({
  db,
  requireAuth,
  requireAdmin,
  getSocket,
  uploadAudio,
}) {
  const router = express.Router();

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
      WHERE t.phone LIKE '55%'
        AND t.phone NOT LIKE '%@%'
        AND length(t.phone) BETWEEN 12 AND 13
      GROUP BY t.id
      ORDER BY t.updated_at DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset);

    return res.json(tickets);
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

      query += ' ORDER BY created_at DESC';

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
    const messages = db.prepare(`
      SELECT *
      FROM messages
      WHERE ticket_id = ?
        AND (created_at > ? OR updated_at > ?)
      ORDER BY created_at ASC, id ASC
    `).all(id, timestamp, timestamp);
    return res.json(messages);
  });

  router.post('/tickets/:id/send', requireAuth, async (req, res) => {
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

      const sock = getSocket();
      if (!sock) {
        return res.status(503).json({ error: 'WhatsApp não conectado. Por favor, aguarde a reconexão.' });
      }

      // Envia mensagem via WhatsApp com nome do agente
      const jid = ticket.phone.includes('@') ? ticket.phone : `${ticket.phone}@s.whatsapp.net`;
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

      // Se o ticket estiver em 'aguardando' ou não tiver seller_id e o usuário é vendedor, atribui ao vendedor que respondeu
      if (req.userType === 'seller' && (ticket.status === 'aguardando' || !ticket.seller_id)) {
        db.prepare('UPDATE tickets SET seller_id = ? WHERE id = ?').run(req.userId, id);
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

      const sock = getSocket();
      if (!sock) {
        // Remove arquivo se não conseguir enviar
        fs.unlink(req.file.path, () => {});
        return res.status(503).json({ error: 'WhatsApp não conectado. Por favor, aguarde a reconexão.' });
      }

      // Envia áudio via WhatsApp
      const jid = ticket.phone.includes('@') ? ticket.phone : `${ticket.phone}@s.whatsapp.net`;
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

      // Se o ticket estiver em 'aguardando' ou não tiver seller_id e o usuário é vendedor, atribui ao vendedor que respondeu
      if (req.userType === 'seller' && (ticket.status === 'aguardando' || !ticket.seller_id)) {
        db.prepare('UPDATE tickets SET seller_id = ? WHERE id = ?').run(req.userId, id);
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

  router.patch('/tickets/:id/status', requireAuth, async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    if (!['pendente', 'aguardando', 'em_atendimento', 'resolvido'].includes(status)) {
      return res.status(400).json({ error: 'Status inválido' });
    }

    try {
      const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
      if (!ticket) {
        return res.status(404).json({ error: 'Ticket não encontrado' });
      }

      if (status === 'pendente' && ticket.status !== 'pendente') {
        return res.status(400).json({ error: 'Não é permitido voltar para pendente' });
      }

      if (status === 'resolvido') {
        try {
          const sock = getSocket();
          if (sock) {
            const jid = ticket.phone.includes('@') ? ticket.phone : `${ticket.phone}@s.whatsapp.net`;
            await sock.sendMessage(jid, {
              text: '✅ Seu atendimento foi encerrado. Obrigado por entrar em contato! Se precisar de ajuda novamente, é só enviar uma mensagem.',
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

      return res.json({ success: true, message: 'Status atualizado' });
    } catch (_error) {
      return res.status(500).json({ error: 'Erro ao atualizar status' });
    }
  });

  // Atribuir/transferir ticket a um vendedor (admin ou vendedor)
  router.post('/tickets/:id/assign', requireAuth, (req, res) => {
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

    try {
      const tickets = db.prepare(`
        SELECT t.*,
               s.name as seller_name,
               COALESCE(COUNT(m.id), 0) as unread_count
        FROM tickets t
        LEFT JOIN sellers s ON t.seller_id = s.id
        LEFT JOIN messages m ON m.ticket_id = t.id AND m.sender = 'client'
        WHERE (t.seller_id = ? OR t.seller_id IS NULL OR t.status = 'aguardando')
          AND t.status != 'resolvido'
          AND t.phone LIKE '55%'
          AND t.phone NOT LIKE '%@%'
          AND length(t.phone) BETWEEN 12 AND 13
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

      const tickets = db.prepare(`
        SELECT t.*,
               s.name as seller_name,
               COALESCE(COUNT(m.id), 0) as unread_count
        FROM tickets t
        LEFT JOIN sellers s ON t.seller_id = s.id
        LEFT JOIN messages m ON m.ticket_id = t.id AND m.sender = 'client'
        WHERE t.phone LIKE '55%'
          AND t.phone NOT LIKE '%@%'
          AND length(t.phone) BETWEEN 12 AND 13
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
