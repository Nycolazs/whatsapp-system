'use strict';

const LEVELS = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  trace: 5,
};

function resolveLevel(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized && Object.prototype.hasOwnProperty.call(LEVELS, normalized)) return normalized;
  return 'info';
}

function shouldLog(currentLevel, messageLevel) {
  return LEVELS[messageLevel] <= LEVELS[currentLevel];
}

function formatLine(level, name, message) {
  const prefix = name ? `[${level.toUpperCase()}] [${name}]` : `[${level.toUpperCase()}]`;
  return message ? `${prefix} ${message}` : prefix;
}

function coerceExtras(extras) {
  if (!extras || extras.length === 0) return [];
  return extras.map(item => {
    if (item instanceof Error) {
      return { message: item.message, stack: item.stack, name: item.name };
    }
    return item;
  });
}

function createLogger(name, opts = {}) {
  const level = resolveLevel(opts.level || process.env.LOG_LEVEL);

  function log(messageLevel, message, ...extras) {
    if (!shouldLog(level, messageLevel)) return;

    const line = formatLine(messageLevel, name, message);
    const payload = coerceExtras(extras);

    if (messageLevel === 'error') {
      if (payload.length) console.error(line, ...payload);
      else console.error(line);
      return;
    }

    if (messageLevel === 'warn') {
      if (payload.length) console.warn(line, ...payload);
      else console.warn(line);
      return;
    }

    if (payload.length) console.log(line, ...payload);
    else console.log(line);
  }

  return {
    level,
    error: (message, ...extras) => log('error', message, ...extras),
    warn: (message, ...extras) => log('warn', message, ...extras),
    info: (message, ...extras) => log('info', message, ...extras),
    debug: (message, ...extras) => log('debug', message, ...extras),
    trace: (message, ...extras) => log('trace', message, ...extras),
  };
}

module.exports = {
  createLogger,
};
