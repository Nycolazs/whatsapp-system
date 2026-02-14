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

  function isElectronRuntime() {
    try {
      const ua = String((navigator && navigator.userAgent) || '');
      return /\bElectron\/\d+/i.test(ua) || window.__ELECTRON_APP__ === true;
    } catch (_) {
      return false;
    }
  }

  function isCapacitorNativeRuntime() {
    try {
      if (!window.Capacitor) return false;
      if (typeof window.Capacitor.isNativePlatform === 'function') {
        return window.Capacitor.isNativePlatform();
      }
      const platform = window.Capacitor.getPlatform ? window.Capacitor.getPlatform() : 'web';
      return platform && platform !== 'web';
    } catch (_) {
      return false;
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
  const protocol = window.location ? window.location.protocol : '';
  const isElectron = isElectronRuntime();
  const isCapacitorNative = isCapacitorNativeRuntime();
  const isFileProtocol = protocol === 'file:';
  const isLocalHost = hostname === 'localhost' || hostname === '127.0.0.1';
  const isPrivateIp = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0)/.test(hostname);
  const localBase = (isLocalHost || isPrivateIp) && window.location
    ? `${window.location.protocol}//${hostname}:3001`
    : '';
  const mobileFallbackBase = normalizeBase(window.__MOBILE_API_BASE__ || '');

  // Mantemos o endpoint salvo pelo usuário em storage sem limpeza automática.
  // Isso evita perda de configuração entre login e páginas internas (Electron/mobile).
  // Se estiver inválido, o usuário pode ajustar pela UI de endpoint no login.

  // Em apps nativos (arquivo local), default para backend local de dev (emulador Android).
  if (!resolved && (isFileProtocol || isCapacitorNative)) {
    resolved = mobileFallbackBase || 'http://10.0.2.2:3001';
  }

  if (resolved) {
    window.API_BASE = resolved;
  } else if ((isLocalHost || isPrivateIp) && !isCapacitorNative) {
    window.API_BASE = localBase;
  } else if (window.API_BASE == null) {
    window.API_BASE = '';
  }
})();
