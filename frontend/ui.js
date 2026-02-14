// Shared UI helpers: page transitions and toast notifications
(function () {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const AUTH_TOKEN_KEY = 'AUTH_TOKEN';

  function setAppHeight() {
    const height = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    document.documentElement.style.setProperty('--app-height', `${height}px`);
  }

  setAppHeight();
  window.addEventListener('resize', setAppHeight);
  window.addEventListener('orientationchange', setAppHeight);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', setAppHeight);
    window.visualViewport.addEventListener('scroll', setAppHeight);
  }

  function resolveApiUrl(input) {
    if (!input || typeof input !== 'string') return input;
    const base = (window.API_BASE || '').trim();
    if (!base) return input;
    if (/^https?:\/\//i.test(input)) return input;
    if (input.startsWith('/')) return `${base}${input}`;
    return `${base}/${input}`;
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

  function toAbsoluteUrl(input) {
    try {
      if (typeof input === 'string') return new URL(input, window.location.origin);
      if (input instanceof URL) return input;
      if (typeof Request !== 'undefined' && input instanceof Request) {
        return new URL(input.url, window.location.origin);
      }
    } catch (_) {}
    return null;
  }

  function installElectronApiProxyFetch() {
    if (!isElectronRuntime()) return;
    if (!window.fetch || typeof window.fetch !== 'function') return;
    if (window.__API_PROXY_FETCH_INSTALLED__) return;

    const originalFetch = window.fetch.bind(window);
    window.__API_PROXY_FETCH_INSTALLED__ = true;

    window.fetch = function proxiedFetch(input, init) {
      try {
        const baseRaw = String(window.API_BASE || '').trim().replace(/\/+$/, '');
        if (!baseRaw || !/^https?:\/\//i.test(baseRaw)) {
          return originalFetch(input, init);
        }

        const absolute = toAbsoluteUrl(input);
        if (!absolute) return originalFetch(input, init);

        const targetBase = new URL(baseRaw);
        if (absolute.origin !== targetBase.origin) {
          return originalFetch(input, init);
        }

        const proxyPath = `/__api${absolute.pathname}${absolute.search || ''}`;
        const headers = new Headers((init && init.headers) || (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined));
        headers.set('x-api-base', `${targetBase.protocol}//${targetBase.host}`);

        if (typeof Request !== 'undefined' && input instanceof Request) {
          const requestInit = { ...init, headers };
          const proxiedRequest = new Request(proxyPath, input);
          return originalFetch(proxiedRequest, requestInit);
        }

        return originalFetch(proxyPath, { ...init, headers });
      } catch (_) {
        return originalFetch(input, init);
      }
    };
  }

  installElectronApiProxyFetch();

  function getStoredAuthToken() {
    try {
      return String(localStorage.getItem(AUTH_TOKEN_KEY) || '').trim();
    } catch (_) {
      return '';
    }
  }

  function storeAuthToken(token) {
    const normalized = String(token || '').trim();
    try {
      if (normalized) localStorage.setItem(AUTH_TOKEN_KEY, normalized);
      else localStorage.removeItem(AUTH_TOKEN_KEY);
    } catch (_) {}
  }

  function toFetchInputUrl(input) {
    try {
      if (typeof input === 'string') return input;
      if (typeof Request !== 'undefined' && input instanceof Request) return input.url;
      return String(input || '');
    } catch (_) {
      return '';
    }
  }

  function installAuthTokenFetch() {
    if (!window.fetch || typeof window.fetch !== 'function') return;
    if (window.__AUTH_TOKEN_FETCH_INSTALLED__) return;

    const originalFetch = window.fetch.bind(window);
    window.__AUTH_TOKEN_FETCH_INSTALLED__ = true;

    window.fetch = function authTokenFetch(input, init = {}) {
      const token = getStoredAuthToken();
      if (!token) return originalFetch(input, init);

      const rawInputUrl = toFetchInputUrl(input);
      const isRelative = rawInputUrl.startsWith('/') || rawInputUrl.startsWith('./') || rawInputUrl.startsWith('../');
      const isApiAbsolute = /^https?:\/\//i.test(rawInputUrl);
      if (!isRelative && !isApiAbsolute) return originalFetch(input, init);

      try {
        const headers = new Headers((init && init.headers) || (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined));
        if (!headers.has('Authorization')) {
          headers.set('Authorization', `Bearer ${token}`);
        }

        if (typeof Request !== 'undefined' && input instanceof Request) {
          const req = new Request(input, { ...init, headers });
          return originalFetch(req);
        }

        return originalFetch(input, { ...init, headers });
      } catch (_) {
        return originalFetch(input, init);
      }
    };
  }

  installAuthTokenFetch();

  // Global fetch wrapper for large-scale usage:
  // - backs off on 429
  // - shares cooldown across the tab
  // - adds jitter to avoid thundering herds
  let _cooldownUntilMs = 0;

  function parseRateLimitWaitMs(res) {
    try {
      // Standard-ish headers. express-rate-limit adds RateLimit-*.
      const retryAfter = res.headers.get('retry-after');
      if (retryAfter) {
        const seconds = Number(retryAfter);
        if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000);
      }

      const reset = res.headers.get('ratelimit-reset');
      if (reset) {
        const resetNum = Number(reset);
        if (Number.isFinite(resetNum) && resetNum > 0) {
          // Some servers send unix timestamp (seconds)
          const nowS = Math.floor(Date.now() / 1000);
          const deltaS = resetNum > nowS ? (resetNum - nowS) : resetNum;
          if (deltaS > 0) return Math.ceil(deltaS * 1000);
        }
      }
    } catch (_) {}

    // Fallback: short wait.
    return 1200;
  }

  window.smartFetch = async function smartFetch(url, options = {}) {
    const opts = { ...options };
    const method = String(opts.method || 'GET').toUpperCase();
    const maxRetries = typeof opts.maxRetries === 'number' ? opts.maxRetries : (method === 'GET' ? 1 : 0);
    delete opts.maxRetries;

    let attempt = 0;

    while (true) {
      const now = Date.now();
      if (now < _cooldownUntilMs) {
        await sleep(_cooldownUntilMs - now);
      }

      const res = await fetch(resolveApiUrl(url), opts);
      if (res.status !== 429) return res;

      const baseWait = parseRateLimitWaitMs(res);
      const jitter = Math.floor(Math.random() * 350);
      const waitMs = Math.min(baseWait + jitter, 15000);
      _cooldownUntilMs = Math.max(_cooldownUntilMs, Date.now() + waitMs);

      if (attempt >= maxRetries) return res;
      attempt += 1;
      await sleep(waitMs);
    }
  };

  window.smartJson = async function smartJson(url, options = {}) {
    const res = await window.smartFetch(url, options);
    if (!res.ok) {
      let text = '';
      try { text = await res.text(); } catch (_) {}
      const err = new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 180)}` : ''}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  };

  function ensureToastContainer() {
    let c = document.querySelector('.toast-container');
    if (!c) {
      c = document.createElement('div');
      c.className = 'toast-container';
      document.body.appendChild(c);
    }
    return c;
  }

  function showNotification(message, type = 'info', duration = 3500) {
    const container = ensureToastContainer();
    const t = document.createElement('div');
    t.className = `toast ${type} hide`;
    t.setAttribute('role', 'status');
    t.setAttribute('aria-live', 'polite');
    t.innerHTML = `<div class="msg"></div><button class="close-btn" aria-label="Fechar">✕</button>`;
    t.querySelector('.msg').textContent = message;

    const close = () => {
      if (!t.parentElement) return;
      t.classList.add('hide');
      setTimeout(() => t.remove(), 320);
    };

    t.querySelector('.close-btn').addEventListener('click', close);
    container.appendChild(t);

    // trigger entrance (ensure animation runs even when added after paint)
    requestAnimationFrame(() => requestAnimationFrame(() => t.classList.remove('hide')));

    if (duration > 0) {
      setTimeout(close, duration);
    }
  }

  function resolveAppUrl(url) {
    if (!url || typeof url !== 'string') return url;
    if (/^https?:\/\//i.test(url) || url.startsWith('ws://') || url.startsWith('wss://')) return url;

    const hashIndex = url.indexOf('#');
    const rawWithoutHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
    const hash = hashIndex >= 0 ? url.slice(hashIndex) : '';
    const queryIndex = rawWithoutHash.indexOf('?');
    const pathOnly = queryIndex >= 0 ? rawWithoutHash.slice(0, queryIndex) : rawWithoutHash;
    const query = queryIndex >= 0 ? rawWithoutHash.slice(queryIndex) : '';

    if (!pathOnly.startsWith('/')) return url;

    const isNativeApp = isCapacitorNativeRuntime();
    // Em apps nativos (Capacitor), converte rotas limpas para arquivos HTML
    // independentemente do esquema (file:// ou http://localhost).
    if (isNativeApp || (window.location && window.location.protocol === 'file:')) {
      const cleanToFileMap = {
        '/': '/index.html',
        '/login': '/index.html',
        '/agent': '/agent.html',
        '/admin-sellers': '/admin-sellers.html',
        '/whatsapp-qr': '/whatsapp-qr.html',
        '/setup-admin': '/setup-admin.html',
      };

      const localFilePath = cleanToFileMap[pathOnly] || pathOnly;
      return `${localFilePath.replace(/^\//, '')}${query}${hash}`;
    }

    const routeMap = {
      '/index.html': '/',
      '/agent.html': '/agent',
      '/admin-sellers.html': '/admin-sellers',
      '/whatsapp-qr.html': '/whatsapp-qr',
      '/setup-admin.html': '/setup-admin',
    };

    const mapped = routeMap[pathOnly];
    if (!mapped) return url;
    return `${mapped}${query}${hash}`;
  }

  function navigateTo(url) {
    const target = resolveAppUrl(url);
    document.body.classList.remove('enter');
    document.body.classList.add('leave');
    setTimeout(() => { window.location.href = target; }, 300);
  }

  // Initialize page transition (run immediately if DOMContentLoaded already fired)
  function initPageTransition() {
    if (!document.body) return;
    if (!document.body.classList.contains('page')) document.body.classList.add('page');
    requestAnimationFrame(() => document.body.classList.add('enter'));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPageTransition);
  } else {
    initPageTransition();
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      if (isElectronRuntime()) {
        navigator.serviceWorker.getRegistrations()
          .then((regs) => Promise.all(regs.map((reg) => reg.unregister())))
          .catch(() => {});
        if (window.caches && typeof window.caches.keys === 'function') {
          window.caches.keys()
            .then((keys) => Promise.all(keys.map((key) => window.caches.delete(key))))
            .catch(() => {});
        }
        return;
      }

      navigator.serviceWorker.register('/sw.js').catch((err) => {
        console.debug('Service worker registration failed', err);
      });
    });
  }

  let deferredInstallPrompt = null;
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    window.dispatchEvent(new CustomEvent('pwa-install-available'));
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    window.dispatchEvent(new CustomEvent('pwa-installed'));
  });

  // Expose globally
  window.showNotification = showNotification;
  window.resolveAppUrl = resolveAppUrl;
  window.navigateTo = navigateTo;
  window.getAuthToken = getStoredAuthToken;
  window.setAuthToken = storeAuthToken;
  window.clearAuthToken = function clearAuthToken() {
    storeAuthToken('');
  };
  window.canInstallPwa = function canInstallPwa() {
    return !!deferredInstallPrompt;
  };
  window.promptInstallPwa = async function promptInstallPwa() {
    if (!deferredInstallPrompt) return false;
    deferredInstallPrompt.prompt();
    const choice = await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    return choice && choice.outcome === 'accepted';
  };
  window.ensureConnected = async function ensureConnected() {
    async function fetchQrState() {
      return window.smartJson('/whatsapp/qr', { cache: 'no-store', maxRetries: 1 });
    }

    // Avoid redirect flapping: allow a short grace period for reconnection.
    // Only redirect when backend indicates QR is needed (qrDataUrl present or connectionState === 'qr').
    const startedAt = Date.now();
    const maxWaitMs = 4500;
    const pollEveryMs = 650;

    let lastState = null;

    while ((Date.now() - startedAt) < maxWaitMs) {
      try {
        const qrData = await fetchQrState();
        lastState = qrData;

        const isConnected = !!qrData.connected;
        const isStable = !!qrData.stableConnected;
        const needsQr = !!qrData.qrDataUrl || qrData.connectionState === 'qr';

        if (isConnected || isStable) {
          const adminData = await window.smartJson('/auth/has-admin', { cache: 'no-store', maxRetries: 1 });
          if (!adminData.hasAdmin) {
            if (typeof navigateTo === 'function') navigateTo('/setup-admin'); else window.location.href = '/setup-admin';
            return false;
          }
          return true;
        }

        if (needsQr) {
          if (typeof navigateTo === 'function') navigateTo('/whatsapp-qr'); else window.location.href = '/whatsapp-qr';
          return false;
        }

        // Otherwise: reconnecting/starting; wait a bit and retry.
        await sleep(pollEveryMs);
      } catch (e) {
        // Transient backend hiccups: retry during grace period.
        await sleep(pollEveryMs);
      }
    }

    // After grace period, decide based on last known state.
    const needsQr = !!lastState?.qrDataUrl || lastState?.connectionState === 'qr';
    if (needsQr) {
      if (typeof navigateTo === 'function') navigateTo('/whatsapp-qr'); else window.location.href = '/whatsapp-qr';
      return false;
    }

    // Still not sure; keep the user on the page and show a friendly hint.
    showNotification('Reconectando ao WhatsApp... aguarde alguns segundos.', 'warning', 3500);
    return false;
  };
  // Backwards compatibility: many pages use showToast(type: 'success'|'error'|'warning')
  window.showToast = function (message, type = 'success', duration) {
    const mapped = type === 'success' ? 'info' : type;
    showNotification(message, mapped, duration === undefined ? 3500 : duration);
  };
})();
