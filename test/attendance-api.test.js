import assert from 'node:assert/strict';
import { once } from 'node:events';
import crypto from 'node:crypto';
import test from 'node:test';
import signature from 'cookie-signature';
import session from 'express-session';
import pg from 'pg';
import { buildConfig, createApp } from '../server.js';
import { createAttendanceStore, parseStudentList } from '../attendance-api.js';

const SESSION_SECRET = 'teacher-attendance-tests-use-a-long-session-secret';
const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ID_FOREIGN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function memoryAttendanceStore() {
  const rosters = new Map();
  const days = new Map();
  return {
    async getAttendance(subject, date) {
      return { students: rosters.get(subject) ?? [], presentIds: days.get(`${subject}:${date}`) ?? [], date };
    },
    async importStudents(subject, names, date) {
      const students = rosters.get(subject) ?? [];
      for (const item of names) {
        if (!students.some(student => student.name.toLocaleLowerCase() === item.normalizedName.toLocaleLowerCase())) {
          students.push({ id: crypto.randomUUID(), name: item.name });
        }
      }
      rosters.set(subject, students);
      return this.getAttendance(subject, date);
    },
    async saveAttendance(subject, date, presentIds) {
      const owned = rosters.get(subject) ?? [];
      if (presentIds.some(id => !owned.some(student => student.id === id))) return null;
      days.set(`${subject}:${date}`, presentIds);
      return this.getAttendance(subject, date);
    }
  };
}

async function createHarness({ attendanceStore = null } = {}) {
  const config = buildConfig({ NODE_ENV: 'test', SESSION_SECRET });
  const sessionStore = new session.MemoryStore();
  const app = createApp({ config, sessionStore, attendanceStore });
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
  return { origin, cookieFor, async close() { server.close(); await once(server, 'close'); } };
}

const jsonRequest = (url, method, cookie, origin, body) => fetch(url, {
  method,
  headers: { ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}), 'content-type': 'application/json' },
  body: JSON.stringify(body)
});

test('parseStudentList accepts only hyphen bullets and rejects invalid or oversized names', () => {
  assert.deepEqual(parseStudentList('Roster follows:\n  - Aster One  \n2. Birch Two\n• Cedar Three\n- Aster   One\n-   \n* Dune Four\n\n'), [
    { name: 'Aster One', normalizedName: 'Aster One' },
  ]);
  assert.deepEqual(parseStudentList('Plain name\n2. Numbered name\n• Other bullet\n* Star bullet\n'), []);
  assert.deepEqual(parseStudentList('\n \n'), []);
  assert.equal(parseStudentList(`- A${'x'.repeat(120)}`), null);
  assert.equal(parseStudentList('- Good Name\n  - Bad\u0000Name'), null);
  assert.equal(parseStudentList(Array.from({ length: 1001 }, (_, i) => `- Student ${i}`).join('\n')), null);
  assert.equal(parseStudentList('x'.repeat(128 * 1024 + 1)), null);
});

test('attendance API requires Google session, same-origin JSON writes, and strictly validates dates and IDs', async t => {
  const h = await createHarness({ attendanceStore: memoryAttendanceStore() });
  t.after(() => h.close());
  const google = await h.cookieFor('attendance-google', { provider: 'google', subject: 'attendance-A' });
  const fayda = await h.cookieFor('attendance-fayda', { provider: 'fayda', subject: 'fayda-A' });
  const guest = await fetch(`${h.origin}/api/system-apps/attendance?date=2026-05-01`);
  assert.equal(guest.status, 401);
  const nonGoogle = await fetch(`${h.origin}/api/system-apps/attendance?date=2026-05-01`, { headers: { cookie: fayda } });
  assert.equal(nonGoogle.status, 403);

  const invalidDate = await fetch(`${h.origin}/api/system-apps/attendance?date=2026-02-30`, { headers: { cookie: google } });
  assert.equal(invalidDate.status, 400);
  const initial = await fetch(`${h.origin}/api/system-apps/attendance?date=2026-05-01`, { headers: { cookie: google } });
  assert.equal(initial.status, 200);
  assert.match(initial.headers.get('cache-control') ?? '', /no-store/);
  assert.deepEqual(await initial.json(), { students: [], presentIds: [], date: '2026-05-01' });

  assert.equal((await jsonRequest(`${h.origin}/api/system-apps/attendance/import`, 'POST', google, null, { text: 'Aster One' })).status, 403);
  assert.equal((await jsonRequest(`${h.origin}/api/system-apps/attendance/import`, 'POST', google, 'https://wrong.example', { text: 'Aster One' })).status, 403);
  const noNames = await jsonRequest(`${h.origin}/api/system-apps/attendance/import?date=2026-05-01`, 'POST', google, h.origin,
    { text: 'Roster follows:\nAster One\n2. Birch Two\n• Cedar Three' });
  assert.equal(noNames.status, 400);
  assert.match((await noNames.json()).error, /No student names found.*hyphen bullets/u);
  const invalidName = await jsonRequest(`${h.origin}/api/system-apps/attendance/import?date=2026-05-01`, 'POST', google, h.origin,
    { text: '- Good Name\n  - Bad\u0000Name' });
  assert.equal(invalidName.status, 400);
  assert.equal((await invalidName.json()).error, 'Student import request is invalid.');
  const unchanged = await fetch(`${h.origin}/api/system-apps/attendance?date=2026-05-01`, { headers: { cookie: google } });
  assert.deepEqual((await unchanged.json()).students, [], 'rejected imports do not mutate the roster');

  const imported = await jsonRequest(`${h.origin}/api/system-apps/attendance/import?date=2026-05-01`, 'POST', google, h.origin,
    { text: 'Roster follows:\n• Ignored Other\n2. Ignored Numbered\nAster One\n  - Aster One\n- Birch Two\n- Aster   One' });
  assert.equal(imported.status, 200);
  const state = await imported.json();
  assert.deepEqual(state.students.map(student => student.name), ['Aster One', 'Birch Two']);
  assert.deepEqual(state.presentIds, []);
  assert.equal(state.date, '2026-05-01');
  assert.match(imported.headers.get('cache-control') ?? '', /no-store/);

  assert.equal((await jsonRequest(`${h.origin}/api/system-apps/attendance`, 'PUT', google, h.origin,
    { date: '2026-05-01', presentIds: [state.students[0].id, ID_FOREIGN] })).status, 400);
  assert.equal((await jsonRequest(`${h.origin}/api/system-apps/attendance`, 'PUT', google, h.origin,
    { date: '2026-02-30', presentIds: [] })).status, 400);
  const saved = await jsonRequest(`${h.origin}/api/system-apps/attendance`, 'PUT', google, h.origin,
    { date: '2026-05-01', presentIds: [state.students[0].id, state.students[0].id] });
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json()).presentIds, [state.students[0].id]);
});

test('missing attendance store returns a private no-store service error', async t => {
  const h = await createHarness();
  t.after(() => h.close());
  const google = await h.cookieFor('attendance-no-store', { provider: 'google', subject: 'attendance-A' });
  const response = await fetch(`${h.origin}/api/system-apps/attendance?date=2026-05-01`, { headers: { cookie: google } });
  assert.equal(response.status, 503);
  assert.match(response.headers.get('cache-control') ?? '', /no-store/);
});

test('PostgreSQL attendance roster and dated snapshots persist and remain owner-isolated', {
  skip: process.env.STEMMA_ATTENDANCE_POSTGRES_TEST !== '1',
  timeout: 120000
}, async () => {
  const { Pool } = pg;
  const schema = `stemma_attendance_${crypto.randomUUID().replaceAll('-', '')}`;
  const connection = {
    host: '127.0.0.1', port: 5432, database: 'stemma_notification_test',
    user: 'stemma_notification_test', password: 'local-notification-test-only',
    max: 3, connectionTimeoutMillis: 5000
  };
  const admin = new Pool(connection);
  let pool;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ ...connection, options: `-c search_path=${schema}` });
    await pool.query(`CREATE TABLE stemma_google_identities (
      google_subject VARCHAR(255) PRIMARY KEY,
      verified_email VARCHAR(320) NOT NULL DEFAULT ''
    )`);
    await pool.query('INSERT INTO stemma_google_identities (google_subject) VALUES ($1), ($2)', ['attendance-owner', 'attendance-other']);
    const store = createAttendanceStore(pool);
    await store.migrate();
    await store.migrate();

    const imported = await store.importStudents('attendance-owner', parseStudentList('- Ava Green\n- Ava Gray\n- Ava Green'), '2026-06-01');
    assert.deepEqual(imported.students.map(student => student.name), ['Ava Green', 'Ava Gray'], 'exact normalized duplicates are deduped while differing full names remain and import order is stable');
    const avaGreen = imported.students[0].id;
    const avaGray = imported.students[1].id;
    await store.importStudents('attendance-owner', parseStudentList('- Ava   Green \n- Nia Blue'), '2026-06-02');
    assert.equal((await store.getAttendance('attendance-owner', '2026-06-02')).students.length, 3, 'reimport appends only unseen normalized names');
    assert.equal(await store.saveAttendance('attendance-other', '2026-06-01', [avaGreen]), null, 'other subjects cannot mark a foreign student present');

    const firstDay = await store.saveAttendance('attendance-owner', '2026-06-01', [avaGreen]);
    assert.deepEqual(firstDay.presentIds, [avaGreen]);
    await store.saveAttendance('attendance-owner', '2026-06-01', [avaGray]);
    assert.deepEqual((await store.getAttendance('attendance-owner', '2026-06-01')).presentIds, [avaGray], 'PUT replaces the selected day snapshot');
    assert.deepEqual((await store.getAttendance('attendance-owner', '2026-06-02')).presentIds, [], 'other historical dates remain independent');
    assert.deepEqual((await store.saveAttendance('attendance-owner', '2026-06-03', [])).presentIds, [], 'an all-absent day is also a saved snapshot');
    const snapshots = await pool.query('SELECT attendance_date::text AS date FROM stemma_teacher_attendance_snapshots WHERE google_subject = $1 ORDER BY attendance_date', ['attendance-owner']);
    assert.deepEqual(snapshots.rows.map(row => row.date), ['2026-06-01', '2026-06-03'], 'past date snapshots remain stored after updates');
    assert.equal((await store.getAttendance('attendance-other', '2026-06-01')).students.length, 0);

    await pool.end();
    pool = new Pool({ ...connection, options: `-c search_path=${schema}` });
    const reopened = createAttendanceStore(pool);
    assert.equal((await reopened.getAttendance('attendance-owner', '2026-06-01')).presentIds[0], avaGray, 'snapshot survives a fresh connection');
  } finally {
    if (pool) await pool.end().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await admin.end();
  }
});
