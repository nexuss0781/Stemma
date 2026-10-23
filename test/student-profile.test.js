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
  return { firstName: ' Ada ', middleName: ' Byron ', lastName: ' Lovelace ', studentId: ' ST-123 ', department: ' Mathematics ', ...overrides };
}

test('student profile API enforces Google identity, same-origin, strict input, and subject isolation', async t => {
  const records = new Map();
  const writes = [];
  const store = {
    async getStudentProfile(subject) { return records.get(subject) ?? null; },
    async upsertStudentProfile(subject, profile) {
      writes.push({ subject, profile });
      const previous = records.get(subject) ?? {};
      const saved = {
        ...profile,
        nickName: profile.nickName ?? previous.nickName ?? '',
        username: profile.username ?? previous.username ?? '',
        bio: profile.bio ?? previous.bio ?? ''
      };
      records.set(subject, saved);
      return { ...saved };
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
    { ...validProfile(), nickName: '' },
    { ...validProfile(), nickName: 'x'.repeat(61) },
    { ...validProfile(), nickName: 12 },
    { ...validProfile(), username: 'ab' },
    { ...validProfile(), username: 'four' },
    { ...validProfile(), username: 'üsername' },
    { ...validProfile(), username: 'x'.repeat(31) },
    { ...validProfile(), username: null },
    { ...validProfile(), bio: 'x'.repeat(281) },
    { ...validProfile(), bio: 'bad\u0001value' },
    { ...validProfile(), bio: 'bad\tvalue' },
    { ...validProfile(), bio: '\tunsafe boundary' },
    { ...validProfile(), bio: 12 },
    { ...validProfile(), unexpected: 'reject me' },
    ...['firstName', 'middleName', 'lastName', 'studentId', 'department'].flatMap(key => [
      { ...validProfile(), [key]: '' },
      { ...validProfile(), [key]: '   ' }
    ]),
    ...['firstName', 'middleName', 'lastName', 'studentId', 'department'].map(key => {
      const profile = validProfile();
      delete profile[key];
      return profile;
    }),
    { ...validProfile(), middleName: null }
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
  const expectedA = { firstName: 'Ada', middleName: 'Byron', lastName: 'Lovelace', studentId: 'ST-123', department: 'Mathematics' };
  const expectedAWithOptionalDefaults = { ...expectedA, nickName: '', username: '', bio: '' };
  assert.deepEqual(await saved.json(), { profile: expectedAWithOptionalDefaults });
  assert.deepEqual(writes[0], { subject: 'google-subject-A', profile: expectedA });
  assert.deepEqual(await (await fetch(endpoint, { headers: { cookie: googleA } })).json(), { profile: expectedAWithOptionalDefaults });
  assert.deepEqual(await (await fetch(endpoint, { headers: { cookie: googleB } })).json(), { profile: null });

  const completedProfile = {
    ...expectedA,
    nickName: '  Ada B.  ',
    username: '  Ada.Lovelace_1  ',
    bio: '  Mathematician\nand writer.  '
  };
  const completed = await fetch(endpoint, {
    method: 'PUT', headers: { cookie: googleA, origin: h.origin, 'content-type': 'application/json' },
    body: JSON.stringify(completedProfile)
  });
  const expectedCompleted = { ...expectedA, nickName: 'Ada B.', username: 'ada.lovelace_1', bio: 'Mathematician\nand writer.' };
  assert.equal(completed.status, 200);
  assert.deepEqual(await completed.json(), { profile: expectedCompleted });
  assert.deepEqual(writes[1], { subject: 'google-subject-A', profile: expectedCompleted });

  const legacyUpdate = await fetch(endpoint, {
    method: 'PUT', headers: { cookie: googleA, origin: h.origin, 'content-type': 'application/json' },
    body: JSON.stringify(validProfile({ firstName: 'Ada updated' }))
  });
  const expectedLegacyUpdate = { ...expectedCompleted, firstName: 'Ada updated' };
  assert.equal(legacyUpdate.status, 200);
  assert.deepEqual(await legacyUpdate.json(), { profile: expectedLegacyUpdate });
  assert.deepEqual(writes[2], { subject: 'google-subject-A', profile: { ...expectedA, firstName: 'Ada updated' } });
  assert.deepEqual(await (await fetch(endpoint, { headers: { cookie: googleA } })).json(), { profile: expectedLegacyUpdate });

  const savedB = await fetch(endpoint, {
    method: 'PUT', headers: { cookie: googleB, origin: h.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ ...validProfile(), middleName: 'Grace' })
  });
  assert.equal(savedB.status, 200);
  assert.equal(writes[3].subject, 'google-subject-B');
  assert.deepEqual(await (await fetch(endpoint, { headers: { cookie: googleB } })).json(), {
    profile: { firstName: 'Ada', middleName: 'Grace', lastName: 'Lovelace', studentId: 'ST-123', department: 'Mathematics', nickName: '', username: '', bio: '' }
  });
  assert.deepEqual(await (await fetch(endpoint, { headers: { cookie: googleA } })).json(), { profile: expectedLegacyUpdate });
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
  const profile = { firstName: 'Ada', middleName: '', lastName: 'Lovelace', studentId: 'S-1', department: 'Math', nickName: 'Ada', username: 'ada_1', bio: 'Hi\nthere' };
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
  await store.migrate();
  assert.deepEqual(await store.upsertStudentProfile('google-subject-1', profile), profile);
  const legacyProfile = { firstName: 'Ada', middleName: '', lastName: 'Lovelace', studentId: 'S-1', department: 'Math' };
  assert.deepEqual(await store.upsertStudentProfile('google-subject-1', legacyProfile), profile);
  assert.deepEqual(await store.getStudentProfile('google-subject-1'), profile);
  const photo = { data: Buffer.from([1, 2, 3]), mimeType: 'image/png', width: 1, height: 1 };
  await store.getStudentPhoto('google-subject-1');
  await store.saveStudentPhoto('google-subject-1', photo, { onlyIfAbsent: true });

  assert.match(calls[0].text, /CREATE TABLE IF NOT EXISTS stemma_student_profiles/i);
  assert.match(calls[0].text, /REFERENCES stemma_google_identities\s*\(google_subject\)/i);
  assert.match(calls[0].text, /ON DELETE CASCADE/i);
  assert.doesNotMatch(calls[0].text, /\bDROP\s+(TABLE|SCHEMA|DATABASE)\b/i);
  for (const call of [calls[1], calls[4]]) {
    assert.match(call.text, /ALTER TABLE stemma_student_profiles/i);
    for (const column of ['nick_name', 'username', 'bio']) {
      assert.match(call.text, new RegExp(`ADD COLUMN IF NOT EXISTS ${column} TEXT NOT NULL DEFAULT ''`, 'i'));
    }
  }
  for (const call of [calls[2], calls[5]]) {
    assert.match(call.text, /ADD COLUMN IF NOT EXISTS profile_image BYTEA NULL/i);
    assert.match(call.text, /stemma_student_profiles_profile_image_valid/i);
    assert.doesNotMatch(call.text, /\bDROP\s+(TABLE|SCHEMA|DATABASE|COLUMN)\b/i);
  }
  assert.match(calls[6].text, /ON CONFLICT \(google_subject\) DO UPDATE/i);
  assert.match(calls[6].text, /nick_name = COALESCE\(\$7, stemma_student_profiles\.nick_name\)/i);
  assert.match(calls[6].text, /username = COALESCE\(\$8, stemma_student_profiles\.username\)/i);
  assert.match(calls[6].text, /bio = COALESCE\(\$9, stemma_student_profiles\.bio\)/i);
  assert.deepEqual(calls[6].values, ['google-subject-1', 'Ada', '', 'Lovelace', 'S-1', 'Math', 'Ada', 'ada_1', 'Hi\nthere']);
  assert.deepEqual(calls[7].values, ['google-subject-1', 'Ada', '', 'Lovelace', 'S-1', 'Math', null, null, null]);
  assert.match(calls[8].text, /WHERE google_subject = \$1/);
  assert.deepEqual(calls[8].values, ['google-subject-1']);
  assert.match(calls[9].text, /SELECT profile_image AS data/);
  assert.deepEqual(calls[9].values, ['google-subject-1']);
  assert.match(calls[10].text, /UPDATE stemma_student_profiles/);
  assert.match(calls[10].text, /AND profile_image IS NULL/);
  assert.deepEqual(calls[10].values, ['google-subject-1', photo.data, photo.mimeType, 1, 1]);
  assert.deepEqual(calls[11].values, ['google-subject-1']);
});
