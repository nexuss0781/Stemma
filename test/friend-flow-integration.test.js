import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const [appSource, friendUi, paymentUi] = await Promise.all([
  readFile(new URL('../app.js', import.meta.url), 'utf8'),
  readFile(new URL('../friend-ui.js', import.meta.url), 'utf8'),
  readFile(new URL('../payment-ui.js', import.meta.url), 'utf8')
]);
const friendStart = appSource.indexOf('function friendContextActive()');
const friendEnd = appSource.indexOf('function updatePaymentProgress()', friendStart);
assert.ok(friendStart >= 0 && friendEnd > friendStart, 'app friend handlers are present');
const friendHandlers = appSource.slice(friendStart, friendEnd);
const clickStart = appSource.indexOf("document.addEventListener('click', event => {");
const clickEnd = appSource.indexOf("document.addEventListener('keydown', event => {", clickStart);
assert.ok(clickStart >= 0 && clickEnd > clickStart, 'app delegated click handler is present');
const clickHandler = appSource.slice(clickStart, clickEnd);

function student(overrides = {}) {
  const billId = overrides.billId ?? 'bill_2026-10';
  return {
    billId, username: 'Aster.Student', firstName: 'Aster', lastName: 'Bekele', amountDue: '1234.50',
    currency: 'ETB', photoURL: `/api/friend-bills/${encodeURIComponent(billId)}/photo`, month: '2026-10', dueDate: '2026-11-05',
    ...overrides
  };
}

function makeApp({ authenticated = true, detail = async () => student() } = {}) {
  const calls = [];
  const saved = { navigation: 0, render: 0, opened: [] };
  const elements = {};
  let friendsFlow;
  let dialog;
  const document = {
    getElementById(id) { return elements[id] || null; },
    querySelectorAll() { return []; },
    addEventListener(type, handler) { if (type === 'click') this.clickHandler = handler; }
  };
  const closeButton = { focusOptions: null, focus(options) { this.focusOptions = options; } };
  const dialogChoices = [];
  dialog = {
    open: false, innerHTML: '', listeners: [],
    showModal() { this.open = true; },
    close() { this.open = false; },
    addEventListener(type, fn, options) { this.listeners.push({ type, fn, options }); },
    querySelectorAll(selector) { return selector === '[data-friend-student]' ? dialogChoices : []; },
    querySelector(selector) { return selector === '[data-close-friend-picker]' ? closeButton : null; }
  };
  Object.defineProperty(dialog, 'innerHTML', {
    get() { return this._html || ''; },
    set(value) {
      this._html = value;
      dialogChoices.splice(0, dialogChoices.length, ...friendsFlow.students.map(item => ({
        dataset: { friendStudent: item.billId }, focusOptions: null,
        focus(options) { this.focusOptions = options; }
      })));
    }
  });
  elements['friend-student-dialog'] = dialog;
  const payments = {
    isBillOpen: false, isFriend: false, isDeposit: false, isReceiptOpen: false,
    openFriendBill(item) { saved.opened.push(item); this.isFriend = true; this.isBillOpen = true; return true; }
  };
  const window = {
    fetch: async (path, options) => {
      calls.push({ path, options });
      if (path.startsWith('/api/friend-bills?')) return { ok: true, async json() { return { students: [student()] }; } };
      const value = await detail(path);
      if (value instanceof Error) return { ok: false, status: value.status, async json() { return {}; } };
      return { ok: true, async json() { return { student: value }; } };
    }
  };
  const context = vm.createContext({
    document, window, payments, activeRoute: 'cards', activeTabs: { cards: 0 }, paymentSlideIndex: 1,
    googleAuthenticated: authenticated, navigationAccountKey: 'google:test', friendInteractionToken: 0,
    queueNavigationSave() { saved.navigation += 1; }, render() { saved.render += 1; },
    enterParentNavigation: key => key,
    forgetParentNavigation() {},
    backParentNavigation(_key, close) { close(); return false; },
    closeBill() {},
    icon: () => '',
    normalizeDepositAmount: null
  });
  context.normalizeDepositAmount = vm.runInContext(`${paymentUi}\nnormalizeDepositAmount`, context);
  vm.runInContext(friendUi, context);
  context.friends = vm.runInContext('new FriendPaymentFlow()', context);
  friendsFlow = context.friends;
  vm.runInContext(`${friendHandlers}\n${clickHandler}`, context);
  const call = vm.runInContext('({ openFriendPicker, confirmFriendSelection, closeFriendPicker })', context);
  function clickChoice(billId) {
    const choice = { dataset: { friendStudent: billId } };
    const target = { closest(selector) { return selector === '[data-friend-student]' ? choice : null; } };
    document.clickHandler({ target });
  }
  function clickClose() {
    const target = { closest(selector) { return selector === '[data-close-friend-picker]' ? {} : null; } };
    document.clickHandler({ target });
  }
  return { ...call, calls, saved, dialog, payments, friends: context.friends, clickChoice, clickClose, closeButton, dialogChoices };
}

async function openAndSelect(app, selectedId = 'bill_2026-10') {
  assert.equal(await app.openFriendPicker('ast'), true);
  assert.equal(app.dialog.open, true);
  app.clickChoice(selectedId);
  assert.equal(app.friends.selectedBillId, selectedId, 'the real delegated click handler selects the student');
  return app.friends.selected;
}

test('actual delegated selection is confirmed only after a fresh GET revalidation', async () => {
  const app = makeApp();
  await openAndSelect(app);
  await app.confirmFriendSelection();
  assert.equal(app.calls.length, 2);
  assert.equal(app.calls[0].path, '/api/friend-bills?username=ast');
  assert.equal(app.calls[1].path, '/api/friend-bills/bill_2026-10');
  assert.ok(app.calls.every(call => call.options.method === 'GET' && call.options.credentials === 'same-origin'));
  assert.equal(app.saved.opened.length, 1);
  assert.equal(app.saved.opened[0].amountDue, '1234.50');
  assert.equal(app.dialog.open, false);
});

test('changed amount forces another explicit confirmation after fresh details update', async () => {
  let detailReads = 0;
  const app = makeApp({ detail: async () => { detailReads += 1; return student({ amountDue: detailReads === 1 ? '1999.00' : '1999.00' }); } });
  await openAndSelect(app);
  await app.confirmFriendSelection();
  assert.equal(app.saved.opened.length, 0);
  assert.equal(app.friends.notice, 'The bill details changed. Please review them and confirm again.');
  assert.equal(app.friends.selected.amountDue, '1999.00');
  assert.equal(app.dialog.open, true);
  await app.confirmFriendSelection();
  assert.equal(detailReads, 2);
  assert.equal(app.saved.opened.length, 1);
  assert.equal(app.saved.opened[0].amountDue, '1999.00');
});

test('a fresh 404 never opens the bill and removes the stale selection', async () => {
  const app = makeApp({ detail: async () => Object.assign(new Error('not found'), { status: 404 }) });
  await openAndSelect(app);
  await app.confirmFriendSelection();
  assert.equal(app.saved.opened.length, 0);
  assert.equal(app.friends.selectedBillId, '');
  assert.equal(app.friends.status, 'empty');
  assert.match(app.friends.notice, /no longer eligible/);
  assert.equal(app.dialog.open, true);
});

test('closing during a pending fresh lookup invalidates the response and cannot open a bill', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const app = makeApp({ detail: () => pending });
  await openAndSelect(app);
  const confirmation = app.confirmFriendSelection();
  app.clickClose();
  assert.equal(app.dialog.open, false);
  release(student());
  await confirmation;
  assert.equal(app.saved.opened.length, 0);
});

test('guest flow displays sign-in state without starting a search or suggesting a student', async () => {
  const app = makeApp({ authenticated: false });
  assert.equal(await app.openFriendPicker('ast'), true);
  assert.equal(app.calls.length, 0);
  assert.equal(app.friends.status, 'guest');
  assert.deepEqual(Array.from(app.friends.students), []);
  assert.equal(app.friends.selected, null);
  assert.equal(app.saved.opened.length, 0);
});

test('restored selection gets native focus after the fresh search completes', async () => {
  const app = makeApp();
  assert.equal(await app.openFriendPicker('ast', 'bill_2026-10'), true);
  assert.equal(app.friends.selectedBillId, 'bill_2026-10');
  assert.equal(app.dialogChoices.length, 1);
  assert.equal(app.dialogChoices[0].focusOptions.preventScroll, true);
  assert.equal(app.closeButton.focusOptions, null);
});
