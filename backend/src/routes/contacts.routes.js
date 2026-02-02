const express = require('express');

// Cache simples de foto de perfil (reduz chamadas ao WhatsApp em listas grandes)
const profilePicCache = new Map(); // phone -> { url, expiresAt }
const profilePicInFlight = new Map(); // phone -> Promise<{url}>
let activeProfilePicFetches = 0;
const MAX_PROFILE_PIC_FETCHES = Number(process.env.MAX_PROFILE_PIC_FETCHES || 3);
const PROFILE_PIC_TTL_MS = Number(process.env.PROFILE_PIC_TTL_MS || 6 * 60 * 60 * 1000); // 6h

async function withProfilePicConcurrencyLimit(fn) {
  while (activeProfilePicFetches >= MAX_PROFILE_PIC_FETCHES) {
    await new Promise(r => setTimeout(r, 50));
  }
  activeProfilePicFetches++;
  try {
    return await fn();
  } finally {
    activeProfilePicFetches--;
  }
}

function createContactsRouter({ getSocket }) {
  const router = express.Router();

  // Endpoint para obter foto de perfil
  router.get('/profile-picture/:phone', async (req, res) => {
    const { phone } = req.params;

    const sock = getSocket();
    if (!sock) {
      return res.json({ url: null, fromCache: false });
    }

    const key = String(phone || '').trim();
    const now = Date.now();
    let createdJob = false;

    try {
      const cached = profilePicCache.get(key);
      if (cached && cached.expiresAt && cached.expiresAt > now) {
        if (cached.url) {
          return res.json({ url: cached.url, fromCache: true });
        }
        // Foto nula cacheada: tenta atualizar (cai no fluxo abaixo)
      }

      const existing = profilePicInFlight.get(key);
      if (existing) {
        const result = await existing;
        return res.json({ url: result.url || null, fromCache: false });
      }

      const job = (async () => {
        const jid = key.includes('@') ? key : `${key}@s.whatsapp.net`;
        try {
          const url = await withProfilePicConcurrencyLimit(() => sock.profilePictureUrl(jid, 'image'));
          if (url) {
            profilePicCache.set(key, { url, expiresAt: now + PROFILE_PIC_TTL_MS });
            return { url, success: true };
          }
          // Não cacheia nulo por muito tempo (5 min)
          profilePicCache.set(key, { url: null, expiresAt: now + (5 * 60 * 1000) });
          return { url: null, success: false };
        } catch (_e) {
          profilePicCache.set(key, { url: null, expiresAt: now + (5 * 60 * 1000) });
          return { url: null, success: false };
        }
      })();

      profilePicInFlight.set(key, job);
      createdJob = true;
      const result = await job;
      return res.json({ url: result.url || null, fromCache: false });
    } finally {
      if (createdJob) {
        profilePicInFlight.delete(key);
      }
    }
  });

  // Endpoint para obter nome do contato
  router.get('/contact-name/:phone', async (req, res) => {
    const { phone } = req.params;

    const sock = getSocket();
    if (!sock) {
      return res.json({ name: null });
    }

    try {
      const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;

      const contact = await sock.onWhatsApp(jid);
      if (contact && contact[0]) {
        // Mantém chamada por compatibilidade com o comportamento anterior
        await sock.getBusinessProfile(jid).catch(() => null);

        if (sock.store && sock.store.contacts && sock.store.contacts[jid]) {
          const name = sock.store.contacts[jid].name || sock.store.contacts[jid].notify;
          if (name) {
            return res.json({ name });
          }
        }

        if (contact[0].notify) {
          return res.json({ name: contact[0].notify });
        }
      }

      return res.json({ name: null });
    } catch (_error) {
      return res.json({ name: null });
    }
  });

  return router;
}

module.exports = {
  createContactsRouter,
};
