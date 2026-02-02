const express = require('express');

function createHealthRouter({ getQrState, accountContext, db, getSessionsPath }) {
  const router = express.Router();

  router.get('/healthz', (req, res) => {
    return res.json({
      ok: true,
      uptime_s: Math.round(process.uptime()),
      rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      node: process.version,
      whatsapp: getQrState()?.connectionState || null,
      account: (accountContext.getActiveAccount && accountContext.getActiveAccount()) || null,
      dbPath: (db.getPath && db.getPath()) || null,
      sessionsPath: (typeof getSessionsPath === 'function' ? getSessionsPath() : null) || null,
    });
  });

  return router;
}

module.exports = {
  createHealthRouter,
};
