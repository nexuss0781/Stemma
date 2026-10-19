/* Account notifications are fetched per visit; never cached or inferred from demo payments. */
(() => {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const sortRecords = records => [...records].sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
  const isUnread = item => !item.readAt && item.read !== true && (item.readAt === null || item.read === false);
  const notificationTitle = item => item.type === 'system' ? 'System Notification' : item.title || 'Notification';
  function renderMeta(item, compact = false) {
    const date = new Date(item.createdAt);
    const validDate = Number.isFinite(date.getTime());
    const status = item.readAt || item.read === true ? 'Read' : isUnread(item) ? 'Unread' : '';
    return `<span class="notification-meta">${validDate ? `<time datetime="${date.toISOString()}"${compact ? ` title="${escape(date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))}"` : ''}>${escape(date.toLocaleString(undefined, compact ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' } : { dateStyle: 'medium', timeStyle: 'short' }))}</time>` : ''}${status ? `<span class="notification-status${status === 'Unread' ? ' is-unread' : ''}">${status}</span>` : ''}</span>`;
  }
  function previewMessage(message) {
    const text = String(message ?? '').replace(/\s+/g, ' ').trim();
    const preview = text.split(' ').slice(0, 6).join(' ').slice(0, 48).trimEnd();
    return preview.length < text.length ? preview.slice(0, 47).trimEnd() + '…' : preview;
  }
  function groupLabel(item, today, yesterday) {
    if (isUnread(item)) return 'New';
    const date = new Date(item.createdAt);
    if (!Number.isFinite(date.getTime())) return 'Earlier';
    if (date.toDateString() === today.toDateString()) return 'Today';
    if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function renderAvatar(item) {
    // Sender photos are optional metadata, never inferred from the recipient's profile.
    const photo = item.type !== 'system' && typeof item.senderAvatarUrl === 'string'
      && /^(https:\/\/|\/(?!\/))[^\s<>"'\\]+$/i.test(item.senderAvatarUrl) ? item.senderAvatarUrl : '';
    return `<span class="notification-avatar" aria-hidden="true"><svg class="icon"><use href="#i-bell"/></svg>${photo ? `<img src="${escape(photo)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />` : ''}</span>`;
  }
  function renderNotifications(records, selection = null) {
    if (!records.length) return '<div class="notifications-empty"><svg class="icon" aria-hidden="true"><use href="#i-bell"/></svg><h2>No notifications yet</h2><p>There are no saved notifications available for your account.</p></div>';
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    const groups = new Map();
    sortRecords(records).forEach((item, index) => {
      const label = groupLabel(item, today, yesterday);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push({ item, index });
    });
    // Unread first; indices still address the original date-sorted detail records.
    const labels = [...groups.keys()].sort((a, b) => a === 'New' ? -1 : b === 'New' ? 1 : 0);
    return labels.map((label, groupIndex) => `<section class="notification-group" aria-labelledby="notification-group-${groupIndex}"><h2 class="notification-group-title" id="notification-group-${groupIndex}">${escape(label)}</h2><ol class="notifications-list">${groups.get(label).map(({ item, index }) => `<li class="notification-item"><button type="button" class="notification-open${selection?.has(String(item.id)) ? ' is-selected' : ''}" data-notification-index="${index}" ${selection ? `aria-pressed="${selection.has(String(item.id))}"` : 'aria-haspopup="dialog" aria-controls="notification-detail-dialog"'}>${selection ? `<span class="notification-checkbox" aria-hidden="true">${selection.has(String(item.id)) ? '✓' : ''}</span>` : renderAvatar(item)}<span class="notification-summary"><span class="notification-title">${escape(notificationTitle(item))}</span>${item.message ? `<span class="notification-preview">${escape(previewMessage(item.message))}</span>` : ''}${renderMeta(item, true)}</span>${isUnread(item) ? '<span class="notification-unread-dot" aria-label="Unread"></span>' : ''}</button></li>`).join('')}</ol></section>`).join('');
  }
  function renderNotificationDetail(item) {
    return `${renderMeta(item)}${item.message ? `<p class="notification-full-message">${escape(item.message)}</p>` : '<p class="notification-full-message">No additional details were provided.</p>'}`;
  }
  const bell = document.getElementById('profile-notifications-button');
  const page = document.getElementById('notifications-page');
  const main = document.getElementById('app-main');
  const content = document.getElementById('notifications-content');
  const back = document.getElementById('notifications-back');
  const dialog = document.getElementById('notification-detail-dialog');
  const detailTitle = document.getElementById('notification-detail-title');
  const detailContent = document.getElementById('notification-detail-content');
  const crumb = document.getElementById('breadcrumb-current');
  const selectToggle = document.getElementById('notifications-select');
  const selectionTools = document.getElementById('notifications-selection-tools');
  const selectionCount = document.getElementById('notifications-selection-count');
  const selectAll = document.getElementById('notifications-select-all');
  const markRead = document.getElementById('notifications-mark-read');
  const feedback = document.getElementById('notifications-feedback');
  let request = null;
  let records = [];
  let active = false;
  let returnHash = '#profile';
  let returnFocus = null;
  let savedCrumb = null;
  let selectionMode = false;
  const selected = new Set();
  const pendingRead = new Set();
  let detailIndex = null;
  let pressTimer = null;
  let press = null;
  let suppressedClick = null;
  let generation = 0;
  let underlyingScroll = 0;
  const isRoute = () => window.location.hash === '#notifications';
  const routeHash = () => `#${crumb.dataset.route || 'profile'}`;
  function updateTools() {
    selectToggle.hidden = records.length === 0;
    selectToggle.textContent = selectionMode ? 'Cancel' : 'Select';
    selectToggle.setAttribute('aria-pressed', String(selectionMode));
    selectionTools.hidden = !selectionMode;
    selectionCount.textContent = selectionMode ? `${selected.size} selected` : '';
    markRead.disabled = !selected.size || pendingRead.size > 0;
  }
  function renderList(focusIndex) {
    const scroll = content.scrollTop;
    content.innerHTML = renderNotifications(records, selectionMode ? selected : null);
    content.scrollTop = scroll;
    updateTools();
    if (focusIndex !== undefined) content.querySelector?.(`[data-notification-index="${focusIndex}"]`)?.focus({ preventScroll: true });
  }
  function resetSelection() { selectionMode = false; selected.clear(); updateTools(); }
  function toggleSelection(index, forceSelect = false) {
    const item = records[index];
    if (!item) return;
    selectionMode = true;
    const id = String(item.id);
    if (!forceSelect && selected.has(id)) selected.delete(id); else selected.add(id);
    renderList(index);
  }
  async function markIdsRead(ids) {
    ids = ids.filter(id => !pendingRead.has(id));
    if (!ids.length) return;
    const currentGeneration = generation;
    const signal = request?.signal;
    ids.forEach(id => pendingRead.add(id));
    feedback.textContent = '';
    updateTools();
    try {
      for (let start = 0; start < ids.length; start += 5000) {
        const response = await fetch('/api/notifications/read', { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ids.slice(start, start + 5000) }) });
        if (!response.ok) throw new Error('Read update failed.');
        const data = await response.json();
        if (!Array.isArray(data.readIds) || !data.readAt) throw new Error('Invalid read update.');
        if (!active || currentGeneration !== generation) return;
        const confirmed = new Set(data.readIds.map(String));
        records = records.map(item => confirmed.has(String(item.id)) ? { ...item, read: true, readAt: item.readAt || data.readAt } : item);
        renderList();
        if (dialog.open && detailIndex !== null) detailContent.innerHTML = renderNotificationDetail(records[detailIndex]);
      }
      feedback.textContent = ids.length > 1 ? 'Selected notifications marked as read.' : 'Notification marked as read.';
    } catch (error) {
      if (error.name !== 'AbortError' && active && currentGeneration === generation) feedback.textContent = 'Could not save the read status. Please try the Read action again.';
    } finally {
      if (currentGeneration === generation) { ids.forEach(id => pendingRead.delete(id)); updateTools(); }
    }
  }
  async function load() {
    request?.abort();
    generation += 1;
    const current = new AbortController();
    request = current;
    records = [];
    pendingRead.clear();
    resetSelection();
    feedback.textContent = '';
    content.setAttribute('aria-busy', 'true');
    content.innerHTML = '<p class="notifications-notice" role="status">Loading your notifications…</p>';
    try {
      const response = await fetch('/api/notifications', { credentials: 'same-origin', cache: 'no-store', signal: current.signal });
      if (!response.ok) throw Object.assign(new Error('Notification request failed.'), { status: response.status });
      const data = await response.json();
      if (!Array.isArray(data.notifications)) throw new Error('Invalid notification response.');
      if (request !== current || !active || !isRoute()) return;
      records = sortRecords(data.notifications.filter(item => item && typeof item === 'object'));
      renderList();
    } catch (error) {
      if (error.name === 'AbortError' || request !== current || !active || !isRoute()) return;
      content.innerHTML = error.status === 401 || error.status === 403
        ? '<p class="notifications-notice" role="status">Sign in with your student account to view your notifications.</p>'
        : '<div class="notifications-notice" role="status"><p>Your notifications could not be loaded. Please try again.</p><button type="button" class="notifications-retry">Try again</button></div>';
    } finally {
      if (request === current) content.setAttribute('aria-busy', 'false');
    }
  }
  function cancelPress() { if (pressTimer !== null) window.clearTimeout(pressTimer); pressTimer = null; press = null; }
  function hidePage() {
    if (!active) return;
    active = false;
    generation += 1;
    cancelPress();
    suppressedClick = null;
    request?.abort();
    request = null;
    records = [];
    pendingRead.clear();
    resetSelection();
    if (dialog.open) dialog.close();
    feedback.textContent = '';
    content.replaceChildren();
    content.setAttribute('aria-busy', 'false');
    page.hidden = true;
    main.hidden = false;
    document.getElementById('dashboard-grid').scrollTop = underlyingScroll;
    if (savedCrumb) {
      crumb.textContent = savedCrumb.text;
      crumb.classList.toggle('is-label', savedCrumb.label);
      crumb.setAttribute('aria-hidden', savedCrumb.hidden);
    }
    returnFocus?.focus({ preventScroll: true });
  }
  function syncRoute() {
    if (!isRoute()) { hidePage(); return; }
    if (!active) underlyingScroll = document.getElementById('dashboard-grid').scrollTop;
    main.hidden = true;
    page.hidden = false;
    if (crumb.textContent !== 'Notifications') savedCrumb = { text: crumb.textContent, label: crumb.classList.contains('is-label'), hidden: crumb.getAttribute('aria-hidden') || 'false' };
    if (!window.history.state?.stemmaNotificationsReturn) returnHash = routeHash();
    if (!active) {
      returnHash = window.history.state?.stemmaNotificationsReturn || routeHash();
      active = true;
      content.scrollTop = 0;
      back.focus({ preventScroll: true });
      void load();
    }
    crumb.textContent = 'Notifications';
    crumb.classList.add('is-label');
    crumb.setAttribute('aria-hidden', 'false');
  }
  function leave() {
    if (!isRoute()) return;
    window.history.replaceState({}, '', returnHash);
    hidePage();
  }
  window.StemmaNotifications = { renderNotifications, renderNotificationDetail, syncRoute, leave,
    underlyingScrollTop: () => active ? underlyingScroll : null,
    setUnderlyingScrollTop: value => { if (active) underlyingScroll = value; }
  };
  bell.addEventListener('click', () => {
    if (isRoute()) return;
    returnFocus = bell;
    returnHash = window.location.hash || routeHash();
    window.history.pushState({ stemmaNotificationsReturn: returnHash, stemmaNotificationsEntry: true }, '', '#notifications');
    syncRoute();
  });
  back.addEventListener('click', () => {
    if (window.history.state?.stemmaNotificationsEntry) window.history.back(); else leave();
  });
  selectToggle.addEventListener('click', () => { selectionMode = !selectionMode; selected.clear(); renderList(); });
  selectAll.addEventListener('click', () => { records.forEach(item => selected.add(String(item.id))); renderList(); });
  markRead.addEventListener('click', () => { void markIdsRead([...selected]); });
  content.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    const button = event.target.closest('[data-notification-index]');
    if (!button) return;
    suppressedClick = null;
    cancelPress();
    press = { index: Number(button.dataset.notificationIndex), x: event.clientX, y: event.clientY };
    pressTimer = window.setTimeout(() => {
      const index = press.index;
      suppressedClick = { index, until: Date.now() + 1200 };
      cancelPress();
      toggleSelection(index, true);
    }, 550);
  });
  content.addEventListener('pointermove', event => { if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 10) cancelPress(); });
  for (const event of ['pointerup', 'pointercancel', 'pointerleave', 'scroll']) content.addEventListener(event, cancelPress);
  content.addEventListener('contextmenu', event => {
    const button = event.target.closest('[data-notification-index]');
    if (!button) return;
    event.preventDefault();
    cancelPress();
    const index = Number(button.dataset.notificationIndex);
    suppressedClick = { index, until: Date.now() + 1200 };
    toggleSelection(index, true);
  });
  content.addEventListener('keydown', event => {
    const button = event.target.closest('[data-notification-index]');
    if (button && event.shiftKey && (event.key === ' ' || event.key === 'Enter')) { event.preventDefault(); toggleSelection(Number(button.dataset.notificationIndex)); }
    if (event.key === 'Escape' && selectionMode && !dialog.open) { event.preventDefault(); resetSelection(); renderList(); selectToggle.focus(); }
  });
  content.addEventListener('error', event => {
    if (event.target.matches?.('.notification-avatar img')) event.target.hidden = true;
  }, true);
  content.addEventListener('click', event => {
    if (event.target.closest('.notifications-retry')) { void load(); return; }
    const button = event.target.closest('[data-notification-index]');
    if (!button || !active) return;
    const index = Number(button.dataset.notificationIndex);
    if (suppressedClick?.index === index && Date.now() < suppressedClick.until) { suppressedClick = null; return; }
    suppressedClick = null;
    if (selectionMode) { toggleSelection(index); return; }
    const item = records[index];
    if (!item || dialog.open) return;
    detailIndex = index;
    detailTitle.textContent = notificationTitle(item);
    detailContent.innerHTML = renderNotificationDetail(item);
    detailContent.scrollTop = 0;
    dialog.showModal();
    if (isUnread(item)) void markIdsRead([String(item.id)]);
  });
  document.getElementById('notification-detail-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
  dialog.addEventListener('close', () => {
    detailTitle.textContent = '';
    detailContent.replaceChildren();
    if (active && detailIndex !== null) content.querySelector?.(`[data-notification-index="${detailIndex}"]`)?.focus({ preventScroll: true });
    detailIndex = null;
  });
  window.addEventListener('popstate', syncRoute);
  window.addEventListener('hashchange', syncRoute);
  window.addEventListener('pageshow', event => { if (event.persisted && active) { if (dialog.open) dialog.close(); void load(); } });
  updateTools();
  syncRoute();
})();
