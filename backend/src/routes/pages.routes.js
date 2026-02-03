const express = require('express');
const path = require('path');

function createPagesRouter({ frontendDir, getQrState }) {
  const router = express.Router();

  if (!frontendDir) {
    throw new Error('createPagesRouter: frontendDir is required');
  }

  // Middleware para desabilitar cache nas páginas HTML
  const noCacheMiddleware = (req, res, next) => {
    res.set({
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    next();
  };

  // Rotas amigáveis para as telas (sem /frontend/...)
  router.get('/', noCacheMiddleware, (req, res) => {
    // Se já está logado, redireciona para a página apropriada
    if (req.session && req.session.userId) {
      const userRole = req.session.userRole || 'agent';
      if (userRole === 'admin') {
        return res.redirect('/admin-sellers');
      }
      return res.redirect('/agent');
    }
    return res.sendFile(path.join(frontendDir, 'index.html'));
  });

  router.get('/login', noCacheMiddleware, (req, res) => {
    // Se já está logado, redireciona para a página apropriada
    if (req.session && req.session.userId) {
      const userRole = req.session.userRole || 'agent';
      if (userRole === 'admin') {
        return res.redirect('/admin-sellers');
      }
      return res.redirect('/agent');
    }
    return res.sendFile(path.join(frontendDir, 'index.html'));
  });

  router.get('/agent', noCacheMiddleware, (req, res) => res.sendFile(path.join(frontendDir, 'agent.html')));

  router.get('/admin-sellers', noCacheMiddleware, (req, res) => res.sendFile(path.join(frontendDir, 'admin-sellers.html')));

  router.get('/whatsapp-qr', noCacheMiddleware, (req, res) => res.sendFile(path.join(frontendDir, 'whatsapp-qr.html')));

  router.get('/setup-admin', noCacheMiddleware, (req, res) => {
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
