(function () {
  function normalizeBase(value) {
    if (!value) return '';
    const trimmed = String(value).trim();
    if (!trimmed) return '';
    return trimmed.replace(/\/+$/, '');
  }

  const meta = document.querySelector('meta[name="api-base"]');
  const metaBase = meta ? meta.getAttribute('content') : '';

  const windowBase = window.__API_BASE__ || window.API_BASE || '';
  let storageBase = '';
  try {
    storageBase = localStorage.getItem('API_BASE') || '';
  } catch (_) {}

  const resolved = normalizeBase(metaBase || windowBase || storageBase);
  const hostname = window.location ? window.location.hostname : '';
  const isLocalHost = hostname === 'localhost' || hostname === '127.0.0.1';
  const isPrivateIp = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0)/.test(hostname);
  const localBase = (isLocalHost || isPrivateIp) && window.location
    ? `${window.location.protocol}//${hostname}:3001`
    : '';

  if (resolved) {
    window.API_BASE = resolved;
  } else if (isLocalHost || isPrivateIp) {
    window.API_BASE = localBase;
  } else if (window.API_BASE == null) {
    window.API_BASE = '';
  }
})();
