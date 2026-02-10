'use strict';

const { WebSocketServer } = require('ws');
const { URL } = require('url');
const events = require('./events');

function makeDummyResponse() {
  const headers = new Map();
  return {
    getHeader: (name) => headers.get(String(name).toLowerCase()),
    setHeader: (name, value) => headers.set(String(name).toLowerCase(), value),
    removeHeader: (name) => headers.delete(String(name).toLowerCase()),
  };
}

function attachRealtimeWebSocket({ server, sessionMiddleware, allowedOrigins, path = '/ws' }) {
  if (!server) return null;

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    try {
      const origin = req.headers.origin;
      if (Array.isArray(allowedOrigins) && allowedOrigins.length > 0 && origin && !allowedOrigins.includes(origin)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }

      const requestUrl = new URL(req.url, 'http://localhost');
      if (requestUrl.pathname !== path) return;

      const res = makeDummyResponse();
      sessionMiddleware(req, res, () => {
        if (!req.session || !req.session.userId) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req);
        });
      });
    } catch (_) {
      try {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      } catch (_) {}
      socket.destroy();
    }
  });

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'ready', data: { ts: Date.now() } }));

    const onMessage = (payload) => {
      try {
        ws.send(JSON.stringify({ type: 'message', data: payload || {} }));
      } catch (_) {}
    };
    const onTicket = (payload) => {
      try {
        ws.send(JSON.stringify({ type: 'ticket', data: payload || {} }));
      } catch (_) {}
    };

    events.on('message', onMessage);
    events.on('ticket', onTicket);

    ws.on('close', () => {
      events.off('message', onMessage);
      events.off('ticket', onTicket);
    });
  });

  return wss;
}

module.exports = {
  attachRealtimeWebSocket,
};
