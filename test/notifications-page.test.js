import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const source = await readFile(new URL('../notifications-ui.js', import.meta.url), 'utf8');
const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');

function createHarness(customRecords) {
  const elements = new Map();
  const windowListeners = new Map();
  const hashStack = [{ hash: '#payment', state: null }];
  const window = {
    location: { hash: '#payment' },
    history: {
      state: null,
      pushState(state, _title, url) {
        const hash = new URL(url, 'https://stemma.test').hash;
        hashStack.push({ hash, state });
        this.state = state;
        window.location.hash = hash;
      },
      replaceState(state, _title, url) {
        const hash = new URL(url, 'https://stemma.test').hash;
        hashStack[hashStack.length - 1] = { hash, state };
        this.state = state;
        window.location.hash = hash;
      },
      back() {
        if (hashStack.length > 1) hashStack.pop();
        const current = hashStack.at(-1);
        this.state = current.state;
        window.location.hash = current.hash;
        for (const name of ['popstate', 'hashchange']) {
          for (const callback of windowListeners.get(name) || []) callback({ type: name });
        }
      }
    },
    addEventListener(name, callback) {
      const callbacks = windowListeners.get(name) || [];
      callbacks.push(callback);
      windowListeners.set(name, callbacks);
    }
  };
  class Element {
    constructor(id) {
      this.id = id;
      this.hidden = false;
      this.open = false;
      this.dataset = id === 'breadcrumb-current' ? { route: 'payment' } : {};
      this.attributes = new Map();
      this.listeners = new Map();
      this.classes = new Set();
      this.classList = {
        contains: name => this.classes.has(name),
        add: name => this.classes.add(name),
        toggle: (name, force) => {
          const enabled = force === undefined ? !this.classes.has(name) : Boolean(force);
          if (enabled) this.classes.add(name); else this.classes.delete(name);
          return enabled;
        }
      };
      this.focusCalls = [];
      this.scrollTop = 0;
      this.textContent = '';
      this.innerHTML = '';
    }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    replaceChildren() { this.innerHTML = ''; this.textContent = ''; }
    focus(options) { this.focusCalls.push(options); }
    showModal() { this.open = true; }
    close() {
      if (!this.open) return;
      this.open = false;
      this.listeners.get('close')?.({ target: this });
    }
    click(target = this) { this.listeners.get('click')?.({ target }); }
  }
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new Element(id));
      return elements.get(id);
    }
  };
  const records = customRecords || [
    { id: 'older', title: 'Older update', message: 'An earlier update', createdAt: '2025-02-01T10:00:00Z', readAt: null },
    { id: 'newer', title: 'Latest update', message: 'Details <and> more', createdAt: '2026-03-02T11:30:00Z', readAt: null }
  ];
  const requests = [];
  const fetch = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/read')) return { ok: true, json: async () => ({ readIds: JSON.parse(options.body).ids, readAt: '2026-10-19T01:00:00Z' }) };
    return { ok: true, json: async () => ({ notifications: records }) };
  };
  vm.runInNewContext(source, { window, document, fetch, AbortController });
  return { document, window, requests };
}

test('notifications are a separate hidden main with a focused back control and a tall detail dialog', () => {
  assert.match(html, /<main[^>]*id="app-main"/);
  assert.match(html, /<main[^>]*id="notifications-page"[^>]*hidden[\s\S]*?<button[^>]*id="notifications-back"/);
  assert.match(html, /<h1 id="notifications-title">Notifications<\/h1>/);
  assert.match(html, /<section[^>]*id="notifications-content"/);
  assert.match(html, /<dialog[^>]*id="notification-detail-dialog"[^>]*aria-labelledby="notification-detail-title"/);
  assert.match(html, /<h2 id="notification-detail-title"><\/h2>/);
  assert.match(html, /id="notification-detail-content"/);
  assert.match(html, /id="notification-detail-close"[^>]*aria-label="Close notification details"/);
  assert.match(source, /window\.StemmaNotifications\s*=\s*\{[^}]*renderNotifications[^}]*renderNotificationDetail[^}]*syncRoute[^}]*leave/);
});

test('main app leaves notifications before navigation, syncs after rendering, and preserves the notifications hash during auth restore', () => {
  const render = appSource.match(/function render\(\) \{([\s\S]*?)\n\}/)?.[1];
  const navigate = appSource.match(/function navigate\(route\) \{([\s\S]*?)\n\}/)?.[1];
  const restore = appSource.match(/function restoreNavigationLocation\(accountKey\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(render && navigate && restore);
  assert.match(render, /window\.StemmaNotifications\?\.syncRoute\(\);/);
  assert.ok(navigate.indexOf('window.StemmaNotifications?.leave();') < navigate.indexOf('cancelPendingNavigationRestoration();'));
  assert.match(restore, /window\.location\.hash !== '#notifications'/);
});

test('bell opens the page, sorted rows open the correct detail, and back restores the underlying route', async () => {
  const { document, window, requests } = createHarness();
  const bell = document.getElementById('profile-notifications-button');
  const main = document.getElementById('app-main');
  const page = document.getElementById('notifications-page');
  const content = document.getElementById('notifications-content');

  bell.click();
  assert.equal(window.location.hash, '#notifications');
  assert.equal(main.hidden, true);
  assert.equal(page.hidden, false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/notifications');
  assert.equal(requests[0].options.cache, 'no-store');
  assert.match(content.innerHTML, /data-notification-index="0"/);
  assert.ok(content.innerHTML.indexOf('Latest update') < content.innerHTML.indexOf('Older update'));

  const row = { dataset: { notificationIndex: '0' } };
  content.click({ closest: selector => selector === '.notifications-retry' ? null : selector === '[data-notification-index]' ? row : null });
  const dialog = document.getElementById('notification-detail-dialog');
  assert.equal(dialog.open, true);
  assert.equal(document.getElementById('notification-detail-title').textContent, 'Latest update');
  assert.match(document.getElementById('notification-detail-content').innerHTML, /Details &lt;and&gt; more/);

  document.getElementById('notification-detail-close').click();
  assert.equal(dialog.open, false);
  assert.equal(document.getElementById('notification-detail-title').textContent, '');
  document.getElementById('notifications-back').click();
  assert.equal(window.location.hash, '#payment');
  assert.equal(main.hidden, false);
  assert.equal(page.hidden, true);
  assert.equal(content.innerHTML, '');
  assert.equal(bell.focusCalls.at(-1).preventScroll, true);
});

test('unread dots clear after read acknowledgement, and bulk selection does not open details', async () => {
  const { document, requests } = createHarness();
  document.getElementById('profile-notifications-button').click();
  await new Promise(resolve => setImmediate(resolve));
  const content = document.getElementById('notifications-content');
  assert.equal((content.innerHTML.match(/notification-unread-dot/g) || []).length, 2);
  document.getElementById('notifications-select').click();
  assert.equal(document.getElementById('notifications-selection-tools').hidden, false);
  const row = { dataset: { notificationIndex: '0' } };
  content.click({ closest: selector => selector === '[data-notification-index]' ? row : null });
  assert.equal(document.getElementById('notifications-selection-count').textContent, '1 selected');
  assert.equal(document.getElementById('notification-detail-dialog').open, false);
  document.getElementById('notifications-select-all').click();
  assert.equal(document.getElementById('notifications-selection-count').textContent, '2 selected');
  document.getElementById('notifications-mark-read').click();
  await new Promise(resolve => setImmediate(resolve));
  const mutation = requests.find(item => item.url.endsWith('/read'));
  assert.equal(mutation.options.method, 'POST');
  assert.deepEqual(JSON.parse(mutation.options.body).ids.sort(), ['newer', 'older']);
  assert.doesNotMatch(content.innerHTML, /notification-unread-dot/);
  assert.match(content.innerHTML, /notification-status">Read/);
  assert.equal(document.getElementById('notifications-feedback').textContent, 'Selected notifications marked as read.');
  document.getElementById('notifications-select').click();
  assert.equal(document.getElementById('notifications-selection-tools').hidden, true);
});

test('system titles are identical in feed and detail without changing personal titles or record content', async () => {
  const message = 'Original notification message with all of its words and details unchanged.';
  for (const item of [
    { type: 'system', title: 'Welcome to Stemma', senderAvatarUrl: 'https://example.com/photo.jpg' },
    { type: 'system', title: '' },
    { type: 'personal', title: 'A personal invitation', senderAvatarUrl: '/assets/stemma-brand.svg' },
    { type: 'user', title: '<b>User title</b>', senderAvatarUrl: 'https://example.com/photo.jpg' },
    { title: 'Legacy title' },
    { type: 'personal', title: '' }
  ]) {
    const record = { id: 'notice', message, createdAt: '2026-10-19T10:00:00Z', readAt: '2026-10-19T11:00:00Z', ...item };
    const before = JSON.stringify(record);
    const { document, requests } = createHarness([record]);
    document.getElementById('profile-notifications-button').click();
    await new Promise(resolve => setImmediate(resolve));
    const content = document.getElementById('notifications-content');
    const title = item.type === 'system' ? 'System Notification' : item.title || 'Notification';
    const escapedTitle = title.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    assert.ok(content.innerHTML.includes(`<span class="notification-title">${escapedTitle}</span>`));
    assert.match(content.innerHTML, /Original notification message with all of…/);
    assert.match(content.innerHTML, /href="#i-bell"/);
    assert.equal(/<img\b/.test(content.innerHTML), item.type !== 'system' && Boolean(item.senderAvatarUrl));
    const row = { dataset: { notificationIndex: '0' } };
    content.click({ closest: selector => selector === '[data-notification-index]' ? row : null });
    assert.equal(document.getElementById('notification-detail-title').textContent, title);
    assert.ok(document.getElementById('notification-detail-content').innerHTML.includes(message));
    assert.equal(requests.length, 1, 'opening an already-read record does not write read state');
    assert.equal(JSON.stringify(record), before, 'rendering does not rewrite stored notification content');
  }
});
