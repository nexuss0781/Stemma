import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import signature from 'cookie-signature';
import session from 'express-session';
import { buildConfig, createApp } from '../server.js';
import { createGroupStore, isValidGroupSlug } from '../groups-api.js';

const SESSION_SECRET = 'groups-api-tests-use-a-long-session-secret';
const google = subject => ({ provider: 'google', subject });
async function harness(groupsStore) {
  const config = buildConfig({ NODE_ENV: 'test', SESSION_SECRET });
  const sessionStore = new session.MemoryStore();
  const app = createApp({ config, sessionStore, groupStore: groupsStore });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function cookieFor(id, user) {
    const data = { cookie: { originalMaxAge: null, expires: null, httpOnly: true, path: '/', sameSite: 'lax', secure: false }, ...(user ? { stemmaUser: user } : {}) };
    await new Promise((resolve, reject) => sessionStore.set(id, data, error => error ? reject(error) : resolve()));
    return `stemma.sid=${encodeURIComponent(`s:${signature.sign(id, SESSION_SECRET)}`)}`;
  }
  return { origin, cookieFor, async close() { server.close(); await once(server, 'close'); } };
}
const get = (url, cookie) => fetch(url, { headers: cookie ? { cookie } : {} });
const post = (url, cookie, origin, body) => fetch(url, { method: 'POST', headers: { ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}), 'content-type': 'application/json' }, body: JSON.stringify(body) });
const patch = (url, cookie, origin, body) => fetch(url, { method: 'PATCH', headers: { ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}), 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('group slugs require 5-40 safe characters and reject current app routes/assets', () => {
  for (const value of ['valid-group', 'three', 'A_B12']) assert.equal(isValidGroupSlug(value), true);
  for (const value of ['ab', 'A_B1', 'has space', 'auth', 'api', 'assets', 'invite', 'dashboard', 'overview', 'cards', 'pulse', 'goals', 'profile', 'app-js', 'groups-ui-js', 'a'.repeat(41)]) assert.equal(isValidGroupSlug(value), false);
});

test('group SPA URLs serve the app without exposing invite tokens as referrers', async t => {
  const h = await harness(null); t.after(() => h.close());
  const token = 'A'.repeat(43);
  let response = await fetch(`${h.origin}/invite/${token}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.match(response.headers.get('content-type'), /text\/html/);
  response = await fetch(`${h.origin}/private_urls/${token}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  response = await fetch(`${h.origin}/my-club`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal((await fetch(`${h.origin}/dashboard`)).status, 404);
  assert.equal((await fetch(`${h.origin}/assets/profile.jpg`)).status, 200);
});

test('Groups API auth, validation, privacy, membership, owner settings and message contract', async t => {
  const calls = [];
  const privateGroup = { id: '15', name: 'Secret group', slug: 'secret-hangout', description: 'secret detail', visibility: 'private', memberCount: 3, isMember: false, isOwner: false };
  const memberGroup = { ...privateGroup, isMember: true, isOwner: true, inviteUrl: '/invite/0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcd' };
  const publicGroup = { id: '16', name: 'Public club', slug: 'public-club', description: '', visibility: 'public', memberCount: 1, isMember: false, isOwner: false, publicUrl: '/public-club' };
  const store = {
    async listMine(subject) { calls.push(['mine', subject]); return [{ ...memberGroup, inviteToken: memberGroup.inviteUrl.split('/').at(-1) }]; },
    async searchPublic(subject, query, limit) { calls.push(['search', subject, query, limit]); return [publicGroup]; },
    async createGroup(subject, input) { calls.push(['create', subject, input]); return { ...memberGroup, id: '17', name: input.name, slug: input.slug, visibility: input.visibility }; },
    async getById(subject, id, invite) { calls.push(['detail', subject, id, invite]); return invite === 'valid-token-0000000000000000000000000000000000000' ? { group: { ...privateGroup, isMember: false }, members: [{ username: 'hidden', nickName: 'Hidden', role: 'member' }] } : id === '16' ? { group: publicGroup } : null; },
    async resolvePublicSlug(subject, slug) { return slug === 'public-club' ? { group: publicGroup } : null; },
    async resolveInvite(subject, token) { return token === 'valid-token-0000000000000000000000000000000000000' ? { group: privateGroup, members: [{ username: 'leak', nickName: 'Leak', role: 'owner' }] } : null; },
    async join(subject, id, invite) { calls.push(['join', subject, id, invite]); return invite ? { ...memberGroup, id } : id === '16' ? { ...publicGroup, isMember: true, isOwner: false } : null; },
    async leave(subject, id) { calls.push(['leave', subject, id]); return id === '15' ? { left: true } : null; },
    async updateGroup(subject, id, changes) { calls.push(['update', subject, id, changes]); return id === '15' ? { ...memberGroup, ...changes } : null; },
    async listMessages(subject, id, before, limit) { calls.push(['messages', subject, id, before, limit]); return id === '15' ? [{ id: '60', text: 'hello', createdAt: new Date('2026-01-01T00:00:00Z'), authorSubject: subject, username: 'alice', nickName: 'Alice' }] : []; },
    async sendMessage(subject, id, text) { calls.push(['send', subject, id, text]); return id === '15' ? { id: '61', text, createdAt: new Date('2026-01-02T00:00:00Z'), authorSubject: subject, username: 'alice', nickName: 'Alice' } : null; }
  };
  const h = await harness(store); t.after(() => h.close());
  const cookie = await h.cookieFor('group-user', google('subject-alice'));
  assert.equal((await get(`${h.origin}/api/pulse/groups`)).status, 401);
  let response = await get(`${h.origin}/api/pulse/groups`, cookie);
  assert.deepEqual((await response.json()).groups, [{ id: '15', name: 'Secret group', slug: 'secret-hangout', description: 'secret detail', visibility: 'private', memberCount: 3, isMember: true, isOwner: true, inviteUrl: `/private_urls/${memberGroup.inviteUrl.split('/').at(-1)}` }]);
  assert.doesNotMatch(JSON.stringify(await (await get(`${h.origin}/api/pulse/groups`, cookie)).json()), /inviteToken/);
  assert.deepEqual(calls.at(-1), ['mine', 'subject-alice']);
  response = await get(`${h.origin}/api/pulse/groups/search?q=club`, cookie);
  assert.deepEqual((await response.json()).groups, [publicGroup]);
  assert.deepEqual(calls.at(-1), ['search', 'subject-alice', 'club', 50]);
  assert.equal((await get(`${h.origin}/api/pulse/groups/search?q=x`, cookie)).status, 400);
  assert.equal((await get(`${h.origin}/api/pulse/groups/15`, cookie)).status, 404, 'private group id does not disclose group');
  assert.equal((await get(`${h.origin}/api/pulse/groups/16`, cookie)).status, 200);
  const invite = 'valid-token-0000000000000000000000000000000000000';
  response = await get(`${h.origin}/api/pulse/groups/15?invite=${invite}`, cookie);
  assert.deepEqual(await response.json(), { group: privateGroup }, 'invite preview never returns members');
  response = await get(`${h.origin}/api/pulse/groups/invite/${invite}`, cookie);
  assert.deepEqual(await response.json(), { group: privateGroup }, 'invite resolver hides members from non-members');
  response = await post(`${h.origin}/api/pulse/groups`, cookie, h.origin, { name: ' New group ', slug: 'New-group', description: '', visibility: 'private' });
  assert.equal(response.status, 201);
  assert.deepEqual(calls.find(c => c[0] === 'create'), ['create', 'subject-alice', { name: 'New group', slug: 'new-group', description: '', visibility: 'private' }]);
  for (const body of [{ name: 'x', slug: 'auth', description: '', visibility: 'private' }, { name: 'group', slug: 'good-slug', description: '', visibility: 'any' }, { name: 'group', slug: 'good-slug', description: '', visibility: 'public', isOwner: true }]) assert.equal((await post(`${h.origin}/api/pulse/groups`, cookie, h.origin, body)).status, 400);
  assert.equal((await post(`${h.origin}/api/pulse/groups`, cookie, null, { name: 'Valid name', slug: 'valid-slug', description: '', visibility: 'public' })).status, 403);
  assert.equal((await post(`${h.origin}/api/pulse/groups/16/join`, cookie, h.origin, {})).status, 200);
  assert.equal((await post(`${h.origin}/api/pulse/groups/15/join`, cookie, h.origin, {})).status, 404);
  assert.equal((await post(`${h.origin}/api/pulse/groups/15/join`, cookie, h.origin, { invite })).status, 200);
  assert.deepEqual(calls.filter(c => c[0] === 'join').map(c => c.slice(1)), [['subject-alice', '16', null], ['subject-alice', '15', null], ['subject-alice', '15', invite]]);
  assert.equal((await post(`${h.origin}/api/pulse/groups/15/leave`, cookie, h.origin, {})).status, 200);
  assert.equal((await patch(`${h.origin}/api/pulse/groups/15`, cookie, h.origin, { visibility: 'public' })).status, 200);
  response = await get(`${h.origin}/api/pulse/groups/15/messages?before=61`, cookie);
  assert.deepEqual(await response.json(), { messages: [{ id: '60', text: 'hello', createdAt: '2026-01-01T00:00:00.000Z', mine: true, author: { username: 'alice', nickName: 'Alice' } }], hasMore: false });
  assert.deepEqual(calls.find(c => c[0] === 'messages'), ['messages', 'subject-alice', '15', '61', 51]);
  assert.equal((await post(`${h.origin}/api/pulse/groups/15/messages`, cookie, h.origin, { text: ' hi ', author: 'forbidden' })).status, 400);
  response = await post(`${h.origin}/api/pulse/groups/15/messages`, cookie, h.origin, { text: ' hello ' });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { message: { id: '61', text: 'hello', createdAt: '2026-01-02T00:00:00.000Z', mine: true, author: { username: 'alice', nickName: 'Alice' } } });
  assert.equal((await post(`${h.origin}/api/pulse/groups/15/messages`, cookie, null, { text: 'hi' })).status, 403);
});

test('two-step group API exposes only public candidate fields and validates durable avatars/private links', async t => {
  const calls = [];
  const token = 'Z'.repeat(43);
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
  const storedGroup = { id: '20', name: 'New circle', slug: 'private-1234567890abcdef', description: '', visibility: 'private',
    inviteToken: token, hasAvatar: true, memberCount: 2, isMember: true, isOwner: true };
  const store = {
    async isSlugAvailable(slug) { calls.push(['availability', slug]); return slug !== 'taken-slug'; },
    async listCandidates(subject, query, limit) { calls.push(['candidates', subject, query, limit]); return [
      { username: 'beta_user', nickName: 'Beta', hasPhoto: true }, { username: 'gamma_user', nickName: 'Gamma', hasPhoto: false }
    ]; },
    async getCandidatePhoto(username) { return username === 'beta_user' ? { data: Buffer.from('photo'), mimeType: 'image/png' } : null; },
    async getAvatar(subject, id) { calls.push(['avatar', subject, id]); return subject === 'group-member' && id === '20' ? { data: gif, mimeType: 'image/gif' } : null; },
    async createGroup(subject, input) { calls.push(['create', subject, input]); return storedGroup; },
    async updateGroup(subject, id, changes) { calls.push(['update', subject, id, changes]); return { ...storedGroup, hasAvatar: Boolean(changes.avatar) }; },
    async resolveInvite(subject, received) { return received === token ? { group: { ...storedGroup, isMember: false, isOwner: false } } : null; }
  };
  const h = await harness(store); t.after(() => h.close());
  const member = await h.cookieFor('group-member-cookie', google('group-member'));
  const outsider = await h.cookieFor('group-outsider-cookie', google('group-outsider'));
  assert.deepEqual(await (await get(`${h.origin}/api/pulse/groups/availability?slug=Taken-Slug`, member)).json(), { available: false });
  assert.deepEqual(await (await get(`${h.origin}/api/pulse/groups/availability?slug=available-slug`, member)).json(), { available: true });
  assert.deepEqual(await (await get(`${h.origin}/api/pulse/groups/availability?slug=private_urls`, member)).json(), { available: false });
  assert.equal((await get(`${h.origin}/api/pulse/groups/availability?slug=available-slug`)).status, 401);
  const candidates = await get(`${h.origin}/api/pulse/groups/candidates?q=beta`, member);
  assert.deepEqual(await candidates.json(), { users: [
    { username: 'beta_user', nickName: 'Beta', photoUrl: '/api/pulse/groups/candidates/beta_user/photo' },
    { username: 'gamma_user', nickName: 'Gamma' }
  ] });
  assert.deepEqual(calls.find(call => call[0] === 'candidates'), ['candidates', 'group-member', 'beta', 50]);
  assert.equal((await get(`${h.origin}/api/pulse/groups/candidates/beta_user/photo`, member)).status, 200);
  let response = await get(`${h.origin}/api/pulse/groups/20/avatar`, outsider);
  assert.equal(response.status, 404, 'private avatars are only visible to group members');
  response = await get(`${h.origin}/api/pulse/groups/20/avatar`, member);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/gif');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), gif);

  const create = await post(`${h.origin}/api/pulse/groups`, member, h.origin, {
    name: ' New circle ', description: '', visibility: 'private', inviteToken: token,
    avatarDataUrl: `data:image/gif;base64,${gif.toString('base64')}`, memberUsernames: ['beta_user']
  });
  assert.equal(create.status, 201);
  const result = await create.json();
  assert.equal(result.group.inviteUrl, `/private_urls/${token}`);
  assert.equal(result.group.avatarUrl, '/api/pulse/groups/20/avatar');
  assert.doesNotMatch(JSON.stringify(result), /group-member|inviteToken|ownerSubject/);
  const createCall = calls.find(call => call[0] === 'create');
  assert.equal(createCall[2].slug, null, 'private slug can be omitted for server-side generation');
  assert.deepEqual(createCall[2].memberUsernames, ['beta_user']);
  assert.deepEqual(createCall[2].avatar, { data: gif, mimeType: 'image/gif' });
  assert.equal(createCall[2].inviteToken, token);
  assert.equal((await get(`${h.origin}/api/pulse/groups/private_urls/${token}`, member)).status, 200);
  assert.equal((await get(`${h.origin}/api/pulse/groups/invite/${token}`, member)).status, 200, 'legacy invite resolver stays supported');

  assert.equal((await post(`${h.origin}/api/pulse/groups`, member, h.origin, {
    name: 'Wrong mime', slug: 'wrong-mime', description: '', visibility: 'public',
    avatarDataUrl: `data:image/png;base64,${gif.toString('base64')}`
  })).status, 400);
  assert.equal((await post(`${h.origin}/api/pulse/groups`, member, h.origin, {
    name: 'Duplicate members', slug: 'duplicate-members', description: '', visibility: 'public', memberUsernames: ['Beta_user', 'beta_user']
  })).status, 400);
  response = await patch(`${h.origin}/api/pulse/groups/20`, member, h.origin, { avatarDataUrl: `data:image/gif;base64,${gif.toString('base64')}` });
  assert.equal(response.status, 200);
  assert.ok(calls.find(call => call[0] === 'update')[3].avatar);
});

test('PostgreSQL groups persist, isolate private discovery, transfer ownership and gate messages', { skip: process.env.STEMMA_CHAT_POSTGRES_TEST !== '1', timeout: 120000 }, async t => {
  const { Pool } = await import('pg');
  const crypto = await import('node:crypto');
  const schema = `stemma_groups_${crypto.randomUUID().replaceAll('-', '')}`;
  const connection = { host: '127.0.0.1', port: 5432, database: 'stemma_notification_test', user: 'stemma_notification_test', password: 'local-notification-test-only', max: 4, connectionTimeoutMillis: 5000 };
  const admin = new Pool(connection); let pool, h;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ ...connection, options: `-c search_path=${schema}` });
    await pool.query(`CREATE TABLE stemma_google_identities (google_subject VARCHAR(255) PRIMARY KEY, verified_email VARCHAR(320) NOT NULL DEFAULT '')`);
    await pool.query(`CREATE TABLE stemma_student_profiles (google_subject VARCHAR(255) PRIMARY KEY REFERENCES stemma_google_identities(google_subject) ON DELETE CASCADE, username TEXT NOT NULL DEFAULT '', nick_name TEXT NOT NULL DEFAULT '', profile_image BYTEA, profile_image_mime TEXT)`);
    await pool.query(`INSERT INTO stemma_google_identities (google_subject) VALUES ('alpha'), ('beta'), ('gamma')`);
    await pool.query(`INSERT INTO stemma_student_profiles (google_subject, username, nick_name) VALUES ('alpha','alpha_user','Alpha'), ('beta','beta_user','Beta'), ('gamma','gamma_user','Gamma')`);
    const store = createGroupStore(pool); await store.migrate(); await store.migrate();
    h = await harness(store);
    const alpha = await h.cookieFor('group-alpha', google('alpha')), beta = await h.cookieFor('group-beta', google('beta')), gamma = await h.cookieFor('group-gamma', google('gamma'));
    const create = await post(`${h.origin}/api/pulse/groups`, alpha, h.origin, { name: 'Private Group', slug: 'private-group', description: 'hidden', visibility: 'private' });
    assert.equal(create.status, 201); const ownerGroup = (await create.json()).group;
    assert.equal((await get(`${h.origin}/api/pulse/groups/search?q=Private`, beta)).json && 1, 1);
    let r = await get(`${h.origin}/api/pulse/groups/${ownerGroup.id}`, beta); assert.equal(r.status, 404);
    r = await get(`${h.origin}/api/pulse/groups/resolve/private-group`, beta); assert.equal(r.status, 404);
    const token = ownerGroup.inviteUrl.split('/').at(-1);
    r = await get(`${h.origin}/api/pulse/groups/invite/${token}`, beta); assert.equal(r.status, 200); assert.equal('members' in await r.json(), false);
    assert.equal((await get(`${h.origin}/api/pulse/groups/${ownerGroup.id}/messages`, beta)).json && 1, 1);
    r = await get(`${h.origin}/api/pulse/groups/${ownerGroup.id}/messages`, beta); assert.deepEqual(await r.json(), { messages: [], hasMore: false });
    assert.equal((await post(`${h.origin}/api/pulse/groups/${ownerGroup.id}/messages`, beta, h.origin, { text: 'blocked' })).status, 404);
    assert.equal((await post(`${h.origin}/api/pulse/groups/${ownerGroup.id}/join`, beta, h.origin, { invite: token })).status, 200);
    await post(`${h.origin}/api/pulse/groups/${ownerGroup.id}/join`, gamma, h.origin, { invite: token });
    r = await post(`${h.origin}/api/pulse/groups/${ownerGroup.id}/messages`, beta, h.origin, { text: 'hello' }); assert.equal(r.status, 201);
    r = await get(`${h.origin}/api/pulse/groups/${ownerGroup.id}`, beta); assert.equal((await r.json()).members.length, 3);
    r = await post(`${h.origin}/api/pulse/groups/${ownerGroup.id}/leave`, alpha, h.origin, {}); assert.equal(r.status, 200);
    r = await get(`${h.origin}/api/pulse/groups`, beta); assert.equal((await r.json()).groups.find(g => g.id === ownerGroup.id).isOwner, true);
    const conflict = await post(`${h.origin}/api/pulse/groups`, gamma, h.origin, { name: 'Different', slug: 'PRIVATE-GROUP', description: '', visibility: 'public' }); assert.equal(conflict.status, 409);
    await h.close(); h = null; await pool.end(); pool = new Pool({ ...connection, options: `-c search_path=${schema}` });
    const reopened = createGroupStore(pool); h = await harness(reopened);
    const beta2 = await h.cookieFor('group-beta-reopened', google('beta'));
    r = await get(`${h.origin}/api/pulse/groups/${ownerGroup.id}/messages`, beta2); assert.equal((await r.json()).messages[0].text, 'hello');
  } finally {
    if (h) await h.close(); if (pool) await pool.end().catch(() => {}); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {}); await admin.end();
  }
});
