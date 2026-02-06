// Shared UI helpers: page transitions and toast notifications
(function () {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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

      const res = await fetch(url, opts);
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

  function navigateTo(url) {
    document.body.classList.remove('enter');
    document.body.classList.add('leave');
    setTimeout(() => { window.location.href = url; }, 300);
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

  // Expose globally
  window.showNotification = showNotification;
  window.navigateTo = navigateTo;
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
