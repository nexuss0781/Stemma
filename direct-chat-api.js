import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import rateLimit from 'express-rate-limit';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PAGE_SIZE = 50;
const MAX_TEXT_LENGTH = 4000;

export function createDirectChatStore(pool) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('A PostgreSQL pool is required.');
  return {
    async migrate() {
      await pool.query(await fs.readFile(path.join(ROOT, 'migrations', '006_direct_chat.sql'), 'utf8'));
    },
    async createConversation(subject, username) {
      const profile = await pool.query(
        `SELECT google_subject AS subject, username, nick_name AS "nickName"
         FROM stemma_student_profiles
         WHERE lower(username) = lower($1) AND char_length(btrim(username)) > 0
         ORDER BY google_subject LIMIT 2`, [username]);
      if (profile.rows.length !== 1 || profile.rows[0].subject === subject) return null;
      const other = profile.rows[0];
      const [participantA, participantB] = [subject, other.subject].sort();
      const result = await pool.query(
        `INSERT INTO stemma_direct_chat_conversations (participant_a, participant_b)
         VALUES ($1, $2) ON CONFLICT (participant_a, participant_b) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
         RETURNING id::text AS id`, [participantA, participantB]);
      return { id: result.rows[0].id, username: other.username, nickName: other.nickName };
    },
    async listConversations(subject, limit) {
      const result = await pool.query(
        `SELECT c.id::text AS id,
                p.username, p.nick_name AS "nickName",
                m.id::text AS "lastMessageId", m.text AS "lastMessageText",
                m.created_at AS "lastMessageAt"
         FROM stemma_direct_chat_conversations c
         JOIN stemma_student_profiles p ON p.google_subject = CASE WHEN c.participant_a = $1 THEN c.participant_b ELSE c.participant_a END
         LEFT JOIN LATERAL (
           SELECT id, text, created_at FROM stemma_direct_chat_messages
           WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1
         ) m ON TRUE
         WHERE c.participant_a = $1 OR c.participant_b = $1
         ORDER BY COALESCE(m.id, c.id) DESC LIMIT $2`, [subject, limit]);
      return result.rows;
    },
    async listMessages(subject, conversationId, before, limit) {
      const result = await pool.query(
        `SELECT m.id::text AS id, m.text, m.created_at AS "createdAt", m.author_subject AS "authorSubject"
         FROM stemma_direct_chat_messages m
         JOIN stemma_direct_chat_conversations c ON c.id = m.conversation_id
         WHERE m.conversation_id = $1::bigint AND (c.participant_a = $2 OR c.participant_b = $2)
           AND ($3::bigint IS NULL OR m.id < $3::bigint)
         ORDER BY m.id DESC LIMIT $4`, [conversationId, subject, before, limit]);
      return result.rows;
    },
    async sendMessage(subject, conversationId, text) {
      const result = await pool.query(
        `INSERT INTO stemma_direct_chat_messages (conversation_id, author_subject, text)
         SELECT c.id, $2::varchar(255), $3::text FROM stemma_direct_chat_conversations c
         WHERE c.id = $1::bigint AND (c.participant_a = $2::varchar(255) OR c.participant_b = $2::varchar(255))
         RETURNING id::text AS id, text, created_at AS "createdAt", author_subject AS "authorSubject"`,
        [conversationId, subject, text]);
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

function parseBefore(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^[1-9]\d{0,18}$/.test(value)) return undefined;
  return BigInt(value) <= 9_223_372_036_854_775_807n ? value : undefined;
}

function validConversationId(value) { return typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n; }

function validateUsernameBody(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || typeof value.username !== 'string') return null;
  const username = value.username.trim();
  return /^[A-Za-z0-9_.]{3,30}$/.test(username) ? username : null;
}

function validateTextBody(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || typeof value.text !== 'string') return null;
  const text = value.text.trim();
  return text && !text.includes('\0') && [...text].length <= MAX_TEXT_LENGTH ? text : null;
}

function safeDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function registerDirectChatApi(app, { directChatStore = null, requireGoogleSession, config }) {
  if (typeof requireGoogleSession !== 'function') throw new TypeError('Google-session middleware is required.');
  const limiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false,
    handler: (_req, res) => { setPrivateNoStore(res); res.status(429).json({ error: 'Too many chat requests. Please wait and try again.' }); }
  });
  const available = (req, res) => {
    setPrivateNoStore(res);
    if (!directChatStore) { res.status(503).json({ error: 'Direct chat service is unavailable.' }); return false; }
    return true;
  };
  app.get('/api/pulse/conversations', requireGoogleSession, limiter, async (req, res) => {
    if (!available(req, res)) return;
    try {
      const rows = await directChatStore.listConversations(req.session.stemmaUser.subject, 51);
      const conversations = (Array.isArray(rows) ? rows : []).filter(row => row && validConversationId(row.id) && typeof row.username === 'string' && typeof row.nickName === 'string');
      const hasMore = conversations.length > PAGE_SIZE;
      return res.json({ conversations: conversations.slice(0, PAGE_SIZE).map(row => ({
        id: row.id, username: row.username, nickName: row.nickName,
        lastMessage: typeof row.lastMessageId === 'string' && typeof row.lastMessageText === 'string' && safeDate(row.lastMessageAt)
          ? { id: row.lastMessageId, text: row.lastMessageText, createdAt: safeDate(row.lastMessageAt) } : null
      })), hasMore });
    } catch { return res.status(503).json({ error: 'Direct chat service is unavailable.' }); }
  });
  app.post('/api/pulse/conversations', requireGoogleSession, limiter, sameOriginJson(config), express.json({ limit: '20kb', strict: true }), async (req, res) => {
    if (!available(req, res)) return;
    const username = validateUsernameBody(req.body);
    if (!username) return res.status(400).json({ error: 'A valid username is required.' });
    try {
      const row = await directChatStore.createConversation(req.session.stemmaUser.subject, username);
      if (!row || !validConversationId(row.id) || typeof row.username !== 'string' || typeof row.nickName !== 'string') {
        return res.status(404).json({ error: 'That username is unavailable.' });
      }
      return res.status(201).json({ conversation: { id: row.id, username: row.username, nickName: row.nickName } });
    } catch { return res.status(503).json({ error: 'Direct chat service is unavailable.' }); }
  });
  app.get('/api/pulse/conversations/:id/messages', requireGoogleSession, limiter, async (req, res) => {
    setPrivateNoStore(res);
    if (!directChatStore) return res.status(503).json({ error: 'Direct chat service is unavailable.' });
    if (!validConversationId(req.params.id)) return res.status(400).json({ error: 'Conversation id is invalid.' });
    const before = parseBefore(req.query.before);
    if (before === undefined) return res.status(400).json({ error: 'Message cursor is invalid.' });
    try {
      const rows = await directChatStore.listMessages(req.session.stemmaUser.subject, req.params.id, before, PAGE_SIZE + 1);
      const messages = (Array.isArray(rows) ? rows : []).filter(row => row && validConversationId(row.id) && typeof row.text === 'string' && safeDate(row.createdAt));
      const hasMore = messages.length > PAGE_SIZE;
      return res.json({ messages: messages.slice(0, PAGE_SIZE).map(row => ({ id: row.id, text: row.text, createdAt: safeDate(row.createdAt), mine: row.authorSubject === req.session.stemmaUser.subject })), hasMore });
    } catch { return res.status(503).json({ error: 'Direct chat service is unavailable.' }); }
  });
  app.post('/api/pulse/conversations/:id/messages', requireGoogleSession, limiter, sameOriginJson(config), express.json({ limit: '20kb', strict: true }), async (req, res) => {
    setPrivateNoStore(res);
    if (!directChatStore) return res.status(503).json({ error: 'Direct chat service is unavailable.' });
    if (!validConversationId(req.params.id)) return res.status(400).json({ error: 'Conversation id is invalid.' });
    const text = validateTextBody(req.body);
    if (!text) return res.status(400).json({ error: 'Message must be nonblank text of at most 4000 characters.' });
    try {
      const row = await directChatStore.sendMessage(req.session.stemmaUser.subject, req.params.id, text);
      if (!row) return res.status(404).json({ error: 'Conversation not found.' });
      if (!validConversationId(row.id) || typeof row.text !== 'string' || !safeDate(row.createdAt)) return res.status(503).json({ error: 'Direct chat service is unavailable.' });
      return res.status(201).json({ message: { id: row.id, text: row.text, createdAt: safeDate(row.createdAt), mine: row.authorSubject === req.session.stemmaUser.subject } });
    } catch { return res.status(503).json({ error: 'Direct chat service is unavailable.' }); }
  });
}
