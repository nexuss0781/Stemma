import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const [appSource, memorySource, htmlSource, cssSource] = await Promise.all([
  readFile(new URL('../app.js', import.meta.url), 'utf8'),
  readFile(new URL('../navigation-memory.js', import.meta.url), 'utf8'),
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../styles.css', import.meta.url), 'utf8')
]);
const controllerStart = appSource.indexOf('// Account-scoped UI location only:');
const controllerEnd = appSource.indexOf('function updateOnboardingAccess() {', controllerStart);
assert.ok(controllerStart >= 0 && controllerEnd > controllerStart, 'navigation controller block is present');
const controllerSource = appSource.slice(controllerStart, controllerEnd);
const PREFIX = 'stemma:navigation:v1:';
const ROUTES = ['overview', 'cards', 'pulse', 'goals', 'profile'];

function makeState(route, { tab = 0, view = 'main', ...rest } = {}) {
  const tabs = Object.fromEntries(ROUTES.map(key => [key, 0]));
  tabs[route] = tab;
  return {
    version: 1, route, tabs, paymentSlide: 1, interval: '3-months', view,
    isDeposit: false, depositAmount: '', receiptTime: '', historyId: '', scrollTop: 347,
    ...rest
  };
}

function makeHarness() {
  const values = new Map();
  const storage = {
    values,
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); }
  };
  const scheduled = new Map();
  const calls = { render: 0, sync: 0, showSheet: 0, showHistoryDetails: [], openDeposit: 0, openDemoReceipt: 0, fetch: 0, submit: 0 };
  let nextFrame = 1;
  const historyDialog = { open: false, dataset: {}, focusCalls: 0 };
  const sheetDialog = { open: false };
  const grid = {
    scrollTop: 0,
    historyEntries: [],
    querySelectorAll(selector) { return selector === '[data-history-entry]' ? this.historyEntries : []; }
  };
  const elements = {
    'dashboard-grid': grid,
    'history-details-dialog': historyDialog,
    'bill-payment-dialog': sheetDialog,
    'drawer-student-name': makeTextElement(),
    'drawer-student-username': makeTextElement()
  };
  const document = {
    visibilityState: 'visible',
    getElementById(id) { return elements[id] || null; },
    querySelector(selector) {
      if (selector === '[data-review-bill]') return { focus() {} };
      return null;
    },
    addEventListener() {}
  };
  const window = {
    location: { hash: '#profile', pathname: '/dashboard', search: '?demo=1' },
    history: { replaceState(_state, _title, url) { window.location.hash = url.slice(url.indexOf('#')); } },
    addEventListener() {},
    requestAnimationFrame(callback) { const id = nextFrame++; scheduled.set(id, callback); return id; },
    cancelAnimationFrame(id) { scheduled.delete(id); }
  };
  const payments = {
    isBillOpen: false, isReceiptOpen: false, isDeposit: false, depositAmount: '', demoReceiptTime: '',
    closeSheet() { sheetDialog.open = false; },
    showSheet() { calls.showSheet += 1; sheetDialog.open = true; },
    openDeposit() { calls.openDeposit += 1; },
    openDemoReceipt() { calls.openDemoReceipt += 1; }
  };
  const context = vm.createContext({
    document, window, localStorage: storage, payments,
    friends: { query: '', selectedBillId: '', clear() { this.query = ''; this.selectedBillId = ''; }, cancel() {} },
    closeFriendPicker() {},
    closeHistoryDetails() { historyDialog.open = false; },
    showHistoryDetails(id) { calls.showHistoryDetails.push(id); historyDialog.open = true; historyDialog.dataset.historyId = id; },
    render() { calls.render += 1; },
    syncPaymentCarousel() { calls.sync += 1; },
    fetch() { calls.fetch += 1; throw new Error('navigation restoration must not fetch'); },
    submitPayment() { calls.submit += 1; },
    submit() { calls.submit += 1; }
  });
  vm.runInContext(memorySource, context, { filename: 'navigation-memory.js' });
  vm.runInContext(`
    const activeTabs = { overview: 0, cards: 0, pulse: 0, goals: 0, profile: 0 };
    let activeRoute = 'overview';
    let paymentSlideIndex = 0;
    let paymentDemoInterval = '15-days';
    let routeDirection = 0;
    let dashboardEntered = false;
    let friendInteractionToken = 0;
  `, context, { filename: 'app-navigation-state.js' });
  vm.runInContext(controllerSource, context, { filename: 'app-navigation-controller.js' });
  return {
    context, storage, scheduled, calls, grid, historyDialog, sheetDialog, elements, window,
    evaluate(expression) { return vm.runInContext(expression, context); },
    save(account, state) { return vm.runInContext(`navigationMemory.save(${JSON.stringify(account)}, ${JSON.stringify(state)})`, context); },
    load(account) { return vm.runInContext(`navigationMemory.load(${JSON.stringify(account)})`, context); },
    flushFrames() {
      let rounds = 0;
      while (scheduled.size) {
        assert.ok(rounds++ < 20, 'animation-frame queue settles');
        const batch = [...scheduled.values()];
        scheduled.clear();
        for (const callback of batch) callback();
      }
    }
  };
}

function makeTextElement() {
  let text = '';
  return {
    hidden: false,
    htmlWrites: 0,
    get textContent() { return text; },
    set textContent(value) { text = String(value); },
    set innerHTML(_value) { this.htmlWrites += 1; },
    get innerHTML() { return ''; }
  };
}

test('fresh account starts at Overview and ignores another account’s stored route and stale hash', () => {
  const h = makeHarness();
  assert.equal(h.save('google:other@example.test', makeState('profile', { tab: 2 })), true);
  h.evaluate("dashboardEntered = true; restoreNavigationLocation('google:fresh@example.test')");
  assert.equal(h.evaluate('activeRoute'), 'overview');
  assert.equal(h.window.location.hash, '#overview');
  assert.equal(h.load('google:other@example.test').route, 'profile');
  h.flushFrames();
  assert.equal(h.load('google:fresh@example.test').route, 'overview');
});

test('saved route, every tab index, and route-specific tab state are restored', () => {
  const h = makeHarness();
  const saved = makeState('goals', { tab: 2 });
  saved.tabs.overview = 1;
  saved.tabs.profile = 2;
  assert.equal(h.save('google:tabs@example.test', saved), true);
  h.evaluate("dashboardEntered = true; restoreNavigationLocation('google:tabs@example.test')");
  assert.equal(h.evaluate('activeRoute'), 'goals');
  assert.deepEqual(JSON.parse(JSON.stringify(h.evaluate('activeTabs'))), saved.tabs);
  assert.equal(h.evaluate('paymentSlideIndex'), 1);
  assert.equal(h.evaluate('paymentDemoInterval'), '3-months');
  h.flushFrames();
});

test('Pulse route and its highest category index are restored', () => {
  const h = makeHarness();
  const saved = makeState('pulse', { tab: 4 });
  assert.equal(h.save('google:pulse@example.test', saved), true);
  h.evaluate("dashboardEntered = true; restoreNavigationLocation('google:pulse@example.test')");
  assert.equal(h.evaluate('activeRoute'), 'pulse');
  assert.equal(h.evaluate('activeTabs.pulse'), 4);
  h.flushFrames();
});

test('bill, sheet, receipt and history details restore using UI flags and safe dialog helpers only', () => {
  const cases = [
    { view: 'bill', tab: 0, state: {} },
    { view: 'sheet', tab: 0, state: {} },
    { view: 'receipt', tab: 0, state: { receiptTime: '2026/10/18 23:59:59' } },
    { view: 'history-details', tab: 2, state: { historyId: 'STM-20261018-007' } }
  ];
  for (const item of cases) {
    const h = makeHarness();
    const saved = makeState('cards', { tab: item.tab, view: item.view, ...item.state });
    assert.equal(h.save('google:views@example.test', saved), true, `valid ${item.view} fixture saves`);
    h.evaluate("restoreNavigationLocation('google:views@example.test')");
    assert.equal(h.evaluate('activeRoute'), 'cards');
    assert.equal(h.evaluate('activeTabs.cards'), item.tab);
    assert.equal(h.evaluate('payments.isBillOpen'), item.view === 'bill' || item.view === 'sheet' || item.view === 'receipt');
    assert.equal(h.evaluate('payments.isReceiptOpen'), item.view === 'receipt');
    assert.equal(h.calls.showSheet, 0);
    assert.deepEqual(h.calls.showHistoryDetails, []);
    assert.equal(h.scheduled.size, 0, 'restore dialog work is deferred before dashboard entry');

    h.evaluate('finishNavigationRestoration()');
    assert.equal(h.scheduled.size, 0, 'finish is inert until dashboardEntered');
    assert.equal(h.sheetDialog.open, false);
    assert.equal(h.historyDialog.open, false);
    h.evaluate('dashboardEntered = true; finishNavigationRestoration()');
    assert.equal(h.scheduled.size, 1, 'dashboard entry schedules deferred restoration');
    assert.equal(h.calls.showSheet, 0);
    assert.deepEqual(h.calls.showHistoryDetails, []);
    h.flushFrames();

    assert.equal(h.calls.showSheet, item.view === 'sheet' ? 1 : 0);
    assert.deepEqual(h.calls.showHistoryDetails, item.view === 'history-details' ? ['STM-20261018-007'] : []);
    assert.equal(h.calls.openDeposit, 0);
    assert.equal(h.calls.openDemoReceipt, 0);
    assert.equal(h.calls.fetch, 0);
    assert.equal(h.calls.submit, 0);
    assert.equal(h.calls.sync, 1);
    assert.equal(h.historyDialog.open, item.view === 'history-details');
    assert.equal(h.sheetDialog.open, item.view === 'sheet');
  }
  assert.doesNotMatch(controllerSource, /\bfetch\s*\(|\bopenDeposit\s*\(|\bopenDemoReceipt\s*\(|\bsubmit(?:Payment)?\s*\(/,
    'restoration controller contains no network, payment-opening, or submission calls');
});

test('account switching saves the active account separately and restores the target account', () => {
  const h = makeHarness();
  assert.equal(h.save('google:alice@example.test', makeState('cards', { tab: 1 })), true);
  assert.equal(h.save('google:bob@example.test', makeState('profile', { tab: 2 })), true);
  h.evaluate("dashboardEntered = true; restoreNavigationLocation('google:alice@example.test')");
  h.flushFrames();
  h.evaluate("activeRoute = 'goals'; activeTabs.goals = 2; persistNavigationLocation(); restoreNavigationLocation('google:bob@example.test')");
  assert.equal(h.evaluate('activeRoute'), 'profile');
  assert.equal(h.evaluate('activeTabs.profile'), 2);
  assert.equal(h.load('google:alice@example.test').route, 'goals');
  assert.equal(h.load('google:alice@example.test').tabs.goals, 2);
  assert.equal(h.load('google:bob@example.test').route, 'profile');
  assert.equal(h.storage.values.size, 2);
  h.flushFrames();
});

test('invalid stored route falls back to Overview rather than honoring the URL hash', () => {
  const h = makeHarness();
  h.storage.values.set(`${PREFIX}google%3Abad%40example.test`, JSON.stringify({ version: 1, route: 'javascript:alert(1)' }));
  h.window.location.hash = '#cards';
  h.evaluate("dashboardEntered = true; restoreNavigationLocation('google:bad@example.test')");
  assert.equal(h.evaluate('activeRoute'), 'overview');
  assert.equal(h.window.location.hash, '#overview');
  h.flushFrames();
});

test('legacy Activity route is rejected and falls back to Overview', () => {
  const h = makeHarness();
  const legacy = makeState('overview');
  legacy.route = 'activity';
  h.storage.values.set(`${PREFIX}google%3Alegacy%40example.test`, JSON.stringify(legacy));
  h.window.location.hash = '#activity';
  h.evaluate("dashboardEntered = true; restoreNavigationLocation('google:legacy@example.test')");
  assert.equal(h.evaluate('activeRoute'), 'overview');
  assert.equal(h.window.location.hash, '#overview');
  assert.equal(h.load('google:legacy@example.test'), null);
  h.flushFrames();
});

test('capture and queued flush persist the same active UI view and scroll position', () => {
  const h = makeHarness();
  h.evaluate("dashboardEntered = true; restoreNavigationLocation('google:capture@example.test')");
  h.flushFrames();
  h.grid.scrollTop = 612;
  h.sheetDialog.open = true;
  h.evaluate("activeRoute = 'cards'; activeTabs.cards = 0; payments.isBillOpen = true; payments.isReceiptOpen = false");
  const captured = JSON.parse(JSON.stringify(h.evaluate('captureNavigationLocation()')));
  assert.equal(captured.route, 'cards');
  assert.equal(captured.tabs.cards, 0);
  assert.equal(captured.view, 'sheet');
  assert.equal(captured.scrollTop, 612);
  h.evaluate('queueNavigationSave()');
  assert.equal(h.load('google:capture@example.test').route, 'overview', 'save waits for the queued animation frame');
  h.flushFrames();
  const persisted = h.load('google:capture@example.test');
  assert.equal(persisted.route, captured.route);
  assert.equal(persisted.tabs.cards, captured.tabs.cards);
  assert.equal(persisted.view, captured.view);
  assert.equal(persisted.scrollTop, captured.scrollTop);
});

test('sidebar identity falls back to trimmed first and last names as text, and hides for guests', () => {
  const h = makeHarness();
  h.evaluate(`googleAuthenticated = true; savedStudentProfile = {
    nickName: '   ', firstName: '  Ada ', middleName: ' <b>Marie</b> ', lastName: ' Lovelace  ', username: '  @ada<&>  '
  }; renderSidebarIdentity()`);
  const name = h.elements['drawer-student-name'];
  const username = h.elements['drawer-student-username'];
  assert.equal(name.textContent, 'Ada Lovelace');
  assert.equal(username.textContent, '@ada<&>');
  assert.equal(name.hidden, false);
  assert.equal(username.hidden, false);
  assert.equal(name.htmlWrites + username.htmlWrites, 0, 'identity is never interpolated through HTML');
  h.evaluate('googleAuthenticated = false; renderSidebarIdentity()');
  assert.equal(name.textContent, '');
  assert.equal(username.textContent, '');
  assert.equal(name.hidden, true);
  assert.equal(username.hidden, true);
  assert.equal(name.htmlWrites + username.htmlWrites, 0);
  assert.match(controllerSource.match(/function renderSidebarIdentity\(\) \{[\s\S]*?\n\}/)?.[0] || '', /\.textContent\s*=/);
  assert.doesNotMatch(controllerSource.match(/function renderSidebarIdentity\(\) \{[\s\S]*?\n\}/)?.[0] || '', /\.innerHTML\s*=|insertAdjacentHTML/);
});

test('sidebar identity prefers the trimmed saved nickname and keeps it as text', () => {
  const h = makeHarness();
  h.evaluate(`googleAuthenticated = true; savedStudentProfile = {
    nickName: '  <b>Ada</b>  ', firstName: 'Augusta', middleName: 'Byron', lastName: 'Lovelace', username: 'ada'
  }; renderSidebarIdentity()`);
  const name = h.elements['drawer-student-name'];
  const username = h.elements['drawer-student-username'];
  assert.equal(name.textContent, '<b>Ada</b>');
  assert.equal(username.textContent, '@ada');
  assert.equal(name.hidden, false);
  assert.equal(username.hidden, false);
  assert.equal(name.htmlWrites + username.htmlWrites, 0, 'nickname and username are never interpolated through HTML');
});

test('drawer puts Overview first and Pulse follows Cards in bottom-nav order; sidebar assets remain local', async () => {
  const sectionsMatch = /^const sections = \[([\s\S]*?)^\];/m.exec(appSource);
  assert.ok(sectionsMatch, 'navigation section definition exists');
  assert.deepEqual([...sectionsMatch[1].matchAll(/id:\s*'([^']+)'/g)].map(([, id]) => id),
    ['cards', 'pulse', 'overview', 'goals', 'profile'], 'Pulse follows Payment and Profile remains last');
  const cardTargetsMatch = /^const cardTargets = \[([^\]]*)\];/m.exec(appSource);
  assert.ok(cardTargetsMatch, 'placeholder card destinations exist');
  const cardTargets = [...cardTargetsMatch[1].matchAll(/'([^']+)'/g)].map(([, route]) => route);
  const routeIds = [...sectionsMatch[1].matchAll(/id:\s*'([^']+)'/g)].map(([, id]) => id);
  assert.deepEqual(cardTargets, ['overview', 'goals', 'cards', 'profile']);
  assert.ok(cardTargets.every(route => routeIds.includes(route)), 'every card destination remains a valid navigation route');
  const bottomNav = appSource.match(/function renderBottomNav\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(bottomNav, /sections\.map\(item\s*=>/);
  assert.match(bottomNav, /const drawerSections = \[sections\.find\(item => item\.id === 'overview'\), \.\.\.sections\.filter\(item => item\.id !== 'overview'\)\]/);
  assert.match(bottomNav, /drawerSections\.map\(item\s*=>/);

  assert.match(htmlSource, /<img class="drawer-college-crest" src="assets\/tafari-makonnen-sidebar-crest\.png" alt="Tafari Makonnen College crest"\s*\/>/);
  const crest = await readFile(new URL('../assets/tafari-makonnen-sidebar-crest.png', import.meta.url));
  assert.equal(crest.subarray(1, 4).toString(), 'PNG');
  assert.equal(crest[25], 6, 'sidebar crest is a true RGBA PNG with an alpha channel');
  assert.equal(crest.readUInt32BE(16), 672);
  assert.equal(crest.readUInt32BE(20), 582);
  assert.match(htmlSource, /<img class="welcome-college-logo" src="assets\/tafari-makonnen-college-logo\.png"/);
  await readFile(new URL('../assets/tafari-makonnen-college-logo.png', import.meta.url));
  assert.match(cssSource, /@font-face\s*\{[^}]*font-family:\s*'Fraunces Deadline'[^}]*url\('\/assets\/fraunces-deadline\.ttf'\)/s);
  assert.match(cssSource, /\.drawer-student-name\s*\{[^}]*font-family:\s*'Fraunces Deadline'/s);
  await readFile(new URL('../assets/fraunces-deadline.ttf', import.meta.url));
  assert.doesNotMatch(htmlSource, /fonts\.googleapis\.com|fonts\.gstatic\.com/i, 'no new external font asset is introduced');
});

 test('glass styling is scoped to the image card and the drawer retains burgundy', () => {
  const theme = cssSource.slice(cssSource.indexOf('.drawer-backdrop { background: rgba(61,8,14,.28); }'), cssSource.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(theme, /\.navigation-drawer\s*\{[^}]*background:\s*rgba\(91,20,22,\.98\)/);
  assert.match(theme, /\.drawer-college-card\s*\{[^}]*backdrop-filter:\s*blur\(26px\)/);
  assert.doesNotMatch(theme, /\.navigation-drawer\s*\{[^}]*backdrop-filter/);
});

test('college/profile card uses warm-gold glass and the selected drawer link uses the gold pill', () => {
  const glass = cssSource.slice(cssSource.indexOf('/* Warm frosted glass,'), cssSource.indexOf('/* Keep a 44px touch target'));
  assert.match(glass, /\.drawer-college-card\s*\{[^}]*border-radius:\s*22px/s);
  assert.match(glass, /background:[^}]*rgba\(251,241,200,\.1\)[^}]*rgba\(104,27,29,\.2\)/s);
  assert.doesNotMatch(glass, /color-mix|background:[^;}]*#[0-9a-f]{3,8}/i, 'glass fill remains translucent rather than opaque');
  assert.match(glass, /\.drawer-college-card::before\s*\{[^}]*pointer-events:\s*none[^}]*linear-gradient\(125deg/s);
  assert.match(glass, /\.drawer-college-card::after\s*\{[^}]*background:[^;}]*assets\/tafari-makonnen-sidebar-crest\.png[^}]*filter:\s*blur\(16px\)/s);
  assert.match(cssSource, /\.drawer-college-crest\s*\{[^}]*object-fit:\s*contain/s);
  assert.match(cssSource, /\.drawer-student-name\s*\{[^}]*color:\s*var\(--brand-gold-light\)/s);
  assert.match(cssSource, /\.drawer-link\[aria-current="page"\]::before\s*\{[^}]*background:\s*var\(--brand-gold\)/s);
  assert.match(cssSource, /\.drawer-link\[aria-current="page"\]\s*\{[^}]*color:\s*var\(--brand-burgundy\)/s);
});

test('sidebar identity uses only tight soft glyph shadows, never a broad backdrop or outlines', () => {
  const glass = cssSource.slice(cssSource.indexOf('/* Warm frosted glass,'), cssSource.indexOf('/* Keep a 44px touch target'));
  assert.match(glass, /--drawer-crest-height:\s*max\(96px, calc\(clamp\(190px, 27vh, 218px\) - 36\.75px - var\(--drawer-name-line\)\)\)/);
  assert.match(glass, /height:\s*calc\(var\(--drawer-crest-height\) \+ 18px\); min-height:\s*0; padding:\s*8px 0/);
  assert.match(glass, /\.drawer-college-crest\s*\{[^}]*height:\s*var\(--drawer-crest-height\)[^}]*flex:\s*0 0 auto/s);
  assert.match(glass, /\.drawer-student-identity\s*\{[^}]*position:\s*absolute[^}]*isolation:\s*isolate[^}]*bottom:\s*calc\(8px \+ var\(--drawer-crest-height\) \* \.015\)[^}]*margin:\s*0; padding:\s*0; background:\s*none; text-align:\s*left/s);
  const identity = glass.slice(glass.indexOf('.drawer-student-identity {'));
  assert.doesNotMatch(identity, /::before|::after|radial-gradient|filter:\s*blur|box-shadow/, 'no rectangular or blurred backdrop is painted behind the identity');
  assert.match(identity, /\.drawer-student-name, \.drawer-student-username\s*\{[^}]*text-align:\s*left; text-shadow:\s*0 1px 2px rgba\(0,0,0,\.8\);/s);
  assert.doesNotMatch(identity, /text-stroke|text-shadow:\s*-1px|text-shadow:[^;}]*,[^;}]*rgba/, 'one blurred shadow follows glyphs, with no sharp or stacked outlines');
  assert.doesNotMatch(identity, /text-shadow:\s*none/, 'neither line overrides the shared glyph shadow');
  assert.match(glass, /overflow:\s*hidden; white-space:\s*nowrap; text-overflow:\s*ellipsis/);
});
