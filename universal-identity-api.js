import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const USERNAME_RE = /^[a-z0-9_.-]{5,40}$/i;

export function createUniversalIdentityStore(pool) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('A PostgreSQL pool is required.');
  return {
    async getBySubject(subject) {
      const result = await pool.query(`SELECT identity_id::text AS "identityId", username
        FROM stemma_universal_identities WHERE entity_type = 'account' AND entity_key = $1 LIMIT 1`, [subject]);
      return result.rows[0] ?? null;
    },
    async migrate() {
      const migration = await fs.readFile(path.join(ROOT, 'migrations', '021_universal_identity.sql'), 'utf8');
      const registry = JSON.parse(await fs.readFile(path.join(ROOT, 'system-apps', 'apps.json'), 'utf8'));
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(hashtext('stemma-universal-identity-021'))");
        await client.query(migration);
        for (const app of registry.apps || []) {
          const username = String(app.id || '').toLowerCase();
          if (!USERNAME_RE.test(username)) throw new Error(`System app registry id is not a valid universal username: ${username}`);
          const collision = await client.query(`SELECT entity_type, entity_key, username FROM stemma_universal_identities
            WHERE lower(username) = lower($1) AND NOT (entity_type = 'system_app' AND entity_key = $1) LIMIT 1`, [username]);
          if (collision.rows[0]) throw new Error(`Universal identity migration conflict: system app @${username} conflicts with ${collision.rows[0].entity_type} ${collision.rows[0].entity_key}; no identities were changed.`);
          await client.query(`INSERT INTO stemma_universal_identities (entity_type, entity_key, username, display_name)
            VALUES ('system_app', $1, $1, $2) ON CONFLICT (entity_type, entity_key) DO UPDATE SET display_name = EXCLUDED.display_name`, [username, app.name || username]);
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally { client.release(); }
    },
    async getByIdentifier(identifier) {
      const byUuid = UUID_RE.test(identifier);
      const result = await pool.query(`SELECT u.identity_id::text AS "identityId", u.identity_id::text AS id,
          u.username, u.entity_type AS kind, u.display_name AS "displayName", u.entity_key AS "entityKey",
          CASE WHEN u.entity_type = 'group' THEN g.visibility = 'public'
               WHEN u.entity_type = 'account' THEN a.google_subject IS NOT NULL ELSE true END AS visible
        FROM stemma_universal_identities u
        LEFT JOIN stemma_groups g ON u.entity_type = 'group' AND g.id::text = u.entity_key
        LEFT JOIN stemma_google_identities a ON u.entity_type = 'account' AND a.google_subject = u.entity_key
        WHERE ${byUuid ? 'u.identity_id = $1::uuid' : 'lower(u.username) = lower($1)'} LIMIT 1`, [identifier]);
      const row = result.rows[0];
      if (!row || !row.visible) return null;
      if (row.kind === 'account') {
        const profile = await pool.query(`SELECT nick_name FROM stemma_student_profiles WHERE google_subject = $1 LIMIT 1`, [row.entityKey]);
        if (profile.rows[0]?.nick_name?.trim()) row.displayName = profile.rows[0].nick_name.trim();
      }
      if (row.kind === 'group') {
        const group = await pool.query(`SELECT id::text AS "legacyId", name, description, visibility FROM stemma_groups WHERE id::text = $1 AND visibility = 'public' LIMIT 1`, [row.entityKey]);
        if (!group.rows[0]) return null;
        row.legacyId = group.rows[0].legacyId; row.displayName = group.rows[0].name;
      }
      if (row.kind === 'channel') {
        const channel = await pool.query(`SELECT id::text AS "legacyId", name FROM stemma_pulse_channels WHERE id::text = $1 LIMIT 1`, [row.entityKey]);
        if (!channel.rows[0]) return null;
        row.legacyId = channel.rows[0].legacyId; row.displayName = channel.rows[0].name;
      }
      delete row.visible; delete row.entityKey;
      return row;
    },
    async isUsernameAvailable(username) {
      const result = await pool.query(`SELECT NOT EXISTS (SELECT 1 FROM stemma_universal_identities WHERE lower(username) = lower($1)) AS available`, [username]);
      return result.rows[0]?.available === true;
    }
  };
}

function noStore(res) { res.set({ 'Cache-Control': 'private, no-store, max-age=0', Pragma: 'no-cache', 'Referrer-Policy': 'no-referrer' }); }
export function registerUniversalIdentityApi(app, { identityStore, requireGoogleSession }) {
  app.get('/api/identity/availability', requireGoogleSession, async (req, res) => {
    noStore(res);
    const username = typeof req.query.username === 'string' ? req.query.username.trim() : '';
    if (!USERNAME_RE.test(username)) return res.json({ available: false });
    try { return res.json({ available: await identityStore.isUsernameAvailable(username) }); }
    catch { return res.status(503).json({ error: 'Identity service is unavailable.' }); }
  });
  app.get('/api/identity/resolve/:identifier', requireGoogleSession, async (req, res) => {
    noStore(res);
    const identifier = req.params.identifier;
    if (!(UUID_RE.test(identifier) || USERNAME_RE.test(identifier))) return res.status(400).json({ error: 'Identity is invalid.' });
    try {
      const identity = await identityStore.getByIdentifier(identifier);
      if (!identity) return res.status(404).json({ error: 'Identity not found.' });
      return res.json({ identity });
    } catch { return res.status(503).json({ error: 'Identity service is unavailable.' }); }
  });
}
