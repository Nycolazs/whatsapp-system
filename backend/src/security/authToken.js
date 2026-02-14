const crypto = require('crypto');

function toBase64Url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function fromBase64Url(input) {
  const normalized = String(input).replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4;
  const padded = pad ? normalized + '='.repeat(4 - pad) : normalized;
  return Buffer.from(padded, 'base64');
}

function hmacSha256(content, secret) {
  return crypto.createHmac('sha256', secret).update(content).digest();
}

function safeEqual(a, b) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function createAuthToken(
  { userId, userName, userType },
  { secret, expiresInSeconds = 60 * 60 * 24 * 30 } = {}
) {
  if (!secret) throw new Error('Missing token secret');

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    userId,
    userName,
    userType,
    iat: now,
    exp: now + Math.max(60, Number(expiresInSeconds) || 0),
  };

  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = toBase64Url(JSON.stringify(header));
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = toBase64Url(hmacSha256(signingInput, secret));

  return `${signingInput}.${signature}`;
}

function verifyAuthToken(token, { secret } = {}) {
  if (!token || !secret) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const expectedSig = hmacSha256(signingInput, secret);
  const givenSig = fromBase64Url(encodedSignature);
  if (!safeEqual(expectedSig, givenSig)) return null;

  let payload = null;
  try {
    payload = JSON.parse(fromBase64Url(encodedPayload).toString('utf8'));
  } catch (_) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (!payload || !payload.exp || Number(payload.exp) < now) return null;
  if (!payload.userId || !payload.userType) return null;

  return payload;
}

function extractBearerToken(req) {
  const authHeader = req && req.headers ? req.headers.authorization : null;
  if (!authHeader || typeof authHeader !== 'string') return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  return match[1].trim() || null;
}

module.exports = {
  createAuthToken,
  verifyAuthToken,
  extractBearerToken,
};
