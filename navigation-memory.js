/* Account-scoped, local-only navigation UI memory. Never stores financial or identity data. */
(function attachStemmaNavigationMemory(root) {
  'use strict';

  const ROUTES = Object.freeze(['overview', 'cards', 'activity', 'goals', 'profile']);
  const TAB_KEYS = Object.freeze(['overview', 'cards', 'activity', 'goals', 'profile']);
  const INTERVALS = Object.freeze(['15-days', '1-month', '2-months', '3-months']);
  const VIEWS = Object.freeze(['main', 'bill', 'sheet', 'receipt', 'history-details']);
  const STORAGE_PREFIX = 'stemma:navigation:v1:';
  const MAX_JSON_BYTES = 8 * 1024;

  function defaults() {
    return {
      version: 1,
      route: 'overview',
      tabs: { overview: 0, cards: 0, activity: 0, goals: 0, profile: 0 },
      paymentSlide: 0,
      interval: '15-days',
      view: 'main',
      isDeposit: false,
      depositAmount: '',
      receiptTime: '',
      historyId: '',
      scrollTop: 0
    };
  }

  function normalizeDepositAmount(value) {
    if (typeof value !== 'string') return null;
    const raw = value.trim();
    if (!/^(?:\d{1,9}(?:\.\d{1,2})?|\.\d{1,2})$/.test(raw)) return null;
    const [integer, fraction = ''] = raw.split('.');
    const amount = `${(integer || '0').replace(/^0+(?=\d)/, '')}.${fraction.padEnd(2, '0')}`;
    return amount === '0.00' ? null : amount;
  }

  function isStrictReceiptTime(value) {
    if (value === '') return true;
    if (typeof value !== 'string') return false;
    const match = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
    if (!match) return false;
    const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const hour = Number(hourText);
    const minute = Number(minuteText);
    const second = Number(secondText);
    const date = new Date(Date.UTC(year, month - 1, day));
    return year >= 1 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day && hour <= 23 && minute <= 59 && second <= 59;
  }

  function isHistoryId(value) {
    return value === '' || (typeof value === 'string' && /^STM-\d{8}-\d{3}$/.test(value));
  }

  function sanitize(state) {
    if (!state || typeof state !== 'object' || Array.isArray(state) || state.version !== 1 ||
        typeof state.route !== 'string' || !ROUTES.includes(state.route)) return null;

    const result = defaults();
    result.route = state.route;
    const tabs = state.tabs && typeof state.tabs === 'object' && !Array.isArray(state.tabs) ? state.tabs : {};
    for (const key of TAB_KEYS) {
      if (Number.isInteger(tabs[key]) && tabs[key] >= 0 && tabs[key] <= 2) result.tabs[key] = tabs[key];
    }
    if (state.paymentSlide === 0 || state.paymentSlide === 1) result.paymentSlide = state.paymentSlide;
    if (typeof state.interval === 'string' && INTERVALS.includes(state.interval)) result.interval = state.interval;
    if (typeof state.view === 'string' && VIEWS.includes(state.view)) result.view = state.view;
    if (typeof state.isDeposit === 'boolean') result.isDeposit = state.isDeposit;
    if (typeof state.scrollTop === 'number' && Number.isInteger(state.scrollTop) && state.scrollTop >= 0 && state.scrollTop <= 1000000) {
      result.scrollTop = state.scrollTop;
    }

    if (typeof state.receiptTime === 'string' && isStrictReceiptTime(state.receiptTime)) result.receiptTime = state.receiptTime;
    if (isHistoryId(state.historyId)) result.historyId = state.historyId;
    const amount = normalizeDepositAmount(state.depositAmount);
    if (amount) result.depositAmount = amount;

    // Non-card routes never retain payment/history dialog state or its metadata.
    if (result.route !== 'cards') {
      result.view = 'main';
      result.isDeposit = false;
      result.depositAmount = '';
      result.receiptTime = '';
      result.historyId = '';
      return result;
    }

    // History has its own tab and can only show the main list or a valid transaction detail.
    if (result.tabs.cards === 2) {
      result.isDeposit = false;
      result.depositAmount = '';
      result.receiptTime = '';
      if (result.view !== 'main' && !(result.view === 'history-details' && result.historyId !== '')) {
        result.view = 'main';
        result.historyId = '';
      }
      if (result.view === 'main') result.historyId = '';
      return result;
    }

    result.historyId = '';
    if (result.view === 'history-details') result.view = 'main';
    if (result.view !== 'main' && result.view !== 'bill' && result.view !== 'sheet' && result.view !== 'receipt') {
      result.view = 'main';
    }
    if (result.isDeposit) {
      if (result.tabs.cards !== 1 || result.view === 'main' || !result.depositAmount) {
        result.view = 'main';
        result.isDeposit = false;
        result.depositAmount = '';
        result.receiptTime = '';
      }
    } else {
      if (result.tabs.cards === 1 && result.view !== 'main') result.view = 'main';
      if (result.tabs.cards !== 1 || result.view !== 'main') result.depositAmount = '';
    }
    if (result.view !== 'receipt') result.receiptTime = '';
    return result;
  }

  function utf8ByteLength(value) {
    let bytes = 0;
    for (let i = 0; i < value.length; i += 1) {
      const code = value.charCodeAt(i);
      if (code < 0x80) bytes += 1;
      else if (code < 0x800) bytes += 2;
      else if (code >= 0xD800 && code <= 0xDBFF && i + 1 < value.length &&
          value.charCodeAt(i + 1) >= 0xDC00 && value.charCodeAt(i + 1) <= 0xDFFF) {
        bytes += 4;
        i += 1;
      } else bytes += 3;
      if (bytes > MAX_JSON_BYTES) return bytes;
    }
    return bytes;
  }

  class StemmaNavigationMemory {
    constructor(storage) {
      if (storage === undefined) {
        try { storage = root.localStorage; } catch (_) { storage = null; }
      }
      this.storage = storage || null;
    }

    static sanitize(state) {
      return sanitize(state);
    }

    load(accountKey) {
      if (typeof accountKey !== 'string' || accountKey.length === 0 || !this.storage) return null;
      let key;
      try { key = STORAGE_PREFIX + encodeURIComponent(accountKey); } catch (_) { return null; }
      try {
        const raw = this.storage.getItem(key);
        if (typeof raw !== 'string' || utf8ByteLength(raw) > MAX_JSON_BYTES) return null;
        const parsed = JSON.parse(raw);
        return sanitize(parsed);
      } catch (_) {
        return null;
      }
    }

    save(accountKey, state) {
      if (typeof accountKey !== 'string' || accountKey.length === 0 || !this.storage) return false;
      let key;
      try { key = STORAGE_PREFIX + encodeURIComponent(accountKey); } catch (_) { return false; }
      const clean = sanitize(state);
      if (!clean) return false;
      try {
        const serialized = JSON.stringify(clean);
        if (utf8ByteLength(serialized) > MAX_JSON_BYTES) return false;
        this.storage.setItem(key, serialized);
        return true;
      } catch (_) {
        return false;
      }
    }
  }

  root.StemmaNavigationMemory = StemmaNavigationMemory;
})(globalThis);
