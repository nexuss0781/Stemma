import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import rateLimit from 'express-rate-limit';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENT_BODY = '7mb';
const TYPES = Object.freeze({
  'image/jpeg': { extensions: ['jpg', 'jpeg'], kind: 'jpeg', inline: true },
  'image/png': { extensions: ['png'], kind: 'png', inline: true },
  'image/webp': { extensions: ['webp'], kind: 'webp', inline: true },
  'image/gif': { extensions: ['gif'], kind: 'gif', inline: true },
  'application/pdf': { extensions: ['pdf'], kind: 'pdf' },
  'text/plain': { extensions: ['txt', 'log'], kind: 'text' },
  'text/csv': { extensions: ['csv'], kind: 'text' },
  'application/zip': { extensions: ['zip'], kind: 'zip' },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { extensions: ['docx'], kind: 'docx' },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { extensions: ['xlsx'], kind: 'xlsx' },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': { extensions: ['pptx'], kind: 'pptx' },
  'audio/mpeg': { extensions: ['mp3'], kind: 'mp3' },
  'audio/wav': { extensions: ['wav'], kind: 'wav' },
  'audio/ogg': { extensions: ['ogg', 'oga'], kind: 'ogg' },
  'audio/flac': { extensions: ['flac'], kind: 'flac' },
  'audio/mp4': { extensions: ['m4a'], kind: 'mp4' },
  'video/mp4': { extensions: ['mp4'], kind: 'mp4' },
  'video/webm': { extensions: ['webm'], kind: 'webm' },
  'video/quicktime': { extensions: ['mov'], kind: 'mp4' }
});
const SAFE_INLINE_IMAGES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export function cleanAttachmentName(value) {
  if (typeof value !== 'string') return null;
  // Treat filenames as display labels, never paths. Strip control/bidi characters and path separators.
  const name = value.replace(/[\\/]/g, '_').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, '').trim();
  if (!name || name === '.' || name === '..' || [...name].length > 180) return null;
  return name;
}

function officeZipMatches(data, type) {
  if (!data.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return false;
  const archiveHeader = data.subarray(0, Math.min(data.length, 256 * 1024)).toString('latin1');
  const marker = type === 'docx' ? 'word/document.xml' : type === 'xlsx' ? 'xl/workbook.xml' : 'ppt/presentation.xml';
  return archiveHeader.includes(marker);
}

function signatureMatches(data, kind) {
  switch (kind) {
    case 'jpeg': return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    case 'png': return data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    case 'webp': return data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP';
    case 'gif': return ['GIF87a', 'GIF89a'].includes(data.toString('ascii', 0, 6));
    case 'pdf': return data.subarray(0, 5).toString('ascii') === '%PDF-';
    case 'zip': return data.length >= 4 && data.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    case 'docx': case 'xlsx': case 'pptx': return officeZipMatches(data, kind);
    case 'text': {
      if (data.includes(0)) return false;
      try { new TextDecoder('utf-8', { fatal: true }).decode(data); return true; } catch { return false; }
    }
    case 'mp3': return data.subarray(0, 3).toString('ascii') === 'ID3' || (data.length > 1 && data[0] === 0xff && (data[1] & 0xe0) === 0xe0);
    case 'wav': return data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WAVE';
    case 'ogg': return data.subarray(0, 4).toString('ascii') === 'OggS';
    case 'flac': return data.subarray(0, 4).toString('ascii') === 'fLaC';
    case 'mp4': return data.length >= 12 && data.toString('ascii', 4, 8) === 'ftyp';
    case 'webm': return data.length >= 4 && data.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    default: return false;
  }
}

export function validateAttachmentBody(value, { allowReplyTo = false } = {}) {
  const allowedKeys = ['name', 'mimeType', 'data', ...(allowReplyTo ? ['replyToId'] : [])];
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![3, 4].includes(Object.keys(value).length) || !['name', 'mimeType', 'data'].every(key => Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !allowedKeys.includes(key))) return null;
  let replyToId;
  if (Object.hasOwn(value, 'replyToId')) {
    if (!allowReplyTo || typeof value.replyToId !== 'string' || !/^[1-9]\d{0,18}$/.test(value.replyToId) || BigInt(value.replyToId) > 9_223_372_036_854_775_807n) return null;
    replyToId = value.replyToId;
  }
  const name = cleanAttachmentName(value.name);
  const mimeType = typeof value.mimeType === 'string' ? value.mimeType.toLowerCase().trim() : '';
  const type = TYPES[mimeType];
  if (!name || !type || typeof value.data !== 'string') return null;
  const extension = name.includes('.') ? name.split('.').at(-1).toLowerCase() : '';
  if (!type.extensions.includes(extension)) return null;
  const encoded = value.data;
  if (!encoded || encoded.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;
  const data = Buffer.from(encoded, 'base64');
  if (!data.length || data.length > MAX_ATTACHMENT_BYTES || data.toString('base64') !== encoded || !signatureMatches(data, type.kind)) return null;
  return { name, mimeType, size: data.length, data, ...(replyToId ? { replyToId } : {}) };
}

function attachmentDto(row) {
  return { id: row.id, url: `/api/pulse/attachments/${row.id}`, name: row.name, mimeType: row.mimeType, size: Number(row.size) };
}

export function createAttachmentStore(pool) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new TypeError('A PostgreSQL pool is required.');
  return {
    async migrate() {
      await pool.query(await fs.readFile(path.join(ROOT, 'migrations', '007_chat_attachments.sql'), 'utf8'));
      const groupsReady = await pool.query("SELECT to_regclass('stemma_groups_messages') IS NOT NULL AS ready");
      if (groupsReady.rows[0]?.ready) await pool.query(await fs.readFile(path.join(ROOT, 'migrations', '011_group_chat_attachments.sql'), 'utf8'));
    },
    async createConversationAttachment(subject, conversationId, attachment) {
      const client = await pool.connect();
      const id = crypto.randomUUID();
      try {
        await client.query('BEGIN');
        const message = attachment.replyToId
          ? await client.query(
            `WITH target AS (
               SELECT id, text, author_subject FROM stemma_direct_chat_messages
               WHERE conversation_id = $1::bigint AND id = $4::bigint
             ), created AS (
               INSERT INTO stemma_direct_chat_messages (conversation_id, author_subject, text, reply_to_message_id)
               SELECT c.id, $2::varchar(255), $3::text, target.id
               FROM stemma_direct_chat_conversations c JOIN target ON TRUE
               WHERE c.id = $1::bigint AND (c.participant_a = $2::varchar(255) OR c.participant_b = $2::varchar(255))
               RETURNING id::text AS id, text, created_at AS "createdAt", author_subject AS "authorSubject"
             )
             SELECT created.*, target.text AS "replyText", target.author_subject AS "replyAuthorSubject"
             FROM created JOIN target ON TRUE`,
            [conversationId, subject, `Attachment: ${attachment.name}`, attachment.replyToId])
          : await client.query(
            `INSERT INTO stemma_direct_chat_messages (conversation_id, author_subject, text)
             SELECT c.id, $2::varchar(255), $3::text FROM stemma_direct_chat_conversations c
             WHERE c.id = $1::bigint AND (c.participant_a = $2::varchar(255) OR c.participant_b = $2::varchar(255))
             RETURNING id::text AS id, text, created_at AS "createdAt", author_subject AS "authorSubject"`,
            [conversationId, subject, `Attachment: ${attachment.name}`]);
        if (!message.rows[0]) { await client.query('ROLLBACK'); return null; }
        const row = message.rows[0];
        await client.query(
          `INSERT INTO stemma_pulse_attachments (id, google_subject, chat_message_id, name, mime_type, byte_size, data)
           VALUES ($1::uuid, $2, $3::bigint, $4, $5, $6, $7)`,
          [id, subject, row.id, attachment.name, attachment.mimeType, attachment.size, attachment.data]);
        await client.query('COMMIT');
        const { replyText, replyAuthorSubject, ...messageRow } = row;
        return { ...messageRow, ...(attachment.replyToId ? { replyTo: { id: attachment.replyToId, text: replyText, mine: replyAuthorSubject === subject, available: true } } : {}),
          attachment: { id, url: `/api/pulse/attachments/${id}`, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size } };
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      finally { client.release(); }
    },
    async createSavedAttachment(subject, attachment) {
      const client = await pool.connect();
      const id = crypto.randomUUID();
      try {
        await client.query('BEGIN');
        const message = await client.query(
          `INSERT INTO stemma_pulse_saved_messages (google_subject, text)
           VALUES ($1, $2) RETURNING id::text AS id, text, created_at AS "createdAt"`,
          [subject, `Attachment: ${attachment.name}`]);
        const row = message.rows[0];
        await client.query(
          `INSERT INTO stemma_pulse_attachments (id, google_subject, saved_message_id, name, mime_type, byte_size, data)
           VALUES ($1::uuid, $2, $3::bigint, $4, $5, $6, $7)`,
          [id, subject, row.id, attachment.name, attachment.mimeType, attachment.size, attachment.data]);
        await client.query('COMMIT');
        return { ...row, attachment: { id, url: `/api/pulse/attachments/${id}`, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size } };
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      finally { client.release(); }
    },
    async createGroupAttachment(subject, groupId, attachment) {
      const client = await pool.connect();
      const id = crypto.randomUUID();
      try {
        await client.query('BEGIN');
        const message = await client.query(
          `WITH inserted AS (
             INSERT INTO stemma_groups_messages (group_id, author_subject, text)
             SELECT g.id, $2::varchar(255), $3::text FROM stemma_groups g
             WHERE g.id = $1::bigint AND EXISTS (
               SELECT 1 FROM stemma_groups_memberships m WHERE m.group_id = g.id AND m.member_subject = $2::varchar(255)
             )
             RETURNING id, group_id, author_subject, text, created_at
           ) SELECT i.id::text AS id, i.text, i.created_at AS "createdAt", i.author_subject AS "authorSubject",
                    COALESCE(p.username, '') AS username, COALESCE(p.nick_name, '') AS "nickName"
             FROM inserted i LEFT JOIN stemma_student_profiles p ON p.google_subject = i.author_subject`,
          [groupId, subject, `Attachment: ${attachment.name}`]);
        const row = message.rows[0];
        if (!row) { await client.query('ROLLBACK'); return null; }
        await client.query(
          `INSERT INTO stemma_pulse_attachments (id, google_subject, group_message_id, name, mime_type, byte_size, data)
           VALUES ($1::uuid, $2, $3::bigint, $4, $5, $6, $7)`,
          [id, subject, row.id, attachment.name, attachment.mimeType, attachment.size, attachment.data]);
        await client.query('COMMIT');
        return { ...row, attachment: { id, url: `/api/pulse/attachments/${id}`, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size } };
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      finally { client.release(); }
    },
    async getAttachmentForSubject(subject, id) {
      const result = await pool.query(
        `SELECT a.id::text AS id, a.name, a.mime_type AS "mimeType", a.byte_size AS size, a.data
         FROM stemma_pulse_attachments a
         LEFT JOIN stemma_pulse_saved_messages s ON s.id = a.saved_message_id
         LEFT JOIN stemma_direct_chat_messages m ON m.id = a.chat_message_id
         LEFT JOIN stemma_direct_chat_conversations c ON c.id = m.conversation_id
         LEFT JOIN stemma_groups_messages gm ON gm.id = a.group_message_id
         WHERE a.id = $2::uuid AND (
           (a.saved_message_id IS NOT NULL AND s.google_subject = $1)
           OR (a.chat_message_id IS NOT NULL AND (c.participant_a = $1 OR c.participant_b = $1))
           OR (a.group_message_id IS NOT NULL AND EXISTS (
             SELECT 1 FROM stemma_groups_memberships member WHERE member.group_id = gm.group_id AND member.member_subject = $1
           ))
         ) LIMIT 1`, [subject, id]);
      const row = result.rows[0];
      return row ? { ...row, data: Buffer.from(row.data), size: Number(row.size) } : null;
    },
    async getAttachmentsForMessages(subject, scope, messageIds) {
      const ids = Array.isArray(messageIds) ? messageIds.filter(id => typeof id === 'string' && /^[1-9][0-9]{0,18}$/.test(id)) : [];
      if (!ids.length) return [];
      let result;
      if (scope === 'saved') {
        result = await pool.query(
          `SELECT a.id::text AS id, a.saved_message_id::text AS "messageId", a.name, a.mime_type AS "mimeType", a.byte_size AS size
           FROM stemma_pulse_attachments a JOIN stemma_pulse_saved_messages s ON s.id = a.saved_message_id
           WHERE s.google_subject = $1 AND a.saved_message_id = ANY($2::bigint[])`, [subject, ids]);
      } else if (typeof scope === 'string' && /^[1-9][0-9]{0,18}$/.test(scope)) {
        result = await pool.query(
          `SELECT a.id::text AS id, a.chat_message_id::text AS "messageId", a.name, a.mime_type AS "mimeType", a.byte_size AS size
           FROM stemma_pulse_attachments a JOIN stemma_direct_chat_messages m ON m.id = a.chat_message_id
           JOIN stemma_direct_chat_conversations c ON c.id = m.conversation_id
           WHERE (c.participant_a = $1 OR c.participant_b = $1) AND c.id = $2::bigint AND a.chat_message_id = ANY($3::bigint[])`, [subject, scope, ids]);
      } else if (typeof scope === 'string' && /^group:[1-9][0-9]{0,18}$/.test(scope)) {
        const groupId = scope.slice('group:'.length);
        result = await pool.query(
          `SELECT a.id::text AS id, a.group_message_id::text AS "messageId", a.name, a.mime_type AS "mimeType", a.byte_size AS size
           FROM stemma_pulse_attachments a JOIN stemma_groups_messages m ON m.id = a.group_message_id
           WHERE m.group_id = $2::bigint AND a.group_message_id = ANY($3::bigint[])
             AND EXISTS (SELECT 1 FROM stemma_groups_memberships member WHERE member.group_id = m.group_id AND member.member_subject = $1)`, [subject, groupId, ids]);
      } else return [];
      return result.rows.map(row => ({ ...attachmentDto(row), messageId: row.messageId }));
    }
  };
}

function noStore(res) {
  res.set({ 'Cache-Control': 'private, no-store, max-age=0', Pragma: 'no-cache', 'Referrer-Policy': 'no-referrer' });
}

function sameOriginJson(config) {
  return (req, res, next) => {
    noStore(res);
    const origin = req.get('origin');
    const expectedOrigin = config.appOrigin || `${req.protocol}://${req.get('host')}`;
    if (!origin || origin !== expectedOrigin) return res.status(403).json({ error: 'This request could not be verified.' });
    if (!req.is('application/json')) return res.status(415).json({ error: 'A JSON request body is required.' });
    return next();
  };
}

function validConversationId(value) { return typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n; }
function validAttachmentId(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value); }

export function registerAttachmentsApi(app, { attachmentStore = null, requireGoogleSession, config }) {
  if (typeof requireGoogleSession !== 'function') throw new TypeError('Google-session middleware is required.');
  const limiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false,
    handler: (_req, res) => { noStore(res); res.status(429).json({ error: 'Too many attachment requests. Please wait and try again.' }); }
  });
  const downloadLimiter = rateLimit({ windowMs: 60_000, limit: 180, standardHeaders: 'draft-8', legacyHeaders: false,
    handler: (_req, res) => { noStore(res); res.status(429).json({ error: 'Too many attachment requests. Please wait and try again.' }); }
  });
  const unavailable = res => { noStore(res); return res.status(503).json({ error: 'Attachment service is unavailable.' }); };
  const parser = express.json({ limit: MAX_ATTACHMENT_BODY, strict: true });
  app.post('/api/pulse/conversations/:id/attachments', requireGoogleSession, limiter, sameOriginJson(config), parser, async (req, res) => {
    noStore(res);
    if (!attachmentStore) return unavailable(res);
    if (!validConversationId(req.params.id)) return res.status(400).json({ error: 'Conversation id is invalid.' });
    const attachment = validateAttachmentBody(req.body, { allowReplyTo: true });
    if (!attachment) return res.status(400).json({ error: 'Attachment file data or type is invalid.' });
    try {
      const row = await attachmentStore.createConversationAttachment(req.session.stemmaUser.subject, req.params.id, attachment);
      if (!row) return res.status(404).json({ error: 'Conversation not found.' });
      return res.status(201).json({ message: { id: row.id, text: row.text, createdAt: new Date(row.createdAt).toISOString(), mine: row.authorSubject === req.session.stemmaUser.subject, attachment: row.attachment, ...(row.replyTo ? { replyTo: row.replyTo } : {}) } });
    } catch { return unavailable(res); }
  });
  app.post('/api/pulse/groups/:id/attachments', requireGoogleSession, limiter, sameOriginJson(config), parser, async (req, res) => {
    noStore(res);
    if (!attachmentStore) return unavailable(res);
    if (!validConversationId(req.params.id)) return res.status(400).json({ error: 'Group id is invalid.' });
    const attachment = validateAttachmentBody(req.body);
    if (!attachment) return res.status(400).json({ error: 'Attachment file data or type is invalid.' });
    try {
      const row = await attachmentStore.createGroupAttachment(req.session.stemmaUser.subject, req.params.id, attachment);
      if (!row) return res.status(404).json({ error: 'Group not found.' });
      return res.status(201).json({ message: { id: row.id, text: row.text, createdAt: new Date(row.createdAt).toISOString(), mine: row.authorSubject === req.session.stemmaUser.subject,
        author: { username: typeof row.username === 'string' ? row.username : '', nickName: typeof row.nickName === 'string' ? row.nickName : '' }, attachment: row.attachment } });
    } catch { return unavailable(res); }
  });
  app.post('/api/pulse/saved/attachments', requireGoogleSession, limiter, sameOriginJson(config), parser, async (req, res) => {
    noStore(res);
    if (!attachmentStore) return unavailable(res);
    const attachment = validateAttachmentBody(req.body);
    if (!attachment) return res.status(400).json({ error: 'Attachment file data or type is invalid.' });
    try {
      const row = await attachmentStore.createSavedAttachment(req.session.stemmaUser.subject, attachment);
      return res.status(201).json({ message: { id: row.id, text: row.text, createdAt: new Date(row.createdAt).toISOString(), attachment: row.attachment } });
    } catch { return unavailable(res); }
  });
  app.get('/api/pulse/attachments/:id', requireGoogleSession, downloadLimiter, async (req, res) => {
    noStore(res);
    if (!attachmentStore) return unavailable(res);
    if (!validAttachmentId(req.params.id)) return res.status(404).json({ error: 'Attachment not found.' });
    try {
      const file = await attachmentStore.getAttachmentForSubject(req.session.stemmaUser.subject, req.params.id);
      if (!file || !Buffer.isBuffer(file.data) || !TYPES[file.mimeType]) return res.status(404).json({ error: 'Attachment not found.' });
      const inline = SAFE_INLINE_IMAGES.has(file.mimeType);
      const fallbackName = file.name.replace(/["\\\r\n]/g, '_').replace(/[^\x20-\x7e]/g, '_');
      res.set({
        'Cache-Control': 'private, no-store, max-age=0',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Content-Type': file.mimeType,
        'Content-Length': String(file.data.length),
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(file.name)}`
      });
      return res.status(200).send(file.data);
    } catch { return unavailable(res); }
  });
}
