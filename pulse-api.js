import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import rateLimit from 'express-rate-limit';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SEARCH_PAGE_SIZE = 30;
const SAVED_PAGE_SIZE = 50;
const MAX_SEARCH_LENGTH = 80;
const MAX_SAVED_TEXT_LENGTH = 4000;
const MAX_SEARCH_OFFSET = 100_000;

export function createPulseStore(pool) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('A PostgreSQL pool is required.');
  return {
    async migrate() {
      const migration = await fs.readFile(path.join(ROOT, 'migrations', '005_pulse_saved_messages.sql'), 'utf8');
      await pool.query(migration);
    },
    async searchUsers(query, offset, limit) {
      const result = await pool.query(
        `SELECT username, nick_name AS "nickName"
         FROM stemma_student_profiles
         WHERE (char_length(btrim(username)) > 0 OR char_length(btrim(nick_name)) > 0)
           AND (strpos(lower(username), lower($1)) > 0 OR strpos(lower(nick_name), lower($1)) > 0)
         ORDER BY lower(username), lower(nick_name), google_subject
         OFFSET $2 LIMIT $3`,
        [query, offset, limit]
      );
      return result.rows;
    },
    async listSavedMessages(subject, before, limit) {
      const result = await pool.query(
        `SELECT id::text AS id, text, created_at AS "createdAt"
         FROM stemma_pulse_saved_messages
         WHERE google_subject = $1 AND ($2::bigint IS NULL OR id < $2::bigint)
         ORDER BY stemma_pulse_saved_messages.id DESC
         LIMIT $3`,
        [subject, before, limit]
      );
      return result.rows;
    },
    async createSavedMessage(subject, text) {
      const result = await pool.query(
        `INSERT INTO stemma_pulse_saved_messages (google_subject, text)
         VALUES ($1, $2)
         RETURNING id::text AS id, text, created_at AS "createdAt"`,
        [subject, text]
      );
      return result.rows[0] ?? null;
    }
  };
}

function setPrivateNoStore(res) {
  res.set('Cache-Control', 'private, no-store, max-age=0');
  res.set('Pragma', 'no-cache');
  res.set('Referrer-Policy', 'no-referrer');
}

function sameOriginJson(config) {
  return (req, res, next) => {
    const origin = req.get('origin');
    const expectedOrigin = config.appOrigin || `${req.protocol}://${req.get('host')}`;
    if (!origin || origin !== expectedOrigin) {
      setPrivateNoStore(res);
      return res.status(403).json({ error: 'This request could not be verified.' });
    }
    if (!req.is('application/json')) {
      setPrivateNoStore(res);
      return res.status(415).json({ error: 'A JSON request body is required.' });
    }
    return next();
  };
}

function parseOffset(value) {
  if (value === undefined) return 0;
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) return null;
  const offset = Number(value);
  return Number.isSafeInteger(offset) && offset <= MAX_SEARCH_OFFSET ? offset : null;
}

function parseBefore(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^[1-9]\d{0,18}$/.test(value)) return undefined;
  return BigInt(value) <= 9_223_372_036_854_775_807n ? value : undefined;
}

function validateSavedBody(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== 1 || !Object.hasOwn(value, 'text') || typeof value.text !== 'string') return null;
  const text = value.text.trim();
  if (!text || text.includes('\0') || [...text].length > MAX_SAVED_TEXT_LENGTH) return null;
  return text;
}

function safeCreatedAt(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function registerPulseApi(app, { pulseStore = null, attachmentStore = null, requireGoogleSession, config }) {
  if (typeof requireGoogleSession !== 'function') throw new TypeError('Google-session middleware is required.');
  const pulseLimiter = rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => {
      setPrivateNoStore(res);
      res.status(429).json({ error: 'Too many Pulse requests. Please wait and try again.' });
    }
  });

  app.get('/api/pulse/users', requireGoogleSession, pulseLimiter, async (req, res) => {
    setPrivateNoStore(res);
    if (!pulseStore) return res.status(503).json({ error: 'Pulse service is unavailable.' });
    const rawQuery = typeof req.query.q === 'string' ? req.query.q : '';
    const query = rawQuery.trim().replace(/^@/, '');
    const offset = parseOffset(req.query.offset);
    if ([...query].length > MAX_SEARCH_LENGTH || offset === null) {
      return res.status(400).json({ error: 'Pulse user search request is invalid.' });
    }
    if (!query) return res.json({ users: [], hasMore: false });
    try {
      const rows = await pulseStore.searchUsers(query, offset, SEARCH_PAGE_SIZE + 1);
      // Whitelist fields and re-check the literal match at the boundary; never serialize
      // any extra properties supplied by a store implementation.
      const users = (Array.isArray(rows) ? rows : []).filter(row => {
        if (!row || typeof row.username !== 'string' || typeof row.nickName !== 'string') return false;
        if (!row.username.trim() && !row.nickName.trim()) return false;
        const needle = query.toLocaleLowerCase();
        return row.username.toLocaleLowerCase().includes(needle) || row.nickName.toLocaleLowerCase().includes(needle);
      });
      const hasMore = users.length > SEARCH_PAGE_SIZE;
      return res.json({ users: users.slice(0, SEARCH_PAGE_SIZE).map(row => ({ username: row.username, nickName: row.nickName })), hasMore });
    } catch {
      return res.status(503).json({ error: 'Pulse service is unavailable.' });
    }
  });

  app.get('/api/pulse/saved', requireGoogleSession, pulseLimiter, async (req, res) => {
    setPrivateNoStore(res);
    if (!pulseStore) return res.status(503).json({ error: 'Pulse service is unavailable.' });
    const before = parseBefore(req.query.before);
    if (before === undefined) return res.status(400).json({ error: 'Saved messages cursor is invalid.' });
    try {
      const rows = await pulseStore.listSavedMessages(req.session.stemmaUser.subject, before, SAVED_PAGE_SIZE + 1);
      const validRows = (Array.isArray(rows) ? rows : []).filter(row => row && typeof row.id === 'string' && typeof row.text === 'string' && safeCreatedAt(row.createdAt));
      const hasMore = validRows.length > SAVED_PAGE_SIZE;
      const pageRows = validRows.slice(0, SAVED_PAGE_SIZE);
      const attachmentRows = attachmentStore?.getAttachmentsForMessages
        ? await attachmentStore.getAttachmentsForMessages(req.session.stemmaUser.subject, 'saved', pageRows.map(row => row.id))
        : [];
      const byMessage = new Map((Array.isArray(attachmentRows) ? attachmentRows : []).map(row => [row.messageId, row]));
      const messages = pageRows.map(row => {
        const metadata = byMessage.get(row.id);
        const attachment = metadata && typeof metadata.id === 'string' && typeof metadata.name === 'string' &&
          typeof metadata.mimeType === 'string' && Number.isSafeInteger(Number(metadata.size))
          ? { id: metadata.id, url: `/api/pulse/attachments/${metadata.id}`, name: metadata.name, mimeType: metadata.mimeType, size: Number(metadata.size) }
          : null;
        return { id: row.id, text: row.text, createdAt: safeCreatedAt(row.createdAt), ...(attachment ? { attachment } : {}) };
      });
      return res.json({ messages, hasMore });
    } catch {
      return res.status(503).json({ error: 'Pulse service is unavailable.' });
    }
  });

  app.post('/api/pulse/saved', requireGoogleSession, pulseLimiter, sameOriginJson(config), express.json({ limit: '20kb', strict: true }), async (req, res) => {
    setPrivateNoStore(res);
    if (!pulseStore) return res.status(503).json({ error: 'Pulse service is unavailable.' });
    const text = validateSavedBody(req.body);
    if (text === null) return res.status(400).json({ error: 'Saved message must be nonblank text of at most 4000 characters.' });
    try {
      const row = await pulseStore.createSavedMessage(req.session.stemmaUser.subject, text);
      if (!row || typeof row.id !== 'string' || typeof row.text !== 'string' || !safeCreatedAt(row.createdAt)) {
        return res.status(503).json({ error: 'Pulse service is unavailable.' });
      }
      return res.status(201).json({ message: { id: row.id, text: row.text, createdAt: safeCreatedAt(row.createdAt) } });
    } catch {
      return res.status(503).json({ error: 'Pulse service is unavailable.' });
    }
  });
}
