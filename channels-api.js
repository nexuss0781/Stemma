import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import rateLimit from 'express-rate-limit';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PAGE_SIZE = 50;
const MAX_NAME_LENGTH = 80;
const MAX_TEXT_LENGTH = 4000;
const ID_RE = /^[1-9]\d{0,18}$/;
const MAX_BIGINT = 9_223_372_036_854_775_807n;

export function createChannelsStore(pool) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('A PostgreSQL pool is required.');
  const selectChannels = `SELECT c.id::text AS id, c.name,
      (c.owner_subject = $1) AS "isOwner", c.created_at AS "createdAt", c.updated_at AS "updatedAt",
      lp.id::text AS "lastPostId", lp.text AS "lastPostText", lp.created_at AS "lastPostCreatedAt"
    FROM stemma_pulse_channels c
    LEFT JOIN LATERAL (
      SELECT p.id, p.text, p.created_at FROM stemma_pulse_channel_posts p
      WHERE p.channel_id = c.id ORDER BY p.id DESC LIMIT 1
    ) lp ON true`;
  return {
    async migrate() {
      await pool.query(await fs.readFile(path.join(ROOT, 'migrations', '014_pulse_channels.sql'), 'utf8'));
    },
    async listChannels(subject) {
      const result = await pool.query(`${selectChannels} ORDER BY c.updated_at DESC, c.id DESC`, [subject]);
      return result.rows;
    },
    async createChannel(subject, name) {
      const result = await pool.query(`INSERT INTO stemma_pulse_channels (owner_subject, name)
        VALUES ($1, $2)
        RETURNING id::text AS id, name, true AS "isOwner", created_at AS "createdAt", updated_at AS "updatedAt"`, [subject, name]);
      return result.rows[0] ?? null;
    },
    async getChannel(subject, id) {
      const result = await pool.query(`${selectChannels} WHERE c.id = $2::bigint LIMIT 1`, [subject, id]);
      return result.rows[0] ?? null;
    },
    async listPosts(id, before, limit) {
      const result = await pool.query(`SELECT p.id::text AS id, p.text, p.created_at AS "createdAt"
        FROM stemma_pulse_channel_posts p
        WHERE p.channel_id = $1::bigint AND ($2::bigint IS NULL OR p.id < $2::bigint)
        ORDER BY p.id DESC LIMIT $3`, [id, before, limit]);
      return result.rows;
    },
    async createPost(subject, id, text) {
      // Ownership is part of the INSERT predicate: an API authorization check alone is not sufficient.
      const result = await pool.query(`INSERT INTO stemma_pulse_channel_posts (channel_id, text)
        SELECT c.id, $3::text FROM stemma_pulse_channels c
        WHERE c.id = $1::bigint AND c.owner_subject = $2
        RETURNING id::text AS id, text, created_at AS "createdAt"`, [id, subject, text]);
      return result.rows[0] ?? null;
    }
  };
}

export const createChannelStore = createChannelsStore;

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

function validId(value) {
  return typeof value === 'string' && ID_RE.test(value) && BigInt(value) <= MAX_BIGINT;
}
function parseBefore(value) {
  if (value === undefined) return null;
  if (!validId(value)) return undefined;
  return value;
}
function safeDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
function serializePost(row) {
  const createdAt = row && safeDate(row.createdAt);
  if (!row || !validId(row.id) || typeof row.text !== 'string' || !createdAt) return null;
  return { id: row.id, text: row.text, createdAt };
}
function serializeChannel(row) {
  const createdAt = row && safeDate(row.createdAt);
  const updatedAt = row && safeDate(row.updatedAt);
  if (!row || !validId(row.id) || typeof row.name !== 'string' || typeof row.isOwner !== 'boolean' || !createdAt || !updatedAt) return null;
  const lastPost = row.lastPostId == null ? null : serializePost({ id: row.lastPostId, text: row.lastPostText, createdAt: row.lastPostCreatedAt });
  if (row.lastPostId != null && !lastPost) return null;
  return { id: row.id, name: row.name, isOwner: row.isOwner, createdAt, updatedAt, lastPost };
}
function validateNameBody(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'name') || typeof value.name !== 'string') return null;
  const name = value.name.trim();
  if (!name || name.includes('\0') || [...name].length > MAX_NAME_LENGTH) return null;
  return name;
}
function validatePostBody(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'text') || typeof value.text !== 'string') return null;
  const text = value.text.trim();
  if (!text || text.includes('\0') || [...text].length > MAX_TEXT_LENGTH) return null;
  return text;
}

export function registerChannelsApi(app, { channelStore = null, channelsStore = channelStore, requireGoogleSession, config }) {
  if (typeof requireGoogleSession !== 'function') throw new TypeError('Google-session middleware is required.');
  const limiter = rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: req => {
      const subject = req.session?.stemmaUser?.subject;
      // Authenticated calls are isolated per user; req.ip is express-rate-limit's standard fallback key.
      return typeof subject === 'string' && subject ? `channel-user:${subject}` : req.ip;
    },
    handler: (_req, res) => {
      setPrivateNoStore(res);
      res.status(429).json({ error: 'Too many Channels requests. Please wait and try again.' });
    }
  });
  const ready = res => {
    setPrivateNoStore(res);
    if (!channelsStore) {
      res.status(503).json({ error: 'Channels service is unavailable.' });
      return false;
    }
    return true;
  };
  const subjectOf = req => req.session.stemmaUser.subject;

  app.get('/api/pulse/channels', requireGoogleSession, limiter, async (req, res) => {
    if (!ready(res)) return;
    try {
      const rows = await channelsStore.listChannels(subjectOf(req));
      const channels = (Array.isArray(rows) ? rows : []).map(serializeChannel);
      if (channels.some(channel => !channel)) return res.status(503).json({ error: 'Channels service is unavailable.' });
      return res.json({ channels });
    } catch {
      return res.status(503).json({ error: 'Channels service is unavailable.' });
    }
  });

  app.post('/api/pulse/channels', requireGoogleSession, limiter, sameOriginJson(config), express.json({ limit: '16kb', strict: true }), async (req, res) => {
    if (!ready(res)) return;
    const name = validateNameBody(req.body);
    if (name === null) return res.status(400).json({ error: 'Channel name must be nonblank and at most 80 characters.' });
    try {
      const row = await channelsStore.createChannel(subjectOf(req), name);
      const channel = serializeChannel(row);
      if (!channel) return res.status(503).json({ error: 'Channels service is unavailable.' });
      return res.status(201).json({ channel });
    } catch {
      return res.status(503).json({ error: 'Channels service is unavailable.' });
    }
  });

  app.get('/api/pulse/channels/:id', requireGoogleSession, limiter, async (req, res) => {
    if (!ready(res)) return;
    if (!validId(req.params.id)) return res.status(400).json({ error: 'Channel ID is invalid.' });
    try {
      const row = await channelsStore.getChannel(subjectOf(req), req.params.id);
      const channel = serializeChannel(row);
      if (!row) return res.status(404).json({ error: 'Channel not found.' });
      if (!channel) return res.status(503).json({ error: 'Channels service is unavailable.' });
      return res.json({ channel });
    } catch {
      return res.status(503).json({ error: 'Channels service is unavailable.' });
    }
  });

  app.get('/api/pulse/channels/:id/posts', requireGoogleSession, limiter, async (req, res) => {
    if (!ready(res)) return;
    if (!validId(req.params.id)) return res.status(400).json({ error: 'Channel ID is invalid.' });
    const before = parseBefore(req.query.before);
    if (before === undefined) return res.status(400).json({ error: 'Posts cursor is invalid.' });
    try {
      const channel = await channelsStore.getChannel(subjectOf(req), req.params.id);
      if (!channel) return res.status(404).json({ error: 'Channel not found.' });
      const rows = await channelsStore.listPosts(req.params.id, before, PAGE_SIZE + 1);
      const posts = (Array.isArray(rows) ? rows : []).map(serializePost);
      if (posts.some(post => !post)) return res.status(503).json({ error: 'Channels service is unavailable.' });
      const hasMore = posts.length > PAGE_SIZE;
      const page = posts.slice(0, PAGE_SIZE);
      return res.json({ posts: page, hasMore, nextBefore: hasMore ? page.at(-1).id : null });
    } catch {
      return res.status(503).json({ error: 'Channels service is unavailable.' });
    }
  });

  app.post('/api/pulse/channels/:id/posts', requireGoogleSession, limiter, sameOriginJson(config), express.json({ limit: '20kb', strict: true }), async (req, res) => {
    if (!ready(res)) return;
    if (!validId(req.params.id)) return res.status(400).json({ error: 'Channel ID is invalid.' });
    const text = validatePostBody(req.body);
    if (text === null) return res.status(400).json({ error: 'Post must be nonblank text of at most 4000 characters.' });
    try {
      const channelRow = await channelsStore.getChannel(subjectOf(req), req.params.id);
      if (!channelRow) return res.status(404).json({ error: 'Channel not found.' });
      const channel = serializeChannel(channelRow);
      if (!channel) return res.status(503).json({ error: 'Channels service is unavailable.' });
      if (!channel.isOwner) return res.status(403).json({ error: 'Only the channel owner may post.' });
      // The store additionally predicates its INSERT on owner_subject, preventing bypass of this API check.
      const row = await channelsStore.createPost(subjectOf(req), req.params.id, text);
      if (!row) return res.status(403).json({ error: 'Only the channel owner may post.' });
      const post = serializePost(row);
      if (!post) return res.status(503).json({ error: 'Channels service is unavailable.' });
      return res.status(201).json({ post });
    } catch {
      return res.status(503).json({ error: 'Channels service is unavailable.' });
    }
  });
}
