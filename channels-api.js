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
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ATTACHMENT_SELECT = `(SELECT jsonb_build_object(
      'id', a.id::text, 'url', '/api/pulse/attachments/' || a.id::text,
      'name', a.name, 'mimeType', a.mime_type, 'size', a.byte_size
    ) FROM stemma_pulse_attachments a WHERE a.channel_post_id = p.id LIMIT 1)`;

export function createChannelsStore(pool) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('A PostgreSQL pool is required.');
  async function legacyChannelId(id) {
    if (!UUID_RE.test(String(id))) return id;
    const result = await pool.query(`SELECT entity_key FROM stemma_universal_identities WHERE identity_id = $1::uuid AND entity_type = 'channel' LIMIT 1`, [id]);
    return result.rows[0]?.entity_key ?? null;
  }
  async function withIdentity(rows) {
    if (!rows.length) return rows;
    const ready = await pool.query("SELECT to_regclass('stemma_universal_identities') IS NOT NULL AS ready");
    if (!ready.rows[0]?.ready) return rows;
    const ids = await pool.query(`SELECT entity_key, identity_id::text AS "identityId" FROM stemma_universal_identities
      WHERE entity_type = 'channel' AND entity_key = ANY($1::text[])`, [rows.map(row => row.id)]);
    const byKey = new Map(ids.rows.map(row => [row.entity_key, row.identityId]));
    return rows.map(row => ({ ...row, identityId: byKey.get(row.id) || null }));
  }
  const selectChannels = `SELECT c.id::text AS id, c.name, c.username,
      (c.owner_subject = $1) AS "isOwner", c.created_at AS "createdAt", c.updated_at AS "updatedAt",
      lp.id::text AS "lastPostId", lp.text AS "lastPostText", lp.created_at AS "lastPostCreatedAt",
      (SELECT count(*)::int FROM stemma_pulse_channel_subscribers sc WHERE sc.channel_id = c.id) AS "subscriberCount",
      (mine.google_subject IS NOT NULL) AS "isSubscribed", COALESCE(mine.muted, false) AS muted,
      mine.last_read_post_id::text AS "lastReadPostId",
      COALESCE(NULLIF(btrim(owner_profile.nick_name), ''), NULLIF(btrim(owner_profile.username), '')) AS "ownerName",
      NULL::text AS "avatarUrl",
      pp.id::text AS "pinnedPostId", pp.text AS "pinnedPostText", pp.created_at AS "pinnedPostCreatedAt",
      ${ATTACHMENT_SELECT.replaceAll('p.', 'pp.')} AS "pinnedPostAttachment"
    FROM stemma_pulse_channels c
    LEFT JOIN stemma_student_profiles owner_profile ON owner_profile.google_subject = c.owner_subject
    LEFT JOIN stemma_pulse_channel_subscribers mine ON mine.channel_id = c.id AND mine.google_subject = $1
    LEFT JOIN LATERAL (
      SELECT p.id, p.text, p.created_at FROM stemma_pulse_channel_posts p
      WHERE p.channel_id = c.id ORDER BY p.id DESC LIMIT 1
    ) lp ON true
    LEFT JOIN LATERAL (
      SELECT p.id, p.text, p.created_at FROM stemma_pulse_channel_posts p
      WHERE p.channel_id = c.id AND p.id = c.pinned_post_id LIMIT 1
    ) pp ON true`;
  const postSelect = `SELECT p.id::text AS id, p.text, p.created_at AS "createdAt",
      ${ATTACHMENT_SELECT} AS attachment
    FROM stemma_pulse_channel_posts p`;
  return {
    async getLegacyId(id) { return legacyChannelId(id); },
    async migrate() {
      await pool.query(await fs.readFile(path.join(ROOT, 'migrations', '014_pulse_channels.sql'), 'utf8'));
      await pool.query(await fs.readFile(path.join(ROOT, 'migrations', '015_pulse_channels_membership.sql'), 'utf8'));
      await pool.query('ALTER TABLE stemma_pulse_channels ADD COLUMN IF NOT EXISTS username VARCHAR(40)');
    },
    async listChannels(subject) {
      const result = await pool.query(`${selectChannels} ORDER BY c.updated_at DESC, c.id DESC`, [subject]);
      return withIdentity(result.rows);
    },
    async createChannel(subject, name, username = null) {
      const result = await pool.query(`WITH inserted AS (
          INSERT INTO stemma_pulse_channels (owner_subject, name, username) VALUES ($1, $2, $3)
          RETURNING id, owner_subject, name, username, created_at, updated_at
        ) SELECT i.id::text AS id, i.name, i.username, true AS "isOwner", i.created_at AS "createdAt", i.updated_at AS "updatedAt",
            0::int AS "subscriberCount", false AS "isSubscribed", false AS muted, NULL::text AS "lastReadPostId",
            COALESCE(NULLIF(btrim(p.nick_name), ''), NULLIF(btrim(p.username), '')) AS "ownerName",
            NULL::text AS "avatarUrl", NULL::text AS "pinnedPostId", NULL::text AS "pinnedPostText",
            NULL::timestamptz AS "pinnedPostCreatedAt", NULL::jsonb AS "pinnedPostAttachment"
          FROM inserted i LEFT JOIN stemma_student_profiles p ON p.google_subject = i.owner_subject`, [subject, name, username]);
      return (await withIdentity(result.rows))[0] ?? null;
    },
    async getChannel(subject, id) {
      const resolved = await legacyChannelId(id);
      if (!resolved) return null;
      const result = await pool.query(`${selectChannels} WHERE c.id = $2::bigint LIMIT 1`, [subject, resolved]);
      return (await withIdentity(result.rows))[0] ?? null;
    },
    async listPosts(id, before, limit) {
      id = await legacyChannelId(id);
      if (!id) return [];
      const result = await pool.query(`${postSelect}
        WHERE p.channel_id = $1::bigint AND ($2::bigint IS NULL OR p.id < $2::bigint)
        ORDER BY p.id DESC LIMIT $3`, [id, before, limit]);
      return result.rows;
    },
    async createPost(subject, id, text) {
      id = await legacyChannelId(id);
      if (!id) return null;
      // Ownership is part of the INSERT predicate: an API authorization check alone is not sufficient.
      const result = await pool.query(`INSERT INTO stemma_pulse_channel_posts (channel_id, text)
        SELECT c.id, $3::text FROM stemma_pulse_channels c
        WHERE c.id = $1::bigint AND c.owner_subject = $2
        RETURNING id::text AS id, text, created_at AS "createdAt"`, [id, subject, text]);
      return result.rows[0] ?? null;
    },
    async setSubscription(subject, id, subscribed) {
      id = await legacyChannelId(id);
      if (!id) return false;
      const result = await pool.query(`WITH channel AS (
          SELECT id FROM stemma_pulse_channels WHERE id = $2::bigint
        ), removed AS (
          DELETE FROM stemma_pulse_channel_subscribers s USING channel c
          WHERE s.channel_id = c.id AND s.google_subject = $1 AND NOT $3::boolean
          RETURNING s.channel_id
        ), added AS (
          INSERT INTO stemma_pulse_channel_subscribers (channel_id, google_subject)
          SELECT id, $1 FROM channel WHERE $3::boolean
          ON CONFLICT (channel_id, google_subject) DO NOTHING
          RETURNING channel_id
        ) SELECT EXISTS (SELECT 1 FROM channel) AS "channelExists"`, [subject, id, subscribed]);
      return result.rows[0]?.channelExists === true;
    },
    async setMuted(subject, id, muted) {
      id = await legacyChannelId(id);
      if (!id) return false;
      const result = await pool.query(`UPDATE stemma_pulse_channel_subscribers s
        SET muted = $3::boolean FROM stemma_pulse_channels c
        WHERE c.id = $2::bigint AND s.channel_id = c.id AND s.google_subject = $1
        RETURNING s.channel_id`, [subject, id, muted]);
      return (result.rowCount ?? result.rows.length) > 0;
    },
    async markRead(subject, id, postId) {
      id = await legacyChannelId(id);
      if (!id) return { channelExists: false, postExists: false, isSubscribed: false, lastReadPostId: null };
      const result = await pool.query(`WITH channel AS (
          SELECT id FROM stemma_pulse_channels WHERE id = $2::bigint
        ), target AS (
          SELECT p.id, p.channel_id FROM stemma_pulse_channel_posts p, channel c
          WHERE p.channel_id = c.id AND p.id = $3::bigint
        ), changed AS (
          UPDATE stemma_pulse_channel_subscribers s
          SET last_read_post_id = GREATEST(COALESCE(s.last_read_post_id, target.id), target.id)
          FROM target WHERE s.channel_id = target.channel_id AND s.google_subject = $1
          RETURNING s.last_read_post_id
        ) SELECT EXISTS (SELECT 1 FROM channel) AS "channelExists",
          EXISTS (SELECT 1 FROM target) AS "postExists",
          EXISTS (SELECT 1 FROM changed) AS "isSubscribed",
          (SELECT last_read_post_id::text FROM changed LIMIT 1) AS "lastReadPostId"`, [subject, id, postId]);
      return result.rows[0] ?? { channelExists: false, postExists: false, isSubscribed: false, lastReadPostId: null };
    },
    async setPinnedPost(subject, id, postId) {
      id = await legacyChannelId(id);
      if (!id) return false;
      const result = await pool.query(`UPDATE stemma_pulse_channels c SET pinned_post_id = $3::bigint
        WHERE c.id = $2::bigint AND c.owner_subject = $1
          AND ($3::bigint IS NULL OR EXISTS (
            SELECT 1 FROM stemma_pulse_channel_posts p WHERE p.channel_id = c.id AND p.id = $3::bigint
          ))
        RETURNING c.id`, [subject, id, postId]);
      return (result.rowCount ?? result.rows.length) > 0;
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
  return typeof value === 'string' && (UUID_RE.test(value) || (ID_RE.test(value) && BigInt(value) <= MAX_BIGINT));
}
function validSequenceId(value) {
  return typeof value === 'string' && ID_RE.test(value) && BigInt(value) <= MAX_BIGINT;
}
function parseBefore(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !ID_RE.test(value) || BigInt(value) > MAX_BIGINT) return undefined;
  return value;
}
function safeDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
function serializeAttachment(value) {
  if (value == null) return null;
  const attachment = typeof value === 'string' ? (() => { try { return JSON.parse(value); } catch { return null; } })() : value;
  if (!attachment || typeof attachment !== 'object' || typeof attachment.id !== 'string' ||
      typeof attachment.name !== 'string' || typeof attachment.mimeType !== 'string' ||
      !Number.isInteger(Number(attachment.size)) || Number(attachment.size) < 1) return null;
  return { id: attachment.id, url: `/api/pulse/attachments/${attachment.id}`, name: attachment.name,
    mimeType: attachment.mimeType, size: Number(attachment.size) };
}
function serializePost(row) {
  const createdAt = row && safeDate(row.createdAt);
  if (!row || !validSequenceId(row.id) || typeof row.text !== 'string' || !createdAt) return null;
  const post = { id: row.id, text: row.text, createdAt };
  if (Object.hasOwn(row, 'attachment')) {
    const attachment = serializeAttachment(row.attachment);
    if (row.attachment != null && !attachment) return null;
    post.attachment = attachment;
  }
  return post;
}
function serializeChannel(row) {
  const createdAt = row && safeDate(row.createdAt);
  const updatedAt = row && safeDate(row.updatedAt);
  if (!row || !validId(row.id) || typeof row.name !== 'string' || typeof row.isOwner !== 'boolean' || !createdAt || !updatedAt) return null;
  const lastPost = row.lastPostId == null ? null : serializePost({ id: row.lastPostId, text: row.lastPostText, createdAt: row.lastPostCreatedAt });
  if (row.lastPostId != null && !lastPost) return null;
  const pinnedPost = row.pinnedPostId == null ? null : serializePost({ id: row.pinnedPostId, text: row.pinnedPostText,
    createdAt: row.pinnedPostCreatedAt, attachment: row.pinnedPostAttachment });
  if (row.pinnedPostId != null && !pinnedPost) return null;
  const subscriberCount = row.subscriberCount === undefined ? 0 : Number(row.subscriberCount);
  const isSubscribed = row.isSubscribed === undefined ? false : row.isSubscribed;
  const muted = row.muted === undefined ? false : row.muted;
  const lastReadPostId = row.lastReadPostId === undefined || row.lastReadPostId === null ? null : row.lastReadPostId;
  if (!Number.isSafeInteger(subscriberCount) || subscriberCount < 0 || typeof isSubscribed !== 'boolean' || typeof muted !== 'boolean' ||
      (lastReadPostId !== null && !validSequenceId(lastReadPostId))) return null;
  return { id: row.id, ...(typeof row.identityId === 'string' ? { identityId: row.identityId, uuid: row.identityId } : {}),
    ...(typeof row.username === 'string' ? { username: row.username } : {}), name: row.name, isOwner: row.isOwner, createdAt, updatedAt, lastPost,
    subscriberCount, isSubscribed, muted, lastReadPostId, pinnedPost,
    ownerName: typeof row.ownerName === 'string' && row.ownerName.trim() ? row.ownerName : null,
    avatarUrl: typeof row.avatarUrl === 'string' && row.avatarUrl.trim() ? row.avatarUrl : null };
}
function validateExactBooleanBody(value, key) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 &&
    Object.hasOwn(value, key) && typeof value[key] === 'boolean' ? value[key] : undefined;
}
function validateNameBody(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'name') || typeof value.name !== 'string' || Object.keys(value).some(key => !['name', 'username'].includes(key))) return null;
  const name = value.name.trim();
  if (!name || name.includes('\0') || [...name].length > MAX_NAME_LENGTH) return null;
  let username = null;
  if (Object.hasOwn(value, 'username')) {
    if (typeof value.username !== 'string' || !/^[A-Za-z0-9_.-]{5,40}$/.test(value.username.trim())) return null;
    username = value.username.trim().toLowerCase();
  }
  return { name, username };
}
function validatePostBody(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'text') || typeof value.text !== 'string') return null;
  const text = value.text.trim();
  if (!text || text.includes('\0') || [...text].length > MAX_TEXT_LENGTH) return null;
  return text;
}
function validateReadBody(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 ||
      !Object.hasOwn(value, 'postId') || !validId(value.postId)) return null;
  return value.postId;
}
function validatePinBody(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'postId')) return undefined;
  if (value.postId === null) return null;
  return typeof value.postId === 'string' && ID_RE.test(value.postId) && BigInt(value.postId) <= MAX_BIGINT ? value.postId : undefined;
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
  const channelId = (req, res) => {
    if (!validId(req.params.id)) {
      res.status(400).json({ error: 'Channel ID is invalid.' });
      return false;
    }
    return true;
  };
  const loadChannel = async (subject, id) => {
    const row = await channelsStore.getChannel(subject, id);
    return { row, channel: serializeChannel(row) };
  };

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
    const input = validateNameBody(req.body);
    if (input === null) return res.status(400).json({ error: 'Channel name or username is invalid.' });
    try {
      const row = await channelsStore.createChannel(subjectOf(req), input.name, input.username);
      const channel = serializeChannel(row);
      if (!channel) return res.status(503).json({ error: 'Channels service is unavailable.' });
      return res.status(201).json({ channel });
    } catch {
      return res.status(503).json({ error: 'Channels service is unavailable.' });
    }
  });

  app.get('/api/pulse/channels/:id', requireGoogleSession, limiter, async (req, res) => {
    if (!ready(res) || !channelId(req, res)) return;
    try {
      const { row, channel } = await loadChannel(subjectOf(req), req.params.id);
      if (!row) return res.status(404).json({ error: 'Channel not found.' });
      if (!channel) return res.status(503).json({ error: 'Channels service is unavailable.' });
      return res.json({ channel });
    } catch {
      return res.status(503).json({ error: 'Channels service is unavailable.' });
    }
  });

  app.get('/api/pulse/channels/:id/posts', requireGoogleSession, limiter, async (req, res) => {
    if (!ready(res) || !channelId(req, res)) return;
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
    if (!ready(res) || !channelId(req, res)) return;
    const text = validatePostBody(req.body);
    if (text === null) return res.status(400).json({ error: 'Post must be nonblank text of at most 4000 characters.' });
    try {
      const { row: channelRow, channel } = await loadChannel(subjectOf(req), req.params.id);
      if (!channelRow) return res.status(404).json({ error: 'Channel not found.' });
      if (!channel) return res.status(503).json({ error: 'Channels service is unavailable.' });
      if (!channel.isOwner) return res.status(403).json({ error: 'Only the channel owner may post.' });
      const row = await channelsStore.createPost(subjectOf(req), req.params.id, text);
      if (!row) return res.status(403).json({ error: 'Only the channel owner may post.' });
      const post = serializePost(row);
      if (!post) return res.status(503).json({ error: 'Channels service is unavailable.' });
      return res.status(201).json({ post });
    } catch {
      return res.status(503).json({ error: 'Channels service is unavailable.' });
    }
  });

  app.post('/api/pulse/channels/:id/subscription', requireGoogleSession, limiter, sameOriginJson(config), express.json({ limit: '4kb', strict: true }), async (req, res) => {
    if (!ready(res) || !channelId(req, res)) return;
    const subscribed = validateExactBooleanBody(req.body, 'subscribed');
    if (subscribed === undefined) return res.status(400).json({ error: 'Subscription must be a boolean.' });
    try {
      const { row } = await loadChannel(subjectOf(req), req.params.id);
      if (!row) return res.status(404).json({ error: 'Channel not found.' });
      if (!await channelsStore.setSubscription(subjectOf(req), req.params.id, subscribed)) return res.status(404).json({ error: 'Channel not found.' });
      const { channel } = await loadChannel(subjectOf(req), req.params.id);
      if (!channel) return res.status(503).json({ error: 'Channels service is unavailable.' });
      return res.json({ channel });
    } catch {
      return res.status(503).json({ error: 'Channels service is unavailable.' });
    }
  });

  app.post('/api/pulse/channels/:id/preferences', requireGoogleSession, limiter, sameOriginJson(config), express.json({ limit: '4kb', strict: true }), async (req, res) => {
    if (!ready(res) || !channelId(req, res)) return;
    const muted = validateExactBooleanBody(req.body, 'muted');
    if (muted === undefined) return res.status(400).json({ error: 'Muted must be a boolean.' });
    try {
      const { row } = await loadChannel(subjectOf(req), req.params.id);
      if (!row) return res.status(404).json({ error: 'Channel not found.' });
      if (!await channelsStore.setMuted(subjectOf(req), req.params.id, muted)) return res.status(409).json({ error: 'Subscribe to the channel before changing its preferences.' });
      const { channel } = await loadChannel(subjectOf(req), req.params.id);
      return channel ? res.json({ channel }) : res.status(503).json({ error: 'Channels service is unavailable.' });
    } catch {
      return res.status(503).json({ error: 'Channels service is unavailable.' });
    }
  });

  app.post('/api/pulse/channels/:id/read', requireGoogleSession, limiter, sameOriginJson(config), express.json({ limit: '4kb', strict: true }), async (req, res) => {
    if (!ready(res) || !channelId(req, res)) return;
    const postId = validateReadBody(req.body);
    if (postId === null) return res.status(400).json({ error: 'A valid postId is required.' });
    try {
      const { row } = await loadChannel(subjectOf(req), req.params.id);
      if (!row) return res.status(404).json({ error: 'Channel not found.' });
      const state = await channelsStore.markRead(subjectOf(req), req.params.id, postId);
      if (!state.channelExists) return res.status(404).json({ error: 'Channel not found.' });
      if (!state.postExists) return res.status(404).json({ error: 'Post not found in this channel.' });
      if (!state.isSubscribed) return res.status(409).json({ error: 'Subscribe to the channel before updating its read cursor.' });
      return res.json({ lastReadPostId: state.lastReadPostId });
    } catch {
      return res.status(503).json({ error: 'Channels service is unavailable.' });
    }
  });

  app.post('/api/pulse/channels/:id/pin', requireGoogleSession, limiter, sameOriginJson(config), express.json({ limit: '4kb', strict: true }), async (req, res) => {
    if (!ready(res) || !channelId(req, res)) return;
    const postId = validatePinBody(req.body);
    if (postId === undefined) return res.status(400).json({ error: 'postId must be a valid post ID or null.' });
    try {
      const { row, channel } = await loadChannel(subjectOf(req), req.params.id);
      if (!row) return res.status(404).json({ error: 'Channel not found.' });
      if (!channel) return res.status(503).json({ error: 'Channels service is unavailable.' });
      if (!channel.isOwner) return res.status(403).json({ error: 'Only the channel owner may pin posts.' });
      const changed = await channelsStore.setPinnedPost(subjectOf(req), req.params.id, postId);
      if (!changed) return postId === null ? res.status(403).json({ error: 'Only the channel owner may pin posts.' }) : res.status(400).json({ error: 'Pinned post must belong to this channel.' });
      const updated = await loadChannel(subjectOf(req), req.params.id);
      if (!updated.channel) return res.status(503).json({ error: 'Channels service is unavailable.' });
      return res.json({ channel: updated.channel });
    } catch {
      return res.status(503).json({ error: 'Channels service is unavailable.' });
    }
  });
}
