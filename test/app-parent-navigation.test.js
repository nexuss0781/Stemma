import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const adapterStart = source.indexOf('function enterParentNavigation(');
const adapterEnd = source.indexOf('function renderBottomNav()', adapterStart);
assert.ok(adapterStart >= 0 && adapterEnd > adapterStart, 'parent-navigation adapters are present');
const adapterSource = source.slice(adapterStart, adapterEnd);
const routeStart = source.indexOf('function syncRouteFromHash()');
const routeEnd = source.indexOf("window.addEventListener('hashchange'", routeStart);
assert.ok(routeStart >= 0 && routeEnd > routeStart, 'hash route synchronization is present');
const routeSource = source.slice(routeStart, routeEnd);

test('visible back delegates to the matching parent entry without callback recursion', () => {
  const calls = [];
  const stack = [];
  const navigation = {
    enter(key, callback) { stack.push({ key, callback }); calls.push(['enter', key]); return key; },
    back(key) {
      const top = stack.at(-1);
      if (!top || top.key !== key) return false;
      stack.pop();
      calls.push(['back', key]);
      top.callback();
      return true;
    },
    forget(key) { calls.push(['forget', key]); }
  };
  const context = vm.createContext({ window: { StemmaParentNavigation: navigation } });
  context.calls = calls;
  vm.runInContext(adapterSource, context);
  const returned = vm.runInContext(`enterParentNavigation('bill', () => calls.push('closed'))`, context);
  assert.equal(returned, 'bill');
  vm.runInContext(`backParentNavigation('bill', () => calls.push('fallback'))`, context);
  assert.deepEqual(calls, [['enter', 'bill'], ['back', 'bill'], 'closed']);
  assert.deepEqual(stack, []);
});

test('a mismatched or unavailable parent entry falls back to original close behavior', () => {
  const calls = [];
  const context = vm.createContext({ window: { StemmaParentNavigation: {
    back: key => (calls.push(['back', key]), false),
    forget: key => calls.push(['forget', key])
  } } });
  context.calls = calls;
  vm.runInContext(adapterSource, context);
  vm.runInContext(`backParentNavigation('drawer', () => calls.push('closed'))`, context);
  assert.deepEqual(calls, [['back', 'drawer'], ['forget', 'drawer'], 'closed']);

  const noApi = vm.createContext({ window: {} });
  vm.runInContext(adapterSource, noApi);
  assert.equal(vm.runInContext(`enterParentNavigation('receipt', () => {})`, noApi), 'receipt');
  assert.equal(vm.runInContext(`backParentNavigation('receipt', () => { closed = true })`, noApi), false);
  assert.equal(vm.runInContext('closed', noApi), true);
});

test('top-level back/forward route changes render valid routes but ignore notifications hashes', () => {
  const calls = [];
  const state = { activeRoute: 'cards', payments: { isBillOpen: true, isReceiptOpen: true, isDeposit: true, isFriend: true, friendBill: {} } };
  const context = vm.createContext({
    ...state,
    pageTabs: { cards: [], goals: [], overview: [] },
    window: { location: { hash: '#notifications' }, StemmaParentNavigation: { reset: () => calls.push('reset') } },
    cancelPendingNavigationRestoration: () => calls.push('cancel-restore'),
    closeFriendPicker: () => calls.push('close-picker'),
    closeHistoryDetails: () => calls.push('close-history'),
    payments: { ...state.payments, closeSheet: () => calls.push('close-sheet') },
    closeDrawer: () => calls.push('close-drawer'),
    render: () => calls.push('render'), routeDirection: 1
  });
  vm.runInContext(routeSource, context);
  vm.runInContext('syncRouteFromHash()', context);
  assert.equal(context.activeRoute, 'cards');
  assert.deepEqual(calls, [], 'notifications retain their owning route state');

  context.window.location.hash = '#goals';
  vm.runInContext('syncRouteFromHash()', context);
  assert.equal(context.activeRoute, 'goals');
  assert.equal(context.payments.isBillOpen, false);
  assert.equal(context.payments.isReceiptOpen, false);
  assert.equal(context.payments.isDeposit, false);
  assert.equal(context.payments.isFriend, false);
  assert.equal(context.payments.friendBill, null);
  assert.deepEqual(calls, ['reset', 'cancel-restore', 'close-picker', 'close-history', 'close-sheet', 'close-drawer', 'render']);
});

test('Likee deep links map to Pulse and preserve current Pulse state', () => {
  const context = vm.createContext({ activeRoute: 'overview', activeTabs: { pulse: 0 }, pageTabs: { pulse: [] }, window: { location: { hash: '#likee/video/01234567-89ab-cdef-0123-456789abcdef' }, StemmaParentNavigation: { reset() {} } }, cancelPendingNavigationRestoration() {}, closeFriendPicker() {}, closeHistoryDetails() {}, payments: { closeSheet() {} }, closeDrawer() {}, render() {} });
  vm.runInContext(routeSource, context);
  vm.runInContext('syncRouteFromHash()', context);
  assert.equal(context.activeRoute, 'pulse');
  assert.equal(context.activeTabs.pulse, 5);
});

test('app explicitly integrates drawer, bill, receipt, review, picker, history and account reset hooks', () => {
  for (const key of ['drawer', 'bill', 'receipt', 'payment-review', 'friend-picker', 'history-detail']) {
    assert.ok(source.includes(`enterParentNavigation('${key}'`), `${key} entry is wired`);
    assert.ok(source.includes(`backParentNavigation('${key}'`) || source.includes(`request${key === 'history-detail' ? 'HistoryDetails' : key === 'friend-picker' ? 'FriendPicker' : key === 'payment-review' ? 'PaymentReview' : key === 'drawer' ? 'Drawer' : key === 'receipt' ? 'Receipt' : 'Bill'}Back`), `${key} has a close/back path`);
  }
  assert.match(source, /window\.addEventListener\('hashchange', syncRouteFromHash\)/);
  assert.match(source, /window\.addEventListener\('popstate', syncRouteFromHash\)/);
  assert.match(source, /window\.StemmaParentNavigation\?\.reset\(\)/);
});
