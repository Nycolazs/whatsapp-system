const express = require('express');
const qrcode = require('qrcode');

function createWhatsAppRouter({ baileys, db, requireAdmin }) {
  const router = express.Router();

  router.get('/whatsapp/qr', async (_req, res) => {
    try {
      const qrState = baileys.getQrState();

      if (qrState.connected) {
        return res.json({
          connected: true,
          stableConnected: !!qrState.stableConnected,
          connectionState: qrState.connectionState,
          qrAt: qrState.qrAt,
          lastConnectedAt: qrState.lastConnectedAt,
          lastDisconnectedAt: qrState.lastDisconnectedAt,
          lastDisconnectCode: qrState.lastDisconnectCode,
          lastDisconnectReason: qrState.lastDisconnectReason,
          qrDataUrl: null,
        });
      }

      if (!qrState.qr) {
        return res.json({
          connected: false,
          stableConnected: !!qrState.stableConnected,
          connectionState: qrState.connectionState,
          qrAt: qrState.qrAt,
          lastConnectedAt: qrState.lastConnectedAt,
          lastDisconnectedAt: qrState.lastDisconnectedAt,
          lastDisconnectCode: qrState.lastDisconnectCode,
          lastDisconnectReason: qrState.lastDisconnectReason,
          qrDataUrl: null,
        });
      }

      const qrDataUrl = await qrcode.toDataURL(qrState.qr, { margin: 2, scale: 6 });
      return res.json({
        connected: false,
        stableConnected: !!qrState.stableConnected,
        connectionState: qrState.connectionState,
        qrAt: qrState.qrAt,
        lastConnectedAt: qrState.lastConnectedAt,
        lastDisconnectedAt: qrState.lastDisconnectedAt,
        lastDisconnectCode: qrState.lastDisconnectCode,
        lastDisconnectReason: qrState.lastDisconnectReason,
        qrDataUrl,
      });
    } catch (_error) {
      return res.status(500).json({
        connected: false,
        stableConnected: false,
        connectionState: 'error',
        qrAt: null,
        lastConnectedAt: null,
        lastDisconnectedAt: null,
        lastDisconnectCode: 'error',
        lastDisconnectReason: 'backend_error',
        qrDataUrl: null,
      });
    }
  });

  router.post('/whatsapp/qr/refresh', async (_req, res) => {
    try {
      const result = await baileys.forceNewQr();
      if (!result.ok) {
        return res.status(409).json({ error: 'WhatsApp já está conectado' });
      }
      return res.json({ success: true });
    } catch (_error) {
      return res.status(500).json({ error: 'Erro ao atualizar QR' });
    }
  });

  router.post('/whatsapp/logout', requireAdmin, async (_req, res) => {
    try {
      await baileys.forceNewQr(true);
      db.clearAllData();
      return res.json({ success: true });
    } catch (_error) {
      return res.status(500).json({ error: 'Erro ao desconectar WhatsApp' });
    }
  });

  return router;
}

module.exports = {
  createWhatsAppRouter,
};
