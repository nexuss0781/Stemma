import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import http from 'node:http';
import pg from 'pg';
import session from 'express-session';
import signature from 'cookie-signature';
import { buildConfig, createApp, createGoogleIdentityStore, createStudentProfileStore } from '../server.js';

// Opt-in only: never uses production tables. Credentials are supplied outside the repository.
test('PostgreSQL preserves legacy details, stores real BYTEA photos, and isolates authenticated accounts', {
  skip: !process.env.STEMMA_POSTGRES_TEST_CONFIG,
  timeout: 120000
}, async t => {
  const [database] = JSON.parse(await fs.readFile(process.env.STEMMA_POSTGRES_TEST_CONFIG, 'utf8'));
  const connection = { host: database.host, port: database.port, user: database.username,
    password: database.password, database: database.name, ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000, query_timeout: 15000 };
  const schema = `stemma_pg_test_${crypto.randomBytes(8).toString('hex')}`;
  assert.match(schema, /^stemma_pg_test_[a-f0-9]{16}$/);
  const admin = new pg.Client(connection);
  await admin.connect();
  let pool;
  let server;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ ...connection, options: `-c search_path=${schema}`, max: 3 });
    const identities = createGoogleIdentityStore(pool);
    await identities.migrate();
    await pool.query(await fs.readFile(new URL('../migrations/002_student_profiles.sql', import.meta.url), 'utf8'));
    await pool.query("ALTER TABLE stemma_student_profiles ADD COLUMN nick_name TEXT NOT NULL DEFAULT '', ADD COLUMN username TEXT NOT NULL DEFAULT '', ADD COLUMN bio TEXT NOT NULL DEFAULT ''");
    const alpha = 'synthetic-pg-profile-alpha';
    const beta = 'synthetic-pg-profile-beta';
    await identities.upsertGoogleIdentity({ subject: alpha, verifiedEmail: 'alpha@example.invalid' });
    await identities.upsertGoogleIdentity({ subject: beta, verifiedEmail: 'beta@example.invalid' });
    const details = { firstName: 'Alex', middleName: 'Sample', lastName: 'Student', studentId: 'TEST-026', department: 'Computer Science', nickName: 'Alex', username: 'alex_student', bio: 'Synthetic database integration profile.' };
    await pool.query('INSERT INTO stemma_student_profiles (google_subject,first_name,middle_name,last_name,student_id,department,nick_name,username,bio) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [alpha, ...Object.values(details)]);
    const profiles = createStudentProfileStore(pool);
    await profiles.migrate();
    await profiles.migrate();
    const preserved = await profiles.getStudentProfile(alpha);
    for (const [key, value] of Object.entries(details)) assert.equal(preserved[key], value, `migration preserves ${key}`);
    await profiles.upsertStudentProfile(beta, { ...details, username: 'beta_student' });
    const email = await pool.query('SELECT verified_email FROM stemma_google_identities WHERE google_subject=$1', [alpha]);
    assert.equal(email.rows[0].verified_email, 'alpha@example.invalid');
    const secret = 'synthetic-postgres-test-session-key-not-a-production-key';
    const sessions = new session.MemoryStore();
    const cookie = async subject => {
      const sid = `synthetic-${subject}`;
      await new Promise((resolve, reject) => sessions.set(sid, { cookie: { originalMaxAge: null, expires: null, httpOnly: true, path: '/', sameSite: 'lax', secure: false }, stemmaUser: { provider: 'google', subject, profile: { name: 'Synthetic Student', email: subject === alpha ? 'alpha@example.invalid' : 'beta@example.invalid' } } }, error => error ? reject(error) : resolve()));
      return `stemma.sid=${encodeURIComponent(`s:${signature.sign(sid, secret)}`)}`;
    };
    const alphaCookie = await cookie(alpha);
    const betaCookie = await cookie(beta);
    const start = async () => {
      const app = createApp({ config: buildConfig({ NODE_ENV: 'test', SESSION_SECRET: secret }), sessionStore: sessions, googleIdentityStore: createGoogleIdentityStore(pool), studentProfileStore: createStudentProfileStore(pool) });
      server = http.createServer(app);
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      return `http://127.0.0.1:${server.address().port}`;
    };
    let origin = await start();
    const photo = await fs.readFile(new URL('../assets/google-signin-mark.png', import.meta.url));
    const get = (userCookie, path = '/api/student-profile/photo') => fetch(origin + path, { headers: { Cookie: userCookie } });
    const put = (userCookie, extra = {}) => fetch(origin + '/api/student-profile/photo', { method: 'PUT', headers: { Cookie: userCookie, Origin: origin, 'Content-Type': 'image/png', ...extra }, body: photo });
    assert.equal((await fetch(origin + '/api/student-profile/photo')).status, 401);
    assert.equal((await get(alphaCookie)).status, 404);
    assert.equal((await put(alphaCookie)).status, 200);
    let response = await get(alphaCookie);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^image\/png/);
    assert.match(response.headers.get('cache-control'), /private/);
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), photo);
    assert.equal((await get(betaCookie)).status, 404, 'another account cannot read the first photo');
    assert.equal((await put(alphaCookie, { 'If-None-Match': '*' })).status, 412, 'legacy import cannot replace an existing remote photo');
    const columns = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='stemma_student_profiles' AND data_type='bytea'", [schema]);
    assert.equal(columns.rows.length, 1);
    const imageColumn = columns.rows[0].column_name;
    assert.match(imageColumn, /^[a-z_]+$/);
    const stored = await pool.query(`SELECT ${imageColumn} AS bytes FROM stemma_student_profiles WHERE google_subject=$1`, [alpha]);
    assert.deepEqual(stored.rows[0].bytes, photo, 'actual image bytes are persisted in PostgreSQL, not an in-memory placeholder');
    const other = await pool.query(`SELECT ${imageColumn} AS bytes FROM stemma_student_profiles WHERE google_subject=$1`, [beta]);
    assert.equal(other.rows[0].bytes, null);
    const json = await (await get(alphaCookie, '/api/student-profile')).json();
    for (const [key, value] of Object.entries(details)) assert.equal(json.profile[key], value);
    assert.ok(!JSON.stringify(json).includes(photo.toString('base64')), 'JSON details do not expose binary photo data');
    await new Promise(resolve => server.close(resolve));
    await pool.end();
    pool = new pg.Pool({ ...connection, options: `-c search_path=${schema}`, max: 3 });
    origin = await start();
    response = await get(alphaCookie);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), photo, 'photo survives server and database-pool recreation');
    assert.equal((await get(betaCookie)).status, 404);
    console.log('Real PostgreSQL verified: preserved details/email, BYTEA storage, server restart, account isolation; synthetic schema only.');
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
