(function () {
  function normalizeBase(value) {
    if (!value) return '';
    const trimmed = String(value).trim();
    if (!trimmed) return '';
    return trimmed.replace(/\/+$/, '');
  }

  function safeParseUrl(value) {
    try {
      return new URL(value, window.location.origin);
    } catch (_) {
      return null;
    }
  }

  const meta = document.querySelector('meta[name="api-base"]');
  const metaBase = meta ? meta.getAttribute('content') : '';

  const windowBase = window.__API_BASE__ || window.API_BASE || '';
  let storageBase = '';
  try {
    storageBase = localStorage.getItem('API_BASE') || '';
  } catch (_) {}

  const source = metaBase ? 'meta' : (windowBase ? 'window' : (storageBase ? 'storage' : ''));
  let resolved = normalizeBase(metaBase || windowBase || storageBase);
  const hostname = window.location ? window.location.hostname : '';
  const isLocalHost = hostname === 'localhost' || hostname === '127.0.0.1';
  const isPrivateIp = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0)/.test(hostname);
  const localBase = (isLocalHost || isPrivateIp) && window.location
    ? `${window.location.protocol}//${hostname}:3001`
    : '';

  // Evita CORS em ambiente local por conta de API_BASE antigo salvo no navegador.
  // Mantemos override explícito via meta/window, mas descartamos valor "storage"
  // quando ele aponta para outra origem.
  if ((isLocalHost || isPrivateIp) && source === 'storage' && resolved) {
    const parsed = safeParseUrl(resolved);
    const isCrossOrigin = parsed && parsed.origin !== window.location.origin;
    if (!parsed || isCrossOrigin) {
      resolved = '';
      try {
        localStorage.removeItem('API_BASE');
      } catch (_) {}
    }
  }

  if (resolved) {
    window.API_BASE = resolved;
  } else if (isLocalHost || isPrivateIp) {
    window.API_BASE = localBase;
  } else if (window.API_BASE == null) {
    window.API_BASE = '';
  }
})();
