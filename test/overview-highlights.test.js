import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../overview-ui.js', import.meta.url), 'utf8');
const routes = [
  ['/api/notifications', 'notifications', 'notifications'],
  ['/api/pulse/conversations', 'conversations', 'conversations'],
  ['/api/pulse/groups', 'groups', 'groups'],
  ['/api/pulse/channels', 'channels', 'channels'],
  ['/api/likee/videos', 'videos', 'videos']
];

function createContainer() {
  let markup = '';
  return {
    isConnected: true,
    history: [],
    get innerHTML() { return markup; },
    set innerHTML(value) { markup = String(value); this.history.push(markup); }
  };
}

function createHarness({ fetchImpl = async () => ({ ok: true, json: async () => ({}) }), timerImpl, clearTimerImpl } = {}) {
  const context = vm.createContext({
    fetch: fetchImpl,
    AbortController,
    setTimeout: timerImpl || setTimeout,
    clearTimeout: clearTimerImpl || clearTimeout
  });
  vm.runInContext(source, context, { filename: 'overview-ui.js' });
  return context.StemmaOverview;
}

const waitForRequests = async () => {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
};

function response(body, ok = true) {
  return { ok, json: async () => body };
}

function bodyFor(key, items) {
  return { [key]: items };
}

function card(markup, id) {
  const start = markup.indexOf(`class="overview-quick-card overview-quick-${id}"`);
  assert.notEqual(start, -1, `${id} shortcut is present`);
  const end = markup.indexOf('</button>', start);
  assert.notEqual(end, -1, `${id} shortcut is closed`);
  return markup.slice(start, end + '</button>'.length);
}

function populatedBodies() {
  return {
    notifications: bodyFor('notifications', [{ readAt: null, message: 'Fresh notification' }]),
    conversations: bodyFor('conversations', [{ username: 'reader', lastMessage: { text: 'Fresh chat' } }]),
    groups: bodyFor('groups', [{ name: 'Fresh group' }]),
    channels: bodyFor('channels', [{ lastPost: { text: 'Fresh channel post' } }]),
    videos: bodyFor('videos', [{ caption: 'Fresh moment' }])
  };
}

test('notification highlight counts actual unread items, not the number of records', () => {
  const overview = createHarness();
  const html = overview.render({
    notifications: {
      status: 'ready',
      items: [
        { id: 'unread-null', readAt: null, message: 'Unread null timestamp' },
        { id: 'read', readAt: '2026-01-01T00:00:00Z', message: 'Already read' },
        { id: 'unread-legacy', read: false, message: 'Unread legacy flag' },
        { id: 'read-legacy', read: true, message: 'Legacy read flag' },
        { id: 'unread-both', readAt: null, read: false, message: 'Unread explicit state' }
      ]
    }
  }, { authenticated: true, profile: { firstName: 'Ada', middleName: 'Byron', lastName: 'Lovelace', studentId: '1', department: 'Math' } });

  assert.match(card(html, 'notifications'), /<strong>3 unread<\/strong>/);
  assert.match(card(html, 'notifications'), /3 new/);
  assert.match(html, /3 notifications to catch up on/);
});

test('payment shortcut is explicitly a demo preview and shows no invented balance or fee amount', () => {
  const html = createHarness().render({}, { authenticated: true, profile: null });
  const payment = card(html, 'payment');
  assert.match(payment, />Demo</);
  assert.match(payment, /Fees, made clearer/);
  assert.match(payment, /Payment screens are demo previews/);
  assert.doesNotMatch(payment, /\$\s?\d|\b(?:USD|EUR|GBP)\s?\d|\d[.,]\d{2}/i);
});

test('guest rendering ignores supplied private profile and account data', () => {
  const secret = 'PRIVATE_ACCOUNT_SENTINEL_9f38';
  const html = createHarness().render({
    notifications: { status: 'ready', items: [{ readAt: null, message: secret }] },
    conversations: { status: 'ready', items: [{ username: secret, lastMessage: { text: secret } }] },
    groups: { status: 'ready', items: [{ name: secret }] },
    channels: { status: 'ready', items: [{ lastPost: { text: secret } }] },
    videos: { status: 'ready', items: [{ caption: secret }] }
  }, {
    authenticated: false,
    profile: { firstName: secret, lastName: secret, studentId: secret, department: secret },
    filter: 0
  });

  assert.doesNotMatch(html, new RegExp(secret));
  assert.match(html, /Sign in to see more/);
  assert.match(html, /Your space starts with you/);
  assert.match(card(html, 'profile'), /Make it yours/);
});

test('all user-controlled shortcut content is HTML escaped', () => {
  const payload = '<img src=x onerror="alert(1)">&\'"';
  const html = createHarness().render({
    notifications: { status: 'ready', items: [{ readAt: null, message: payload }] },
    conversations: { status: 'ready', items: [{ username: payload, lastMessage: { text: payload } }] },
    groups: { status: 'ready', items: [{ name: payload }] },
    channels: { status: 'ready', items: [{ lastPost: { text: payload } }] },
    videos: { status: 'ready', items: [{ caption: payload }] }
  }, {
    authenticated: true,
    profile: { firstName: 'Ada', lastName: 'Lovelace', studentId: 'S-1', department: payload }
  });

  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;&amp;&#39;&quot;/);
  assert.ok((html.match(/&lt;img src=x/g) || []).length >= 4);
});

test('overview category filters show the intended shortcuts and correct count', () => {
  const overview = createHarness();
  const all = overview.render({}, { authenticated: true, profile: null, filter: 0 });
  const connected = overview.render({}, { authenticated: true, profile: null, filter: 1 });
  const essentials = overview.render({}, { authenticated: true, profile: null, filter: 2 });

  assert.match(all, /7 shortcuts/);
  assert.match(connected, /Stay connected/);
  assert.match(connected, /4 shortcuts/);
  for (const id of ['conversations', 'groups', 'channels', 'videos']) assert.ok(connected.includes(`overview-quick-${id}`));
  for (const id of ['notifications', 'payment', 'profile']) assert.ok(!connected.includes(`overview-quick-${id}`));
  assert.match(essentials, /Your essentials/);
  assert.match(essentials, /3 shortcuts/);
  for (const id of ['notifications', 'payment', 'profile']) assert.ok(essentials.includes(`overview-quick-${id}`));
  for (const id of ['conversations', 'groups', 'channels', 'videos']) assert.ok(!essentials.includes(`overview-quick-${id}`));
});

test('one failed endpoint does not blank the Overview or erase successful highlights', async t => {
  const fixtures = populatedBodies();
  for (const [url, key, id] of routes) {
    await t.test(`${key} fetch error is isolated`, async () => {
      const overview = createHarness({
        fetchImpl: async requestUrl => {
          if (requestUrl === url) throw new Error('endpoint unavailable');
          const [, otherKey] = routes.find(route => route[0] === requestUrl);
          return response(fixtures[otherKey]);
        }
      });
      const container = createContainer();
      overview.mount(container, { authenticated: true, profile: null });
      await waitForRequests();

      const failedCard = card(container.innerHTML, id);
      assert.match(failedCard, /Not connected/);
      assert.match(failedCard, />Retry</);
      assert.match(container.innerHTML, /Fresh notification|Fresh chat|Fresh group|Fresh channel post|Fresh moment/);
      assert.match(container.innerHTML, /Your highlights, not your to-do list/);
      assert.ok(container.innerHTML.length > 500, 'the rest of the page remains rendered');
    });
  }
});

test('fetch responses update each endpoint independently and use returned unread counts', async () => {
  const fixtures = populatedBodies();
  fixtures.notifications = bodyFor('notifications', [
    { readAt: null, message: 'unread one' },
    { readAt: '2026-10-01', message: 'read record' },
    { read: false, message: 'unread two' }
  ]);
  const overview = createHarness({ fetchImpl: async url => {
    const [, key] = routes.find(route => route[0] === url);
    return response(fixtures[key]);
  } });
  const container = createContainer();
  overview.mount(container, { authenticated: true, profile: null });
  await waitForRequests();

  assert.match(card(container.innerHTML, 'notifications'), /<strong>2 unread<\/strong>/);
  assert.match(card(container.innerHTML, 'conversations'), /Fresh chat/);
  assert.match(card(container.innerHTML, 'groups'), /Fresh group/);
  assert.match(card(container.innerHTML, 'channels'), /Fresh channel post/);
  assert.match(card(container.innerHTML, 'videos'), /Fresh moment/);
  assert.doesNotMatch(container.innerHTML, /Checking…/);
});

test('a timed-out endpoint is aborted and rendered as an isolated retry while other data stays visible', async () => {
  const timers = [];
  const calls = [];
  const fixtures = populatedBodies();
  const overview = createHarness({
    timerImpl: (callback, delay) => {
      const handle = { callback, delay, cleared: false };
      timers.push(handle);
      return handle;
    },
    clearTimerImpl: handle => { handle.cleared = true; },
    fetchImpl: (url, options) => {
      calls.push({ url, signal: options.signal });
      if (url !== '/api/pulse/groups') {
        const [, key] = routes.find(route => route[0] === url);
        return Promise.resolve(response(fixtures[key]));
      }
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted by timeout')), { once: true });
      });
    }
  });
  const container = createContainer();
  overview.mount(container, { authenticated: true, profile: null });
  const timedOutIndex = routes.findIndex(route => route[0] === '/api/pulse/groups');
  assert.equal(timers[timedOutIndex].delay, 12000);
  timers[timedOutIndex].callback();
  await waitForRequests();

  assert.equal(calls.find(call => call.url === '/api/pulse/groups').signal.aborted, true);
  assert.match(card(container.innerHTML, 'groups'), /Not connected/);
  assert.match(card(container.innerHTML, 'groups'), />Retry</);
  assert.match(container.innerHTML, /Fresh notification/);
  assert.match(container.innerHTML, /Fresh chat/);
  assert.ok(timers.every(timer => timer.cleared), 'all endpoint timeout handles are cleaned up');
});

test('unmount aborts outstanding endpoint requests and stale account responses cannot overwrite the new account', async () => {
  const requests = [];
  const pending = [];
  const fetchImpl = (url, options) => {
    const request = { url, signal: options.signal };
    requests.push(request);
    return new Promise(resolve => pending.push({ request, resolve }));
  };
  const overview = createHarness({ fetchImpl });
  const container = createContainer();
  overview.mount(container, { authenticated: true, profile: null });
  assert.equal(requests.length, routes.length);

  overview.mount(container, { authenticated: false, profile: { firstName: 'Stale private data' } });
  assert.ok(requests.slice(0, routes.length).every(request => request.signal.aborted));
  const guestMarkup = container.innerHTML;
  assert.doesNotMatch(guestMarkup, /Stale private data/);
  assert.match(guestMarkup, /Your space starts with you/);

  overview.mount(container, { authenticated: true, profile: null });
  const latestRequests = requests.slice(routes.length);
  assert.equal(latestRequests.length, routes.length);
  for (const { request, resolve } of pending.slice(routes.length)) {
    const [, key] = routes.find(route => route[0] === request.url);
    resolve(response(bodyFor(key, [{ readAt: null, message: 'current-account-data' }])));
  }
  await waitForRequests();
  const currentMarkup = container.innerHTML;
  assert.match(currentMarkup, /current-account-data/);

  for (const { request, resolve } of pending.slice(0, routes.length)) {
    const [, key] = routes.find(route => route[0] === request.url);
    resolve(response(bodyFor(key, [{ readAt: null, message: 'stale-account-secret' }])));
  }
  await waitForRequests();
  assert.equal(container.innerHTML, currentMarkup, 'late responses from the previous account do not repaint');
  assert.doesNotMatch(container.innerHTML, /stale-account-secret/);

  overview.unmount();
  assert.ok(latestRequests.every(request => request.signal.aborted), 'unmount aborts the active account requests too');
});
