import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import rateLimit from 'express-rate-limit';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PAGE_SIZE = 50;
const MAX_MESSAGE_LENGTH = 4000;
const SLUG_RE = /^[A-Za-z0-9_-]{3,40}$/;
const ID_RE = /^[1-9]\d{0,18}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{40,64}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/u;
const RESERVED_SLUGS = new Set([
  'api', 'auth', 'assets', 'healthz', 'invite', 'index', 'index-html', 'dashboard', 'overview', 'cards', 'pulse', 'goals', 'profile', 'app', 'app-js',
  'payment-ui', 'payment-ui-js', 'profile-photo', 'profile-photo-js', 'profile-ui', 'profile-ui-js',
  'navigation-memory', 'navigation-memory-js', 'parent-navigation', 'parent-navigation-js',
  'friend-ui', 'friend-ui-js', 'notifications-ui', 'notifications-ui-js', 'pulse-ui', 'pulse-ui-js',
  'direct-chat-ui', 'direct-chat-ui-js', 'chat-attachments-ui', 'chat-attachments-ui-js',
  'pulse-data-ui', 'pulse-data-ui-js', 'pulse-css', 'styles', 'styles-css', 'groups-ui', 'groups-ui-js', 'groups-css'
]);

export function createGroupsStore(pool) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('A PostgreSQL pool is required.');
  async function transaction(callback) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }
  const summarySql = `SELECT g.id::text AS id, g.name, g.slug, g.description, g.visibility,
      g.owner_subject AS "ownerSubject", g.invite_token AS "inviteToken",
      (SELECT count(*)::int FROM stemma_groups_memberships m WHERE m.group_id = g.id) AS "memberCount",
      EXISTS (SELECT 1 FROM stemma_groups_memberships m WHERE m.group_id = g.id AND m.member_subject = $1) AS "isMember",
      (g.owner_subject = $1 AND EXISTS (SELECT 1 FROM stemma_groups_memberships m WHERE m.group_id = g.id AND m.member_subject = $1 AND m.role = 'owner')) AS "isOwner"
    FROM stemma_groups g`;
  return {
    async migrate() {
      await pool.query(await fs.readFile(path.join(ROOT, 'migrations', '009_groups.sql'), 'utf8'));
    },
    async listMine(subject) {
      const result = await pool.query(`${summarySql} WHERE EXISTS (
        SELECT 1 FROM stemma_groups_memberships m WHERE m.group_id = g.id AND m.member_subject = $1
      ) ORDER BY g.updated_at DESC, g.id DESC`, [subject]);
      return result.rows;
    },
    async searchPublic(subject, query, limit = PAGE_SIZE) {
      const escaped = query.replace(/[\\%_]/g, '\\$&');
      const result = await pool.query(`${summarySql}
        WHERE g.visibility = 'public' AND g.name ILIKE $2 ESCAPE E'\\\\'
        ORDER BY g.name, g.id LIMIT $3`, [subject, `%${escaped}%`, limit]);
      return result.rows;
    },
    async createGroup(subject, { name, slug, description, visibility }) {
      const token = crypto.randomBytes(32).toString('base64url');
      return transaction(async client => {
        const inserted = await client.query(`INSERT INTO stemma_groups
          (name, slug, description, visibility, owner_subject, invite_token)
          VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING id::text AS id, name, slug, description, visibility, owner_subject AS "ownerSubject", invite_token AS "inviteToken"`,
        [name, slug, description, visibility, subject, token]);
        const group = inserted.rows[0];
        await client.query(`INSERT INTO stemma_groups_memberships (group_id, member_subject, role) VALUES ($1::bigint, $2, 'owner')`, [group.id, subject]);
        return (await getSummary(client, group.id, subject));
      });
    },
    async getById(subject, id, inviteToken = null) {
      const group = await fetchSummary(pool, subject, `g.id = $2::bigint AND (
        g.visibility = 'public' OR EXISTS (SELECT 1 FROM stemma_groups_memberships m WHERE m.group_id = g.id AND m.member_subject = $1)
        OR ($3::text IS NOT NULL AND g.invite_token = $3)
      )`, [subject, id, inviteToken]);
      return group ? detail(group, subject, pool) : null;
    },
    async resolvePublicSlug(subject, slug) {
      const group = await fetchSummary(pool, subject, `lower(g.slug) = lower($2) AND g.visibility = 'public'`, [subject, slug]);
      return group ? detail(group, subject, pool) : null;
    },
    async resolveInvite(subject, token) {
      const group = await fetchSummary(pool, subject, `g.invite_token = $2`, [subject, token]);
      return group ? detail(group, subject, pool) : null;
    },
    async join(subject, id, inviteToken = null) {
      return transaction(async client => {
        const locked = await client.query(`SELECT id::text AS id, owner_subject AS "ownerSubject", visibility, invite_token AS "inviteToken"
          FROM stemma_groups WHERE id = $1::bigint FOR UPDATE`, [id]);
        const group = locked.rows[0];
        if (!group) return null;
        const existing = await client.query(`SELECT 1 FROM stemma_groups_memberships
          WHERE group_id = $1::bigint AND member_subject = $2`, [id, subject]);
        if (!existing.rows.length && group.visibility === 'private' && group.inviteToken !== inviteToken) return null;
        await client.query(`INSERT INTO stemma_groups_memberships (group_id, member_subject, role)
          VALUES ($1::bigint, $2, CASE WHEN $2::varchar(255) = $3::varchar(255) THEN 'owner' ELSE 'member' END)
          ON CONFLICT (group_id, member_subject) DO NOTHING`, [id, subject, group.ownerSubject]);
        return getSummary(client, id, subject);
      });
    },
    async leave(subject, id) {
      return transaction(async client => {
        const locked = await client.query(`SELECT id::text AS id, owner_subject AS "ownerSubject"
          FROM stemma_groups WHERE id = $1::bigint FOR UPDATE`, [id]);
        const group = locked.rows[0];
        if (!group) return null;
        const membership = await client.query(`SELECT role FROM stemma_groups_memberships
          WHERE group_id = $1::bigint AND member_subject = $2 FOR UPDATE`, [id, subject]);
        if (!membership.rows.length) return null;
        if (membership.rows[0].role === 'owner' && group.ownerSubject === subject) {
          const successor = await client.query(`SELECT member_subject FROM stemma_groups_memberships
            WHERE group_id = $1::bigint AND member_subject <> $2 ORDER BY joined_at, id LIMIT 1`, [id, subject]);
          await client.query(`DELETE FROM stemma_groups_memberships WHERE group_id = $1::bigint AND member_subject = $2`, [id, subject]);
          if (successor.rows[0]) {
            await client.query(`UPDATE stemma_groups_memberships SET role = 'owner'
              WHERE group_id = $1::bigint AND member_subject = $2`, [id, successor.rows[0].member_subject]);
            await client.query(`UPDATE stemma_groups SET owner_subject = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1::bigint`, [id, successor.rows[0].member_subject]);
          }
        } else {
          await client.query(`DELETE FROM stemma_groups_memberships WHERE group_id = $1::bigint AND member_subject = $2`, [id, subject]);
        }
        return { left: true };
      });
    },
    async updateGroup(subject, id, changes) {
      const keys = Object.keys(changes);
      const columns = { name: 'name', description: 'description', visibility: 'visibility', slug: 'slug' };
      const values = [id, subject];
      const updates = keys.map(key => { values.push(changes[key]); return `${columns[key]} = $${values.length}`; });
      const result = await pool.query(`UPDATE stemma_groups g SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
        WHERE g.id = $1::bigint AND g.owner_subject = $2
          AND EXISTS (SELECT 1 FROM stemma_groups_memberships m WHERE m.group_id = g.id AND m.member_subject = $2 AND m.role = 'owner')
        RETURNING g.id::text AS id`, values);
      return result.rows[0] ? getSummary(pool, id, subject) : null;
    },
    async listMessages(subject, id, before, limit) {
      const result = await pool.query(`SELECT m.id::text AS id, m.text, m.created_at AS "createdAt",
          m.author_subject AS "authorSubject", COALESCE(p.username, '') AS username, COALESCE(p.nick_name, '') AS "nickName"
        FROM stemma_groups_messages m
        JOIN stemma_groups_memberships member ON member.group_id = m.group_id AND member.member_subject = $2
        LEFT JOIN stemma_student_profiles p ON p.google_subject = m.author_subject
        WHERE m.group_id = $1::bigint AND ($3::bigint IS NULL OR m.id < $3::bigint)
        ORDER BY m.id DESC LIMIT $4`, [id, subject, before, limit]);
      return result.rows;
    },
    async sendMessage(subject, id, text) {
      const result = await pool.query(`WITH inserted AS (
          INSERT INTO stemma_groups_messages (group_id, author_subject, text)
          SELECT g.id, $2::varchar(255), $3::text FROM stemma_groups g
          WHERE g.id = $1::bigint AND EXISTS (SELECT 1 FROM stemma_groups_memberships m WHERE m.group_id = g.id AND m.member_subject = $2::varchar(255))
          RETURNING id, group_id, author_subject, text, created_at
        ) SELECT i.id::text AS id, i.text, i.created_at AS "createdAt", i.author_subject AS "authorSubject",
          COALESCE(p.username, '') AS username, COALESCE(p.nick_name, '') AS "nickName"
          FROM inserted i LEFT JOIN stemma_student_profiles p ON p.google_subject = i.author_subject`, [id, subject, text]);
      return result.rows[0] ?? null;
    }
  };
}

async function getSummary(client, id, subject) {
  return (await fetchSummary(client, subject, 'g.id = $2::bigint', [subject, id]));
}
async function fetchSummary(client, subject, condition, values) {
  const result = await client.query(`SELECT g.id::text AS id, g.name, g.slug, g.description, g.visibility,
      g.owner_subject AS "ownerSubject", g.invite_token AS "inviteToken",
      (SELECT count(*)::int FROM stemma_groups_memberships m WHERE m.group_id = g.id) AS "memberCount",
      EXISTS (SELECT 1 FROM stemma_groups_memberships m WHERE m.group_id = g.id AND m.member_subject = $1) AS "isMember",
      (g.owner_subject = $1 AND EXISTS (SELECT 1 FROM stemma_groups_memberships m WHERE m.group_id = g.id AND m.member_subject = $1 AND m.role = 'owner')) AS "isOwner"
    FROM stemma_groups g WHERE ${condition} LIMIT 1`, values);
  return result.rows[0] ?? null;
}
async function detail(group, subject, client) {
  const dto = groupDto(group);
  if (!dto.isMember) return { group: dto };
  const result = await client.query(`SELECT p.username, p.nick_name AS "nickName", m.role
    FROM stemma_groups_memberships m JOIN stemma_student_profiles p ON p.google_subject = m.member_subject
    WHERE m.group_id = $1::bigint ORDER BY m.joined_at, m.id`, [group.id]);
  return { group: dto, members: result.rows.map(row => ({ username: row.username, nickName: row.nickName, role: row.role })) };
}
function groupDto(row) {
  return {
    id: row.id, name: row.name, slug: row.slug, description: row.description, visibility: row.visibility,
    memberCount: Number(row.memberCount) || 0, isMember: row.isMember === true, isOwner: row.isOwner === true,
    ...(row.visibility === 'public' ? { publicUrl: `/${row.slug}` } : {}),
    ...(row.isMember === true && row.visibility === 'private' && typeof row.inviteToken === 'string' && validToken(row.inviteToken)
      ? { inviteUrl: `/invite/${row.inviteToken}` }
      : row.isMember === true && row.visibility === 'private' && typeof row.inviteUrl === 'string' && /^\/invite\/[A-Za-z0-9_-]{40,64}$/.test(row.inviteUrl)
        ? { inviteUrl: row.inviteUrl } : {})
  };
}
function privateNoStore(res) {
  res.set({ 'Cache-Control': 'private, no-store, max-age=0', Pragma: 'no-cache', 'Referrer-Policy': 'no-referrer' });
}
function sameOriginJson(config) {
  return (req, res, next) => {
    const origin = req.get('origin');
    const expectedOrigin = config.appOrigin || `${req.protocol}://${req.get('host')}`;
    if (!origin || origin !== expectedOrigin) { privateNoStore(res); return res.status(403).json({ error: 'This request could not be verified.' }); }
    if (!req.is('application/json')) { privateNoStore(res); return res.status(415).json({ error: 'A JSON request body is required.' }); }
    return next();
  };
}
function validId(value) { return typeof value === 'string' && ID_RE.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n; }
function parseBefore(value) {
  if (value === undefined) return null;
  return typeof value === 'string' && ID_RE.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n ? value : undefined;
}
function validSlug(value) { return typeof value === 'string' && SLUG_RE.test(value) && !RESERVED_SLUGS.has(value.toLowerCase()); }
function validToken(value) { return typeof value === 'string' && TOKEN_RE.test(value); }
function validateName(value) {
  if (typeof value !== 'string' || CONTROL_RE.test(value)) return null;
  const name = value.trim();
  return name && [...name].length <= 80 ? name : null;
}
function validateDescription(value) {
  if (typeof value !== 'string' || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(value)) return null;
  const description = value.trim();
  return [...description].length <= 500 ? description : null;
}
function validateCreate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['name', 'slug', 'description', 'visibility'].includes(key))) return null;
  const name = validateName(body.name), description = validateDescription(body.description);
  const slug = typeof body.slug === 'string' ? body.slug.trim().toLowerCase() : '';
  if (!name || description === null || !validSlug(slug) || !['public', 'private'].includes(body.visibility)) return null;
  return { name, slug, description, visibility: body.visibility };
}
function validatePatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const allowed = ['name', 'description', 'visibility', 'slug'];
  const keys = Object.keys(body);
  if (!keys.length || keys.some(key => !allowed.includes(key))) return null;
  const changes = {};
  if (Object.hasOwn(body, 'name')) { changes.name = validateName(body.name); if (!changes.name) return null; }
  if (Object.hasOwn(body, 'description')) { changes.description = validateDescription(body.description); if (changes.description === null) return null; }
  if (Object.hasOwn(body, 'visibility')) { if (!['public', 'private'].includes(body.visibility)) return null; changes.visibility = body.visibility; }
  if (Object.hasOwn(body, 'slug')) { if (typeof body.slug !== 'string' || !validSlug(body.slug.trim().toLowerCase())) return null; changes.slug = body.slug.trim().toLowerCase(); }
  return changes;
}
function validateMessage(body, allowed = ['text']) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key)) || typeof body.text !== 'string') return null;
  const text = body.text.trim();
  return text && !text.includes('\0') && [...text].length <= MAX_MESSAGE_LENGTH ? text : null;
}
function validGroupRow(row) {
  return row && validId(row.id) && typeof row.name === 'string' && typeof row.slug === 'string' &&
    typeof row.description === 'string' && ['public', 'private'].includes(row.visibility);
}
function safeDate(value) { const d = value instanceof Date ? value : new Date(value); return Number.isNaN(d.getTime()) ? null : d.toISOString(); }
function publicGroup(row) {
  if (!validGroupRow(row)) return null;
  return groupDto(row);
}
function registerGroupsApi(app, { groupsStore = null, requireGoogleSession, config }) {
  if (typeof requireGoogleSession !== 'function') throw new TypeError('Google-session middleware is required.');
  const limiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false,
    handler: (_req, res) => { privateNoStore(res); res.status(429).json({ error: 'Too many group requests. Please wait and try again.' }); }
  });
  const auth = [requireGoogleSession, (req, res, next) => { privateNoStore(res); limiter(req, res, next); }];
  const available = res => { if (!groupsStore) { res.status(503).json({ error: 'Groups service is unavailable.' }); return false; } return true; };
  const safeGroup = row => publicGroup(row);
  app.get('/api/pulse/groups', ...auth, async (req, res) => {
    if (!available(res)) return;
    try {
      const rows = await groupsStore.listMine(req.session.stemmaUser.subject);
      return res.json({ groups: (rows || []).map(safeGroup).filter(Boolean) });
    } catch { return res.status(503).json({ error: 'Groups service is unavailable.' }); }
  });
  app.get('/api/pulse/groups/search', ...auth, async (req, res) => {
    if (!available(res)) return;
    const q = req.query.q;
    if (typeof q !== 'string' || q.trim().length < 2 || [...q.trim()].length > 80 || CONTROL_RE.test(q)) return res.status(400).json({ error: 'A valid group search query is required.' });
    try {
      const rows = await groupsStore.searchPublic(req.session.stemmaUser.subject, q.trim(), PAGE_SIZE);
      return res.json({ groups: (rows || []).map(safeGroup).filter(Boolean) });
    } catch { return res.status(503).json({ error: 'Groups service is unavailable.' }); }
  });
  app.post('/api/pulse/groups', ...auth, sameOriginJson(config), express.json({ limit: '20kb', strict: true }), async (req, res) => {
    if (!available(res)) return;
    const body = validateCreate(req.body);
    if (!body) return res.status(400).json({ error: 'Group name, valid slug, description, and visibility are required.' });
    try {
      const row = await groupsStore.createGroup(req.session.stemmaUser.subject, body);
      const group = safeGroup(row);
      return group ? res.status(201).json({ group }) : res.status(503).json({ error: 'Groups service is unavailable.' });
    } catch (error) {
      if (error?.code === '23505') return res.status(409).json({ error: 'That group name or URL is already in use.' });
      return res.status(503).json({ error: 'Groups service is unavailable.' });
    }
  });
  const detailHandler = async (req, res, resolver) => {
    if (!available(res)) return;
    try {
      const result = await resolver(req.session.stemmaUser.subject);
      if (!result || !result.group || !safeGroup(result.group)) return res.status(404).json({ error: 'Group not found.' });
      // A group preview never returns member identities, even when the store has extra fields.
      if (result.group.isMember === true && Array.isArray(result.members)) return res.json({ group: safeGroup(result.group), members: result.members.filter(m => m && typeof m.username === 'string' && typeof m.nickName === 'string' && ['owner', 'member'].includes(m.role)).map(m => ({ username: m.username, nickName: m.nickName, role: m.role })) });
      return res.json({ group: safeGroup(result.group) });
    } catch { return res.status(503).json({ error: 'Groups service is unavailable.' }); }
  };
  app.get('/api/pulse/groups/resolve/:slug', ...auth, async (req, res) => {
    if (!validSlug(req.params.slug)) return res.status(400).json({ error: 'Group URL is invalid.' });
    return detailHandler(req, res, subject => groupsStore.resolvePublicSlug(subject, req.params.slug));
  });
  app.get('/api/pulse/groups/invite/:token', ...auth, async (req, res) => {
    if (!validToken(req.params.token)) return res.status(404).json({ error: 'Group not found.' });
    return detailHandler(req, res, subject => groupsStore.resolveInvite(subject, req.params.token));
  });
  app.get('/api/pulse/groups/:id', ...auth, async (req, res) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: 'Group ID is invalid.' });
    const invite = req.query.invite;
    if (invite !== undefined && !validToken(invite)) return res.status(404).json({ error: 'Group not found.' });
    return detailHandler(req, res, subject => groupsStore.getById(subject, req.params.id, invite ?? null));
  });
  app.post('/api/pulse/groups/:id/join', ...auth, sameOriginJson(config), express.json({ limit: '20kb', strict: true }), async (req, res) => {
    if (!available(res)) return;
    if (!validId(req.params.id)) return res.status(400).json({ error: 'Group ID is invalid.' });
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => k !== 'invite') || (Object.hasOwn(body, 'invite') && !validToken(body.invite))) return res.status(400).json({ error: 'Group invitation is invalid.' });
    try {
      const row = await groupsStore.join(req.session.stemmaUser.subject, req.params.id, body.invite ?? null);
      if (!row) return res.status(404).json({ error: 'Group not found or invitation is invalid.' });
      const group = safeGroup(row);
      return group ? res.json({ group }) : res.status(503).json({ error: 'Groups service is unavailable.' });
    } catch (error) {
      if (error?.code === '23505') return res.status(409).json({ error: 'Group membership could not be created.' });
      return res.status(503).json({ error: 'Groups service is unavailable.' });
    }
  });
  app.post('/api/pulse/groups/:id/leave', ...auth, sameOriginJson(config), express.json({ limit: '20kb', strict: true }), async (req, res) => {
    if (!available(res)) return;
    if (!validId(req.params.id)) return res.status(400).json({ error: 'Group ID is invalid.' });
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length) return res.status(400).json({ error: 'A valid request body is required.' });
    try {
      const result = await groupsStore.leave(req.session.stemmaUser.subject, req.params.id);
      return result ? res.json({ left: true }) : res.status(404).json({ error: 'Group not found.' });
    } catch { return res.status(503).json({ error: 'Groups service is unavailable.' }); }
  });
  app.patch('/api/pulse/groups/:id', ...auth, sameOriginJson(config), express.json({ limit: '20kb', strict: true }), async (req, res) => {
    if (!available(res)) return;
    if (!validId(req.params.id)) return res.status(400).json({ error: 'Group ID is invalid.' });
    const changes = validatePatch(req.body);
    if (!changes) return res.status(400).json({ error: 'Group settings are invalid.' });
    try {
      const row = await groupsStore.updateGroup(req.session.stemmaUser.subject, req.params.id, changes);
      if (!row) return res.status(404).json({ error: 'Group not found.' });
      const group = safeGroup(row);
      return group ? res.json({ group }) : res.status(503).json({ error: 'Groups service is unavailable.' });
    } catch (error) {
      if (error?.code === '23505') return res.status(409).json({ error: 'That group URL is already in use.' });
      return res.status(503).json({ error: 'Groups service is unavailable.' });
    }
  });
  app.get('/api/pulse/groups/:id/messages', ...auth, async (req, res) => {
    if (!available(res)) return;
    if (!validId(req.params.id)) return res.status(400).json({ error: 'Group ID is invalid.' });
    const before = parseBefore(req.query.before);
    if (before === undefined) return res.status(400).json({ error: 'Message cursor is invalid.' });
    try {
      const rows = await groupsStore.listMessages(req.session.stemmaUser.subject, req.params.id, before, PAGE_SIZE + 1);
      const messages = (rows || []).filter(row => row && validId(row.id) && typeof row.text === 'string' && safeDate(row.createdAt));
      const hasMore = messages.length > PAGE_SIZE;
      return res.json({ messages: messages.slice(0, PAGE_SIZE).map(row => ({
        id: row.id, text: row.text, createdAt: safeDate(row.createdAt), mine: row.authorSubject === req.session.stemmaUser.subject,
        author: { username: typeof row.username === 'string' ? row.username : '', nickName: typeof row.nickName === 'string' ? row.nickName : '' }
      })), hasMore });
    } catch { return res.status(503).json({ error: 'Groups service is unavailable.' }); }
  });
  app.post('/api/pulse/groups/:id/messages', ...auth, sameOriginJson(config), express.json({ limit: '20kb', strict: true }), async (req, res) => {
    if (!available(res)) return;
    if (!validId(req.params.id)) return res.status(400).json({ error: 'Group ID is invalid.' });
    const text = validateMessage(req.body);
    if (!text) return res.status(400).json({ error: 'Message must be nonblank text of at most 4000 characters.' });
    try {
      const row = await groupsStore.sendMessage(req.session.stemmaUser.subject, req.params.id, text);
      if (!row) return res.status(404).json({ error: 'Group not found.' });
      if (!validId(row.id) || typeof row.text !== 'string' || !safeDate(row.createdAt)) return res.status(503).json({ error: 'Groups service is unavailable.' });
      return res.status(201).json({ message: { id: row.id, text: row.text, createdAt: safeDate(row.createdAt), mine: row.authorSubject === req.session.stemmaUser.subject,
        author: { username: typeof row.username === 'string' ? row.username : '', nickName: typeof row.nickName === 'string' ? row.nickName : '' } } });
    } catch { return res.status(503).json({ error: 'Groups service is unavailable.' }); }
  });
}

export const createGroupStore = createGroupsStore;
export { registerGroupsApi, validSlug as isValidGroupSlug, RESERVED_SLUGS as RESERVED_GROUP_SLUGS };
