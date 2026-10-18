import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const [friendUi, paymentUi] = await Promise.all([
  readFile(new URL('friend-ui.js', root), 'utf8'),
  readFile(new URL('payment-ui.js', root), 'utf8')
]);

function harness(fetch = async () => ({ ok: true, async json() { return { students: [] }; } })) {
  const calls = [];
  const context = vm.createContext({
    window: { fetch: async (...args) => { calls.push(args); return fetch(...args); } },
    icon: name => `<svg aria-hidden="true" data-icon="${name}"></svg>`,
    Date, Set, Object, Array, String, Number, RegExp, encodeURIComponent
  });
  context.normalizeDepositAmount = vm.runInContext(`${paymentUi}\nnormalizeDepositAmount`, context);
  const api = vm.runInContext(`${friendUi}\n({ FriendPaymentFlow, normalizeFriendUsername, validateFriendStudent, escapeFriendHTML })`, context);
  return { ...api, flow: new api.FriendPaymentFlow(), calls };
}

function student(overrides = {}) {
  const billId = overrides.billId ?? 'bill_2026-10';
  return {
    billId, username: 'Aster.Student', firstName: 'Aster', lastName: 'Bekele',
    amountDue: '1234.50', currency: 'ETB', photoURL: `/api/friend-bills/${encodeURIComponent(billId)}/photo`,
    month: '2026-10', dueDate: '2026-11-05',
    middleName: 'PRIVATE-MIDDLE', email: 'private@example.test', bio: 'PRIVATE-BIO', studentId: 'PRIVATE-ID',
    ...overrides
  };
}

const ok = body => async () => ({ ok: true, async json() { return body; } });
const failed = status => async () => ({ ok: false, status, async json() { throw new Error('must not parse failed response'); } });

test('username normalization accepts only bounded usernames and optional leading @', () => {
  const { normalizeFriendUsername: normalize } = harness();
  assert.equal(normalize('  @Aster.Student_2  '), 'Aster.Student_2');
  assert.equal(normalize('abc'), 'abc');
  for (const value of [null, 4, '', '  ', '@ab', 'ab c', 'a'.repeat(31), '@@valid', '-invalid']) assert.equal(normalize(value), null, String(value));
});

test('search and details use same-origin GET-only, no-store requests and expose only allowlisted profile fields', async () => {
  const h = harness(path => Promise.resolve({ ok: true, async json() { return path.includes('/bill_') ? { student: student() } : { students: [student()] }; } }));
  assert.equal(await h.flow.search('@ast'), true);
  assert.equal(h.calls.length, 1);
  const [path, options] = h.calls[0];
  assert.equal(path, '/api/friend-bills?username=ast');
  assert.deepEqual({ method: options.method, credentials: options.credentials, cache: options.cache, redirect: options.redirect, accept: options.headers.Accept }, {
    method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', accept: 'application/json'
  });
  assert.equal('body' in options, false);
  assert.equal(await h.flow.resolve('bill_2026-10').then(item => item.billId), 'bill_2026-10');
  assert.equal(h.calls[1][0], '/api/friend-bills/bill_2026-10');
  assert.equal(h.calls[1][1].method, 'GET');
  assert.equal(h.calls.every(([, init]) => init.method === 'GET' && !('body' in init)), true);
  const keys = Object.keys(h.flow.students[0]).sort();
  assert.deepEqual(keys, ['amountDue', 'billId', 'currency', 'dueDate', 'firstName', 'lastName', 'month', 'photoURL', 'username'].sort());
  assert.doesNotMatch(JSON.stringify(h.flow.students), /PRIVATE-MIDDLE|private@example|PRIVATE-BIO|PRIVATE-ID/);
});

test('malformed students, zero or malformed amount, wrong currency, and bad photo URLs are filtered', async () => {
  const valid = student({ billId: 'good' });
  const h = harness(ok({ students: [
    valid,
    student({ billId: 'zero', amountDue: '0.00' }),
    student({ billId: 'number', amountDue: 12.5 }),
    student({ billId: 'badcurrency', currency: 'USD' }),
    student({ billId: 'external', photoURL: 'https://evil.test/photo.png' }),
    student({ billId: 'relative-other', photoURL: '/assets/photo.png' }),
    student({ billId: 'badid', billId: '../bad' }),
    null, [], 'not a student'
  ] }));
  assert.equal(await h.flow.search('ast'), true);
  assert.deepEqual(Array.from(h.flow.students, item => item.billId), ['good']);
  assert.equal(h.flow.students[0].photoURL, '/api/friend-bills/good/photo');
});

test('results are prefix-matched and duplicate bill IDs are removed', async () => {
  const h = harness(ok({ students: [
    student({ billId: 'first', username: 'Aster.One' }),
    student({ billId: 'first', username: 'Aster.Duplicate' }),
    student({ billId: 'wrong-prefix', username: 'Beryl.Student' }),
    student({ billId: 'next', username: 'Asteroid' })
  ] }));
  await h.flow.search('ast');
  assert.deepEqual(Array.from(h.flow.students, item => item.billId), ['first', 'next']);
});

test('empty, unavailable, unauthorized, and service-error searches never invent a student', async () => {
  for (const [label, fetcher, status, notice] of [
    ['empty', ok({ students: [] }), 'empty', /No eligible students/],
    ['unavailable', ok({ students: [], unavailable: true }), 'empty', /No eligible students/],
    ['unauthorized', failed(401), 'guest', /Sign in/],
    ['forbidden', failed(403), 'guest', /Sign in/],
    ['service unavailable', failed(503), 'error', /could not be loaded/]
  ]) {
    const h = harness(fetcher);
    await h.flow.search('ast');
    assert.equal(h.flow.status, status, label);
    assert.deepEqual(Array.from(h.flow.students), [], label);
    assert.match(h.flow.renderPicker(), notice, label);
    assert.match(h.flow.renderPicker(), /data-confirm-friend disabled aria-disabled="true"/, label);
    assert.doesNotMatch(h.flow.renderPicker(), /Aster|Bekele|1234\.50/, label);
  }
});

test('cancelled older search cannot overwrite the newest result', async () => {
  let releaseOld;
  const oldResponse = new Promise(resolve => { releaseOld = resolve; });
  let releaseCancel;
  const cancelResponse = new Promise(resolve => { releaseCancel = resolve; });
  let oldCalls = 0;
  const h = harness(path => path.includes('old') ? (++oldCalls === 1 ? oldResponse : cancelResponse) : Promise.resolve({ ok: true, async json() { return { students: [student({ billId: 'newest', username: 'new.user' })] }; } }));
  const oldSearch = h.flow.search('old.user');
  await h.flow.search('new');
  assert.equal(h.flow.students[0].billId, 'newest');
  releaseOld({ ok: true, async json() { return { students: [student({ billId: 'stale', username: 'old.user' })] }; } });
  assert.equal(await oldSearch, false);
  assert.equal(h.flow.students[0].billId, 'newest');
  const cancelledSearch = h.flow.search('old.user');
  h.flow.cancel();
  releaseCancel({ ok: true, async json() { return { students: [student({ billId: 'cancelled', username: 'old.user' })] }; } });
  assert.equal(await cancelledSearch, false);
  assert.deepEqual(Array.from(h.flow.students), []);
});

test('rendered form and picker escape text, expose mobile-friendly hooks, and gate confirmation on selection', () => {
  const h = harness();
  h.flow.query = '<script>alert(1)</script>';
  const form = h.flow.renderForm();
  assert.match(form, /<dialog[^>]+id="friend-student-dialog"/);
  assert.match(form, /id="friend-username"[^>]+inputmode="text"[^>]+autocomplete="off"[^>]+autocapitalize="none"[^>]+spellcheck="false"[^>]+maxlength="31"[^>]+pattern="@\?\[A-Za-z0-9_\.\]\{3,30\}"[^>]+required/);
  assert.match(form, /value="&lt;script&gt;alert\(1\)&lt;\/script&gt;"/);
  assert.doesNotMatch(form, /<script>/);
  h.flow.students = [h.validateFriendStudent(student({ firstName: '<img src=x onerror=alert(1)>' }))];
  h.flow.status = 'ready';
  assert.match(h.flow.renderPicker(), /data-confirm-friend disabled aria-disabled="true"/);
  assert.match(h.flow.renderPicker(), /Select a username/);
  h.flow.selectedBillId = 'bill_2026-10';
  const picker = h.flow.renderPicker();
  assert.match(picker, /data-confirm-friend\s*>/);
  assert.match(picker, /data-friend-student="bill_2026-10" aria-pressed="true"/);
  assert.match(picker, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(picker, /<img src=x/);
  assert.match(picker, /class="friend-student-photo" src="\/api\/friend-bills\/bill_2026-10\/photo"/);
});
