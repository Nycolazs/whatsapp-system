// Shared UI helpers: page transitions and toast notifications
(function () {
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
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    async function fetchQrState() {
      const res = await fetch('/whatsapp/qr', { cache: 'no-store' });
      return res.json();
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
          const adminResponse = await fetch('/auth/has-admin', { cache: 'no-store' });
          const adminData = await adminResponse.json();
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
