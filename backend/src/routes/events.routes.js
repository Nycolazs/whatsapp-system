'use strict';

const express = require('express');
const events = require('../server/events');

function createEventsRouter({ requireAuth }) {
  const router = express.Router();

  router.get('/events', requireAuth, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    try { res.flushHeaders(); } catch (_) {}

    // Envia evento inicial
    res.write('retry: 2000\n');
    res.write('event: ready\n');
    res.write(`data: ${JSON.stringify({ ts: Date.now() })}\n\n`);

    const send = (eventName, payload) => {
      try {
        res.write(`event: ${eventName}\n`);
        res.write(`data: ${JSON.stringify(payload || {})}\n\n`);
        if (typeof res.flush === 'function') res.flush();
      } catch (_) {}
    };

    const onMessage = (payload) => send('message', payload);
    const onTicket = (payload) => send('ticket', payload);

    events.on('message', onMessage);
    events.on('ticket', onTicket);

    const pingInterval = setInterval(() => {
      try {
        res.write('event: ping\n');
        res.write('data: {}\n\n');
        if (typeof res.flush === 'function') res.flush();
      } catch (_) {}
    }, 25000);

    req.on('close', () => {
      clearInterval(pingInterval);
      events.off('message', onMessage);
      events.off('ticket', onTicket);
      try { res.end(); } catch (_) {}
    });
  });

  return router;
}

module.exports = {
  createEventsRouter,
};
