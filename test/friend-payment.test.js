import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const paymentUi = await readFile(new URL('payment-ui.js', root), 'utf8');

function makeExperience({ dialogOpen = false } = {}) {
  const dialog = {
    open: dialogOpen,
    close() { this.open = false; },
    showModal() { this.open = true; }
  };
  const context = vm.createContext({
    document: { getElementById: id => id === 'bill-payment-dialog' ? dialog : null },
    icon: name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"></use></svg>`
  });
  const instance = vm.runInContext(`${paymentUi}\nnew PaymentExperience()`, context);
  return { instance, dialog };
}

function validStudent(overrides = {}) {
  const dto = {
    billId: 'bill_2026-10',
    username: 'student.name_1',
    firstName: 'Aster',
    lastName: 'Bekele',
    amountDue: '1234.50',
    currency: 'ETB',
    photoURL: '/api/friend-bills/bill_2026-10/photo',
    month: '2026-10',
    dueDate: '2026-11-05'
  };
  return { ...dto, ...overrides };
}

test('friend bill opens from a validated snapshot and renders actual identity, amount, month, and date', () => {
  const { instance } = makeExperience();
  assert.equal(instance.isFriend, false);
  assert.equal(instance.friendBill, null);
  const student = validStudent();
  assert.equal(instance.openFriendBill(student), true);
  assert.equal(instance.isFriend, true);
  assert.equal(instance.isDeposit, false);
  assert.equal(instance.isBillOpen, true);
  assert.equal(instance.isReceiptOpen, false);

  student.firstName = '<img src=x onerror=alert(1)>';
  student.amountDue = '99.99';
  const markup = instance.renderBill();
  assert.match(markup, /aria-label="Back to For friend"/);
  assert.match(markup, /<h1 id="bill-page-title">Pay student bill<\/h1>/);
  assert.match(markup, /Customer Name:<\/span><strong>Aster Bekele<\/strong>/);
  assert.match(markup, /<td>10\/2026<\/td><td>1234\.50<small>ETB<\/small><\/td><td class="bill-example-due">05\/11\/2026<\/td>/);
  assert.match(markup, /<span>Total Bill Amount<\/span><strong>1234\.50 ETB<\/strong>/);
  assert.match(markup, /<p class="bill-sheet-amount"><span>1234\.50<\/span><small>ETB<\/small><\/p>/);
  assert.doesNotMatch(markup, /676\.45|12\/2024|27\/01\/2025|701\.00/);
  assert.doesNotMatch(markup, /<img src=x/);
  assert.match(markup, /No wallet connected/);
  assert.match(markup, /Visual preview only · Telebirr is not connected\./);
  assert.match(markup, /Visual preview only · No payment will be sent\./);
  assert.match(markup, /<button class="bill-pay-button" type="button" data-bill-pay disabled aria-disabled="true" aria-describedby="bill-sheet-note">Pay<\/button>/);
  assert.doesNotMatch(markup.match(/<button class="bill-pay-button"[^>]*>/)?.[0] ?? '', /data-demo-pay/);
  assert.equal(instance.isReceiptOpen, false, 'opening friend bill does not auto-open its payment sheet or receipt');
});

test('optional month and due date render as dashes, and malformed calendar values are rejected', () => {
  const { instance } = makeExperience();
  assert.equal(instance.openFriendBill(validStudent({ month: '', dueDate: '' })), true);
  assert.match(instance.renderBill(), /<td>—<\/td><td>1234\.50<small>ETB<\/small><\/td><td class="bill-example-due">—<\/td>/);

  for (const field of [
    { month: '2026-13' }, { month: '26-10' }, { dueDate: '2026-02-29' },
    { dueDate: '2026-04-31' }, { dueDate: '2026-1-01' }
  ]) {
    const attempt = makeExperience().instance;
    assert.equal(attempt.openFriendBill(validStudent(field)), false, JSON.stringify(field));
    assert.equal(attempt.isFriend, false);
    assert.equal(attempt.friendBill, null);
  }
});

test('friend names are escaped before insertion into shared bill markup', () => {
  const { instance } = makeExperience();
  assert.equal(instance.openFriendBill(validStudent({ firstName: 'Ada & <script>', lastName: 'O"Neil\'s' })), true);
  const markup = instance.renderBill();
  assert.match(markup, /Ada &amp; &lt;script&gt; O&quot;Neil&#39;s/);
  assert.doesNotMatch(markup, /<script>|O"Neil/);
});

test('friend DTO rejects malformed identity, amounts, currency, photo path, and noncanonical values without state changes', () => {
  const invalid = [
    { billId: 'x/'.repeat(2) }, { billId: 'a'.repeat(81) },
    { username: 'ab' }, { username: 'has space' }, { username: 'a'.repeat(31) },
    { firstName: '' }, { firstName: ' '.repeat(3) }, { firstName: 'x'.repeat(81) },
    { lastName: '<'.repeat(81) }, { amountDue: '0.00' }, { amountDue: '00.01' },
    { amountDue: '1' }, { amountDue: '1.2' }, { amountDue: '1.000' },
    { amountDue: '1000000000.00' }, { amountDue: 1.25 }, { currency: 'USD' },
    { photoURL: '/api/friend-bills/other/photo' }, { month: null }, { dueDate: null }
  ];
  for (const changes of invalid) {
    const { instance } = makeExperience();
    const before = { isFriend: instance.isFriend, friendBill: instance.friendBill, isDeposit: instance.isDeposit, isBillOpen: instance.isBillOpen, isReceiptOpen: instance.isReceiptOpen };
    assert.equal(instance.openFriendBill(validStudent(changes)), false, JSON.stringify(changes));
    assert.deepEqual({ isFriend: instance.isFriend, friendBill: instance.friendBill, isDeposit: instance.isDeposit, isBillOpen: instance.isBillOpen, isReceiptOpen: instance.isReceiptOpen }, before);
  }
  for (const value of [null, undefined, [], 'not a DTO']) {
    assert.equal(makeExperience().instance.openFriendBill(value), false);
  }
});

test('friend mode cannot become a fake receipt, even through a direct guarded handler call', () => {
  const { instance, dialog } = makeExperience({ dialogOpen: true });
  assert.equal(instance.openFriendBill(validStudent()), true);
  instance.openDemoReceipt();
  assert.equal(instance.isReceiptOpen, false);
  assert.equal(dialog.open, true, 'guard leaves any forged/open sheet untouched');
  assert.match(instance.renderReceipt(), /Pay student bill/);
  assert.doesNotMatch(instance.renderReceipt(), /demo-receipt|Successful|DEMO-RCP-001/);
});

test('opening a deposit after friend mode clears the friend snapshot and retains deposit presentation', () => {
  const { instance } = makeExperience();
  assert.equal(instance.openFriendBill(validStudent()), true);
  assert.equal(instance.openDeposit('18.40'), true);
  assert.equal(instance.isFriend, false);
  assert.equal(instance.friendBill, null);
  assert.equal(instance.isDeposit, true);
  const markup = instance.renderBill();
  assert.match(markup, /Customer 001/);
  assert.match(markup, /<td>12\/2024<\/td><td>18\.40<small>ETB<\/small><\/td><td class="bill-example-due">27\/01\/2025<\/td>/);
});

test('normal bill and demo receipt retain the existing illustrative output', () => {
  const { instance } = makeExperience();
  const bill = instance.renderBill();
  assert.match(bill, /Pay Ethio telecom bill/);
  assert.match(bill, /Customer 001/);
  assert.match(bill, /12\/2024/);
  assert.match(bill, /676\.45<small>ETB<\/small>/);
  assert.match(bill, /Available Balance:701\.00ETB/);
  assert.match(bill, /data-bill-pay data-demo-pay/);
  assert.match(instance.renderReceipt(), /-676\.45 <small>\(ETB\)<\/small>/);
});
