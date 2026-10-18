/* Notifications are fetched per opening, never cached on the device or inferred from demo payments. */
(() => {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  function renderNotifications(records) {
    if (!records.length) return '<div class="notifications-empty"><svg class="icon" aria-hidden="true"><use href="#i-bell"/></svg><h3>No notifications yet</h3><p>There are no saved notifications available for your account.</p></div>';
    const dateValue = item => Date.parse(item.createdAt) || 0;
    return '<ol class="notifications-list">' + [...records].sort((a, b) => dateValue(b) - dateValue(a)).map(item => {
      const date = new Date(item.createdAt);
      const validDate = Number.isFinite(date.getTime());
      const status = item.readAt ? 'Read' : item.read === true ? 'Read' : item.read === false || item.readAt === null ? 'Unread' : '';
      return `<li class="notification-item"><h3>${escape(item.title || 'Notification')}</h3>${item.message ? `<p>${escape(item.message)}</p>` : ''}<div class="notification-meta">${validDate ? `<time datetime="${date.toISOString()}">${escape(date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))}</time>` : ''}${status ? `<span class="notification-status${status === 'Unread' ? ' is-unread' : ''}">${status}</span>` : ''}</div></li>`;
    }).join('') + '</ol>';
  }
  window.StemmaNotifications = { renderNotifications };
  const bell = document.getElementById('profile-notifications-button');
  const dialog = document.getElementById('notifications-dialog');
  const content = document.getElementById('notifications-content');
  let request = null;
  async function load() {
    request?.abort();
    const current = new AbortController();
    request = current;
    content.setAttribute('aria-busy', 'true');
    content.innerHTML = '<p class="notifications-notice" role="status">Loading your notifications…</p>';
    try {
      const response = await fetch('/api/notifications', { credentials: 'same-origin', cache: 'no-store', signal: current.signal });
      if (!response.ok) throw Object.assign(new Error('Notification request failed.'), { status: response.status });
      const data = await response.json();
      if (!Array.isArray(data.notifications)) throw new Error('Invalid notification response.');
      if (request !== current || !dialog.open) return;
      content.innerHTML = renderNotifications(data.notifications);
    } catch (error) {
      if (error.name === 'AbortError' || request !== current || !dialog.open) return;
      content.innerHTML = error.status === 401 || error.status === 403
        ? '<p class="notifications-notice" role="status">Sign in with your student account to view your notifications.</p>'
        : '<div class="notifications-notice" role="status"><p>Your notifications could not be loaded. Please try again.</p><button type="button" class="notifications-retry">Try again</button></div>';
    } finally {
      if (request === current) content.setAttribute('aria-busy', 'false');
    }
  }
  bell.addEventListener('click', () => {
    if (dialog.open) return;
    dialog.showModal();
    bell.setAttribute('aria-expanded', 'true');
    void load();
  });
  document.getElementById('notifications-close').addEventListener('click', () => dialog.close());
  content.addEventListener('click', event => { if (event.target.closest('.notifications-retry')) void load(); });
  dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } });
  dialog.addEventListener('close', () => {
    request?.abort();
    request = null;
    content.replaceChildren();
    content.setAttribute('aria-busy', 'false');
    bell.setAttribute('aria-expanded', 'false');
  });
  window.addEventListener('hashchange', () => { if (dialog.open) dialog.close(); });
})();
