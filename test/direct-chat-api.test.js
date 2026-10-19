import assert from 'node:assert/strict';
import { once } from 'node:events';
import crypto from 'node:crypto';
import test from 'node:test';
import signature from 'cookie-signature';
import session from 'express-session';
import pg from 'pg';
import { buildConfig, createApp } from '../server.js';
import { createDirectChatStore } from '../direct-chat-api.js';

const SESSION_SECRET = 'direct-chat-api-tests-use-a-long-session-secret';
const google = subject => ({ provider: 'google', subject });

async function createHarness(directChatStore) {
  const config = buildConfig({ NODE_ENV: 'test', SESSION_SECRET });
  const sessionStore = new session.MemoryStore();
  const app = createApp({ config, sessionStore, directChatStore });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function cookieFor(id, user) {
    const data = { cookie: { originalMaxAge: null, expires: null, httpOnly: true, path: '/', sameSite: 'lax', secure: false }, ...(user ? { stemmaUser: user } : {}) };
    await new Promise((resolve, reject) => sessionStore.set(id, data, error => error ? reject(error) : resolve()));
    return `stemma.sid=${encodeURIComponent(`s:${signature.sign(id, SESSION_SECRET)}`)}`;
  }
  return { origin, cookieFor, async close() { server.close(); await once(server, 'close'); } };
}

const jsonPost = (url, cookie, origin, body) => fetch(url, {
  method: 'POST', headers: { ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}), 'content-type': 'application/json' }, body: JSON.stringify(body)
});

test('Direct chat API requires auth, scopes messages, validates writes, and returns only chat-safe identities', async t => {
  const calls = [];
  const store = {
    async createConversation(subject, username) { calls.push(['create', subject, username]); return { id: '31', username, nickName: 'Friendly', subject: 'must-not-leak', email: 'private@example.invalid' }; },
    async listConversations(subject, limit) { calls.push(['list', subject, limit]); return [{ id: '31', username: 'other_user', nickName: 'Other', googleSubject: 'secret', email: 'hidden' }]; },
    async listMessages(subject, id, before, limit) { calls.push(['history', subject, id, before, limit]); return [{ id: '51', text: 'hello', createdAt: new Date('2026-01-01T00:00:00Z'), authorSubject: 'viewer-secret', legalName: 'not-safe' }]; },
    async sendMessage(subject, id, text) { calls.push(['send', subject, id, text]); return { id: '52', text, createdAt: new Date('2026-01-02T00:00:00Z'), authorSubject: subject, email: 'hidden' }; }
  };
  const h = await createHarness(store);
  t.after(() => h.close());
  const cookie = await h.cookieFor('chat-user', google('viewer-secret'));
  assert.equal((await fetch(`${h.origin}/api/pulse/conversations`)).status, 401);
  let response = await fetch(`${h.origin}/api/pulse/conversations`, { headers: { cookie } });
  assert.deepEqual(await response.json(), { conversations: [{ id: '31', username: 'other_user', nickName: 'Other', lastMessage: null }], hasMore: false });
  assert.deepEqual(calls.at(-1), ['list', 'viewer-secret', 51]);

  response = await jsonPost(`${h.origin}/api/pulse/conversations`, cookie, h.origin, { username: 'other_user' });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { conversation: { id: '31', username: 'other_user', nickName: 'Friendly' } });
  assert.deepEqual(calls.at(-1), ['create', 'viewer-secret', 'other_user']);
  for (const body of [{ username: 'x' }, { username: '../bad' }, { username: 'valid_user', subject: 'attack' }, { username: '' }]) {
    assert.equal((await jsonPost(`${h.origin}/api/pulse/conversations`, cookie, h.origin, body)).status, 400);
  }
  assert.equal((await jsonPost(`${h.origin}/api/pulse/conversations`, cookie, null, { username: 'other_user' })).status, 403);
  assert.equal((await jsonPost(`${h.origin}/api/pulse/conversations`, cookie, h.origin, { username: 'other_user' })).status, 201);

  response = await fetch(`${h.origin}/api/pulse/conversations/31/messages?before=0`, { headers: { cookie } });
  assert.equal(response.status, 400);
  response = await fetch(`${h.origin}/api/pulse/conversations/31/messages?before=9223372036854775808`, { headers: { cookie } });
  assert.equal(response.status, 400);
  response = await fetch(`${h.origin}/api/pulse/conversations/31/messages?before=52`, { headers: { cookie } });
  assert.deepEqual(await response.json(), { messages: [{ id: '51', text: 'hello', createdAt: '2026-01-01T00:00:00.000Z', mine: true }], hasMore: false });
  assert.deepEqual(calls.find(call => call[0] === 'history'), ['history', 'viewer-secret', '31', '52', 51]);

  for (const body of [{ text: ' ' }, { text: 'x'.repeat(4001) }, { text: 'hi', authorSubject: 'other' }, { text: 'nul\0char' }]) {
    assert.equal((await jsonPost(`${h.origin}/api/pulse/conversations/31/messages`, cookie, h.origin, body)).status, 400);
  }
  response = await jsonPost(`${h.origin}/api/pulse/conversations/31/messages`, cookie, h.origin, { text: '  chat text  ' });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { message: { id: '52', text: 'chat text', createdAt: '2026-01-02T00:00:00.000Z', mine: true } });
  assert.deepEqual(calls.at(-1), ['send', 'viewer-secret', '31', 'chat text']);
  const serialized = JSON.stringify(await (await fetch(`${h.origin}/api/pulse/conversations`, { headers: { cookie } })).json());
  assert.doesNotMatch(serialized, /secret|email|googleSubject|legalName/);
});

test('PostgreSQL direct chat concurrent creation, persistence, pagination, validation and participant isolation', {
  skip: process.env.STEMMA_CHAT_POSTGRES_TEST !== '1', timeout: 120000
}, async t => {
  const { Pool } = pg;
  const schema = `stemma_chat_${crypto.randomUUID().replaceAll('-', '')}`;
  const connection = { host: '127.0.0.1', port: 5432, database: 'stemma_notification_test', user: 'stemma_notification_test', password: 'local-notification-test-only', max: 4, connectionTimeoutMillis: 5000 };
  const admin = new Pool(connection);
  let pool;
  let harness;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = { ...connection, options: `-c search_path=${schema}` };
    pool = new Pool(scoped);
    await pool.query(`CREATE TABLE stemma_google_identities (
      google_subject VARCHAR(255) PRIMARY KEY, verified_email VARCHAR(320) NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    await pool.query(`CREATE TABLE stemma_student_profiles (
      google_subject VARCHAR(255) PRIMARY KEY REFERENCES stemma_google_identities(google_subject) ON DELETE CASCADE,
      first_name VARCHAR(80) NOT NULL DEFAULT 'PrivateLegal', middle_name VARCHAR(80) NOT NULL DEFAULT '', last_name VARCHAR(80) NOT NULL DEFAULT 'Name',
      student_id VARCHAR(64) NOT NULL DEFAULT 'test-id', department VARCHAR(100) NOT NULL DEFAULT 'test', nick_name TEXT NOT NULL DEFAULT '', username TEXT NOT NULL DEFAULT '')`);
    const subjects = ['chat-alpha', 'chat-beta', 'chat-outsider'];
    await pool.query('INSERT INTO stemma_google_identities (google_subject) SELECT unnest($1::text[])', [subjects]);
    await pool.query(`INSERT INTO stemma_student_profiles (google_subject, username, nick_name) VALUES
      ('chat-alpha', 'alpha_user', 'Alpha'), ('chat-beta', 'beta_user', 'Beta'), ('chat-outsider', 'outsider_user', 'Outsider')`);
    let store = createDirectChatStore(pool);
    await store.migrate();
    await store.migrate();
    harness = await createHarness(store);
    const alpha = await harness.cookieFor('chat-alpha-session', google(subjects[0]));
    const beta = await harness.cookieFor('chat-beta-session', google(subjects[1]));
    const outsider = await harness.cookieFor('chat-outsider-session', google(subjects[2]));
    const create = (cookie, username) => jsonPost(`${harness.origin}/api/pulse/conversations`, cookie, harness.origin, { username });
    const created = await Promise.all([create(alpha, 'beta_user'), create(beta, 'alpha_user')]);
    assert.ok(created.every(response => response.status === 201));
    const convA = (await created[0].json()).conversation;
    const convB = (await created[1].json()).conversation;
    assert.equal(convA.id, convB.id, 'unique canonical pair prevents duplicate conversations under concurrent creation');
    assert.equal(convA.nickName, 'Beta');
    const conversationId = convA.id;

    const sendA = (text, cookie = alpha) => jsonPost(`${harness.origin}/api/pulse/conversations/${conversationId}/messages`, cookie, harness.origin, { text });
    assert.equal((await sendA(' first ')).status, 201);
    assert.equal((await sendA('second', beta)).status, 201);
    assert.equal((await sendA('not for outsider', outsider)).status, 404);
    assert.equal((await fetch(`${harness.origin}/api/pulse/conversations/${conversationId}/messages`, { headers: { cookie: outsider } })).status, 200);
    let response = await fetch(`${harness.origin}/api/pulse/conversations/${conversationId}/messages`, { headers: { cookie: outsider } });
    assert.deepEqual(await response.json(), { messages: [], hasMore: false }, 'third party sees no history');
    response = await fetch(`${harness.origin}/api/pulse/conversations/${conversationId}/messages`, { headers: { cookie: alpha } });
    const page = await response.json();
    assert.deepEqual(page.messages.map(message => [message.text, message.mine]), [['second', false], ['first', true]]);
    response = await fetch(`${harness.origin}/api/pulse/conversations/${conversationId}/messages?before=${page.messages[0].id}`, { headers: { cookie: alpha } });
    assert.deepEqual((await response.json()).messages.map(message => message.text), ['first']);
    response = await fetch(`${harness.origin}/api/pulse/conversations`, { headers: { cookie: alpha } });
    assert.equal((await response.json()).conversations[0].lastMessage.text, 'second');
    assert.equal((await create(alpha, 'beta_user')).status, 201);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM stemma_direct_chat_conversations')).rows[0].n, 1);

    for (const text of ['', '  ', 'x'.repeat(4001)]) assert.equal((await sendA(text)).status, 400);
    await harness.close(); harness = null;
    await pool.end(); pool = new Pool(scoped);
    store = createDirectChatStore(pool);
    harness = await createHarness(store);
    const reopened = await harness.cookieFor('chat-alpha-reopened', google(subjects[0]));
    response = await fetch(`${harness.origin}/api/pulse/conversations`, { headers: { cookie: reopened } });
    assert.equal((await response.json()).conversations[0].lastMessage.text, 'second', 'messages and conversations persist after store recreation');
    await pool.query('DELETE FROM stemma_google_identities WHERE google_subject = $1', [subjects[0]]);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM stemma_direct_chat_conversations')).rows[0].n, 0, 'identity deletion cascades conversations');
  } finally {
    if (harness) await harness.close();
    if (pool) await pool.end().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await admin.end();
  }
});
