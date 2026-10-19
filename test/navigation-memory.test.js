import test from 'node:test';
import assert from 'node:assert/strict';
import '../navigation-memory.js';

const { StemmaNavigationMemory } = globalThis;
const ROUTES = ['overview', 'cards', 'pulse', 'activity', 'goals', 'profile'];
const EXISTING_ROUTES = ['overview', 'cards', 'activity', 'goals', 'profile'];
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
    isDeposit: false, depositAmount: '', receiptTime: '', historyId: '',
    isFriend: false, friendBillId: '', friendUsernameQuery: '', scrollTop: 1234
  };
}

test('round-trips all existing routes and each of their three tab indexes', () => {
  const storage = makeStorage();
  const memory = new StemmaNavigationMemory(storage);
  for (const route of EXISTING_ROUTES) {
    for (let tab = 0; tab <= 2; tab += 1) {
      const input = state(route, tab);
      assert.equal(memory.save(`google:${route}-${tab}@example.test`, input), true);
      assert.deepEqual(memory.load(`google:${route}-${tab}@example.test`), input);
    }
  }
  assert.equal(storage.values.size, 15);
});

test('round-trips Pulse and each of its five category indexes', () => {
  const memory = new StemmaNavigationMemory(makeStorage());
  for (let category = 0; category <= 4; category += 1) {
    const input = state('pulse', category);
    assert.equal(memory.save(`google:pulse-${category}@example.test`, input), true);
    assert.deepEqual(memory.load(`google:pulse-${category}@example.test`), input);
  }
});

test('invalid Pulse and existing-route category indexes fall back to zero', () => {
  const clean = StemmaNavigationMemory.sanitize;
  for (const index of [-1, 5, 6, 1.5, '5', null]) {
    const sanitized = clean({ ...state('pulse'), tabs: { ...state('pulse').tabs, pulse: index } });
    assert.equal(sanitized.tabs.pulse, 0, `Pulse index ${String(index)} is rejected`);
  }
  const pulseMaximum = clean({ ...state('pulse'), tabs: { ...state('pulse').tabs, pulse: 4 } });
  assert.equal(pulseMaximum.tabs.pulse, 4);
  const existingMaximum = clean({ ...state('cards'), tabs: { ...state('cards').tabs, cards: 2 } });
  assert.equal(existingMaximum.tabs.cards, 2);
  const existingOutOfRange = clean({ ...state('cards'), tabs: { ...state('cards').tabs, cards: 3 } });
  assert.equal(existingOutOfRange.tabs.cards, 0);
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
  assert.deepEqual(loaded.tabs, { overview: 0, cards: 0, pulse: 0, activity: 0, goals: 2, profile: 0 });
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

test('friend-picker and friend bill/sheet states round-trip only on supported cards slides', () => {
  const memory = new StemmaNavigationMemory(makeStorage());
  const picker = { ...state('cards', 0), view: 'friend-picker', friendBillId: 'candidate_42',
    friendUsernameQuery: 'ab', isDeposit: true, depositAmount: '50.00', receiptTime: '2026/10/18 23:59:59' };
  const savedPicker = StemmaNavigationMemory.sanitize(picker);
  assert.equal(savedPicker.view, 'friend-picker');
  assert.equal(savedPicker.isFriend, false);
  assert.equal(savedPicker.friendBillId, 'candidate_42');
  assert.equal(savedPicker.friendUsernameQuery, 'ab');
  assert.equal(savedPicker.isDeposit, false);
  assert.equal(savedPicker.depositAmount, '');
  assert.equal(savedPicker.receiptTime, '');
  assert.equal(memory.save('google:picker@example.test', picker), true);
  assert.deepEqual(memory.load('google:picker@example.test'), savedPicker);

  const staleSlideFriend = StemmaNavigationMemory.sanitize({ ...state('cards', 0), paymentSlide: 0,
    view: 'bill', isFriend: true, friendBillId: 'friend-bill-42' });
  assert.equal(staleSlideFriend.view, 'bill');
  assert.equal(staleSlideFriend.paymentSlide, 1);

  for (const [tab, view] of [[0, 'bill'], [1, 'sheet']]) {
    const friend = { ...state('cards', tab), view, isFriend: true,
      friendBillId: 'friend-bill-42', friendUsernameQuery: 'alice_1', isDeposit: true,
      depositAmount: '676.45', receiptTime: '2026/10/18 23:59:59' };
    const clean = StemmaNavigationMemory.sanitize(friend);
    assert.equal(clean.view, view);
    assert.equal(clean.paymentSlide, 1);
    assert.equal(clean.isFriend, true);
    assert.equal(clean.friendBillId, 'friend-bill-42');
    assert.equal(clean.friendUsernameQuery, 'alice_1');
    assert.equal(clean.isDeposit, false);
    assert.equal(clean.depositAmount, '');
    assert.equal(clean.receiptTime, '');
    assert.equal(memory.save(`google:friend-${tab}@example.test`, friend), true);
    assert.deepEqual(memory.load(`google:friend-${tab}@example.test`), clean);
  }
});

test('friend memory is a strict privacy whitelist and legacy v1 payloads receive safe defaults', () => {
  const clean = StemmaNavigationMemory.sanitize;
  const legacy = { ...state('cards', 0) };
  delete legacy.tabs.pulse;
  delete legacy.isFriend;
  delete legacy.friendBillId;
  delete legacy.friendUsernameQuery;
  assert.deepEqual(clean(legacy), state('cards', 0));

  const storage = makeStorage();
  const memory = new StemmaNavigationMemory(storage);
  const friendPicker = { ...state('cards', 0), view: 'friend-picker', friendUsernameQuery: 'ab',
    fullName: 'Private Name', photo: 'private-photo.jpg', amount: '676.45', recipient: { name: 'Nope' } };
  assert.equal(memory.save('google:privacy@example.test', friendPicker), true);
  const raw = storage.values.get(`${PREFIX}google%3Aprivacy%40example.test`);
  assert.equal(raw.includes('Private Name'), false);
  assert.equal(raw.includes('photo'), false);
  assert.equal(raw.includes('676.45'), false);
  assert.equal(raw.includes('recipient'), false);
  const loaded = memory.load('google:privacy@example.test');
  assert.deepEqual(Object.keys(loaded).sort(), Object.keys(state('cards', 0)).sort());

  for (const query of ['a', 'ab', 'alice_1.test']) {
    assert.equal(clean({ ...state('cards', 0), view: 'main', friendUsernameQuery: query }).friendUsernameQuery, query);
  }
  for (const query of ['@alice', 'a'.repeat(31), 12, null, { username: 'alice' }]) {
    assert.equal(clean({ ...state('cards', 0), view: 'main', friendUsernameQuery: query }).friendUsernameQuery, '');
  }
});

test('invalid, revoked, stale and corrupt friend contexts fail closed without becoming Deposit or receipt views', () => {
  const clean = StemmaNavigationMemory.sanitize;
  const fallback = clean({ ...state('cards', 0), view: 'bill', isFriend: true,
    friendBillId: 'bad/id', friendUsernameQuery: 'alice', isDeposit: true, depositAmount: '676.45' });
  assert.equal(fallback.view, 'main');
  assert.equal(fallback.isFriend, false);
  assert.equal(fallback.friendBillId, '');
  assert.equal(fallback.friendUsernameQuery, 'alice');
  assert.equal(fallback.isDeposit, false);
  assert.equal(fallback.depositAmount, '');

  const missingIdentity = clean({ ...state('cards', 1), view: 'sheet', isFriend: true,
    friendBillId: '', isDeposit: true, depositAmount: '676.45' });
  assert.equal(missingIdentity.view, 'main');
  assert.equal(missingIdentity.isFriend, false);
  assert.equal(missingIdentity.depositAmount, '');

  const unconfirmedIdentity = clean({ ...state('cards', 0), view: 'bill', isFriend: false,
    friendBillId: 'friend-42', depositAmount: '676.45' });
  assert.equal(unconfirmedIdentity.view, 'main');
  assert.equal(unconfirmedIdentity.friendBillId, '');
  assert.equal(unconfirmedIdentity.depositAmount, '');

  const invalidPickerId = clean({ ...state('cards', 0), view: 'friend-picker', friendBillId: '../bad',
    friendUsernameQuery: 'al' });
  assert.equal(invalidPickerId.view, 'main');
  assert.equal(invalidPickerId.friendBillId, '');
  assert.equal(invalidPickerId.friendUsernameQuery, 'al');

  const receipt = clean({ ...state('cards', 0), view: 'receipt', isFriend: true,
    friendBillId: 'friend-42', receiptTime: '2026/10/18 23:59:59' });
  assert.equal(receipt.view, 'main');
  assert.equal(receipt.receiptTime, '');
  assert.equal(receipt.isFriend, false);
  assert.equal(receipt.friendBillId, '');

  const staleTab = clean({ ...state('cards', 2), view: 'sheet', isFriend: true,
    friendBillId: 'friend-42', friendUsernameQuery: 'alice' });
  assert.equal(staleTab.view, 'main');
  assert.equal(staleTab.isFriend, false);
  assert.equal(staleTab.friendBillId, '');
  assert.equal(staleTab.friendUsernameQuery, '');

  const staleRoute = clean({ ...state('profile', 0), isFriend: true,
    friendBillId: 'friend-42', friendUsernameQuery: 'alice' });
  assert.equal(staleRoute.isFriend, false);
  assert.equal(staleRoute.friendBillId, '');
  assert.equal(staleRoute.friendUsernameQuery, '');

  const corruptPicker = clean({ ...state('cards', 0), view: 'friend-picker', isFriend: true,
    friendUsernameQuery: 'al' });
  assert.equal(corruptPicker.view, 'main');
  assert.equal(corruptPicker.isFriend, false);
  assert.equal(corruptPicker.friendUsernameQuery, 'al');
});
