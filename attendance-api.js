import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_STUDENTS = 1000;
const MAX_NAME_LENGTH = 120;
const MAX_IMPORT_BYTES = 128 * 1024;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

function cleanStudentName(value) {
  if (typeof value !== 'string' || CONTROL_CHARACTERS.test(value)) return null;
  const name = value.normalize('NFC').trim().replace(/\s+/gu, ' ');
  return name && [...name].length <= MAX_NAME_LENGTH ? name : null;
}

function normalizeStudentName(name) {
  return name.normalize('NFC').trim().replace(/\s+/gu, ' ');
}

/** Parse student names from hyphen-bullet lines only. Returns null for invalid/oversized input. */
export function parseStudentList(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_IMPORT_BYTES) return null;
  const names = [];
  const seen = new Set();
  for (const rawLine of text.split(/\r?\n/u)) {
    const match = rawLine.match(/^\s*-\s+(.*)$/u);
    if (!match) continue;
    const line = match[1].trim();
    if (!line) continue;
    const name = cleanStudentName(line);
    if (!name) return null;
    const normalized = normalizeStudentName(name);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      names.push({ name, normalizedName: normalized });
      if (names.length > MAX_STUDENTS) return null;
    }
  }
  return names;
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function stateDate(value) {
  return {
    students: value.students.map(row => ({ id: String(row.id), name: row.name })),
    presentIds: value.presentIds.map(String),
    date: value.date
  };
}

async function getState(queryable, subject, date) {
  const [students, present] = await Promise.all([
    queryable.query(
      `SELECT id::text AS id, name
       FROM stemma_teacher_attendance_students
       WHERE google_subject = $1
       ORDER BY roster_position ASC`, [subject]),
    queryable.query(
      `SELECT student_id::text AS id
       FROM stemma_teacher_attendance_days
       WHERE google_subject = $1 AND attendance_date = $2::date
       ORDER BY student_id`, [subject, date])
  ]);
  return { students: students.rows, presentIds: present.rows.map(row => row.id), date };
}

export function createAttendanceStore(pool) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('A PostgreSQL pool is required.');
  }
  return {
    async migrate() {
      await pool.query(await fs.readFile(path.join(ROOT, 'migrations', '017_teacher_attendance.sql'), 'utf8'));
    },
    async getAttendance(subject, date) {
      return stateDate(await getState(pool, subject, date));
    },
    async importStudents(subject, names, date) {
      if (!Array.isArray(names) || names.length > MAX_STUDENTS) throw new TypeError('Invalid student list.');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [subject]);
        const current = await client.query(
          'SELECT count(*)::int AS count FROM stemma_teacher_attendance_students WHERE google_subject = $1', [subject]);
        const existing = names.length
          ? await client.query(
            'SELECT normalized_name FROM stemma_teacher_attendance_students WHERE google_subject = $1 AND normalized_name = ANY($2::text[])',
            [subject, names.map(item => item.normalizedName)])
          : { rows: [] };
        const existingNames = new Set(existing.rows.map(row => row.normalized_name));
        const additions = names.filter(item => !existingNames.has(item.normalizedName));
        if (current.rows[0].count + additions.length > MAX_STUDENTS) {
          const error = new Error('The student roster is full.');
          error.code = 'ATTENDANCE_ROSTER_FULL';
          throw error;
        }
        if (additions.length) {
          await client.query(
            `INSERT INTO stemma_teacher_attendance_students (google_subject, name, normalized_name)
             SELECT $1, item.name, item.normalized_name
             FROM jsonb_to_recordset($2::jsonb) AS item(name text, normalized_name text)
             ON CONFLICT (google_subject, normalized_name) DO NOTHING`,
            [subject, JSON.stringify(additions.map(({ name, normalizedName }) => ({ name, normalized_name: normalizedName }))) ]);
        }
        const state = await getState(client, subject, date);
        await client.query('COMMIT');
        return stateDate(state);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    async saveAttendance(subject, date, presentIds) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [subject]);
        const owned = presentIds.length
          ? await client.query(
            `SELECT id::text AS id FROM stemma_teacher_attendance_students
             WHERE google_subject = $1 AND id = ANY($2::uuid[])`, [subject, presentIds])
          : { rows: [] };
        if (owned.rows.length !== presentIds.length) {
          await client.query('ROLLBACK');
          return null;
        }
        await client.query(
          'DELETE FROM stemma_teacher_attendance_snapshots WHERE google_subject = $1 AND attendance_date = $2::date',
          [subject, date]);
        await client.query(
          'INSERT INTO stemma_teacher_attendance_snapshots (google_subject, attendance_date) VALUES ($1, $2::date)',
          [subject, date]);
        if (presentIds.length) {
          await client.query(
            `INSERT INTO stemma_teacher_attendance_days (google_subject, attendance_date, student_id)
             SELECT $1, $2::date, unnest($3::uuid[])`, [subject, date, presentIds]);
        }
        const state = await getState(client, subject, date);
        await client.query('COMMIT');
        return stateDate(state);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    }
  };
}

function setNoStore(res) {
  res.set({ 'Cache-Control': 'private, no-store, max-age=0', Pragma: 'no-cache', 'Referrer-Policy': 'no-referrer' });
}

function sameOriginJsonGuard(config) {
  return (req, res, next) => {
    setNoStore(res);
    const requestOrigin = req.get('origin');
    const expectedOrigin = config.appOrigin || `${req.protocol}://${req.get('host')}`;
    if (!requestOrigin || requestOrigin !== expectedOrigin) {
      return res.status(403).json({ error: 'This request could not be verified.' });
    }
    if (!req.is('application/json')) return res.status(415).json({ error: 'A JSON request body is required.' });
    return next();
  };
}

function validBody(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function queryDate(req, { defaultToday = false } = {}) {
  if (!Object.hasOwn(req.query, 'date') && defaultToday) return new Date().toISOString().slice(0, 10);
  if (typeof req.query.date !== 'string' || !validDate(req.query.date)) return null;
  return req.query.date;
}

export function registerAttendanceApi(app, { attendanceStore = null, requireGoogleSession, config }) {
  if (typeof requireGoogleSession !== 'function') throw new TypeError('Google-session middleware is required.');
  const unavailable = (_req, res, next) => {
    if (!attendanceStore) {
      setNoStore(res);
      return res.status(503).json({ error: 'Teacher attendance service is unavailable.' });
    }
    return next();
  };
  const base = '/api/system-apps/attendance';

  app.get(base, requireGoogleSession, unavailable, async (req, res) => {
    setNoStore(res);
    const date = queryDate(req);
    if (!date) return res.status(400).json({ error: 'Attendance date is invalid.' });
    try {
      return res.json(await attendanceStore.getAttendance(req.session.stemmaUser.subject, date));
    } catch {
      return res.status(503).json({ error: 'Teacher attendance service is unavailable.' });
    }
  });

  app.post(base + '/import', requireGoogleSession, sameOriginJsonGuard(config), express.json({ limit: '128kb', strict: true }), unavailable, async (req, res) => {
    setNoStore(res);
    const date = queryDate(req, { defaultToday: true });
    if (!date || !validBody(req.body, ['text'])) return res.status(400).json({ error: 'Student import request is invalid.' });
    const names = parseStudentList(req.body.text);
    if (!names) return res.status(400).json({ error: 'Student import request is invalid.' });
    if (!names.length) return res.status(400).json({ error: 'No student names found. Add names as hyphen bullets (for example, - Aster One).' });
    try {
      return res.json(await attendanceStore.importStudents(req.session.stemmaUser.subject, names, date));
    } catch (error) {
      if (error?.code === 'ATTENDANCE_ROSTER_FULL') return res.status(400).json({ error: 'The student roster cannot exceed 1,000 students.' });
      return res.status(503).json({ error: 'Teacher attendance service is unavailable.' });
    }
  });

  app.put(base, requireGoogleSession, sameOriginJsonGuard(config), express.json({ limit: '128kb', strict: true }), unavailable, async (req, res) => {
    setNoStore(res);
    const body = req.body;
    const validIds = Array.isArray(body?.presentIds) && body.presentIds.length <= MAX_STUDENTS &&
      body.presentIds.every(id => typeof id === 'string' && UUID_PATTERN.test(id));
    if (!validBody(body, ['date', 'presentIds']) || !validDate(body.date) || !validIds) {
      return res.status(400).json({ error: 'Attendance update request is invalid.' });
    }
    const presentIds = [...new Set(body.presentIds.map(id => id.toLowerCase()))];
    try {
      const result = await attendanceStore.saveAttendance(req.session.stemmaUser.subject, body.date, presentIds);
      if (!result) return res.status(400).json({ error: 'Attendance includes a student outside this roster.' });
      return res.json(result);
    } catch {
      return res.status(503).json({ error: 'Teacher attendance service is unavailable.' });
    }
  });
}
