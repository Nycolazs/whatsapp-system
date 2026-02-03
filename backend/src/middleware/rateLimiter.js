'use strict';

const rateLimit = require('express-rate-limit');

// Rate limiter para criação de recursos (previne spam)
const createResourceLimiter = rateLimit({
  windowMs: Number(process.env.CREATE_RATE_WINDOW_MS || 60 * 1000), // 1 min
  max: Number(process.env.CREATE_RATE_MAX_ATTEMPTS || 10),
  message: { error: 'Muitas requisições. Aguarde um momento.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiter geral (menos restritivo)
const generalLimiter = rateLimit({
  windowMs: Number(process.env.GENERAL_RATE_WINDOW_MS || 60 * 1000), // 1 min
  max: Number(process.env.GENERAL_RATE_MAX_ATTEMPTS || 100),
  message: { error: 'Muitas requisições. Aguarde um momento.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.DISABLE_RATE_LIMIT === '1',
});

module.exports = {
  createResourceLimiter,
  generalLimiter,
};
