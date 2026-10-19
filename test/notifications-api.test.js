import assert from 'node:assert/strict';
import { once } from 'node:events';
import crypto from 'node:crypto';
import { test } from 'node:test';
import signature from 'cookie-signature';
import session from 'express-session';
import pg from 'pg';
import { buildConfig, createApp } from '../server.js';
import { createNotificationStore } from '../notifications-api.js';

const SESSION_SECRET = 'notification-api-tests-use-a-long-session-secret';
const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function createMemoryPool() {
  const records = [];
  let idCounter = 0;
  let fail = false;
  return {
    records,
    setFail(value) { fail = value; },
    async query(sql, params = []) {
      if (fail) throw new Error('database unavailable');
      if (/^\s*CREATE TABLE/i.test(sql) || /^\s*CREATE INDEX/i.test(sql) || /^\s*INSERT INTO stemma_student_notifications[\s\S]*SELECT google_subject/i.test(sql)) {
        return { rows: [] };
      }
      if (/^\s*INSERT INTO stemma_student_notifications/i.test(sql)) {
        const [subject, key, title, message] = params;
        if (!records.some(row => row.subject === subject && row.key === key)) {
          idCounter += 1;
          records.push({ id: idCounter === 1 ? ID_A : ID_B, subject, key, title, message, createdAt: new Date(Date.UTC(2026, 0, idCounter)), readAt: null });
        }
        return { rows: [] };
      }
      if (/^\s*SELECT id::text AS id/i.test(sql)) {
        assert.match(sql, /CASE WHEN notification_key = 'app-welcome-v1' THEN 'system' ELSE NULL END AS type/);
        const [subject] = params;
        return { rows: records.filter(row => row.subject === subject)
          .sort((left, right) => right.createdAt - left.createdAt)
          .map(row => ({ id: row.id, title: row.title, message: row.message, createdAt: row.createdAt, readAt: row.readAt, type: row.key === 'app-welcome-v1' ? 'system' : null })) };
      }
      if (/^\s*UPDATE stemma_student_notifications/i.test(sql)) {
        const [subject, ids] = params;
        const readAt = new Date('2026-05-01T12:00:00.000Z');
        const selected = records.filter(row => row.subject === subject && ids.includes(row.id));
        for (const row of selected) row.readAt ??= readAt;
        return { rows: selected.map(row => ({ id: row.id, readAt: row.readAt })) };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
}

async function createHarness({ notificationStore = null } = {}) {
  const config = buildConfig({ NODE_ENV: 'test', SESSION_SECRET });
  const sessionStore = new session.MemoryStore();
  const app = createApp({ config, sessionStore, notificationStore });
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
  return { origin, async close() { server.close(); await once(server, 'close'); }, cookieFor };
}

test('store seeds one long welcome notice per subject and lists only that subject newest first', async () => {
  const pool = createMemoryPool();
  const store = createNotificationStore(pool);
  const first = await store.listNotifications('google-A');
  const again = await store.listNotifications('google-A');
  const other = await store.listNotifications('google-B');
  assert.equal(first.length, 1);
  assert.equal(again.length, 1);
  assert.equal(other.length, 1);
  assert.notEqual(first[0].id, other[0].id);
  assert.match(first[0].title, /welcome/i);
  assert.equal(first[0].type, 'system');
  assert.ok(first[0].message.length > 250);
  assert.match(first[0].message, /payment examples in this demo do not move real money/i);
  assert.match(first[0].message, /does not add any sample or past transactions/i);
  assert.equal(pool.records.filter(row => row.subject === 'google-A').length, 1);
});

test('read updates are subject-scoped and return only changed rows', async () => {
  const pool = createMemoryPool();
  const store = createNotificationStore(pool);
  const a = (await store.listNotifications('google-A'))[0];
  const b = (await store.listNotifications('google-B'))[0];
  const marked = await store.markNotificationsRead('google-A', [a.id, b.id]);
  assert.deepEqual(marked.map(row => row.id), [a.id]);
  assert.equal(marked[0].readAt.toISOString(), '2026-05-01T12:00:00.000Z');
  assert.equal((await store.listNotifications('google-B'))[0].readAt, null);
  const markedAgain = await store.markNotificationsRead('google-A', [a.id]);
  assert.deepEqual(markedAgain.map(row => row.id), [a.id]);
  assert.equal(markedAgain[0].readAt.toISOString(), marked[0].readAt.toISOString());
});

test('API enforces Google authentication, same-origin JSON, validation, and owner-only marking', async t => {
  const pool = createMemoryPool();
  const store = createNotificationStore(pool);
  const h = await createHarness({ notificationStore: store });
  t.after(() => h.close());
  const googleA = await h.cookieFor('google-a', { provider: 'google', subject: 'google-A' });
  const googleB = await h.cookieFor('google-b', { provider: 'google', subject: 'google-B' });
  const fayda = await h.cookieFor('fayda', { provider: 'fayda', subject: 'fayda-A' });
  const endpoint = `${h.origin}/api/notifications`;

  const guest = await fetch(`${endpoint}/read`, { method: 'POST' });
  assert.equal(guest.status, 401);
  const nonGoogle = await fetch(`${endpoint}/read`, { method: 'POST', headers: { cookie: fayda } });
  assert.equal(nonGoogle.status, 403);

  const list = await fetch(endpoint, { headers: { cookie: googleA } });
  assert.equal(list.status, 200);
  assert.match(list.headers.get('cache-control') || '', /private/i);
  assert.match(list.headers.get('cache-control') || '', /no-store/i);
  const payload = await list.json();
  assert.equal(payload.sourceAvailable, true);
  assert.equal(payload.notifications.length, 1);
  assert.equal(payload.notifications[0].readAt, null);

  const noOrigin = await fetch(`${endpoint}/read`, {
    method: 'POST', headers: { cookie: googleA, 'content-type': 'application/json' }, body: JSON.stringify({ ids: [payload.notifications[0].id] })
  });
  assert.equal(noOrigin.status, 403);
  const wrongOrigin = await fetch(`${endpoint}/read`, {
    method: 'POST', headers: { cookie: googleA, origin: 'https://evil.example', 'content-type': 'application/json' }, body: JSON.stringify({ ids: [payload.notifications[0].id] })
  });
  assert.equal(wrongOrigin.status, 403);

  for (const body of [{}, { ids: ['not-a-uuid'] }, { ids: [payload.notifications[0].id], extra: true }, { ids: Array(5001).fill(payload.notifications[0].id) }]) {
    const invalid = await fetch(`${endpoint}/read`, {
      method: 'POST', headers: { cookie: googleA, origin: h.origin, 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    assert.equal(invalid.status, 400);
  }

  const bList = await fetch(endpoint, { headers: { cookie: googleB } });
  const bId = (await bList.json()).notifications[0].id;
  const mark = await fetch(`${endpoint}/read`, {
    method: 'POST', headers: { cookie: googleA, origin: h.origin, 'content-type': 'application/json' }, body: JSON.stringify({ ids: [payload.notifications[0].id, bId] })
  });
  assert.equal(mark.status, 200);
  const marked = await mark.json();
  assert.deepEqual(marked.readIds, [payload.notifications[0].id]);
  assert.equal(marked.readAt, '2026-05-01T12:00:00.000Z');
  const bAfter = await fetch(endpoint, { headers: { cookie: googleB } });
  assert.equal((await bAfter.json()).notifications[0].readAt, null);
  const replay = await fetch(`${endpoint}/read`, {
    method: 'POST', headers: { cookie: googleA, origin: h.origin, 'content-type': 'application/json' }, body: JSON.stringify({ ids: [payload.notifications[0].id, bId] })
  });
  assert.deepEqual((await replay.json()).readIds, [payload.notifications[0].id]);
});

test('unavailable store preserves honest empty GET; store failures return 503', async t => {
  const noStore = await createHarness();
  t.after(() => noStore.close());
  const cookie = await noStore.cookieFor('google', { provider: 'google', subject: 'google-A' });
  const empty = await fetch(`${noStore.origin}/api/notifications`, { headers: { cookie } });
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), { notifications: [], sourceAvailable: false });

  const pool = createMemoryPool();
  const h = await createHarness({ notificationStore: createNotificationStore(pool) });
  t.after(() => h.close());
  const activeCookie = await h.cookieFor('google', { provider: 'google', subject: 'google-A' });
  pool.setFail(true);
  const listFailure = await fetch(`${h.origin}/api/notifications`, { headers: { cookie: activeCookie } });
  assert.equal(listFailure.status, 503);
  const readFailure = await fetch(`${h.origin}/api/notifications/read`, {
    method: 'POST', headers: { cookie: activeCookie, origin: h.origin, 'content-type': 'application/json' }, body: JSON.stringify({ ids: [ID_A] })
  });
  assert.equal(readFailure.status, 503);
});

test('PostgreSQL migration, backfill, idempotence, subject isolation and read persistence', {
  skip: process.env.STEMMA_NOTIFICATIONS_POSTGRES_TEST !== '1'
}, async () => {
  const { Pool } = pg;
  const schema = `stemma_notifications_${crypto.randomUUID().replaceAll('-', '')}`;
  const baseConfig = {
    host: '127.0.0.1',
    port: 5432,
    database: 'stemma_notification_test',
    user: 'stemma_notification_test',
    password: 'local-notification-test-only',
    max: 2,
    connectionTimeoutMillis: 5000
  };
  const adminPool = new Pool(baseConfig);
  let scopedPool;
  try {
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const poolConfig = { ...baseConfig, options: `-c search_path=${schema}` };
    scopedPool = new Pool(poolConfig);
    await scopedPool.query(`CREATE TABLE stemma_google_identities (
      google_subject VARCHAR(255) PRIMARY KEY,
      verified_email VARCHAR(320) NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    await scopedPool.query('INSERT INTO stemma_google_identities (google_subject, verified_email) VALUES ($1, $2)', ['existing-google-user', 'verified@example.test']);

    const store = createNotificationStore(scopedPool);
    await store.migrate();
    const migrationBackfill = await scopedPool.query("SELECT count(*)::int AS count FROM stemma_student_notifications WHERE google_subject = 'existing-google-user' AND notification_key = 'app-welcome-v1'");
    assert.equal(migrationBackfill.rows[0].count, 1);
    const seeded = await store.listNotifications('existing-google-user');
    assert.equal(seeded.length, 1);
    assert.equal(seeded[0].type, 'system');
    await scopedPool.query("UPDATE stemma_student_notifications SET title = 'Renamed welcome' WHERE google_subject = $1", ['existing-google-user']);
    await scopedPool.query("INSERT INTO stemma_student_notifications (google_subject, notification_key, title, message) VALUES ($1, $2, $3, $4)", ['existing-google-user', 'personal-invitation', 'Welcome to Stemma', 'Personal message']);
    const classified = await store.listNotifications('existing-google-user');
    assert.equal(classified.find(item => item.title === 'Renamed welcome').type, 'system');
    assert.equal(classified.find(item => item.title === 'Welcome to Stemma').type, null);
    assert.equal((await store.listNotifications('existing-google-user')).length, 2);

    const userA = await store.listNotifications('new-google-user-A');
    const userB = await store.listNotifications('new-google-user-B');
    const changed = await store.markNotificationsRead('new-google-user-A', [userA[0].id, userB[0].id]);
    assert.deepEqual(changed.map(row => row.id), [userA[0].id]);
    const originalReadAt = changed[0].readAt.toISOString();
    const repeated = await store.markNotificationsRead('new-google-user-A', [userA[0].id]);
    assert.deepEqual(repeated.map(row => row.id), [userA[0].id]);
    assert.equal(repeated[0].readAt.toISOString(), originalReadAt);
    assert.equal((await store.listNotifications('new-google-user-B'))[0].readAt, null);

    await scopedPool.end();
    scopedPool = new Pool(poolConfig);
    const reopenedStore = createNotificationStore(scopedPool);
    assert.equal((await reopenedStore.listNotifications('new-google-user-A'))[0].readAt.toISOString(), originalReadAt);
    assert.equal((await reopenedStore.listNotifications('new-google-user-B'))[0].readAt, null);
  } finally {
    if (scopedPool) await scopedPool.end().catch(() => {});
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await adminPool.end();
  }
});
