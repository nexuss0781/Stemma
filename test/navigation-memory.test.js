import test from 'node:test';
import assert from 'node:assert/strict';
import '../navigation-memory.js';

const { StemmaNavigationMemory } = globalThis;
const ROUTES = ['overview', 'cards', 'activity', 'goals', 'profile'];
const PREFIX = 'stemma:navigation:v1:';

function makeStorage(overrides = {}) {
  const values = new Map();
  return {
    values,
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    ...overrides
  };
}

function state(route = 'overview', selectedTab = 0) {
  const tabs = Object.fromEntries(ROUTES.map(key => [key, 0]));
  tabs[route] = selectedTab;
  return {
    version: 1, route, tabs, paymentSlide: 1, interval: '3-months', view: 'main',
    isDeposit: false, depositAmount: '', receiptTime: '', historyId: '', scrollTop: 1234
  };
}

test('round-trips all five routes and each of their three tab indexes', () => {
  const storage = makeStorage();
  const memory = new StemmaNavigationMemory(storage);
  for (const route of ROUTES) {
    for (let tab = 0; tab <= 2; tab += 1) {
      const input = state(route, tab);
      assert.equal(memory.save(`google:${route}-${tab}@example.test`, input), true);
      assert.deepEqual(memory.load(`google:${route}-${tab}@example.test`), input);
    }
  }
  assert.equal(storage.values.size, 15);
});

test('cards dialog states retain safe deposit, receipt and history metadata', () => {
  const memory = new StemmaNavigationMemory(makeStorage());
  const deposit = state('cards', 1);
  Object.assign(deposit, { view: 'bill', isDeposit: true, depositAmount: '0005.2' });
  assert.equal(memory.save('google:deposit@example.test', deposit), true);
  assert.equal(memory.load('google:deposit@example.test').depositAmount, '5.20');

  const receipt = state('cards', 0);
  Object.assign(receipt, { view: 'receipt', receiptTime: '2026/10/18 23:59:59' });
  assert.equal(memory.save('google:receipt@example.test', receipt), true);
  assert.equal(memory.load('google:receipt@example.test').receiptTime, '2026/10/18 23:59:59');

  const history = state('cards', 2);
  Object.assign(history, { view: 'history-details', historyId: 'STM-20261018-007' });
  assert.equal(memory.save('google:history@example.test', history), true);
  assert.equal(memory.load('google:history@example.test').historyId, 'STM-20261018-007');
});

test('account keys are encoded and isolated; empty account keys never access storage', () => {
  const storage = makeStorage();
  const memory = new StemmaNavigationMemory(storage);
  assert.equal(memory.save('', state('cards')), false);
  assert.equal(memory.load(''), null);
  assert.equal(storage.values.size, 0);
  memory.save('google:alice@example.test', state('activity', 1));
  memory.save('google:bob@example.test', state('goals', 2));
  assert.equal(memory.load('google:alice@example.test').route, 'activity');
  assert.equal(memory.load('google:bob@example.test').route, 'goals');
  assert.equal(storage.values.has(`${PREFIX}google%3Aalice%40example.test`), true);
  assert.equal(memory.load('google:missing@example.test'), null);
});

test('sanitizer rejects malformed, stale and invalid-route payloads and strips injected keys', () => {
  const storage = makeStorage();
  const memory = new StemmaNavigationMemory(storage);
  const key = `${PREFIX}google%3Atest%40example.test`;
  for (const raw of ['{', 'null', '[]', JSON.stringify({ version: 0, route: 'overview' }),
    JSON.stringify({ version: 1, route: '<img src=x>', tabs: {} })]) {
    storage.values.set(key, raw);
    assert.equal(memory.load('google:test@example.test'), null);
  }

  const injected = { ...state('overview'), route: 'overview', password: 'secret', html: '<script>x</script>',
    tabs: { overview: 9, cards: -1, activity: 1.5, goals: 2, profile: 0, injected: 2 } };
  assert.equal(memory.save('google:test@example.test', injected), true);
  const loaded = memory.load('google:test@example.test');
  assert.deepEqual(loaded.tabs, { overview: 0, cards: 0, activity: 0, goals: 2, profile: 0 });
  assert.equal(Object.hasOwn(loaded, 'password'), false);
  assert.equal(Object.hasOwn(loaded, 'html'), false);
  assert.equal(Object.hasOwn(loaded.tabs, 'injected'), false);
  assert.equal(storage.values.get(key).includes('secret'), false);
});

test('invalid view combinations and hostile money or receipt metadata fail closed', () => {
  const clean = StemmaNavigationMemory.sanitize;
  const badRoute = clean({ ...state(), route: 'javascript:alert(1)' });
  assert.equal(badRoute, null);

  const invalidDeposit = clean({ ...state('cards', 1), view: 'bill', isDeposit: true,
    depositAmount: '1;alert(1)' });
  assert.equal(invalidDeposit.view, 'main');
  assert.equal(invalidDeposit.isDeposit, false);
  assert.equal(invalidDeposit.depositAmount, '');

  const malformedReceipt = clean({ ...state('cards', 0), view: 'receipt', receiptTime: '<script>alert(1)</script>' });
  assert.equal(malformedReceipt.view, 'receipt');
  assert.equal(malformedReceipt.receiptTime, '');

  const invalidHistory = clean({ ...state('cards', 2), view: 'history-details', historyId: 'STM-2026-007<script>' });
  assert.equal(invalidHistory.view, 'main');
  assert.equal(invalidHistory.historyId, '');

  const nonCard = clean({ ...state('profile', 2), view: 'receipt', isDeposit: true,
    depositAmount: '20.00', receiptTime: '2026/10/18 23:59:59', historyId: 'STM-20261018-007' });
  assert.equal(nonCard.view, 'main');
  assert.equal(nonCard.isDeposit, false);
  assert.equal(nonCard.depositAmount, '');
  assert.equal(nonCard.receiptTime, '');
  assert.equal(nonCard.historyId, '');
});

test('invalid enums, scroll positions and oversize JSON use safe defaults or return null', () => {
  const storage = makeStorage();
  const memory = new StemmaNavigationMemory(storage);
  const invalid = { ...state('overview'), paymentSlide: 5, interval: 'forever', view: 'popup', scrollTop: 1000001 };
  assert.equal(memory.save('google:defaults@example.test', invalid), true);
  const loaded = memory.load('google:defaults@example.test');
  assert.equal(loaded.paymentSlide, 0);
  assert.equal(loaded.interval, '15-days');
  assert.equal(loaded.view, 'main');
  assert.equal(loaded.scrollTop, 0);

  storage.values.set(`${PREFIX}google%3Alarge%40example.test`, JSON.stringify({ ...state(), padding: 'x'.repeat(9000) }));
  assert.equal(memory.load('google:large@example.test'), null);
});

test('blocked localStorage access and unavailable or quota-exceeded storage do not throw', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('blocked'); } });
    const blocked = new StemmaNavigationMemory();
    assert.equal(blocked.load('google:test@example.test'), null);
    assert.equal(blocked.save('google:test@example.test', state()), false);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  }

  const unavailable = new StemmaNavigationMemory(null);
  assert.equal(unavailable.load('google:test@example.test'), null);
  assert.equal(unavailable.save('google:test@example.test', state()), false);

  const quota = new StemmaNavigationMemory(makeStorage({ setItem() { throw new Error('quota exceeded'); } }));
  assert.equal(quota.save('google:test@example.test', state()), false);
  const denied = new StemmaNavigationMemory(makeStorage({ getItem() { throw new Error('denied'); } }));
  assert.equal(denied.load('google:test@example.test'), null);
});

test('an unsent Deposit draft survives without pretending a bill or payment is open', () => {
  const memory = new StemmaNavigationMemory(makeStorage());
  const draft = { ...state('cards', 1), depositAmount: '1234.56' };
  assert.equal(memory.save('google:draft@example.test', draft), true);
  const saved = memory.load('google:draft@example.test');
  assert.equal(saved.depositAmount, '1234.56');
  assert.equal(saved.view, 'main');
  assert.equal(saved.isDeposit, false);
  const stale = StemmaNavigationMemory.sanitize({ ...draft, view: 'sheet', isDeposit: false });
  assert.equal(stale.view, 'main', 'a Deposit bill requires an explicit validated Deposit mode');
});
