const path = require('path');
const fs = require('fs');

const session = require('express-session');
const SqliteStoreFactory = require('better-sqlite3-session-store');
const Database = require('better-sqlite3');

function configureSessionPragmas(client) {
  try {
    client.pragma('journal_mode = WAL');
    client.pragma(`synchronous = ${process.env.SQLITE_SYNCHRONOUS || 'NORMAL'}`);
    client.pragma(`busy_timeout = ${Number(process.env.SQLITE_BUSY_TIMEOUT_MS || 5000)}`);
    client.pragma(`wal_autocheckpoint = ${Number(process.env.SQLITE_WAL_AUTOCHECKPOINT || 1000)}`);
  } catch (_) {}
}

function openSessionDb(filePath) {
  const dir = path.dirname(filePath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {}
  const client = new Database(filePath);
  configureSessionPragmas(client);
  return client;
}

function makeSqliteSessionStore(client) {
  const SqliteStore = SqliteStoreFactory(session);
  return new SqliteStore({
    client,
    expired: {
      clear: true,
      intervalMs: 900000, // 15 minutos
    },
  });
}

class DynamicSessionStore extends session.Store {
  constructor() {
    super();
    this._inner = null;
  }

  setInner(store) {
    this._inner = store;
  }

  _call(method, args) {
    const s = this._inner;
    if (!s || typeof s[method] !== 'function') {
      const cb = args && args.length ? args[args.length - 1] : null;
      if (typeof cb === 'function') cb(new Error('Session store not ready'));
      return;
    }
    return s[method](...args);
  }

  get(sid, cb) {
    return this._call('get', [sid, cb]);
  }

  set(sid, sess, cb) {
    return this._call('set', [sid, sess, cb]);
  }

  destroy(sid, cb) {
    return this._call('destroy', [sid, cb]);
  }

  touch(sid, sess, cb) {
    return this._call('touch', [sid, sess, cb]);
  }

  all(cb) {
    return this._call('all', [cb]);
  }

  length(cb) {
    return this._call('length', [cb]);
  }

  clear(cb) {
    return this._call('clear', [cb]);
  }
}

function createSessionMiddleware({
  accountContext,
  accountManager,
  secret,
  cookie,
}) {
  if (!accountManager) {
    throw new Error('createSessionMiddleware: accountManager is required');
  }

  const dynamicStore = new DynamicSessionStore();

  let sessionDb = null;
  let currentSessionDbPath = null;

  function ensureSessionStoreForActiveAccount() {
    const desired = accountManager.getSessionsPathForActiveOrDefault();
    if (sessionDb && currentSessionDbPath === desired) return;

    const oldDb = sessionDb;
    sessionDb = openSessionDb(desired);
    currentSessionDbPath = desired;
    dynamicStore.setInner(makeSqliteSessionStore(sessionDb));
    try {
      if (oldDb) oldDb.close();
    } catch (_) {}
  }

  ensureSessionStoreForActiveAccount();
  try {
    accountContext && accountContext.emitter && accountContext.emitter.on('changed', () => {
      ensureSessionStoreForActiveAccount();
    });
  } catch (_) {}

  const middleware = session({
    store: dynamicStore,
    secret,
    resave: false,
    saveUninitialized: false,
    cookie,
  });

  return {
    middleware,
    getCurrentSessionDbPath: () => currentSessionDbPath,
    close: () => {
      try {
        if (sessionDb) sessionDb.close();
      } catch (_) {}
    },
  };
}

module.exports = {
  createSessionMiddleware,
};
