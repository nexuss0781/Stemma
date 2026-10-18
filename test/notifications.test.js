import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import signature from 'cookie-signature';
import session from 'express-session';
import { buildConfig, createApp } from '../server.js';

const SESSION_SECRET = 'notifications-tests-have-a-long-session-secret-value';
const notificationsSource = readFileSync(new URL('../notifications-ui.js', import.meta.url), 'utf8');

async function createHarness() {
  const config = buildConfig({ NODE_ENV: 'test', SESSION_SECRET });
  const sessionStore = new session.MemoryStore();
  const app = createApp({ config, sessionStore });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;

  async function cookieFor(id, stemmaUser) {
    const data = {
      cookie: { originalMaxAge: null, expires: null, httpOnly: true, path: '/', sameSite: 'lax', secure: false },
      ...(stemmaUser ? { stemmaUser } : {})
    };
    await new Promise((resolve, reject) => sessionStore.set(id, data, error => error ? reject(error) : resolve()));
    return `stemma.sid=${encodeURIComponent(`s:${signature.sign(id, SESSION_SECRET)}`)}`;
  }

  return {
    origin,
    server,
    async close() {
      server.close();
      await once(server, 'close');
    },
    cookieFor
  };
}

function loadRenderer() {
  const listeners = new Map();
  const makeElement = () => ({
    open: false,
    addEventListener(name, callback) { listeners.set(name, callback); },
    setAttribute() {},
    replaceChildren() {},
    showModal() { this.open = true; },
    close() { this.open = false; },
    getBoundingClientRect() { return { left: 0, right: 10, top: 0, bottom: 10 }; }
  });
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement());
      return elements.get(id);
    }
  };
  const window = { addEventListener() {}, location: { hash: '#profile' } };
  vm.runInNewContext(notificationsSource, { window, document, fetch: async () => { throw new Error('Unexpected fetch'); }, AbortController });
  return window.StemmaNotifications.renderNotifications;
}

test('notifications API requires a Google session, returns an honest empty result, and cannot switch subjects via query', async t => {
  const h = await createHarness();
  t.after(() => h.close());
  const googleA = await h.cookieFor('google-a', { provider: 'google', subject: 'google-subject-A' });
  const googleB = await h.cookieFor('google-b', { provider: 'google', subject: 'google-subject-B' });
  const fayda = await h.cookieFor('fayda', { provider: 'fayda', subject: 'fayda-subject' });
  const endpoint = `${h.origin}/api/notifications`;

  const guest = await fetch(endpoint);
  assert.equal(guest.status, 401);
  assert.deepEqual(await guest.json(), { error: 'Authentication required.' });

  const nonGoogle = await fetch(endpoint, { headers: { cookie: fayda } });
  assert.equal(nonGoogle.status, 403);
  assert.deepEqual(await nonGoogle.json(), { error: 'This request could not be verified.' });

  for (const cookie of [googleA, googleB]) {
    const response = await fetch(endpoint, { headers: { cookie } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { notifications: [], sourceAvailable: false });
    const cacheControl = response.headers.get('cache-control') || '';
    assert.match(cacheControl, /\bprivate\b/i);
    assert.match(cacheControl, /\bno-store\b/i);
  }

  for (const [cookie, subject] of [[googleA, 'google-subject-B'], [googleB, 'google-subject-A'], [googleA, 'fayda-subject']]) {
    const response = await fetch(`${endpoint}?subject=${encodeURIComponent(subject)}`, { headers: { cookie } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { notifications: [], sourceAvailable: false });
  }
});

test('notifications UI script is served as a public asset', async t => {
  const h = await createHarness();
  t.after(() => h.close());
  const response = await fetch(`${h.origin}/notifications-ui.js`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /javascript/i);
  assert.match(response.headers.get('cache-control') || '', /public/i);
  assert.equal(await response.text(), notificationsSource);
});

test('notification renderer displays every record newest first without mutating input', () => {
  const renderNotifications = loadRenderer();
  const records = [
    { id: 'old', title: 'Old notice', message: 'Earlier', createdAt: '2025-01-01T10:00:00Z' },
    { id: 'new', title: 'New notice', message: 'Latest', createdAt: '2026-04-03T12:30:00Z' },
    { id: 'undated', title: 'No date', message: 'Still displayed' }
  ];
  const original = structuredClone(records);
  const html = renderNotifications(records);
  const newest = html.indexOf('New notice');
  const older = html.indexOf('Old notice');
  const undated = html.indexOf('No date');
  assert.notEqual(newest, -1);
  assert.notEqual(older, -1);
  assert.notEqual(undated, -1);
  assert.ok(newest < older && older < undated, 'records should be sorted newest first, with undated records retained');
  assert.deepEqual(records, original);
});

test('notification renderer escapes title and message HTML', () => {
  const renderNotifications = loadRenderer();
  const html = renderNotifications([{
    title: ` <img src=x onerror="title"> & ' `,
    message: `<script>alert('message')</script> & "quoted"`,
    createdAt: '2026-01-01T00:00:00Z'
  }]);
  assert.match(html, /&lt;img src=x onerror=&quot;title&quot;&gt; &amp; &#39;/);
  assert.match(html, /&lt;script&gt;alert\(&#39;message&#39;\)&lt;\/script&gt; &amp; &quot;quoted&quot;/);
  assert.doesNotMatch(html, /<img|<script>/i);
});

test('dates and read states appear only when the record provides valid availability', () => {
  const renderNotifications = loadRenderer();
  const html = renderNotifications([
    { title: 'Read item', createdAt: '2026-06-01T08:00:00Z', read: true },
    { title: 'Unread item', createdAt: '2026-06-02T08:00:00Z', read: false },
    { title: 'Read timestamp', createdAt: '2026-06-03T08:00:00Z', readAt: '2026-06-03T09:00:00Z' },
    { title: 'Unknown metadata', createdAt: 'not-a-date' },
    { title: 'No metadata' }
  ]);
  assert.match(html, /datetime="2026-06-01T08:00:00\.000Z"/);
  assert.match(html, /datetime="2026-06-02T08:00:00\.000Z"/);
  assert.match(html, /datetime="2026-06-03T08:00:00\.000Z"/);
  assert.match(html, /<span class="notification-status">Read<\/span>/);
  assert.match(html, /<span class="notification-status is-unread">Unread<\/span>/);
  assert.equal((html.match(/<span class="notification-status/g) || []).length, 3);
  assert.equal((html.match(/<time\b/g) || []).length, 3);
  assert.doesNotMatch(html, /Unknown metadata[\s\S]*?<time\b|No metadata[\s\S]*?<time\b/);
});

test('empty notification list states there are no saved notifications and invents no demos', () => {
  const renderNotifications = loadRenderer();
  const html = renderNotifications([]);
  assert.match(html, /No notifications yet/);
  assert.match(html, /There are no saved notifications available for your account\./);
  assert.doesNotMatch(html, /demo|payment|Alice|Bob|\b\$\d/i);
  assert.doesNotMatch(html, /notifications-list|notification-item/);
});
