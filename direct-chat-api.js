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
      await pool.query(await fs.readFile(path.join(ROOT, 'migrations', '008_direct_chat_replies.sql'), 'utf8'));
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
        `SELECT m.id::text AS id, m.text, m.created_at AS "createdAt", m.author_subject AS "authorSubject",
                m.reply_to_message_id::text AS "replyToId", r.text AS "replyToText",
                r.author_subject AS "replyToAuthorSubject"
         FROM stemma_direct_chat_messages m
         JOIN stemma_direct_chat_conversations c ON c.id = m.conversation_id
         LEFT JOIN stemma_direct_chat_messages r ON r.id = m.reply_to_message_id AND r.conversation_id = m.conversation_id
         WHERE m.conversation_id = $1::bigint AND (c.participant_a = $2 OR c.participant_b = $2)
           AND ($3::bigint IS NULL OR m.id < $3::bigint)
         ORDER BY m.id DESC LIMIT $4`, [conversationId, subject, before, limit]);
      return result.rows;
    },
    async getPeerPhoto(subject, conversationId) {
      const result = await pool.query(
        `SELECT p.profile_image AS data, p.profile_image_mime AS "mimeType"
         FROM stemma_direct_chat_conversations c
         JOIN stemma_student_profiles p ON p.google_subject = CASE
           WHEN c.participant_a = $2 THEN c.participant_b ELSE c.participant_a END
         WHERE c.id = $1::bigint AND (c.participant_a = $2 OR c.participant_b = $2)
           AND p.profile_image IS NOT NULL
         LIMIT 1`, [conversationId, subject]);
      const row = result.rows[0];
      return row ? { data: Buffer.from(row.data), mimeType: row.mimeType } : null;
    },
    async sendMessage(subject, conversationId, text, replyToId = null) {
      const result = await pool.query(
        `WITH inserted AS (
           INSERT INTO stemma_direct_chat_messages (conversation_id, author_subject, text, reply_to_message_id)
           SELECT c.id, $2::varchar(255), $3::text, $4::bigint FROM stemma_direct_chat_conversations c
           WHERE c.id = $1::bigint AND (c.participant_a = $2::varchar(255) OR c.participant_b = $2::varchar(255))
             AND ($4::bigint IS NULL OR EXISTS (
               SELECT 1 FROM stemma_direct_chat_messages target
               WHERE target.id = $4::bigint AND target.conversation_id = c.id
             ))
           RETURNING id, conversation_id, text, created_at, author_subject, reply_to_message_id
         )
         SELECT inserted.id::text AS id, inserted.text, inserted.created_at AS "createdAt",
                inserted.author_subject AS "authorSubject", inserted.reply_to_message_id::text AS "replyToId",
                target.text AS "replyToText", target.author_subject AS "replyToAuthorSubject"
         FROM inserted
         LEFT JOIN stemma_direct_chat_messages target
           ON target.id = inserted.reply_to_message_id AND target.conversation_id = inserted.conversation_id`,
        [conversationId, subject, text, replyToId]);
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
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.text !== 'string' ||
      Object.keys(value).some(key => !['text', 'replyToId'].includes(key)) ||
      (Object.hasOwn(value, 'replyToId') && (typeof value.replyToId !== 'string' || !/^[1-9]\d{0,18}$/.test(value.replyToId) || BigInt(value.replyToId) > 9_223_372_036_854_775_807n))) return null;
  const text = value.text.trim();
  return text && !text.includes('\0') && [...text].length <= MAX_TEXT_LENGTH
    ? { text, ...(Object.hasOwn(value, 'replyToId') ? { replyToId: value.replyToId } : {}) }
    : null;
}

function replyToDto(row, viewerSubject) {
  if (typeof row?.replyToId !== 'string' || !/^[1-9]\d{0,18}$/.test(row.replyToId)) return undefined;
  if (typeof row.replyToText !== 'string' || typeof row.replyToAuthorSubject !== 'string') {
    return { id: row.replyToId, available: false };
  }
  return { id: row.replyToId, text: row.replyToText, mine: row.replyToAuthorSubject === viewerSubject, available: true };
}

function safeDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function attachmentDto(row) {
  if (!row || typeof row.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.id) ||
      typeof row.name !== 'string' || !row.name.trim() || row.name.length > 255 || typeof row.mimeType !== 'string' ||
      !Number.isSafeInteger(Number(row.size)) || Number(row.size) < 1 || Number(row.size) > 5 * 1024 * 1024) return null;
  return { id: row.id, url: `/api/pulse/attachments/${row.id}`, name: row.name, mimeType: row.mimeType, size: Number(row.size) };
}

export function registerDirectChatApi(app, { directChatStore = null, attachmentStore = null, requireGoogleSession, config }) {
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
      const page = conversations.slice(0, PAGE_SIZE);
      const attachmentRows = attachmentStore?.getAttachmentsForMessages
        ? (await Promise.all(page.filter(row => typeof row.lastMessageId === 'string').map(row =>
          attachmentStore.getAttachmentsForMessages(req.session.stemmaUser.subject, row.id, [row.lastMessageId])
        ))).flat()
        : [];
      const attachmentsByMessage = new Map((Array.isArray(attachmentRows) ? attachmentRows : []).map(row => [row.messageId, attachmentDto(row)]).filter(([, attachment]) => attachment));
      return res.json({ conversations: page.map(row => {
        const hasLast = typeof row.lastMessageId === 'string' && typeof row.lastMessageText === 'string' && safeDate(row.lastMessageAt);
        const attachment = hasLast ? attachmentsByMessage.get(row.lastMessageId) : null;
        return {
          id: row.id, username: row.username, nickName: row.nickName,
          lastMessage: hasLast ? { id: row.lastMessageId, text: row.lastMessageText, createdAt: safeDate(row.lastMessageAt), ...(attachment ? { attachment } : {}) } : null
        };
      }), hasMore });
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
      const page = messages.slice(0, PAGE_SIZE);
      const attachmentRows = attachmentStore?.getAttachmentsForMessages
        ? await attachmentStore.getAttachmentsForMessages(req.session.stemmaUser.subject, req.params.id, page.map(row => row.id))
        : [];
      const attachmentsByMessage = new Map((Array.isArray(attachmentRows) ? attachmentRows : []).map(row => [row.messageId, attachmentDto(row)]).filter(([, attachment]) => attachment));
      return res.json({ messages: page.map(row => {
        const attachment = attachmentsByMessage.get(row.id);
        const replyTo = replyToDto(row, req.session.stemmaUser.subject);
        return { id: row.id, text: row.text, createdAt: safeDate(row.createdAt), mine: row.authorSubject === req.session.stemmaUser.subject, ...(replyTo ? { replyTo } : {}), ...(attachment ? { attachment } : {}) };
      }), hasMore });
    } catch { return res.status(503).json({ error: 'Direct chat service is unavailable.' }); }
  });
  app.get('/api/pulse/conversations/:id/peer-photo', requireGoogleSession, limiter, async (req, res) => {
    setPrivateNoStore(res);
    if (!directChatStore) return res.status(503).json({ error: 'Direct chat service is unavailable.' });
    if (!validConversationId(req.params.id)) return res.status(400).json({ error: 'Conversation id is invalid.' });
    try {
      const photo = await directChatStore.getPeerPhoto?.(req.session.stemmaUser.subject, req.params.id);
      // Missing photos and non-members are indistinguishable; the store's query
      // only returns image bytes after verifying conversation membership.
      if (!photo || !Buffer.isBuffer(photo.data) || !['image/png', 'image/jpeg', 'image/webp'].includes(photo.mimeType)) {
        return res.status(404).json({ error: 'Profile photo not found.' });
      }
      res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Type': photo.mimeType });
      return res.status(200).send(photo.data);
    } catch { return res.status(503).json({ error: 'Direct chat service is unavailable.' }); }
  });
  app.post('/api/pulse/conversations/:id/messages', requireGoogleSession, limiter, sameOriginJson(config), express.json({ limit: '20kb', strict: true }), async (req, res) => {
    setPrivateNoStore(res);
    if (!directChatStore) return res.status(503).json({ error: 'Direct chat service is unavailable.' });
    if (!validConversationId(req.params.id)) return res.status(400).json({ error: 'Conversation id is invalid.' });
    const body = validateTextBody(req.body);
    if (!body) return res.status(400).json({ error: 'Message must be nonblank text of at most 4000 characters with an optional valid reply reference.' });
    try {
      const row = body.replyToId === undefined
        ? await directChatStore.sendMessage(req.session.stemmaUser.subject, req.params.id, body.text)
        : await directChatStore.sendMessage(req.session.stemmaUser.subject, req.params.id, body.text, body.replyToId);
      if (!row) return res.status(404).json({ error: 'Conversation not found.' });
      if (!validConversationId(row.id) || typeof row.text !== 'string' || !safeDate(row.createdAt)) return res.status(503).json({ error: 'Direct chat service is unavailable.' });
      const replyTo = replyToDto(row, req.session.stemmaUser.subject);
      return res.status(201).json({ message: { id: row.id, text: row.text, createdAt: safeDate(row.createdAt), mine: row.authorSubject === req.session.stemmaUser.subject, ...(replyTo ? { replyTo } : {}) } });
    } catch { return res.status(503).json({ error: 'Direct chat service is unavailable.' }); }
  });
}
