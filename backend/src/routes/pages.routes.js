const express = require('express');
const path = require('path');

function createPagesRouter({ frontendDir, getQrState }) {
  const router = express.Router();

  if (!frontendDir) {
    throw new Error('createPagesRouter: frontendDir is required');
  }

  // Rotas amigáveis para as telas (sem /frontend/...)
  router.get('/', (req, res) => {
    return res.sendFile(path.join(frontendDir, 'index.html'));
  });

  router.get('/login', (req, res) => {
    return res.sendFile(path.join(frontendDir, 'index.html'));
  });

  router.get('/agent', (req, res) => res.sendFile(path.join(frontendDir, 'agent.html')));

  router.get('/admin-sellers', (req, res) => res.sendFile(path.join(frontendDir, 'admin-sellers.html')));

  router.get('/whatsapp-qr', (req, res) => res.sendFile(path.join(frontendDir, 'whatsapp-qr.html')));

  router.get('/setup-admin', (req, res) => {
    const qrState = typeof getQrState === 'function' ? getQrState() : null;
    if (!qrState?.connected) {
      return res.redirect('/whatsapp-qr');
    }
    return res.sendFile(path.join(frontendDir, 'setup-admin.html'));
  });

  return router;
}

module.exports = {
  createPagesRouter,
};
