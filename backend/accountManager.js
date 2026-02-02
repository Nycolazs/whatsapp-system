const fs = require('fs');
const path = require('path');

const accountContext = require('./accountContext');

const ROOT_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const ACCOUNTS_DIR = path.join(DATA_DIR, 'accounts');
const ACTIVE_ACCOUNT_FILE = path.join(DATA_DIR, 'active-account.json');
const STAGING_DIR = path.join(DATA_DIR, 'staging');
const STAGING_AUTH_DIR = path.join(STAGING_DIR, 'wa-auth');

// Legacy locations (v1)
const LEGACY_DB_DIR = path.join(DATA_DIR, 'db');
const LEGACY_DB_PATH = path.join(LEGACY_DB_DIR, 'db.sqlite');
const LEGACY_SESSIONS_PATH = path.join(LEGACY_DB_DIR, 'sessions.db');
const LEGACY_AUTH_DIR_BACKEND = path.join(__dirname, 'auth');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function normalizeAccountNumber(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;

  // Accept already-normalized BR numbers (55 + 10/11 digits)
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
    return digits;
  }

  // If it looks like a local BR number, prefix 55
  if (!digits.startsWith('55') && (digits.length === 10 || digits.length === 11)) {
    return `55${digits}`;
  }

  // Fallback: if it's reasonably long, keep it (avoid hard-breaking other country codes)
  if (digits.length >= 10 && digits.length <= 15) {
    return digits;
  }

  return null;
}

function extractNumberFromBaileysUser(sockUser) {
  const rawId = sockUser?.id || sockUser?.jid || '';
  if (!rawId) return null;
  const beforeAt = String(rawId).split('@')[0];
  const beforeColon = beforeAt.split(':')[0];
  return normalizeAccountNumber(beforeColon);
}

function extractNumberFromCredsDir(authDir) {
  // Baileys multi-file auth state writes creds.json with creds.me.id
  try {
    const credsPath = path.join(authDir, 'creds.json');
    const json = safeReadJson(credsPath);
    const meId = json?.me?.id || json?.creds?.me?.id || null;
    if (!meId) return null;
    const beforeAt = String(meId).split('@')[0];
    const beforeColon = beforeAt.split(':')[0];
    return normalizeAccountNumber(beforeColon);
  } catch (_) {
    return null;
  }
}

function getAccountDir(account) {
  return path.join(ACCOUNTS_DIR, String(account));
}

function getAccountPaths(account) {
  const accountDir = getAccountDir(account);
  const dbDir = path.join(accountDir, 'db');
  const dbPath = path.join(dbDir, 'db.sqlite');
  const sessionsPath = path.join(dbDir, 'sessions.db');
  const authDir = path.join(accountDir, 'wa-auth');
  const backupsDir = path.join(accountDir, 'backups');
  return { accountDir, dbDir, dbPath, sessionsPath, authDir, backupsDir };
}

function ensureAccount(account) {
  ensureDir(ACCOUNTS_DIR);
  const paths = getAccountPaths(account);
  ensureDir(paths.dbDir);
  ensureDir(paths.authDir);
  ensureDir(paths.backupsDir);
  return paths;
}

function getActiveAccountFromFile() {
  const json = safeReadJson(ACTIVE_ACCOUNT_FILE);
  const acc = normalizeAccountNumber(json?.account);
  return acc || null;
}

function persistActiveAccount(account) {
  ensureDir(DATA_DIR);
  fs.writeFileSync(
    ACTIVE_ACCOUNT_FILE,
    JSON.stringify({ account, updatedAt: new Date().toISOString() }, null, 2),
    'utf8'
  );
}

function setActiveAccount(account) {
  const normalized = normalizeAccountNumber(account);
  if (!normalized) return null;
  accountContext.setActiveAccount(normalized);
  persistActiveAccount(normalized);
  return normalized;
}

function listDbSidecars(dbFilePath) {
  return [
    dbFilePath,
    `${dbFilePath}-shm`,
    `${dbFilePath}-wal`,
  ];
}

function copyFileIfExists(src, dest) {
  try {
    if (!fs.existsSync(src)) return false;
    ensureDir(path.dirname(dest));
    fs.copyFileSync(src, dest);
    return true;
  } catch (_) {
    return false;
  }
}

function copyDirRecursive(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return;
  ensureDir(destDir);
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      copyFileIfExists(srcPath, destPath);
    }
  }
}

function tryRenameOrCopyDir(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return false;
  ensureDir(path.dirname(destDir));
  try {
    fs.renameSync(srcDir, destDir);
    return true;
  } catch (_) {
    // Cross-device or permission: copy + remove
    copyDirRecursive(srcDir, destDir);
    try {
      fs.rmSync(srcDir, { recursive: true, force: true });
    } catch (_) {}
    return true;
  }
}

function snapshotAccount(account, reason = 'snapshot') {
  const paths = ensureAccount(account);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(paths.backupsDir, `${stamp}-${String(reason).replace(/[^a-zA-Z0-9_-]/g, '_')}`);
  ensureDir(dir);

  // DB
  for (const p of listDbSidecars(paths.dbPath)) {
    copyFileIfExists(p, path.join(dir, 'db', path.basename(p)));
  }
  for (const p of listDbSidecars(paths.sessionsPath)) {
    copyFileIfExists(p, path.join(dir, 'db', path.basename(p)));
  }

  // Auth
  copyDirRecursive(paths.authDir, path.join(dir, 'wa-auth'));

  return dir;
}

function migrateLegacyToAccount(account) {
  const normalized = normalizeAccountNumber(account);
  if (!normalized) return { migrated: false };

  const paths = ensureAccount(normalized);
  let migrated = false;

  // Move legacy DB into account if account DB doesn't exist
  try {
    if (fs.existsSync(LEGACY_DB_PATH) && !fs.existsSync(paths.dbPath)) {
      ensureDir(paths.dbDir);
      fs.renameSync(LEGACY_DB_PATH, paths.dbPath);
      migrated = true;
    }
  } catch (_) {
    // fallback copy
    if (fs.existsSync(LEGACY_DB_PATH) && !fs.existsSync(paths.dbPath)) {
      copyFileIfExists(LEGACY_DB_PATH, paths.dbPath);
      migrated = true;
    }
  }

  // Move legacy sessions DB
  try {
    if (fs.existsSync(LEGACY_SESSIONS_PATH) && !fs.existsSync(paths.sessionsPath)) {
      ensureDir(paths.dbDir);
      fs.renameSync(LEGACY_SESSIONS_PATH, paths.sessionsPath);
      migrated = true;
    }
  } catch (_) {
    if (fs.existsSync(LEGACY_SESSIONS_PATH) && !fs.existsSync(paths.sessionsPath)) {
      copyFileIfExists(LEGACY_SESSIONS_PATH, paths.sessionsPath);
      migrated = true;
    }
  }

  // Move legacy auth dir
  if (fs.existsSync(LEGACY_AUTH_DIR_BACKEND) && fs.readdirSync(LEGACY_AUTH_DIR_BACKEND).length > 0) {
    if (!fs.existsSync(paths.authDir) || fs.readdirSync(paths.authDir).length === 0) {
      tryRenameOrCopyDir(LEGACY_AUTH_DIR_BACKEND, paths.authDir);
      migrated = true;
    }
  }

  return { migrated, paths };
}

function resolveStartupAccount() {
  // 1) Active account file
  const fromFile = getActiveAccountFromFile();
  if (fromFile) {
    ensureAccount(fromFile);
    accountContext.setActiveAccount(fromFile);
    return fromFile;
  }

  // 2) If legacy auth has a number, prefer it
  const legacyNumber = extractNumberFromCredsDir(LEGACY_AUTH_DIR_BACKEND);
  if (legacyNumber) {
    migrateLegacyToAccount(legacyNumber);
    setActiveAccount(legacyNumber);
    return legacyNumber;
  }

  // 3) If staging auth has a number, prefer it
  const stagingNumber = extractNumberFromCredsDir(STAGING_AUTH_DIR);
  if (stagingNumber) {
    ensureAccount(stagingNumber);
    setActiveAccount(stagingNumber);
    return stagingNumber;
  }

  return null;
}

function getAuthPathForStartup() {
  const active = accountContext.getActiveAccount() || resolveStartupAccount();
  if (active) {
    const paths = ensureAccount(active);
    // If account auth has content, use it; otherwise fallback to staging.
    try {
      if (fs.existsSync(paths.authDir) && fs.readdirSync(paths.authDir).length > 0) {
        return paths.authDir;
      }
    } catch (_) {}
  }

  ensureDir(STAGING_AUTH_DIR);
  return STAGING_AUTH_DIR;
}

function getDbPathForActiveOrDefault() {
  const active = accountContext.getActiveAccount() || resolveStartupAccount();
  if (active) {
    const paths = ensureAccount(active);
    return paths.dbPath;
  }

  // Fallback (keeps old behavior until first successful WhatsApp login)
  ensureDir(LEGACY_DB_DIR);
  return LEGACY_DB_PATH;
}

function getSessionsPathForActiveOrDefault() {
  const active = accountContext.getActiveAccount() || resolveStartupAccount();
  if (active) {
    const paths = ensureAccount(active);
    return paths.sessionsPath;
  }

  ensureDir(LEGACY_DB_DIR);
  return LEGACY_SESSIONS_PATH;
}

function activateAccountFromConnectedWhatsApp(account, authPathUsed) {
  const normalized = normalizeAccountNumber(account);
  if (!normalized) return { ok: false, reason: 'invalid_account' };

  const previous = accountContext.getActiveAccount();
  const paths = ensureAccount(normalized);

  // If we used staging auth, move it into the account folder
  if (authPathUsed && path.resolve(authPathUsed) === path.resolve(STAGING_AUTH_DIR)) {
    // If account already has auth, snapshot before overwriting
    try {
      if (fs.existsSync(paths.authDir) && fs.readdirSync(paths.authDir).length > 0) {
        snapshotAccount(normalized, 'before-auth-overwrite');
        fs.rmSync(paths.authDir, { recursive: true, force: true });
        ensureDir(paths.authDir);
      }
    } catch (_) {}

    tryRenameOrCopyDir(STAGING_AUTH_DIR, paths.authDir);
    ensureDir(STAGING_AUTH_DIR); // recreate for next use
  }

  setActiveAccount(normalized);
  const changed = previous && previous !== normalized;

  return { ok: true, account: normalized, changed, paths };
}

function clearAuthDir(authDir) {
  try {
    if (!authDir) return;
    if (!fs.existsSync(authDir)) return;
    for (const entry of fs.readdirSync(authDir)) {
      const p = path.join(authDir, entry);
      try {
        fs.rmSync(p, { recursive: true, force: true });
      } catch (_) {}
    }
  } catch (_) {}
}

module.exports = {
  normalizeAccountNumber,
  extractNumberFromBaileysUser,
  extractNumberFromCredsDir,
  getAccountPaths,
  ensureAccount,
  snapshotAccount,
  migrateLegacyToAccount,
  resolveStartupAccount,
  getAuthPathForStartup,
  getDbPathForActiveOrDefault,
  getSessionsPathForActiveOrDefault,
  activateAccountFromConnectedWhatsApp,
  clearAuthDir,
  paths: {
    ROOT_DIR,
    DATA_DIR,
    ACCOUNTS_DIR,
    STAGING_AUTH_DIR,
    LEGACY_DB_DIR,
    LEGACY_DB_PATH,
    LEGACY_SESSIONS_PATH,
    LEGACY_AUTH_DIR_BACKEND,
    ACTIVE_ACCOUNT_FILE,
  }
};
