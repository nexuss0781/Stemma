import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PostgresSessionStore } from '../postgres-session-store.js';

class FakePostgresPool {
  rows = new Map();
  queries = [];

  async query(sql, params = []) {
    this.queries.push(sql);
    if (sql.includes('CREATE TABLE') || sql.includes('ALTER TABLE') || sql.includes('CREATE INDEX')) {
      return { rows: [] };
    }
    if (sql.includes('UPDATE stemma_sessions') && sql.includes("AND sess->>'stemmaUser' IS NOT NULL")) {
      for (const [sid, row] of this.rows) {
        if (row.expire !== 'infinity' && row.sess?.stemmaUser && row.sess.kind !== 'mobile-auth-handoff' &&
            !sid.startsWith('stemma.mobile.handoff.') &&
            (row.expire === null || row.expire?.getTime() >= Date.now())) row.expire = 'infinity';
      }
      return { rows: [] };
    }
    if (sql.includes("SET expire = 'infinity'::timestamp")) {
      const row = this.rows.get(params[0]);
      if (row && row.expire !== 'infinity' && row.expire?.getTime() >= Date.now()) row.expire = 'infinity';
      return { rows: [] };
    }
    if (sql.startsWith('INSERT INTO stemma_sessions')) {
      const [sid, sess, expire] = params;
      this.rows.set(sid, { sess: structuredClone(sess), expire });
      return { rows: [{ sid }] };
    }
    if (sql.startsWith('SELECT sess, expire =')) {
      const row = this.rows.get(params[0]);
      if (!row || (row.expire !== 'infinity' && row.expire && row.expire.getTime() < Date.now())) return { rows: [] };
      return { rows: [{ sess: structuredClone(row.sess), durable: row.expire === 'infinity' }] };
    }
    if (sql.startsWith('DELETE FROM stemma_sessions') && sql.includes('RETURNING sess')) {
      const [sid, state, challenge, now] = params;
      const row = this.rows.get(sid);
      const expiry = Number(row?.sess?.expiresAt);
      if (!row || (row.expire !== 'infinity' && row.expire && row.expire.getTime() < Date.now()) ||
          (row.sess?.kind !== 'mobile-auth-handoff' &&
            !(row.sess?.kind === undefined && sid.startsWith('stemma.mobile.handoff.'))) || row.sess.state !== state ||
          row.sess.codeChallenge !== challenge || !Number.isFinite(expiry) || expiry <= now) return { rows: [] };
      this.rows.delete(sid);
      return { rows: [{ sess: structuredClone(row.sess) }] };
    }
    if (sql.startsWith('UPDATE stemma_sessions')) {
      const row = this.rows.get(params[0]);
      if (row) row.expire = params[1];
      return { rows: [] };
    }
    if (sql.startsWith('DELETE FROM stemma_sessions WHERE sid =')) {
      this.rows.delete(params[0]);
      return { rows: [] };
    }
    if (sql.startsWith('DELETE FROM stemma_sessions WHERE expire')) {
      for (const [sid, row] of this.rows) {
        if (row.expire !== 'infinity' && row.expire && row.expire.getTime() < Date.now()) this.rows.delete(sid);
      }
      return { rows: [] };
    }
    throw new Error(`Unexpected fake PostgreSQL query: ${sql}`);
  }
}

function callStore(store, method, ...args) {
  return new Promise((resolve, reject) => {
    store[method](...args, (error, value) => error ? reject(error) : resolve(value));
  });
}

const user = { provider: 'google', subject: 'subject-123' };

test('store migration makes only live authenticated non-handoff sessions durable', async t => {
  const pool = new FakePostgresPool();
  const store = new PostgresSessionStore(pool);
  t.after(() => store.close());
  const oldExpiry = new Date(Date.now() + 60_000);
  const expired = new Date(Date.now() - 60_000);
  pool.rows.set('old-live-auth', { sess: { stemmaUser: user }, expire: oldExpiry });
  pool.rows.set('old-expired-auth', { sess: { stemmaUser: user }, expire: expired });
  pool.rows.set('old-live-handoff', { sess: { kind: 'mobile-auth-handoff', stemmaUser: user, expiresAt: Date.now() + 120_000 }, expire: oldExpiry });
  pool.rows.set('old-preauth', { sess: { cookie: {} }, expire: oldExpiry });

  await store.migrate();
  assert.equal(pool.rows.get('old-live-auth').expire, 'infinity');
  assert.equal(pool.rows.get('old-expired-auth').expire, expired, 'migration must not revive expired authentication');
  assert.equal(pool.rows.get('old-live-handoff').expire, oldExpiry, 'handoff records retain their short database expiry');
  assert.equal(pool.rows.get('old-preauth').expire, oldExpiry, 'unauthenticated sessions keep their expiry');
  assert.ok(pool.queries.some(query => query.includes('ALTER TABLE stemma_sessions ALTER COLUMN expire DROP NOT NULL')));
});

test('authenticated sessions stay durable across restart, restore a practical cookie, and logout revokes them', async t => {
  const pool = new FakePostgresPool();
  const store = new PostgresSessionStore(pool);
  t.after(() => store.close());
  await store.migrate();

  const authenticated = {
    cookie: { originalMaxAge: 60_000, maxAge: 60_000, expires: new Date(Date.now() - 60_000).toISOString() },
    stemmaUser: user
  };
  await callStore(store, 'set', 'durable-session', authenticated);
  assert.equal(pool.rows.get('durable-session').expire, 'infinity', 'authenticated row must have no server expiry');

  const restartedStore = new PostgresSessionStore(pool);
  t.after(() => restartedStore.close());
  const getQueryStart = pool.queries.length;
  const restored = await callStore(restartedStore, 'get', 'durable-session');
  assert.equal(pool.queries.length - getQueryStart, 1, 'already-durable GET should issue only its SELECT');
  assert.match(pool.queries[getQueryStart], /^\s*SELECT sess, expire = 'infinity'::timestamp AS durable/);
  assert.ok(!pool.queries.slice(getQueryStart).some(query => query.startsWith('UPDATE stemma_sessions')),
    'already-durable GET must not issue repair/touch SQL');
  assert.equal(restored.stemmaUser.subject, user.subject);
  assert.equal(restored.cookie.maxAge, 400 * 24 * 60 * 60 * 1000);
  assert.equal(restored.cookie.originalMaxAge, 400 * 24 * 60 * 60 * 1000);
  assert.ok(new Date(restored.cookie.expires).getTime() > Date.now());
  const queryCount = pool.queries.length;
  await callStore(restartedStore, 'touch', 'durable-session', authenticated);
  assert.equal(pool.queries.length, queryCount, 'authenticated rolling-cookie touches should not write to PostgreSQL');

  await callStore(restartedStore, 'destroy', 'durable-session');
  assert.equal(await callStore(restartedStore, 'get', 'durable-session'), undefined, 'logout must revoke the durable database row');
});

test('pre-authentication and mobile handoff records retain short expiration', async t => {
  const pool = new FakePostgresPool();
  const store = new PostgresSessionStore(pool);
  t.after(() => store.close());
  await store.migrate();

  const before = Date.now();
  const preAuth = { cookie: { expires: new Date(before + 8 * 60 * 60 * 1000).toISOString() }, oidcTransactions: { state: { expiresAt: before + 5 * 60 * 1000 } } };
  await callStore(store, 'set', 'preauth-session', preAuth);
  const expiry = pool.rows.get('preauth-session').expire;
  assert.ok(expiry instanceof Date);
  assert.ok(expiry.getTime() > before);
  assert.ok(expiry.getTime() <= before + 8 * 60 * 60 * 1000 + 1000);
  assert.deepEqual(await callStore(store, 'get', 'preauth-session'), preAuth);

  const handoffExpiry = Date.now() + 120_000;
  const handoff = {
    kind: 'mobile-auth-handoff', stemmaUser: user, state: 'state-value', codeChallenge: 'challenge-value', expiresAt: handoffExpiry,
    cookie: { originalMaxAge: 120_000, maxAge: 120_000, expires: new Date(handoffExpiry).toISOString() }
  };
  await callStore(store, 'set', 'handoff', handoff);
  const handoffDbExpiry = pool.rows.get('handoff').expire;
  assert.ok(handoffDbExpiry instanceof Date);
  assert.ok(Math.abs(handoffDbExpiry.getTime() - handoffExpiry) < 10);
  assert.deepEqual(await callStore(store, 'get', 'handoff'), handoff, 'handoff cookie lifetime must not be extended as an authenticated browser cookie');
  assert.equal(await store.consumeMobileHandoff('handoff', 'wrong-state', 'challenge-value'), null);
  assert.ok(pool.rows.has('handoff'), 'invalid consumption must not delete a handoff');
});

test('legacy kindless mobile handoffs stay transient and can be consumed once', async t => {
  const pool = new FakePostgresPool();
  const store = new PostgresSessionStore(pool);
  t.after(() => store.close());
  const expiresAt = Date.now() + 120_000;
  const legacyHandoff = {
    stemmaUser: user, state: 'legacy-state', codeChallenge: 'legacy-challenge', expiresAt,
    cookie: { originalMaxAge: 120_000, maxAge: 120_000, expires: new Date(expiresAt).toISOString() }
  };
  const sid = 'stemma.mobile.handoff.legacy-code';
  const dbExpiry = new Date(expiresAt);
  pool.rows.set(sid, { sess: structuredClone(legacyHandoff), expire: dbExpiry });

  await store.migrate();
  assert.equal(pool.rows.get(sid).expire, dbExpiry, 'migration must not promote legacy handoffs to durable auth');
  assert.deepEqual(await callStore(store, 'get', sid), legacyHandoff, 'legacy handoff reads must not restore a durable-auth cookie');
  assert.deepEqual(await store.consumeMobileHandoff(sid, 'legacy-state', 'legacy-challenge'), legacyHandoff);
  assert.equal(pool.rows.has(sid), false, 'a valid legacy handoff is atomically consumed');
});

test('mobile handoff is atomically consumed once with matching state, challenge, and expiry', async t => {
  const pool = new FakePostgresPool();
  const storeA = new PostgresSessionStore(pool);
  const storeB = new PostgresSessionStore(pool);
  t.after(() => storeA.close());
  t.after(() => storeB.close());
  await storeA.migrate();
  const expiresAt = Date.now() + 120_000;
  const handoff = { kind: 'mobile-auth-handoff', stemmaUser: user, state: 'state', codeChallenge: 'challenge', expiresAt };
  await callStore(storeA, 'set', 'one-time-handoff', handoff);
  const results = await Promise.all([
    storeA.consumeMobileHandoff('one-time-handoff', 'state', 'challenge'),
    storeB.consumeMobileHandoff('one-time-handoff', 'state', 'challenge')
  ]);
  assert.equal(results.filter(Boolean).length, 1, 'only one store instance may consume the handoff');
  assert.equal(results.filter(value => value === null).length, 1);
  assert.equal(pool.rows.has('one-time-handoff'), false);

  await callStore(storeA, 'set', 'expired-handoff', { ...handoff, expiresAt: Date.now() - 1 });
  assert.equal(await storeB.consumeMobileHandoff('expired-handoff', 'state', 'challenge'), null);
  assert.equal(pool.rows.has('expired-handoff'), true, 'expired credentials are not returned as consumed sessions');
});
