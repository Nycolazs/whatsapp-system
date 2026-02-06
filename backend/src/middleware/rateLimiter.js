'use strict';

const rateLimit = require('express-rate-limit');

function parseNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function isAssetRequest(req) {
  const p = String(req.path || '');
  if (!p) return false;
  if (p === '/' || p === '/index.html') return true;
  if (p.startsWith('/media/')) return true;
  if (p === '/healthz') return true;

  // Arquivos estáticos comuns (frontend). Evita contar assets no rate limit.
  const lower = p.toLowerCase();
  return (
    lower.endsWith('.html') ||
    lower.endsWith('.htm') ||
    lower.endsWith('.css') ||
    lower.endsWith('.js') ||
    lower.endsWith('.map') ||
    lower.endsWith('.ico') ||
    lower.endsWith('.png') ||
    lower.endsWith('.jpg') ||
    lower.endsWith('.jpeg') ||
    lower.endsWith('.svg') ||
    lower.endsWith('.gif') ||
    lower.endsWith('.webp') ||
    lower.endsWith('.woff') ||
    lower.endsWith('.woff2') ||
    lower.endsWith('.ttf') ||
    lower.endsWith('.eot')
  );
}

function tryCreateRedisStore() {
  const url = process.env.RATE_LIMIT_REDIS_URL || process.env.REDIS_URL;
  if (!url) return null;

  try {
    // Dependências opcionais. Se não estiverem instaladas, volta para memory store.
    // eslint-disable-next-line import/no-extraneous-dependencies
    const { createClient } = require('redis');
    // eslint-disable-next-line import/no-extraneous-dependencies
    const rateLimitRedis = require('rate-limit-redis');
    const RedisStore = rateLimitRedis.RedisStore || rateLimitRedis;

    const client = createClient({ url });
    client.on('error', (err) => {
      // Não derruba a API por erro de Redis.
      try { console.warn('[rateLimit] redis error:', err && err.message ? err.message : err); } catch (_) {}
    });
    client.connect().catch((err) => {
      try { console.warn('[rateLimit] redis connect failed:', err && err.message ? err.message : err); } catch (_) {}
    });

    return new RedisStore({
      sendCommand: (...args) => client.sendCommand(args),
    });
  } catch (err) {
    try {
      console.warn('[rateLimit] Redis store not available (install redis + rate-limit-redis):', err && err.message ? err.message : err);
    } catch (_) {}
    return null;
  }
}

function defaultKeyGenerator(req) {
  // Prefer session identity (when authenticated) to avoid false positives
  // when multiple users share the same IP (proxy/NAT).
  const sessionUserId = req && req.session && req.session.userId;
  if (sessionUserId) return `u:${sessionUserId}`;
  return req.ip;
}

function defaultSkip(req) {
  if (process.env.DISABLE_RATE_LIMIT === '1') return true;
  if (!req) return false;
  if (req.method === 'OPTIONS') return true;
  if (isAssetRequest(req)) return true;
  return false;
}

function buildBaseOptions() {
  const store = tryCreateRedisStore();
  return {
    standardHeaders: true,
    legacyHeaders: false,
    passOnStoreError: true,
    keyGenerator: defaultKeyGenerator,
    skip: defaultSkip,
    ...(store ? { store } : {}),
  };
}

// Rate limiter para criação de recursos (previne spam)
const createResourceLimiter = rateLimit({
  ...buildBaseOptions(),
  windowMs: parseNumber(process.env.CREATE_RATE_WINDOW_MS, 60 * 1000), // 1 min
  max: parseNumber(process.env.CREATE_RATE_MAX_ATTEMPTS, 30),
  message: { error: 'Muitas requisições. Aguarde um momento.' },
});

// Rate limiter geral (menos restritivo)
const generalLimiter = rateLimit({
  ...buildBaseOptions(),
  // Em grande porte, janelas menores evitam "bloqueio longo" após um pico de requisições.
  windowMs: parseNumber(process.env.GENERAL_RATE_WINDOW_MS, 10 * 1000), // 10s
  max: (req) => {
    // Compatibilidade: se GENERAL_RATE_MAX_ATTEMPTS estiver definido, respeita.
    const legacy = process.env.GENERAL_RATE_MAX_ATTEMPTS;
    if (legacy != null && String(legacy).trim() !== '') {
      return parseNumber(legacy, 1000);
    }

    const isAuthed = !!(req && req.session && req.session.userId);
    if (isAuthed) {
      return parseNumber(process.env.AUTH_GENERAL_RATE_MAX_ATTEMPTS, 1000); // por janela
    }
    return parseNumber(process.env.ANON_GENERAL_RATE_MAX_ATTEMPTS, 200); // por janela
  },
  message: { error: 'Muitas requisições. Aguarde um momento.' },
});

module.exports = {
  createResourceLimiter,
  generalLimiter,
};
