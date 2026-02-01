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
  // Backwards compatibility: many pages use showToast(type: 'success'|'error'|'warning')
  window.showToast = function (message, type = 'success', duration) {
    const mapped = type === 'success' ? 'info' : type;
    showNotification(message, mapped, duration === undefined ? 3500 : duration);
  };
})();
