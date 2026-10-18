import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import signature from 'cookie-signature';
import session from 'express-session';
import { buildConfig, createApp } from '../server.js';

const SESSION_SECRET = 'friend-bills-api-tests-have-a-long-session-secret-value';
const subject = 'google-requester';

function png() {
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let bit = 0; bit < 8; bit += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc = bytes => {
    let c = 0xffffffff;
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, bytes) => {
    const typeBytes = Buffer.from(type);
    const len = Buffer.alloc(4); len.writeUInt32BE(bytes.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc(Buffer.concat([typeBytes, bytes])));
    return Buffer.concat([len, typeBytes, bytes, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', Buffer.from([0x78, 0x9c, 0x63, 0, 0, 0, 2, 0, 1])),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

async function harness({ friendBillStore = null, profileStore = profileMemory() } = {}) {
  const config = buildConfig({ NODE_ENV: 'test', SESSION_SECRET });
  const sessions = new session.MemoryStore();
  const app = createApp({ config, sessionStore: sessions, studentProfileStore: profileStore, friendBillStore });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function cookie(id, userSubject = subject, provider = 'google') {
    const data = { cookie: { httpOnly: true, path: '/', sameSite: 'lax', secure: false }, stemmaUser: { provider, subject: userSubject, email: 'session-pii@example.test' } };
    await new Promise((resolve, reject) => sessions.set(id, data, error => error ? reject(error) : resolve()));
    return `stemma.sid=${encodeURIComponent(`s:${signature.sign(id, SESSION_SECRET)}`)}`;
  }
  return {
    origin, server, cookie,
    async close() { server.close(); await once(server, 'close'); }
  };
}

function record(overrides = {}) {
  return {
    billId: 'bill_abc-123', subject: 'google-recipient', amountDue: '123.40',
    currency: 'ETB', eligible: true, month: '2026-10', dueDate: '2026-10-31',
    sourceFakeName: 'MUST NOT LEAK', email: 'bill-source@example.test', ...overrides
  };
}

function profileMemory({ fail = false } = {}) {
  const profiles = new Map([
    ['google-recipient', {
      firstName: 'Aster', lastName: 'Bekele', username: 'Aster.Student',
      middleName: 'PrivateMiddle', studentId: 'PRIVATE-ID', department: 'Private Department',
      bio: 'Private bio', email: 'private-profile@example.test'
    }]
  ]);
  const photos = new Map([['google-recipient', { data: png(), mimeType: 'image/png' }]]);
  return {
    profiles, photos,
    async getStudentProfile(who) { if (fail) throw new Error('internal profile error'); return profiles.get(who) ?? null; },
    async getStudentPhoto(who) { if (fail) throw new Error('internal profile error'); return photos.get(who) ?? null; }
  };
}

function billsMemory({ records = [record()], failSearch = false, failGet = false } = {}) {
  const bills = new Map(records.map(item => [item.billId, item]));
  const calls = [];
  return {
    calls,
    async searchEligibleBills(args) { calls.push(['search', args]); if (failSearch) throw new Error('internal bill error'); return records; },
    async getEligibleBill(args) { calls.push(['get', args]); if (failGet) throw new Error('internal bill error'); return bills.get(args.billId) ?? null; }
  };
}

const get = (origin, path, cookie) => fetch(`${origin}${path}`, { headers: cookie ? { cookie } : {} });

test('friend bills require a Google session and unavailable source returns an empty result without listing profiles', async t => {
  const h = await harness(); t.after(() => h.close());
  const endpoint = `${h.origin}/api/friend-bills?username=ast`;
  const guest = await fetch(endpoint);
  assert.equal(guest.status, 401);
  assert.equal((await fetch(`${h.origin}/api/friend-bills/bill_abc-123/photo`)).status, 401);
  const faydaCookie = await h.cookie('fayda', subject, 'fayda');
  assert.equal((await get(h.origin, '/api/friend-bills?username=ast', faydaCookie)).status, 403);
  const googleCookie = await h.cookie('google');
  const unavailable = await get(h.origin, '/api/friend-bills?username=ast', googleCookie);
  assert.equal(unavailable.status, 200);
  assert.deepEqual(await unavailable.json(), { students: [], unavailable: true });
  assert.match(unavailable.headers.get('cache-control'), /private.*no-store/);
  const invalid = await get(h.origin, '/api/friend-bills?username=ab', googleCookie);
  assert.equal(invalid.status, 400);
  const duplicate = await get(h.origin, '/api/friend-bills?username=ast&username=aster', googleCookie);
  assert.equal(duplicate.status, 400);
});

test('search filters ineligible/self/invalid records and emits only current profile data in exact DTO shape', async t => {
  const profileStore = profileMemory();
  const records = [
    record({ billId: 'self', subject }),
    record({ billId: 'unpaid', eligible: false }),
    record({ billId: 'currency', currency: 'USD' }),
    record({ billId: 'amount', amountDue: '9999999999.00' }),
    record({ billId: 'fake-profile', subject: 'missing-profile' }),
    record()
  ];
  const billStore = billsMemory({ records });
  const h = await harness({ friendBillStore: billStore, profileStore }); t.after(() => h.close());
  const cookie = await h.cookie('search');
  const response = await get(h.origin, '/api/friend-bills?username=%40ast', cookie);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /private.*no-store/);
  const body = await response.json();
  assert.deepEqual(body, {
    students: [{
      billId: 'bill_abc-123', username: 'Aster.Student', firstName: 'Aster', lastName: 'Bekele',
      amountDue: '123.40', currency: 'ETB', photoURL: '/api/friend-bills/bill_abc-123/photo',
      month: '2026-10', dueDate: '2026-10-31'
    }],
    unavailable: false
  });
  assert.equal(billStore.calls[0][0], 'search');
  assert.deepEqual(billStore.calls[0][1], { requesterSubject: subject, username: 'ast', limit: 10 });
  assert.doesNotMatch(JSON.stringify(body), /google-recipient|session-pii|PrivateMiddle|PRIVATE-ID|Private Department|private-profile|Private bio|sourceFakeName|MUST NOT LEAK|email/i);
});

test('detail reauthorizes eligible bill on every request and photo serves validated recipient image only', async t => {
  let current = record();
  const billStore = {
    calls: [],
    async searchEligibleBills() { return []; },
    async getEligibleBill(args) { this.calls.push(args); return current?.billId === args.billId ? current : null; }
  };
  const profileStore = profileMemory();
  const h = await harness({ friendBillStore: billStore, profileStore }); t.after(() => h.close());
  const cookie = await h.cookie('detail');
  const detail = await get(h.origin, '/api/friend-bills/bill_abc-123', cookie);
  assert.equal(detail.status, 200);
  assert.deepEqual(await detail.json(), {
    student: {
      billId: 'bill_abc-123', username: 'Aster.Student', firstName: 'Aster', lastName: 'Bekele',
      amountDue: '123.40', currency: 'ETB', photoURL: '/api/friend-bills/bill_abc-123/photo', month: '2026-10', dueDate: '2026-10-31'
    }
  });
  assert.deepEqual(Object.keys((await (async () => { const x = await get(h.origin, '/api/friend-bills/bill_abc-123', cookie); return x.json(); })()).student).sort(), ['amountDue', 'billId', 'currency', 'dueDate', 'firstName', 'lastName', 'month', 'photoURL', 'username'].sort());
  const photo = await get(h.origin, '/api/friend-bills/bill_abc-123/photo', cookie);
  assert.equal(photo.status, 200);
  assert.equal(photo.headers.get('cache-control'), 'private, no-store');
  assert.equal(photo.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(photo.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await photo.arrayBuffer()), png());
  assert.equal(billStore.calls.length, 3);
  current = null;
  assert.equal((await get(h.origin, '/api/friend-bills/bill_abc-123', cookie)).status, 404);
  assert.equal((await get(h.origin, '/api/friend-bills/bill_abc-123/photo', cookie)).status, 404);
  assert.equal(billStore.calls.length, 5, 'both stale detail and image requests must reauthorize against the bill source');
  assert.equal((await get(h.origin, '/api/friend-bills/%20bad', cookie)).status, 400);
});

test('source/profile failures are safe 503s; stale, self, and invalid eligible records cannot be read', async t => {
  const searchFailure = await harness({ friendBillStore: billsMemory({ failSearch: true }) }); t.after(() => searchFailure.close());
  const cookie = await searchFailure.cookie('broken-search');
  const failed = await get(searchFailure.origin, '/api/friend-bills?username=ast', cookie);
  assert.equal(failed.status, 503);
  const failureText = await failed.text();
  assert.deepEqual(JSON.parse(failureText), { error: 'Friend bill service is unavailable.' });
  assert.doesNotMatch(failureText, /internal bill error|google-recipient/);

  const invalids = [
    record({ subject }),
    record({ eligible: false }),
    record({ currency: 'USD' }),
    record({ amountDue: '0.00' }),
    record({ amountDue: '1000000000.00' })
  ];
  const billStore = billsMemory({ records: invalids });
  const h = await harness({ friendBillStore: billStore }); t.after(() => h.close());
  const authorized = await h.cookie('invalid-records');
  const list = await get(h.origin, '/api/friend-bills?username=ast', authorized);
  assert.equal(list.status, 200);
  assert.deepEqual(await list.json(), { students: [], unavailable: false });
  for (const item of invalids) {
    const response = await get(h.origin, `/api/friend-bills/${item.billId}`, authorized);
    assert.equal(response.status, 404);
  }

  const profileFailure = await harness({ friendBillStore: billsMemory(), profileStore: profileMemory({ fail: true }) }); t.after(() => profileFailure.close());
  const profileCookie = await profileFailure.cookie('profile-failure');
  const failureResponse = await get(profileFailure.origin, '/api/friend-bills?username=ast', profileCookie);
  assert.equal(failureResponse.status, 503);
  assert.deepEqual(await failureResponse.json(), { error: 'Friend bill service is unavailable.' });

  const lookupFailure = await harness({ friendBillStore: billsMemory({ failGet: true }) }); t.after(() => lookupFailure.close());
  const lookupCookie = await lookupFailure.cookie('lookup-failure');
  const lookupResponse = await get(lookupFailure.origin, '/api/friend-bills/bill_abc-123', lookupCookie);
  assert.equal(lookupResponse.status, 503);
  assert.deepEqual(await lookupResponse.json(), { error: 'Friend bill service is unavailable.' });
});

test('friend-bill routes expose no write handlers', async t => {
  const h = await harness({ friendBillStore: billsMemory() }); t.after(() => h.close());
  const cookie = await h.cookie('read-only');
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const response = await fetch(`${h.origin}/api/friend-bills?username=ast`, { method, headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 404, `${method} must not be registered`);
  }
});
