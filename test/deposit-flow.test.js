import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const [paymentUi, appSource] = await Promise.all([
  readFile(new URL('payment-ui.js', root), 'utf8'),
  readFile(new URL('app.js', root), 'utf8')
]);

function makeExperience({ dialogOpen = false } = {}) {
  const effects = { fetch: 0, xhr: 0, localStorage: 0, sessionStorage: 0 };
  const dialog = {
    open: dialogOpen,
    close() { this.open = false; },
    showModal() { this.open = true; }
  };
  const context = vm.createContext({
    document: { getElementById: id => id === 'bill-payment-dialog' ? dialog : null },
    icon: name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"></use></svg>`,
    fetch() { effects.fetch += 1; },
    XMLHttpRequest: function XMLHttpRequestStub() { effects.xhr += 1; },
    localStorage: new Proxy({}, { get() { effects.localStorage += 1; throw new Error('localStorage access'); } }),
    sessionStorage: new Proxy({}, { get() { effects.sessionStorage += 1; throw new Error('sessionStorage access'); } })
  });
  const instance = vm.runInContext(`${paymentUi}\nnew PaymentExperience()`, context);
  return { instance, dialog, effects };
}

function extractHandler(source, eventName) {
  const start = source.indexOf(`document.addEventListener('${eventName}'`);
  assert.ok(start >= 0, `app ${eventName} handler exists`);
  const end = source.indexOf('\n});', start) + 4;
  assert.ok(end > start, `app ${eventName} handler closes`);
  return source.slice(start, end);
}

function fireSubmit({ activeRoute = 'cards', activeTab = 1, amountValue = '24.60', openDeposit = () => true } = {}) {
  let listener;
  let prevented = false;
  let rendered = 0;
  let validityMessage;
  let reportValidityCalls = 0;
  const input = {
    value: amountValue,
    setCustomValidity(message) { validityMessage = message; },
    reportValidity() { reportValidityCalls += 1; return false; }
  };
  const form = { id: 'deposit-amount-form' };
  vm.runInNewContext(extractHandler(appSource, 'submit'), {
    document: {
      addEventListener: (_type, callback) => { listener = callback; },
      getElementById: id => id === 'deposit-amount' ? input : null
    },
    activeRoute,
    activeTabs: { cards: activeTab },
    payments: { openDeposit },
    render() { rendered += 1; }
  });
  assert.equal(typeof listener, 'function');
  listener({
    target: form,
    preventDefault() { prevented = true; }
  });
  return { input, prevented, rendered, validityMessage, reportValidityCalls };
}

function fireInput() {
  let listener;
  let cleared = 0;
  vm.runInNewContext(extractHandler(appSource, 'input'), {
    document: { addEventListener: (_type, callback) => { listener = callback; } }
  });
  assert.equal(typeof listener, 'function');
  listener({ target: { id: 'deposit-amount', setCustomValidity(value) { if (value === '') cleared += 1; } } });
  return cleared;
}

function fireAppClick({ payments, activeTab = 1, selector, dialogOpen = false, sheetDialog }) {
  let listener;
  let renders = 0;
  let focused = 0;
  const input = { focus() { focused += 1; } };
  const dialog = sheetDialog ?? { open: dialogOpen };
  vm.runInNewContext(extractHandler(appSource, 'click'), {
    document: {
      addEventListener: (_type, callback) => { listener = callback; },
      querySelectorAll: () => [],
      querySelector: query => query === '#deposit-amount' ? input : query === '#bill-payment-dialog' ? dialog : null
    },
    window: { matchMedia: () => ({ matches: false }) },
    activeRoute: 'cards',
    activeTabs: { cards: activeTab },
    paymentSlideIndex: 0,
    payments,
    render() { renders += 1; },
    renderTabs() {}
  });
  assert.equal(typeof listener, 'function');
  const target = { id: '', closest: requested => requested === `[data-${selector}]` ? target : null };
  listener({ target, preventDefault() {} });
  return { dialog, focused, renders };
}

test('normalizeDepositAmount accepts only bounded decimal ETB values and canonicalizes exactly', () => {
  const context = vm.createContext({});
  vm.runInContext(paymentUi, context);
  const normalize = value => vm.runInContext(`normalizeDepositAmount(${JSON.stringify(value)})`, context);
  const cases = [
    ['0.01', '0.01'], ['.5', '0.50'], ['5', '5.00'], ['5.2', '5.20'],
    ['0005.20', '5.20'], ['000000000.01', '0.01'], ['999999999.99', '999999999.99'],
    [0.1, '0.10'], [999999999.99, '999999999.99'],
    [' 1', '1.00'], ['1 ', '1.00'], ['1\n', '1.00']
  ];
  for (const [value, expected] of cases) assert.equal(normalize(value), expected, `normalizes ${String(value)}`);

  const invalid = [
    '', ' ', '.', '.0', '0', '0.00', '-1', '+1', '1.', '1.000', '1e2', '1E2',
    'NaN', 'Infinity', '1000000000', '999999999.999',
    '1,000', '1 ETB', '1;alert(1)', '<img>', null, undefined,
    true, {}, [], Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0.01, 0
  ];
  for (const value of invalid) assert.equal(normalize(value), null, `rejects ${String(value)}`);
});

test('deposit state is initialized, opens only with a valid canonical amount, and invalid attempts do not mutate it', () => {
  const { instance } = makeExperience();
  assert.equal(instance.isDeposit, false);
  assert.equal(instance.depositAmount, '');
  assert.equal(instance.openDeposit('00012.3'), true);
  assert.equal(instance.depositAmount, '12.30');
  assert.equal(instance.isDeposit, true);
  assert.equal(instance.isBillOpen, true);
  assert.equal(instance.isReceiptOpen, false);

  const before = {
    isDeposit: instance.isDeposit,
    depositAmount: instance.depositAmount,
    isBillOpen: instance.isBillOpen,
    isReceiptOpen: instance.isReceiptOpen
  };
  for (const invalid of ['0', '1.234', '1e2', 'NaN', '9999999999']) {
    assert.equal(instance.openDeposit(invalid), false);
    assert.deepEqual({
      isDeposit: instance.isDeposit,
      depositAmount: instance.depositAmount,
      isBillOpen: instance.isBillOpen,
      isReceiptOpen: instance.isReceiptOpen
    }, before, `invalid amount ${invalid} leaves all deposit state unchanged`);
  }
});

test('deposit bill uses the shared reference details with the entered amount and an inert Pay control', () => {
  const { instance, dialog, effects } = makeExperience();
  assert.equal(instance.openDeposit('000123.45'), true);
  const markup = instance.renderBill();
  const visibleAmountMentions = (markup.match(/123\.45/g) ?? []).length;
  assert.ok(visibleAmountMentions >= 3, 'entered amount appears in bill details, total selection and payment sheet');
  assert.match(markup, /<article class="bill-page telebirr-preview"/);
  assert.match(markup, /Customer Name:<\/span><strong>Customer 001<\/strong>/);
  assert.match(markup, /<th scope="col">Month<\/th><th scope="col">Amount<\/th><th scope="col">Due Date<\/th>/);
  assert.match(markup, /<td>12\/2024<\/td><td>123\.45<small>ETB<\/small><\/td><td class="bill-example-due">27\/01\/2025<\/td>/);
  assert.match(markup, /<span>Total Bill Amount<\/span><strong>123\.45 ETB<\/strong>/);
  assert.match(markup, /<span>Other amount<\/span>/);
  assert.doesNotMatch(markup, /676\.45/);
  assert.match(markup, /Available Balance:701\.00ETB/);
  const dialogTag = markup.match(/<dialog\b[^>]*>/)?.[0];
  assert.ok(dialogTag, 'wallet sheet markup exists');
  assert.doesNotMatch(dialogTag, /\sopen(?:\s|>)/, 'deposit opens on bill details, before the wallet sheet');
  assert.match(markup, /<button class="bill-pay-button"[^>]*\bdisabled\b[^>]*>/);
  assert.doesNotMatch(markup, /data-demo-pay/);
  assert.match(markup, /Visual preview only · Telebirr is not connected\. No payment was sent; Pay is disabled\./);
  assert.equal(instance.isReceiptOpen, false);
  assert.equal(dialog.open, false);
  const continued = fireAppClick({ payments: instance, selector: 'review-bill', sheetDialog: dialog });
  assert.equal(dialog.open, true, 'Continue opens the wallet sheet after the reference bill is reviewed');
  assert.equal(continued.renders, 0, 'opening the sheet does not trigger a receipt or payment render');
  assert.equal(instance.isReceiptOpen, false);
  assert.match(instance.renderBill(), /<p class="bill-sheet-amount"><span>123\.45<\/span><small>ETB<\/small><\/p>/);
  assert.deepEqual(effects, { fetch: 0, xhr: 0, localStorage: 0, sessionStorage: 0 });
});

test('deposit blocks legacy receipt transitions and the regular illustrative bill keeps Pay disabled', () => {
  const { instance, dialog, effects } = makeExperience({ dialogOpen: true });
  assert.equal(instance.openDeposit('24.60'), true);
  const beforeTime = instance.demoReceiptTime;
  instance.openDemoReceipt();
  assert.equal(instance.isReceiptOpen, false);
  assert.equal(instance.demoReceiptTime, beforeTime);
  assert.equal(dialog.open, true, 'rejected deposit receipt does not close the sheet');
  assert.doesNotMatch(instance.renderBill(), /data-demo-pay/);

  const regular = makeExperience({ dialogOpen: true });
  const bill = regular.instance.renderBill();
  assert.match(bill, /676\.45<small>ETB<\/small>/);
  assert.match(bill, /Available Balance:701\.00ETB/);
  assert.match(bill, /<button class="bill-pay-button" type="button" data-bill-pay disabled aria-describedby="bill-sheet-note">Pay<\/button>/);
  assert.doesNotMatch(bill, /data-demo-pay/);
  assert.match(bill, /Visual preview only · Telebirr is not connected\. No payment was sent; Pay is disabled\./);

  // The original receipt renderer and transition method remain unit-testable,
  // but no enabled Pay control exposes that transition to users.
  regular.instance.isBillOpen = true;
  regular.instance.openDemoReceipt();
  assert.equal(regular.instance.isReceiptOpen, true);
  assert.equal(regular.dialog.open, false);
  assert.match(regular.instance.renderReceipt(), /-676\.45 <small>\(ETB\)<\/small>/);
  assert.deepEqual(effects, { fetch: 0, xhr: 0, localStorage: 0, sessionStorage: 0 });
  assert.deepEqual(regular.effects, { fetch: 0, xhr: 0, localStorage: 0, sessionStorage: 0 });
});

test('deposit form markup is numeric, labeled, explicitly non-payment, and cards tab 1 uses its own entry grid', () => {
  const formStart = appSource.indexOf('function renderDepositForm(');
  const formEnd = appSource.indexOf('\nfunction updatePaymentProgress()', formStart);
  assert.ok(formStart >= 0 && formEnd > formStart, 'renderDepositForm is defined before updatePaymentProgress');
  const renderDepositForm = appSource.slice(formStart, formEnd);
  const formMarkup = vm.runInNewContext(`${renderDepositForm}\nrenderDepositForm()`, {
    payments: { depositAmount: '24.60' }
  });
  assert.match(formMarkup, /class="deposit-entry-card"/);
  assert.match(formMarkup, /<form\b[^>]*id="deposit-amount-form"/);
  assert.match(formMarkup, /id="deposit-amount"[^>]*name="amount"[^>]*type="number"[^>]*inputmode="decimal"[^>]*min="0\.01"[^>]*max="999999999\.99"[^>]*step="0\.01"[^>]*required[^>]*value="24\.60"/);
  assert.match(formMarkup, /<label[^>]*for="deposit-amount"[^>]*>\s*Amount of money\s*<\/label>/);
  assert.match(formMarkup, />Deposit<\/button>/);
  assert.match(formMarkup, /ETB/);
  assert.match(formMarkup, /No payment will be sent\./);

  const cardsStart = appSource.indexOf('function renderCards()');
  const cardsEnd = appSource.indexOf('\nfunction render()', cardsStart);
  assert.ok(cardsStart >= 0 && cardsEnd > cardsStart, 'renderCards exists');
  const grid = {
    classList: {
      values: new Set(),
      toggle(name, on) { on ? this.values.add(name) : this.values.delete(name); },
      add(name) { this.values.add(name); },
      remove(name) { this.values.delete(name); },
      contains(name) { return this.values.has(name); }
    },
    attrs: {},
    setAttribute(name, value) { this.attrs[name] = value; },
    removeAttribute(name) { delete this.attrs[name]; },
    innerHTML: ''
  };
  vm.runInNewContext(`${renderDepositForm}\n${appSource.slice(cardsStart, cardsEnd)}\nrenderCards()`, {
    activeRoute: 'cards',
    activeTabs: { cards: 1 },
    payments: { isBillOpen: false, depositAmount: '24.60' },
    document: { getElementById: id => id === 'dashboard-grid' ? grid : null }
  });
  assert.ok(grid.classList.contains('deposit-entry-grid'));
  assert.match(grid.innerHTML, /deposit-amount-form/);
});

test('deposit form submit is delegated, route/tab guarded and validates without rendering invalid values', () => {
  assert.match(appSource, /document\.addEventListener\('submit'/);
  assert.match(appSource, /document\.addEventListener\('input'/);
  let submitted;
  const valid = fireSubmit({ openDeposit: value => { submitted = value; return true; } });
  assert.equal(valid.prevented, true);
  assert.equal(submitted, '24.60');
  assert.equal(valid.rendered, 1);
  assert.equal(valid.validityMessage, undefined);
  assert.equal(fireInput(), 1, 'input handler clears custom validity');

  let invalidCalls = 0;
  const invalid = fireSubmit({ amountValue: '0', openDeposit: () => { invalidCalls += 1; return false; } });
  assert.equal(invalid.prevented, true);
  assert.equal(invalidCalls, 1);
  assert.equal(invalid.rendered, 0);
  assert.ok(invalid.validityMessage, 'invalid amount sets a custom validation message');
  assert.equal(invalid.reportValidityCalls, 1);

  const wrongRoute = fireSubmit({ activeRoute: 'overview', openDeposit: () => { throw new Error('must not open outside cards'); } });
  assert.equal(wrongRoute.prevented, true, 'matching form submission is prevented before route guarding');
  assert.equal(wrongRoute.rendered, 0);
  const wrongTab = fireSubmit({ activeTab: 0, openDeposit: () => { throw new Error('must not open outside deposit tab'); } });
  assert.equal(wrongTab.prevented, true, 'matching form submission is prevented before tab guarding');
  assert.equal(wrongTab.rendered, 0);
});

test('deposit and regular bill navigation maintain their mutually exclusive state', () => {
  assert.match(appSource, /if\s*\(event\.target\.closest\('\[data-open-bill\]'\)\)\s*\{[\s\S]*?payments\.isDeposit\s*=\s*false/);
  assert.match(appSource, /if\s*\(event\.target\.closest\('\[data-bill-back\]'\)\)\s*\{[\s\S]*?payments\.isDeposit\s*=\s*false/);
  assert.match(appSource, /payments\.isDeposit\s*=\s*false/);
  assert.match(appSource, /const wasDeposit = payments\.isDeposit;\s*payments\.isDeposit = false;[\s\S]*?payments\.isBillOpen = false;\s*render\(\);\s*document\.querySelector\(wasDeposit \? '#deposit-amount' : '\.fee-continue'\)/);
  assert.match(paymentUi, /renderBill\(\)\s*\{\s*if\s*\(this\.isDeposit\)\s*return this\.renderDeposit\(\)/);
  assert.match(paymentUi, /renderDeposit\(\)/);
  assert.match(paymentUi, /if\s*\(this\.isDeposit\s*\|\|\s*!this\.isBillOpen\s*\|\|\s*this\.isReceiptOpen\)/);

  const deposit = makeExperience();
  deposit.instance.openDeposit('1250.50');
  const back = fireAppClick({ payments: deposit.instance, selector: 'bill-back' });
  assert.equal(deposit.instance.isDeposit, false);
  assert.equal(deposit.instance.isBillOpen, false);
  assert.equal(deposit.instance.depositAmount, '1250.50', 'deposit amount remains in the form state');
  assert.equal(back.focused, 1, 'back restores focus to the amount input');
  assert.equal(back.renders, 1);

  deposit.instance.isDeposit = true;
  fireAppClick({ payments: deposit.instance, selector: 'open-bill' });
  assert.equal(deposit.instance.isDeposit, false, 'regular bill entry clears deposit mode');
  assert.equal(deposit.instance.isBillOpen, true);

  deposit.instance.isDeposit = true;
  deposit.instance.isBillOpen = true;
  let receiptAttempts = 0;
  deposit.instance.openDemoReceipt = () => { receiptAttempts += 1; };
  const pay = fireAppClick({ payments: deposit.instance, selector: 'demo-pay', dialogOpen: true });
  assert.equal(receiptAttempts, 0, 'deposit mode rejects the demo Pay click');
  assert.equal(pay.renders, 0);
  assert.equal(deposit.instance.isReceiptOpen, false);
});
