import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import signature from 'cookie-signature';
import session from 'express-session';
import { buildConfig, createApp } from '../server.js';
import { createAttendanceStore } from '../attendance-api.js';

const SESSION_SECRET = 'teacher-attendance-month-tests-use-a-long-session-secret';
const SUBJECT = 'month-owner-subject';
const STUDENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PRESENT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

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

test('createAttendanceStore.getMonth returns only persisted snapshots, including a saved empty day', async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('stemma_teacher_attendance_students')) {
        return { rows: [{ id: STUDENT_ID, name: 'Aster One' }] };
      }
      return { rows: [
        { date: '2026-05-02', presentId: STUDENT_ID },
        { date: '2026-05-02', presentId: PRESENT_ID },
        { date: '2026-05-19', presentId: null }
      ] };
    },
    async connect() { throw new Error('connect should not be used for a read'); }
  };

  const result = await createAttendanceStore(pool).getMonth(SUBJECT, '2026-05');
  assert.deepEqual(result, {
    month: '2026-05',
    students: [{ id: STUDENT_ID, name: 'Aster One' }],
    days: [
      { date: '2026-05-02', presentIds: [STUDENT_ID, PRESENT_ID] },
      { date: '2026-05-19', presentIds: [] }
    ]
  });
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.params[0], SUBJECT, 'every store query is scoped to the requesting account');
    assert.match(call.sql, /google_subject\s*=\s*\$1/u);
  }
  assert.deepEqual(calls[1].params, [SUBJECT, '2026-05']);
  assert.match(calls[1].sql, /LEFT JOIN stemma_teacher_attendance_days/u, 'left join preserves snapshots with no present students');
  assert.match(calls[1].sql, /stemma_teacher_attendance_snapshots/u, 'dates are drawn from saved snapshots');
  assert.match(calls[1].sql, /to_char\(s\.attendance_date, 'YYYY-MM'\) = \$2/u);
});

test('GET attendance month requires Google auth, validates YYYY-MM strictly and uses private no-store responses', async t => {
  const invoked = [];
  const attendanceStore = {
    async getMonth(subject, month) {
      invoked.push([subject, month]);
      return { month, students: [], days: [] };
    }
  };
  const h = await createHarness({ attendanceStore });
  t.after(() => h.close());
  const google = await h.cookieFor('month-google', { provider: 'google', subject: SUBJECT });
  const fayda = await h.cookieFor('month-fayda', { provider: 'fayda', subject: 'other-provider' });

  const guest = await fetch(`${h.origin}/api/system-apps/attendance/month?month=2026-05`);
  assert.equal(guest.status, 401);
  const nonGoogle = await fetch(`${h.origin}/api/system-apps/attendance/month?month=2026-05`, { headers: { cookie: fayda } });
  assert.equal(nonGoogle.status, 403);
  for (const month of ['', '2026-5', '2026-00', '2026-13', '0000-01', '10000-01', '2026-05-01', '2026-02x', '2026-05&month=2026-06']) {
    const response = await fetch(`${h.origin}/api/system-apps/attendance/month?month=${encodeURIComponent(month)}`, { headers: { cookie: google } });
    assert.equal(response.status, 400, `month ${JSON.stringify(month)} must be rejected`);
    assert.match(response.headers.get('cache-control') ?? '', /no-store/u);
  }
  const repeated = await fetch(`${h.origin}/api/system-apps/attendance/month?month=2026-05&month=2026-06`, { headers: { cookie: google } });
  assert.equal(repeated.status, 400, 'array-valued query parameter is invalid');

  const response = await fetch(`${h.origin}/api/system-apps/attendance/month?month=0001-01`, { headers: { cookie: google } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control') ?? '', /no-store/u);
  assert.deepEqual(await response.json(), { month: '0001-01', students: [], days: [] });
  assert.deepEqual(invoked, [[SUBJECT, '0001-01']], 'the authenticated subject is passed to the store');
});

test('month endpoint reports no-store service errors for missing and failing stores', async t => {
  const unavailable = await createHarness();
  t.after(() => unavailable.close());
  const noStoreGoogle = await unavailable.cookieFor('month-no-store', { provider: 'google', subject: SUBJECT });
  const noStoreResponse = await fetch(`${unavailable.origin}/api/system-apps/attendance/month?month=2026-05`, { headers: { cookie: noStoreGoogle } });
  assert.equal(noStoreResponse.status, 503);
  assert.match(noStoreResponse.headers.get('cache-control') ?? '', /no-store/u);

  const broken = await createHarness({ attendanceStore: { async getMonth() { throw new Error('database unavailable'); } } });
  t.after(() => broken.close());
  const google = await broken.cookieFor('month-error', { provider: 'google', subject: SUBJECT });
  const errorResponse = await fetch(`${broken.origin}/api/system-apps/attendance/month?month=2026-05`, { headers: { cookie: google } });
  assert.equal(errorResponse.status, 503);
  assert.match(errorResponse.headers.get('cache-control') ?? '', /no-store/u);
  assert.deepEqual(await errorResponse.json(), { error: 'Teacher attendance service is unavailable.' });
});
