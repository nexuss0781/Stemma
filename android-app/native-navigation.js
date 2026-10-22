/* Android-only UI navigation persistence. It stores navigation/filter/scroll metadata only. */
(function attachStemmaAndroidNavigation(root) {
  'use strict';
  const VERSION = 1;
  const KEY_PREFIX = 'stemma-nav-v1-';
  const ATTENDANCE_KEY_PREFIX = 'stemma-att-v1-';
  const SCREEN_KEY_PREFIX = 'stemma-screen-v1-';
  const ATTENDANCE_PATH = '/system-apps/attendance/index.html';
  const MAX_STATE_CHARS = 12000;
  const MAX_SCROLL = 1000000;
  const ID = /^(?:[1-9]\d{0,18})$/;
  const ROUTES = new Set(['overview', 'cards', 'pulse', 'likee', 'profile']);
  const TAB_MAX = Object.freeze({ overview: 2, cards: 2, pulse: 4, profile: 2, likee: 0 });
  let account = '';
  let accountReady = false;
  let authAllowed = false;
  let activeKey = '';
  let timer = 0;
  let restoring = false;
  let disposed = false;

  const native = () => root.StemmaNative;
  const persistence = () => native()?.persistence;
  const accountValue = () => {
    try { return typeof native()?.account === 'string' ? native().account.trim().slice(0, 320) : ''; }
    catch (_) { return ''; }
  };
  function hashAccount(value) {
    // Stable FNV-1a 64-bit account fingerprint; raw account identifiers never appear in plugin keys.
    let hash = 0xcbf29ce484222325n;
    for (const byte of new TextEncoder().encode(value)) { hash ^= BigInt(byte); hash = BigInt.asUintN(64, hash * 0x100000001b3n); }
    return KEY_PREFIX + hash.toString(16).padStart(16, '0');
  }
  function storageKey(prefix, value) { return prefix + hashAccount(value).slice(KEY_PREFIX.length); }
  const boundedScroll = value => Number.isFinite(Number(value)) ? Math.max(0, Math.min(MAX_SCROLL, Math.round(Number(value)))) : 0;
  function cleanNested(value) {
    const out = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
    for (const key of ['tab', 'stage', 'route', 'type', 'id', 'searchOpen', 'searchTab', 'searchQuery', 'groupQuery', 'groupInfo', 'savedOpen', 'directId', 'channelId', 'groupId', 'date', 'month', 'reportOpen']) {
      const item = value[key];
      if (typeof item === 'string') out[key] = item.slice(0, 160);
      else if (typeof item === 'boolean' || Number.isInteger(item)) out[key] = item;
    }
    if (value.scroll && typeof value.scroll === 'object') {
      out.scroll = {};
      for (const [key, item] of Object.entries(value.scroll).slice(0, 16)) out.scroll[key] = boundedScroll(item);
    }
    return out;
  }
  function sanitize(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || input.version !== VERSION || !ROUTES.has(input.route)) return null;
    const result = { version: VERSION, route: input.route, document: input.document === ATTENDANCE_PATH ? ATTENDANCE_PATH : '/', tabs: {}, paymentSlide: 0, scroll: {}, pulse: {}, attendance: {} };
    for (const [route, max] of Object.entries(TAB_MAX)) {
      const value = input.tabs?.[route]; result.tabs[route] = Number.isInteger(value) ? Math.max(0, Math.min(max, value)) : 0;
    }
    if (input.paymentSlide === 1) result.paymentSlide = 1;
    if (input.scroll && typeof input.scroll === 'object') {
      for (const key of ['mainTop', 'mainLeft', 'windowY']) result.scroll[key] = boundedScroll(input.scroll[key]);
    }
    result.pulse = cleanNested(input.pulse);
    result.attendance = cleanNested(input.attendance);
    if (result.pulse.id && !ID.test(result.pulse.id)) delete result.pulse.id;
    if (result.pulse.groupId && !ID.test(result.pulse.groupId)) delete result.pulse.groupId;
    if (result.pulse.channelId && !ID.test(result.pulse.channelId)) delete result.pulse.channelId;
    if (result.pulse.directId && !ID.test(result.pulse.directId)) delete result.pulse.directId;
    if (result.pulse.searchTab != null) result.pulse.searchTab = Math.max(0, Math.min(4, Number(result.pulse.searchTab) || 0));
    if (typeof result.pulse.searchQuery === 'string') result.pulse.searchQuery = result.pulse.searchQuery.slice(0, 80);
    if (typeof result.pulse.groupQuery === 'string') result.pulse.groupQuery = result.pulse.groupQuery.slice(0, 80);
    if (typeof result.attendance.date === 'string' && !/^\d{4}-\d{2}-\d{2}$/.test(result.attendance.date)) delete result.attendance.date;
    if (typeof result.attendance.month === 'string' && !/^\d{4}-(0[1-9]|1[0-2])$/.test(result.attendance.month)) delete result.attendance.month;
    return result;
  }
  function appState() { return root.StemmaAndroidAppState || null; }
  function pulseState() { return root.StemmaAndroidPulseNavigation || null; }
  function groupState() { return root.StemmaAndroidGroups || null; }
  function channelState() { return root.StemmaAndroidChannels || null; }
  function dataState() { return root.StemmaAndroidPulseData || null; }
  function attendanceState() { return root.StemmaAndroidAttendanceState || null; }
  function capture() {
    const app = appState();
    const base = app?.capture?.() || {};
    const main = root.document?.getElementById('dashboard-grid');
    const pulse = pulseState()?.capture?.() || {};
    const group = groupState()?.capture?.() || {};
    const channel = channelState()?.capture?.() || {};
    const data = dataState()?.capture?.() || {};
    const attend = attendanceState()?.capture?.() || {};
    const mergedPulse = base.route === 'pulse' ? { ...pulse, ...data } : {};
    if (typeof group.groupQuery === 'string') mergedPulse.groupQuery = group.groupQuery;
    if (group.scroll) mergedPulse.scroll = { ...(mergedPulse.scroll || {}), ...group.scroll };
    if (channel.scroll) mergedPulse.scroll = { ...(mergedPulse.scroll || {}), ...channel.scroll };
    if (group.groupId) { mergedPulse.groupId = group.groupId; mergedPulse.groupInfo = group.groupInfo; mergedPulse.scroll = { ...(mergedPulse.scroll || {}), ...(group.scroll || {}) }; }
    if (channel.channelId) { mergedPulse.channelId = channel.channelId; mergedPulse.scroll = { ...(mergedPulse.scroll || {}), ...(channel.scroll || {}) }; }
    return sanitize({
      version: VERSION,
      route: base.route || 'overview',
      document: !appState() && attendanceState() ? ATTENDANCE_PATH : '/',
      tabs: base.tabs || {},
      paymentSlide: base.paymentSlide || 0,
      scroll: { mainTop: main?.scrollTop || 0, mainLeft: main?.scrollLeft || 0, windowY: root.scrollY || 0 },
      pulse: mergedPulse,
      attendance: attend
    });
  }
  async function persistNow() {
    if (disposed || restoring || !accountReady || !authAllowed || !account || !activeKey) return false;
    const store = persistence();
    if (!store || typeof store.set !== 'function') return false;
    const state = capture();
    if (!state) return false;
    let raw;
    try { raw = JSON.stringify(state); } catch (_) { return false; }
    if (raw.length > MAX_STATE_CHARS) return false;
    try {
      await store.set(activeKey, raw);
      await store.set(storageKey(SCREEN_KEY_PREFIX, account), !appState() && attendanceState() ? ATTENDANCE_PATH : '/');
      return true;
    } catch (_) { return false; }
  }
  function scheduleSave() {
    if (!accountReady || !authAllowed || restoring || disposed) return;
    root.clearTimeout(timer);
    timer = root.setTimeout(() => { void persistNow(); }, 450);
  }
  function scrollTo(element, top, left) {
    if (!element) return;
    element.scrollTop = boundedScroll(top);
    if (left !== undefined) element.scrollLeft = boundedScroll(left);
  }
  async function restoreNested(state) {
    const pulse = state.pulse || {};
    if (state.route !== 'pulse') return;
    const mainPulse = pulseState();
    if (mainPulse) await mainPulse.restore?.(pulse);
    if (pulse.groupId) await groupState()?.restore?.(pulse.groupId, pulse.groupInfo, pulse.scroll || {}, pulse.groupQuery || '');
    else if (pulse.channelId) await channelState()?.restore?.(pulse.channelId, pulse.scroll || {});
    else if (pulse.directId) await dataState()?.restoreDirect?.(pulse.directId, pulse.scroll || {});
    else if (pulse.savedOpen) await dataState()?.restoreSaved?.(pulse.scroll || {});
  }
  async function restoreAttendance(state) {
    const value = state.attendance;
    if (!value || (!value.date && !value.month && !value.reportOpen)) return;
    await attendanceState()?.restore?.(value);
  }
  async function restore(state) {
    if (!authAllowed || !accountReady || !account) return false;
    let clean = sanitize(state);
    if (!clean || root.__StemmaAndroidAuthReturn || new URLSearchParams(root.location?.search || '').has('auth')) return false;
    const app = appState();
    const attendanceOnly = !app && Boolean(attendanceState());
    if (!app && !attendanceOnly) return false;
    const launchPath = String(root.__StemmaAndroidInitialPath ?? root.location?.pathname ?? '/');
    if (!attendanceOnly && launchPath !== '/' && !launchPath.endsWith('/index.html')) return false;
    const hash = String(root.__StemmaAndroidInitialHash ?? root.location?.hash ?? '').replace(/^#/, '');
    const explicitLink = Boolean(hash);
    if (hash) {
      const linkedRoute = hash === 'apps' ? 'pulse' : hash === 'goals' ? 'likee' : hash.split('/')[0];
      if (!ROUTES.has(linkedRoute)) return false;
      clean = { ...clean, route: linkedRoute, tabs: { overview: 0, cards: 0, pulse: hash === 'apps' ? 4 : 0, profile: 0, likee: 0 } };
    }
    if (app && !app.restore?.(clean)) return false;
    restoring = true;
    try {
      await new Promise(resolve => root.requestAnimationFrame(() => root.requestAnimationFrame(resolve)));
      if (!authAllowed || account !== accountValue()) return false;
      if (app && !explicitLink) await restoreNested(clean);
      if (!explicitLink) await restoreAttendance(clean);
      if (app) {
        const main = root.document?.getElementById('dashboard-grid');
        scrollTo(main, clean.scroll.mainTop, clean.scroll.mainLeft);
        if (clean.scroll.windowY) root.scrollTo?.(0, clean.scroll.windowY);
      }
      return true;
    } catch (error) { console.warn('Android navigation restore skipped', error); return false; }
    finally { restoring = false; }
  }
  async function loadAndRestore() {
    if (!accountReady || !authAllowed || !account || disposed) return false;
    const currentAccount = account;
    const attendanceOnly = !appState() && Boolean(attendanceState());
    activeKey = storageKey(attendanceOnly ? ATTENDANCE_KEY_PREFIX : KEY_PREFIX, currentAccount);
    const store = persistence();
    if (!store || typeof store.get !== 'function') return false;
    if (!attendanceOnly && String(root.__StemmaAndroidInitialPath ?? root.location?.pathname ?? '/') === '/' &&
        !root.__StemmaAndroidAuthReturn &&
        !String(root.__StemmaAndroidInitialHash ?? root.location?.hash ?? '') && !new URLSearchParams(root.location?.search || '').has('auth')) {
      try {
        const lastDocument = await store.get(storageKey(SCREEN_KEY_PREFIX, currentAccount));
        if (currentAccount !== account || !authAllowed) return false;
        if (lastDocument === ATTENDANCE_PATH) { root.location?.replace?.(ATTENDANCE_PATH); return true; }
      } catch (_) { /* The main navigation record remains usable if screen metadata is unavailable. */ }
    }
    let raw;
    try { raw = await store.get(activeKey); } catch (_) { return false; }
    if (currentAccount !== account || !authAllowed || typeof raw !== 'string' || raw.length > MAX_STATE_CHARS) return false;
    let state;
    try { state = sanitize(JSON.parse(raw)); } catch (_) { return false; }
    return state ? restore(state) : false;
  }
  function setAccountReady() {
    const value = accountValue();
    if (!value) return;
    account = value;
    accountReady = true;
    void loadAndRestore();
  }
  function onAuthReady(event) {
    authAllowed = event?.detail?.authenticated === true && Boolean(accountValue());
    if (!authAllowed) { root.clearTimeout(timer); return; }
    if (accountReady) void loadAndRestore();
  }
  function clearAccount() {
    root.clearTimeout(timer);
    const oldAccount = account;
    const oldKey = activeKey;
    account = ''; accountReady = false; authAllowed = false; activeKey = '';
    if (oldKey) { try { void persistence()?.remove?.(oldKey); } catch (_) {} }
    if (oldAccount) {
      for (const key of [storageKey(KEY_PREFIX, oldAccount), storageKey(ATTENDANCE_KEY_PREFIX, oldAccount), storageKey(SCREEN_KEY_PREFIX, oldAccount)]) {
        try { void persistence()?.remove?.(key); } catch (_) {}
      }
    }
  }
  function onAccountReady() { setAccountReady(); }
  root.addEventListener?.('stemma:account-ready', onAccountReady);
  root.addEventListener?.('stemma:account-cleared', clearAccount);
  root.addEventListener?.('stemma:android-app-auth-ready', onAuthReady);
  root.addEventListener?.('stemma:android-auth-denied', () => { authAllowed = false; root.clearTimeout(timer); });
  root.addEventListener?.('click', scheduleSave, true);
  root.addEventListener?.('input', event => {
    // Search text is navigation state; credentials, payment amounts, and message drafts are never captured.
    if (event.target?.matches?.('#pulse-search-input,[data-group-discovery]')) scheduleSave();
  }, true);
  root.addEventListener?.('scroll', scheduleSave, true);
  root.addEventListener?.('change', scheduleSave, true);
  root.addEventListener?.('hashchange', scheduleSave);
  root.addEventListener?.('pagehide', () => { void persistNow(); });
  root.addEventListener?.('stemma:checkpoint', () => { void persistNow(); });
  root.StemmaAndroidNavigation = Object.freeze({ capture, restore, persist: persistNow, get accountReady() { return accountReady && authAllowed; } });
  if (accountValue()) setAccountReady();
  if (appState()?.isAuthenticated?.()) onAuthReady({ detail: { authenticated: true } });
  if (attendanceState()?.isAuthenticated?.()) onAuthReady({ detail: { authenticated: true } });
})(typeof window !== 'undefined' ? window : globalThis);
