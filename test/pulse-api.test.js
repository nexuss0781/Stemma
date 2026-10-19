import assert from 'node:assert/strict';
import { once } from 'node:events';
import crypto from 'node:crypto';
import test from 'node:test';
import signature from 'cookie-signature';
import session from 'express-session';
import pg from 'pg';
import { buildConfig, createApp } from '../server.js';
import { createPulseStore } from '../pulse-api.js';

const SESSION_SECRET = 'pulse-api-tests-use-a-long-session-secret';

async function createHarness(pulseStore) {
  const config = buildConfig({ NODE_ENV: 'test', SESSION_SECRET });
  const sessionStore = new session.MemoryStore();
  const app = createApp({ config, sessionStore, pulseStore });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function cookieFor(id, user) {
    const data = {
      cookie: { originalMaxAge: null, expires: null, httpOnly: true, path: '/', sameSite: 'lax', secure: false },
      ...(user ? { stemmaUser: user } : {})
    };
    await new Promise((resolve, reject) => sessionStore.set(id, data, error => error ? reject(error) : resolve()));
    return `stemma.sid=${encodeURIComponent(`s:${signature.sign(id, SESSION_SECRET)}`)}`;
  }
  return { origin, cookieFor, async close() { server.close(); await once(server, 'close'); } };
}

const google = subject => ({ provider: 'google', subject });

 test('Pulse API requires Google authentication, strips unsafe store fields, and validates cursors and saved-note writes', async t => {
  const injectedRows = [
    { username: 'Casey_Cat', nickName: 'Casey', email: 'private@example.invalid', firstName: 'Private', subject: 'secret-subject' },
    { username: 'onlyLegalMatch', nickName: '', lastName: 'Private' },
    { username: '', nickName: '', providerSubject: 'secret' }
  ];
  const calls = [];
  const store = {
    async searchUsers(q, offset, limit) { calls.push({ q, offset, limit }); return injectedRows; },
    async listSavedMessages(subject, before, limit) { calls.push({ subject, before, limit }); return []; },
    async createSavedMessage(subject, text) {
      calls.push({ subject, text });
      return { id: '9', text, createdAt: new Date('2026-01-01T00:00:00Z'), legalName: 'must-not-leak' };
    }
  };
  const h = await createHarness(store);
  t.after(() => h.close());
  const cookie = await h.cookieFor('google-user', google('self-subject'));
  const searchUrl = `${h.origin}/api/pulse/users?q=%40casey`;
  const guest = await fetch(searchUrl);
  assert.equal(guest.status, 401);

  const search = await fetch(searchUrl, { headers: { cookie } });
  assert.equal(search.status, 200);
  assert.match(search.headers.get('cache-control'), /no-store/);
  assert.deepEqual(await search.json(), { users: [{ username: 'Casey_Cat', nickName: 'Casey' }], hasMore: false });
  assert.deepEqual(calls[0], { q: 'casey', offset: 0, limit: 31 });

  const invalidOffset = await fetch(`${h.origin}/api/pulse/users?q=x&offset=-1`, { headers: { cookie } });
  assert.equal(invalidOffset.status, 400);
  const invalidCursor = await fetch(`${h.origin}/api/pulse/saved?before=0`, { headers: { cookie } });
  assert.equal(invalidCursor.status, 400);
  const overflowingCursor = await fetch(`${h.origin}/api/pulse/saved?before=9223372036854775808`, { headers: { cookie } });
  assert.equal(overflowingCursor.status, 400);

  const noOrigin = await fetch(`${h.origin}/api/pulse/saved`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hello' })
  });
  assert.equal(noOrigin.status, 403);
  const wrongOrigin = await fetch(`${h.origin}/api/pulse/saved`, {
    method: 'POST', headers: { cookie, origin: 'https://attacker.example', 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hello' })
  });
  assert.equal(wrongOrigin.status, 403);
  const wrongType = await fetch(`${h.origin}/api/pulse/saved`, {
    method: 'POST', headers: { cookie, origin: h.origin, 'content-type': 'text/plain' }, body: 'hello'
  });
  assert.equal(wrongType.status, 415);
  for (const body of [{ text: ' ' }, { text: 'ok', googleSubject: 'other' }, { text: 'x'.repeat(4001) }, { targetAccount: 'other', text: 'hi' }, { text: 'nul\0here' }]) {
    const invalid = await fetch(`${h.origin}/api/pulse/saved`, {
      method: 'POST', headers: { cookie, origin: h.origin, 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    assert.equal(invalid.status, 400);
  }
  const saved = await fetch(`${h.origin}/api/pulse/saved`, {
    method: 'POST', headers: { cookie, origin: h.origin, 'content-type': 'application/json' }, body: JSON.stringify({ text: '  self note  ' })
  });
  assert.equal(saved.status, 201);
  assert.deepEqual(await saved.json(), { message: { id: '9', text: 'self note', createdAt: '2026-01-01T00:00:00.000Z' } });
  assert.deepEqual(calls.find(call => call.text === 'self note'), { subject: 'self-subject', text: 'self note' });
});

test('PostgreSQL Pulse persistence, literal search, account isolation, pagination, and FK cascade', {
  skip: process.env.STEMMA_PULSE_POSTGRES_TEST !== '1',
  timeout: 120000
}, async t => {
  const { Pool } = pg;
  const schema = `stemma_pulse_${crypto.randomUUID().replaceAll('-', '')}`;
  const connection = {
    host: '127.0.0.1', port: 5432, database: 'stemma_notification_test',
    user: 'stemma_notification_test', password: 'local-notification-test-only', max: 3,
    connectionTimeoutMillis: 5000
  };
  const admin = new Pool(connection);
  let pool;
  let h;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = { ...connection, options: `-c search_path=${schema}` };
    pool = new Pool(scoped);
    await pool.query(`CREATE TABLE stemma_google_identities (
      google_subject VARCHAR(255) PRIMARY KEY,
      verified_email VARCHAR(320) NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    await pool.query(`CREATE TABLE stemma_student_profiles (
      google_subject VARCHAR(255) PRIMARY KEY REFERENCES stemma_google_identities(google_subject) ON DELETE CASCADE,
      first_name VARCHAR(80) NOT NULL, middle_name VARCHAR(80) NOT NULL DEFAULT '',
      last_name VARCHAR(80) NOT NULL, student_id VARCHAR(64) NOT NULL, department VARCHAR(100) NOT NULL,
      nick_name TEXT NOT NULL DEFAULT '', username TEXT NOT NULL DEFAULT ''
    )`);
    const alpha = 'pulse-integration-alpha';
    const beta = 'pulse-integration-beta';
    await pool.query('INSERT INTO stemma_google_identities (google_subject) VALUES ($1), ($2)', [alpha, beta]);
    const profileInsert = async (subject, username, nickName, first = 'LegalFirst', last = 'LegalLast') => {
      await pool.query('INSERT INTO stemma_google_identities (google_subject) VALUES ($1) ON CONFLICT DO NOTHING', [subject]);
      await pool.query(`INSERT INTO stemma_student_profiles
        (google_subject, first_name, last_name, student_id, department, nick_name, username)
        VALUES ($1, $4, $5, 'synthetic', 'testing', $3, $2)`, [subject, username, nickName, first, last]);
    };
    await profileInsert(alpha, 'unique_handle', 'UniqueNick', 'LegalOnlyNeedle', 'Smith');
    await profileInsert(beta, 'account_b_handle', 'B Nick');
    await profileInsert('pulse-symbol-profile', 'wild%_card', 'Symbols');
    for (let i = 0; i < 35; i += 1) await profileInsert(`pulse-page-profile-${i}`, `pageuser_${String(i).padStart(2, '0')}`, 'Pagination');

    let pulseStore = createPulseStore(pool);
    await pulseStore.migrate();
    await pulseStore.migrate();
    h = await createHarness(pulseStore);
    const cookieA = await h.cookieFor('pulse-a', google(alpha));
    const cookieB = await h.cookieFor('pulse-b', google(beta));
    const getUsers = async (cookie, query, offset = 0) => fetch(`${h.origin}/api/pulse/users?q=${encodeURIComponent(query)}&offset=${offset}`, { headers: { cookie } });

    let response = await getUsers(cookieA, 'unique');
    assert.deepEqual(await response.json(), { users: [{ username: 'unique_handle', nickName: 'UniqueNick' }], hasMore: false });
    response = await getUsers(cookieA, 'legalonlyneedle');
    assert.deepEqual(await response.json(), { users: [], hasMore: false }, 'search never queries legal-name fields');
    response = await getUsers(cookieA, '@UNIQUE');
    assert.equal((await response.json()).users[0].username, 'unique_handle');
    response = await getUsers(cookieA, '%_');
    assert.deepEqual((await response.json()).users.map(user => user.username), ['wild%_card'], 'percent and underscore are literal characters');
    response = await getUsers(cookieA, 'pageuser');
    const firstPage = await response.json();
    assert.equal(firstPage.users.length, 30);
    assert.equal(firstPage.hasMore, true);
    response = await getUsers(cookieA, 'pageuser', 30);
    const secondPage = await response.json();
    assert.equal(secondPage.users.length, 5);
    assert.equal(secondPage.hasMore, false);
    assert.deepEqual(firstPage.users.map(user => user.username).filter(name => secondPage.users.some(user => user.username === name)), []);
    for (const user of firstPage.users) assert.deepEqual(Object.keys(user).sort(), ['nickName', 'username']);

    const create = (cookie, text, origin = h.origin, body = { text }) => fetch(`${h.origin}/api/pulse/saved`, {
      method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    assert.equal((await create(cookieA, 'Note 1')).status, 201);
    assert.equal((await create(cookieA, '  Note 2  ')).status, 201);
    for (let i = 0; i < 51; i += 1) await pulseStore.createSavedMessage(alpha, `bulk-${i}`);
    const betaNote = await create(cookieB, 'Only Beta');
    assert.equal(betaNote.status, 201);

    response = await fetch(`${h.origin}/api/pulse/saved`, { headers: { cookie: cookieA } });
    const savedFirst = await response.json();
    assert.equal(savedFirst.messages.length, 50);
    assert.equal(savedFirst.hasMore, true);
    assert.ok(savedFirst.messages.every(message => typeof message.id === 'string' && /^\d+$/.test(message.id)));
    assert.ok(savedFirst.messages.every((message, index, all) => index === 0 || BigInt(all[index - 1].id) > BigInt(message.id)), JSON.stringify(savedFirst.messages.map(message => message.id)));
    response = await fetch(`${h.origin}/api/pulse/saved?before=${savedFirst.messages.at(-1).id}`, { headers: { cookie: cookieA } });
    const savedSecond = await response.json();
    assert.equal(savedSecond.messages.length, 3);
    assert.equal(savedSecond.hasMore, false);
    assert.deepEqual(savedSecond.messages.map(message => message.text), ['bulk-0', 'Note 2', 'Note 1']);

    response = await fetch(`${h.origin}/api/pulse/saved`, { headers: { cookie: cookieB } });
    const betaNotes = await response.json();
    assert.deepEqual(betaNotes.messages.map(message => message.text), ['Only Beta']);

    await h.close(); h = null;
    await pool.end(); pool = new Pool(scoped);
    pulseStore = createPulseStore(pool);
    h = await createHarness(pulseStore);
    const reopenedCookie = await h.cookieFor('pulse-a-reopened', google(alpha));
    response = await fetch(`${h.origin}/api/pulse/saved`, { headers: { cookie: reopenedCookie } });
    assert.equal((await response.json()).messages.length, 50, 'saved notes persist across pool/store recreation');
    await pool.query('DELETE FROM stemma_google_identities WHERE google_subject = $1', [alpha]);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM stemma_pulse_saved_messages WHERE google_subject=$1', [alpha])).rows[0].count, 0);
  } finally {
    if (h) await h.close();
    if (pool) await pool.end().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await admin.end();
  }
});
