const crypto = require('crypto');
const bcrypt = require('bcrypt');

const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS || 12);

// Detecta se é hash legado SHA-256 (64 chars hex) ou bcrypt (começa com $2)
function isLegacyHash(hash) {
  return hash && hash.length === 64 && /^[a-f0-9]{64}$/i.test(hash);
}

function hashPasswordLegacy(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

function hashPasswordSync(password) {
  return bcrypt.hashSync(password, BCRYPT_ROUNDS);
}

async function verifyPassword(password, hash) {
  if (isLegacyHash(hash)) {
    const legacyHash = hashPasswordLegacy(password);
    return legacyHash === hash;
  }
  return bcrypt.compare(password, hash);
}

function verifyPasswordSync(password, hash) {
  if (isLegacyHash(hash)) {
    const legacyHash = hashPasswordLegacy(password);
    return legacyHash === hash;
  }
  return bcrypt.compareSync(password, hash);
}

module.exports = {
  hashPassword,
  hashPasswordSync,
  verifyPassword,
  verifyPasswordSync,
  isLegacyHash,
  // Mantém legado para compatibilidade temporária
  hashPasswordLegacy,
};
