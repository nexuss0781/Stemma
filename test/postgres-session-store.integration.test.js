import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { PostgresSessionStore } from '../postgres-session-store.js';

const enabled = process.env.STEMMA_SESSION_DB_TEST === '1';
const connection = {
  host: process.env.STEMMA_SESSION_DB_HOST || '127.0.0.1',
  port: Number(process.env.STEMMA_SESSION_DB_PORT || 5432),
  database: process.env.STEMMA_SESSION_DB_NAME || 'stemma_session_store_test',
  user: process.env.STEMMA_SESSION_DB_USER || 'stemma_session_store_test',
  password: process.env.STEMMA_SESSION_DB_PASSWORD || 'local-session-store-test-only',
  max: 4,
  connectionTimeoutMillis: 5000
};

const makeStore = pool => new PostgresSessionStore(pool);

test('PostgreSQL session store migration, durable auth, short TTL, atomic handoff, restart, and logout', {
  skip: !enabled,
  timeout: 120000
}, async t => {
  const { Pool } = pg;
  const schema = `stemma_session_it_${crypto.randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^stemma_session_it_[a-f0-9]{32}$/);
  const admin = new Pool(connection);
  let poolA;
  let poolB;
  let storeA;
  let storeB;
  let schemaCreated = false;
  t.after(async () => {
    storeA?.close();
    storeB?.close();
    await poolA?.end();
    await poolB?.end();
    if (schemaCreated) await admin.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => {});
    await admin.end();
  });
  await admin.query(`CREATE SCHEMA ${schema}`);
    schemaCreated = true;
    const options = `-c search_path=${schema}`;
    poolA = new Pool({ ...connection, options });
    poolB = new Pool({ ...connection, options });

    // Reproduce the old connect-pg-simple schema and its rows before migration.
    await poolA.query(`CREATE TABLE stemma_sessions (
      sid varchar NOT NULL PRIMARY KEY,
      sess json NOT NULL,
      expire timestamp(6) NOT NULL
    )`);
    const handoffExpiry = Date.now() + 120_000;
    const user = { provider: 'google', subject: 'pg-session-integration-user' };
    await poolA.query(`INSERT INTO stemma_sessions (sid, sess, expire) VALUES
      ('legacy-live-auth', $1::json, CURRENT_TIMESTAMP + interval '2 minutes'),
      ('legacy-expired-auth', $2::json, CURRENT_TIMESTAMP - interval '2 minutes'),
      ('legacy-handoff', $3::json, CURRENT_TIMESTAMP + interval '2 minutes'),
      ('legacy-preauth', $4::json, CURRENT_TIMESTAMP + interval '2 minutes'),
      ('stemma.mobile.handoff.legacy-integration', $5::json, CURRENT_TIMESTAMP + interval '2 minutes')`, [
      JSON.stringify({ stemmaUser: user, cookie: { maxAge: 1, originalMaxAge: 1, expires: '2000-01-01T00:00:00.000Z' } }),
      JSON.stringify({ stemmaUser: { ...user, subject: 'expired-user' } }),
      JSON.stringify({ kind: 'mobile-auth-handoff', stemmaUser: user, state: 'legacy-state', codeChallenge: 'legacy-challenge', expiresAt: handoffExpiry }),
      JSON.stringify({ cookie: { expires: '2000-01-01T00:00:00.000Z' } }),
      JSON.stringify({ stemmaUser: user, state: 'legacy-kindless-state', codeChallenge: 'legacy-kindless-challenge', expiresAt: handoffExpiry })
    ]);

    storeA = makeStore(poolA);
    storeB = makeStore(poolB);
    await storeA.migrate();

    const expiries = await poolA.query('SELECT sid, expire::text AS expire FROM stemma_sessions ORDER BY sid');
    const expiryById = new Map(expiries.rows.map(row => [row.sid, row.expire]));
    assert.equal(expiryById.get('legacy-live-auth'), 'infinity', 'live authenticated legacy rows become non-expiring');
    assert.notEqual(expiryById.get('legacy-expired-auth'), 'infinity', 'expired authentication is not revived');
    assert.notEqual(expiryById.get('legacy-handoff'), 'infinity', 'handoff rows keep their short expiry');
    assert.notEqual(expiryById.get('legacy-preauth'), 'infinity', 'pre-authentication rows keep their short expiry');
    assert.notEqual(expiryById.get('stemma.mobile.handoff.legacy-integration'), 'infinity', 'legacy kindless handoff stays transient');
    assert.equal(await new Promise((resolve, reject) => storeA.get('legacy-expired-auth', (error, value) => error ? reject(error) : resolve(value))), undefined);

    const legacyHandoff = await new Promise((resolve, reject) => storeA.get('stemma.mobile.handoff.legacy-integration', (error, value) => error ? reject(error) : resolve(value)));
    assert.equal(legacyHandoff.stemmaUser.subject, user.subject);
    assert.equal(legacyHandoff.cookie?.maxAge, undefined, 'legacy handoff must not receive a durable-auth cookie lifetime');
    const consumedLegacyHandoff = await storeA.consumeMobileHandoff('stemma.mobile.handoff.legacy-integration', 'legacy-kindless-state', 'legacy-kindless-challenge');
    assert.equal(consumedLegacyHandoff.stemmaUser.subject, user.subject, 'legacy kindless handoff remains consumable');
    assert.equal((await poolA.query(`SELECT 1 FROM stemma_sessions WHERE sid = 'stemma.mobile.handoff.legacy-integration'`)).rowCount, 0);

    const restored = await new Promise((resolve, reject) => storeB.get('legacy-live-auth', (error, value) => error ? reject(error) : resolve(value)));
    assert.equal(restored.stemmaUser.subject, user.subject);
    assert.equal(restored.cookie.maxAge, 400 * 24 * 60 * 60 * 1000);
    assert.equal(restored.cookie.originalMaxAge, 400 * 24 * 60 * 60 * 1000);
    assert.ok(new Date(restored.cookie.expires).getTime() > Date.now(), 'stale persisted cookie expiry is refreshed after restart');

    // Simulate an old application node touching a durable row back to its former cookie expiry.
    await poolA.query(`UPDATE stemma_sessions SET expire = CURRENT_TIMESTAMP + interval '30 minutes' WHERE sid = 'legacy-live-auth'`);
    const refreshed = await new Promise((resolve, reject) => storeB.get('legacy-live-auth', (error, value) => error ? reject(error) : resolve(value)));
    assert.ok(new Date(refreshed.cookie.expires).getTime() > Date.now());
    const repairedExpiry = await poolA.query(`SELECT expire::text AS expire FROM stemma_sessions WHERE sid = 'legacy-live-auth'`);
    assert.equal(repairedExpiry.rows[0].expire, 'infinity', 'get repairs a finite expiry written by an older node');

    const transientExpiry = Date.now() + 90_000;
    const preauth = { cookie: { expires: new Date(transientExpiry).toISOString() } };
    await new Promise((resolve, reject) => storeA.set('new-preauth', preauth, error => error ? reject(error) : resolve()));
    const storedTransient = await poolA.query(`SELECT expire FROM stemma_sessions WHERE sid = 'new-preauth'`);
    assert.ok(storedTransient.rows[0].expire.getTime() > Date.now());
    assert.ok(storedTransient.rows[0].expire.getTime() <= transientExpiry + 1000);

    const handoff = {
      kind: 'mobile-auth-handoff', stemmaUser: user, state: 'atomic-state', codeChallenge: 'atomic-challenge',
      expiresAt: Date.now() + 120_000,
      cookie: { maxAge: 120_000, originalMaxAge: 120_000, expires: new Date(Date.now() + 120_000).toISOString() }
    };
    await new Promise((resolve, reject) => storeA.set('new-handoff', handoff, error => error ? reject(error) : resolve()));
    const storedHandoff = await poolA.query(`SELECT expire FROM stemma_sessions WHERE sid = 'new-handoff'`);
    assert.ok(storedHandoff.rows[0].expire.getTime() > Date.now());
    assert.ok(storedHandoff.rows[0].expire.getTime() <= handoff.expiresAt + 1000, 'handoff database expiry remains short despite stemmaUser');
    assert.equal(await storeA.consumeMobileHandoff('new-handoff', 'wrong-state', 'atomic-challenge'), null);
    const consumes = await Promise.all([
      storeA.consumeMobileHandoff('new-handoff', 'atomic-state', 'atomic-challenge'),
      storeB.consumeMobileHandoff('new-handoff', 'atomic-state', 'atomic-challenge')
    ]);
    assert.equal(consumes.filter(Boolean).length, 1, 'separate store instances and connections atomically return one handoff');
    assert.equal(consumes.filter(value => value === null).length, 1);
    assert.equal((await poolA.query(`SELECT 1 FROM stemma_sessions WHERE sid = 'new-handoff'`)).rowCount, 0);

    const durable = { stemmaUser: user, cookie: { maxAge: 60_000, originalMaxAge: 60_000, expires: new Date(Date.now() - 60_000).toISOString() } };
    await new Promise((resolve, reject) => storeA.set('durable-session', durable, error => error ? reject(error) : resolve()));
    const restartStore = makeStore(poolB);
    try {
      const afterRestart = await new Promise((resolve, reject) => restartStore.get('durable-session', (error, value) => error ? reject(error) : resolve(value)));
      assert.equal(afterRestart.stemmaUser.subject, user.subject);
      assert.equal(afterRestart.cookie.maxAge, 400 * 24 * 60 * 60 * 1000);
    } finally {
      restartStore.close();
    }
    await new Promise((resolve, reject) => storeB.destroy('durable-session', error => error ? reject(error) : resolve()));
    assert.equal(await new Promise((resolve, reject) => storeA.get('durable-session', (error, value) => error ? reject(error) : resolve(value))), undefined,
      'logout destroy remains effective for durable authenticated rows');

  // A handoff's application-level expiresAt also blocks consumption even if
  // an incorrectly extended database expiry exists.
  const alreadyExpired = { ...handoff, expiresAt: Date.now() - 1 };
  await new Promise((resolve, reject) => storeA.set('expired-handoff', alreadyExpired, error => error ? reject(error) : resolve()));
  assert.equal(await storeB.consumeMobileHandoff('expired-handoff', 'atomic-state', 'atomic-challenge'), null);
});
