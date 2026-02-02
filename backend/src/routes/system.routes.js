const express = require('express');

function createSystemRouter({ baileys }) {
  const router = express.Router();

  router.get('/connection-status', (_req, res) => {
    const sock = baileys.getSocket();
    res.json({
      connected: sock !== null,
      message: sock ? 'WhatsApp conectado' : 'WhatsApp desconectado',
    });
  });

  return router;
}

module.exports = {
  createSystemRouter,
};
