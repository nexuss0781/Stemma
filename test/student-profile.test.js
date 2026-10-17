import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import signature from 'cookie-signature';
import session from 'express-session';
import { buildConfig, createApp, createStudentProfileStore } from '../server.js';

const SESSION_SECRET = 'student-profile-tests-have-a-long-session-secret-value';

async function createHarness({ studentProfileStore } = {}) {
  const config = buildConfig({ NODE_ENV: 'test', SESSION_SECRET });
  const sessionStore = new session.MemoryStore();
  const app = createApp({ config, sessionStore, studentProfileStore });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;

  async function cookieFor(id, stemmaUser) {
    const data = {
      cookie: { originalMaxAge: null, expires: null, httpOnly: true, path: '/', sameSite: 'lax', secure: false },
      ...(stemmaUser ? { stemmaUser } : {})
    };
    await new Promise((resolve, reject) => sessionStore.set(id, data, error => error ? reject(error) : resolve()));
    return `stemma.sid=${encodeURIComponent(`s:${signature.sign(id, SESSION_SECRET)}`)}`;
  }

  return {
    origin,
    server,
    async close() {
      server.close();
      await once(server, 'close');
    },
    cookieFor
  };
}

function validProfile(overrides = {}) {
  return { firstName: ' Ada ', lastName: ' Lovelace ', studentId: ' ST-123 ', department: ' Mathematics ', ...overrides };
}

test('student profile API enforces Google identity, same-origin, strict input, and subject isolation', async t => {
  const records = new Map();
  const writes = [];
  const store = {
    async getStudentProfile(subject) { return records.get(subject) ?? null; },
    async upsertStudentProfile(subject, profile) {
      writes.push({ subject, profile });
      records.set(subject, { ...profile });
      return { ...profile };
    }
  };
  const h = await createHarness({ studentProfileStore: store });
  t.after(() => h.close());
  const googleA = await h.cookieFor('google-a', { provider: 'google', subject: 'google-subject-A' });
  const googleB = await h.cookieFor('google-b', { provider: 'google', subject: 'google-subject-B' });
  const fayda = await h.cookieFor('fayda', { provider: 'fayda', subject: 'fayda-subject' });
  const endpoint = `${h.origin}/api/student-profile`;

  const unauthenticated = await fetch(endpoint);
  assert.equal(unauthenticated.status, 401);
  assert.deepEqual(await unauthenticated.json(), { error: 'Authentication required.' });
  const nonGoogle = await fetch(endpoint, { headers: { cookie: fayda } });
  assert.equal(nonGoogle.status, 403);
  assert.equal(writes.length, 0);

  const initiallyEmpty = await fetch(endpoint, { headers: { cookie: googleA } });
  assert.equal(initiallyEmpty.status, 200);
  assert.deepEqual(await initiallyEmpty.json(), { profile: null });

  for (const origin of ['https://attacker.example', undefined]) {
    const response = await fetch(endpoint, {
      method: 'PUT', headers: { cookie: googleA, 'content-type': 'application/json', ...(origin ? { origin } : {}) },
      body: JSON.stringify(validProfile())
    });
    assert.equal(response.status, 403);
  }
  const wrongContentType = await fetch(endpoint, {
    method: 'PUT', headers: { cookie: googleA, origin: h.origin, 'content-type': 'text/plain' }, body: JSON.stringify(validProfile())
  });
  assert.equal(wrongContentType.status, 415);

  for (const invalid of [
    { ...validProfile(), subject: 'attacker-selected-subject' },
    { ...validProfile(), firstName: 42 },
    { ...validProfile(), middleName: 'bad\u0001value' },
    { ...validProfile(), studentId: 'x'.repeat(65) },
    { ...validProfile(), firstName: 'x'.repeat(81) },
    { ...validProfile(), department: 'x'.repeat(101) },
    { ...validProfile(), firstName: '   ' },
    { ...validProfile(), middleName: null },
    { firstName: 'Ada', lastName: 'Lovelace', department: 'Math' }
  ]) {
    const response = await fetch(endpoint, {
      method: 'PUT', headers: { cookie: googleA, origin: h.origin, 'content-type': 'application/json' }, body: JSON.stringify(invalid)
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Student profile data is invalid.' });
  }
  const malformed = await fetch(endpoint, {
    method: 'PUT', headers: { cookie: googleA, origin: h.origin, 'content-type': 'application/json' }, body: '{'
  });
  assert.equal(malformed.status, 400);
  const tooLarge = await fetch(endpoint, {
    method: 'PUT', headers: { cookie: googleA, origin: h.origin, 'content-type': 'application/json' },
    body: JSON.stringify(validProfile({ department: 'D'.repeat(5000) }))
  });
  assert.equal(tooLarge.status, 413);
  assert.equal(writes.length, 0);

  const saved = await fetch(endpoint, {
    method: 'PUT', headers: { cookie: googleA, origin: h.origin, 'content-type': 'application/json' },
    body: JSON.stringify(validProfile())
  });
  assert.equal(saved.status, 200);
  const expectedA = { firstName: 'Ada', middleName: '', lastName: 'Lovelace', studentId: 'ST-123', department: 'Mathematics' };
  assert.deepEqual(await saved.json(), { profile: expectedA });
  assert.deepEqual(writes[0], { subject: 'google-subject-A', profile: expectedA });
  assert.deepEqual(await (await fetch(endpoint, { headers: { cookie: googleA } })).json(), { profile: expectedA });
  assert.deepEqual(await (await fetch(endpoint, { headers: { cookie: googleB } })).json(), { profile: null });

  const savedB = await fetch(endpoint, {
    method: 'PUT', headers: { cookie: googleB, origin: h.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ ...validProfile(), middleName: 'Grace' })
  });
  assert.equal(savedB.status, 200);
  assert.equal(writes[1].subject, 'google-subject-B');
  assert.deepEqual(await (await fetch(endpoint, { headers: { cookie: googleA } })).json(), { profile: expectedA });
});

test('student profile API returns safe 503 responses when its store is missing or unavailable', async t => {
  const h = await createHarness({ studentProfileStore: {
    async getStudentProfile() { throw new Error('database detail must not escape'); },
    async upsertStudentProfile() { throw new Error('database detail must not escape'); }
  } });
  t.after(() => h.close());
  const cookie = await h.cookieFor('google', { provider: 'google', subject: 'google-subject' });
  const endpoint = `${h.origin}/api/student-profile`;
  const get = await fetch(endpoint, { headers: { cookie } });
  assert.equal(get.status, 503);
  assert.deepEqual(await get.json(), { error: 'Student profile service is unavailable.' });
  const put = await fetch(endpoint, {
    method: 'PUT', headers: { cookie, origin: h.origin, 'content-type': 'application/json' }, body: JSON.stringify(validProfile())
  });
  assert.equal(put.status, 503);
  assert.deepEqual(await put.json(), { error: 'Student profile service is unavailable.' });

  const absent = await createHarness();
  t.after(() => absent.close());
  const absentCookie = await absent.cookieFor('google', { provider: 'google', subject: 'google-subject' });
  const unavailable = await fetch(`${absent.origin}/api/student-profile`, { headers: { cookie: absentCookie } });
  assert.equal(unavailable.status, 503);

  const noReturnedRow = await createHarness({ studentProfileStore: {
    async getStudentProfile() { return null; },
    async upsertStudentProfile() { return null; }
  } });
  t.after(() => noReturnedRow.close());
  const noReturnedRowCookie = await noReturnedRow.cookieFor('google', { provider: 'google', subject: 'google-subject' });
  const noRowSave = await fetch(`${noReturnedRow.origin}/api/student-profile`, {
    method: 'PUT',
    headers: { cookie: noReturnedRowCookie, origin: noReturnedRow.origin, 'content-type': 'application/json' },
    body: JSON.stringify(validProfile())
  });
  assert.equal(noRowSave.status, 503);
  assert.deepEqual(await noRowSave.json(), { error: 'Student profile service is unavailable.' });
});

test('student profile migration is additive/idempotent and store queries parameterize subject and fields', async () => {
  const calls = [];
  const profile = { firstName: 'Ada', middleName: '', lastName: 'Lovelace', studentId: 'S-1', department: 'Math' };
  const pool = {
    async query(text, values) {
      calls.push({ text, values });
      if (text.includes('INSERT INTO stemma_student_profiles')) return { rows: [profile] };
      if (text.includes('SELECT first_name')) return { rows: [profile] };
      return { rows: [] };
    }
  };
  const store = createStudentProfileStore(pool);
  await store.migrate();
  assert.deepEqual(await store.upsertStudentProfile('google-subject-1', profile), profile);
  assert.deepEqual(await store.getStudentProfile('google-subject-1'), profile);

  assert.match(calls[0].text, /CREATE TABLE IF NOT EXISTS stemma_student_profiles/i);
  assert.match(calls[0].text, /REFERENCES stemma_google_identities\s*\(google_subject\)/i);
  assert.match(calls[0].text, /ON DELETE CASCADE/i);
  assert.doesNotMatch(calls[0].text, /\bDROP\s+(TABLE|SCHEMA|DATABASE)\b/i);
  assert.match(calls[1].text, /ON CONFLICT \(google_subject\) DO UPDATE/i);
  assert.deepEqual(calls[1].values, ['google-subject-1', 'Ada', '', 'Lovelace', 'S-1', 'Math']);
  assert.match(calls[2].text, /WHERE google_subject = \$1/);
  assert.deepEqual(calls[2].values, ['google-subject-1']);
});
