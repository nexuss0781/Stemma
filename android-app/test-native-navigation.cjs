const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(new URL('./native-navigation.js', `file://${__filename}`), 'utf8');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function environment({ account = 'student@example.test', hash = '', pathname = '/', saved = null, attendance = false, screen = '/' } = {}) {
  const listeners = new Map();
  const calls = { appRestore: [], pulseRestore: [], groupRestore: [], channelRestore: [], directRestore: [], attendanceRestore: [], removed: [], replaced: [], windowScroll: [] };
  const values = new Map();
  const keyRequests = [];
  const grid = { scrollTop: 0, scrollLeft: 0, clientWidth:390 };
  let authenticated = false;
  const app = attendance ? null : {
    isAuthenticated: () => authenticated,
    capture: () => ({ route: 'pulse', tabs: { pulse: 3 }, paymentSlide: 0 }),
    restore: state => { calls.appRestore.push(state); return authenticated; }
  };
  const api = attendance ? {
    isAuthenticated: () => authenticated,
    capture: () => ({ date: '2026-10-20', month: '2026-10', reportOpen: true, scroll: { reportWrapLeft: 321 } }),
    restore: value => { calls.attendanceRestore.push(value); return true; }
  } : null;
  const persistence = {
    async get(key) {
      keyRequests.push(key);
      if (key.startsWith('stemma-screen-v1-')) return screen;
      return saved;
    },
    async set(key, raw) { values.set(key, raw); },
    async remove(key) { calls.removed.push(key); values.delete(key); }
  };
  const root = {
    StemmaNative: { persistence, get account() { return account; } },
    location: { hash, pathname, search: '', replace: path => calls.replaced.push(path) },
    __StemmaAndroidInitialHash: hash,
    __StemmaAndroidInitialPath: pathname,
    document: { getElementById: id => id === 'dashboard-grid' ? grid : null },
    scrollY: 0,
    scrollTo: (...args) => calls.windowScroll.push(args),
    addEventListener(type, fn) { const stack = listeners.get(type) || []; stack.push(fn); listeners.set(type, stack); },
    dispatch(type, detail = {}) { for (const fn of listeners.get(type) || []) fn({ type, detail }); },
    clearTimeout,
    setTimeout,
    requestAnimationFrame: fn => queueMicrotask(fn),
    console: { warn() {} },
    URLSearchParams,
    TextEncoder,
    set authenticated(value) { authenticated = value; }
  };
  root.window = root;
  if (app) root.StemmaAndroidAppState = app;
  if (attendance) root.StemmaAndroidAttendanceState = api;
  if (!attendance) {
    root.StemmaAndroidPulseNavigation = { capture: () => ({ tab: 3, searchOpen: true, searchTab: 2, searchQuery: 'café', stage: 2 }), restore: async value => { calls.pulseRestore.push(value); } };
    root.StemmaAndroidGroups = { capture: () => ({ groupId: '', groupQuery: '', scroll: {} }), restore: async (...args) => { calls.groupRestore.push(args); } };
    root.StemmaAndroidChannels = { capture: () => ({}), restore: async (...args) => { calls.channelRestore.push(args); } };
    root.StemmaAndroidPulseData = { capture: () => ({ directId: '', savedOpen: false, scroll: {} }), restoreDirect: async (...args) => { calls.directRestore.push(args); } };
  }
  vm.runInNewContext(source, { window: root, globalThis: root, TextEncoder, URLSearchParams, BigInt, console: root.console, setTimeout, clearTimeout, Promise, Map, Set, Object, Number, String, Math, JSON, RegExp });
  return { root, calls, values, keyRequests, grid };
}

(async () => {
  const saved = JSON.stringify({ version: 1, route: 'pulse', document: '/', tabs: { pulse: 3 }, pulse: { tab: 3, stage: 2, searchOpen: true, searchTab: 2, searchQuery: 'café', groupId: '42', groupInfo: true, scroll: { groupMessagesTop: 800 } }, attendance: {} });
  const app = environment({ hash: '', saved });
  app.root.dispatch('stemma:account-ready');
  await wait(10);
  assert.equal(app.calls.appRestore.length, 0, 'no navigation restore before auth confirmation');
  app.root.authenticated = true;
  app.root.dispatch('stemma:android-app-auth-ready', { authenticated: true });
  await wait(20);
  assert.equal(app.calls.appRestore.length, 1);
  assert.equal(app.calls.pulseRestore[0].stage, 2, 'Pulse stage survives validation');
  assert.equal(app.calls.groupRestore[0][0], '42', 'selected group restored through explicit API');
  assert.match(app.keyRequests.find(key => key.startsWith('stemma-nav-v1-')), /^stemma-nav-v1-[a-f0-9]{16}$/);
  assert.ok(app.keyRequests.every(key => /^[A-Za-z0-9._-]{1,128}$/.test(key)), 'all persistence keys satisfy native plugin grammar');
  assert.equal(await app.root.StemmaAndroidNavigation.persist(), true);
  const stored = [...app.values.values()].find(value => value.includes('"route":"pulse"'));
  assert.ok(stored && !stored.includes('password') && !stored.includes('secret'), 'capture stores navigation only, never credentials');
  app.root.dispatch('stemma:account-cleared');
  await wait(0);
  assert.ok(app.calls.removed.some(key => key.startsWith('stemma-nav-v1-')), 'account clearing removes the current account state');

  const attendance = environment({ pathname: '/system-apps/attendance/index.html', attendance: true,
    saved: JSON.stringify({ version: 1, route: 'overview', document: '/system-apps/attendance/index.html', tabs: {}, pulse: {}, attendance: { date: '2026-10-20', month: '2026-10', reportOpen: true, scroll: { reportWrapLeft: 321 } } }) });
  attendance.root.dispatch('stemma:account-ready');
  attendance.root.authenticated = true;
  attendance.root.dispatch('stemma:android-app-auth-ready', { authenticated: true });
  await wait(20);
  assert.equal(attendance.calls.attendanceRestore.length, 1, 'attendance document restores without the main-app bridge');
  assert.equal(attendance.calls.appRestore.length, 0);
  assert.ok(attendance.keyRequests.some(key => key.startsWith('stemma-att-v1-')), 'attendance uses its own account-scoped record');

  const lastScreen = environment({ screen: '/system-apps/attendance/index.html', saved: null });
  lastScreen.root.dispatch('stemma:account-ready');
  await wait(1);
  assert.deepEqual(lastScreen.calls.replaced, [], 'last screen is not restored before auth succeeds');
  lastScreen.root.authenticated = true;
  lastScreen.root.dispatch('stemma:android-app-auth-ready', { authenticated: true });
  await wait(20);
  assert.deepEqual(lastScreen.calls.replaced, ['/system-apps/attendance/index.html'], 'cold root launch returns to last authenticated attendance document');

  const deeplink = environment({ hash: '#apps', screen: '/system-apps/attendance/index.html', saved });
  deeplink.root.dispatch('stemma:account-ready');
  deeplink.root.authenticated = true;
  deeplink.root.dispatch('stemma:android-app-auth-ready', { authenticated: true });
  await wait(10);
  assert.deepEqual(deeplink.calls.replaced, [], 'explicit deep links override last-screen redirect');
  assert.equal(deeplink.calls.appRestore[0]?.tabs?.pulse, 4, '#apps selects the Pulse Apps tab');
  assert.equal(deeplink.calls.groupRestore.length, 0, 'deep links do not reopen stale nested conversations');

  const swipeState={version:1,route:'cards',tabs:{cards:0,overview:2,profile:1},paymentSlide:1,scroll:{mainTop:27,mainLeft:0,windowY:0}};
  assert.equal(await deeplink.root.StemmaAndroidNavigation.restore(swipeState,{userInitiated:true}),true);
  assert.equal(deeplink.calls.appRestore.at(-1).route,'cards','deliberate swipe is not overridden by the old #apps launch link');
  assert.equal(deeplink.calls.appRestore.at(-1).tabs.overview,2,'other selected filters survive swipe restoration');
  assert.equal(deeplink.grid.scrollLeft,390,'Pay fee selected slide determines carousel position, not stale left scroll');
  assert.equal(deeplink.grid.scrollTop,27);
  assert.deepEqual(deeplink.calls.windowScroll.at(-1),[0,0],'zero window scroll is explicitly restored');
  assert.equal(deeplink.root.__StemmaAndroidInitialHash,'#apps','swiping never mutates the recorded launch link');
  deeplink.root.__StemmaAndroidAuthReturn=true;
  assert.equal(await deeplink.root.StemmaAndroidNavigation.restore(swipeState),false,'automatic restore remains blocked during auth-return launch');
  assert.equal(await deeplink.root.StemmaAndroidNavigation.restore(swipeState,{userInitiated:true}),true,'authenticated deliberate navigation works after auth-return');
  deeplink.root.dispatch('stemma:account-cleared');
  assert.equal(await deeplink.root.StemmaAndroidNavigation.restore(swipeState,{userInitiated:true}),false,'swipes cannot bypass account authentication');

  console.log('Android navigation persistence tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
