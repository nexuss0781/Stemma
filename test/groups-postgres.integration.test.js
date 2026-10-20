import assert from 'node:assert/strict';
import { once } from 'node:events';
import crypto from 'node:crypto';
import test from 'node:test';
import signature from 'cookie-signature';
import session from 'express-session';
import pg from 'pg';
import { buildConfig, createApp } from '../server.js';
import * as groupsApi from '../groups-api.js';
import { createPulseStore } from '../pulse-api.js';
import { createDirectChatStore } from '../direct-chat-api.js';

const SESSION_SECRET = 'groups-postgres-integration-test-session-secret';
const google = subject => ({ provider: 'google', subject });
const postJson = (url, cookie, origin, body) => fetch(url, {
  method: 'POST',
  headers: { ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}), 'content-type': 'application/json' },
  body: JSON.stringify(body)
});
const patchJson = (url, cookie, origin, body) => fetch(url, {
  method: 'PATCH',
  headers: { ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}), 'content-type': 'application/json' },
  body: JSON.stringify(body)
});

async function createHarness({ groupsStore, pulseStore, directChatStore }) {
  const config = buildConfig({ NODE_ENV: 'test', SESSION_SECRET });
  const sessionStore = new session.MemoryStore();
  const app = createApp({ config, sessionStore, groupStore: groupsStore, groupsStore, pulseStore, directChatStore });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function cookieFor(id, user) {
    const data = {
      cookie: { originalMaxAge: null, expires: null, httpOnly: true, path: '/', sameSite: 'lax', secure: false },
      stemmaUser: user
    };
    await new Promise((resolve, reject) => sessionStore.set(id, data, error => error ? reject(error) : resolve()));
    return `stemma.sid=${encodeURIComponent(`s:${signature.sign(id, SESSION_SECRET)}`)}`;
  }
  return {
    origin,
    cookieFor,
    async close() {
      if (!server.listening) return;
      server.close();
      await once(server, 'close');
    }
  };
}

test('PostgreSQL Groups privacy, membership, messaging, settings and legacy Pulse routes', {
  skip: process.env.STEMMA_GROUPS_DB_TEST !== '1',
  timeout: 120000
}, async () => {
  const { Pool } = pg;
  const schema = `stemma_groups_it_${crypto.randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^stemma_groups_it_[a-f0-9]{32}$/);
  const connection = {
    host: '127.0.0.1', port: 5432, database: 'stemma_notification_test',
    user: 'stemma_notification_test', password: 'local-notification-test-only',
    max: 5, connectionTimeoutMillis: 5000
  };
  const admin = new Pool(connection);
  let pool;
  let harness;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = { ...connection, options: `-c search_path=${schema}` };
    pool = new Pool(scoped);
    await pool.query(`CREATE TABLE stemma_google_identities (
      google_subject VARCHAR(255) PRIMARY KEY,
      verified_email VARCHAR(320) NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    await pool.query(`CREATE TABLE stemma_student_profiles (
      google_subject VARCHAR(255) PRIMARY KEY REFERENCES stemma_google_identities(google_subject) ON DELETE CASCADE,
      first_name VARCHAR(80) NOT NULL DEFAULT 'Synthetic', middle_name VARCHAR(80) NOT NULL DEFAULT '',
      last_name VARCHAR(80) NOT NULL DEFAULT 'Tester', student_id VARCHAR(64) NOT NULL DEFAULT 'groups-it',
      department VARCHAR(100) NOT NULL DEFAULT 'integration-test', nick_name TEXT NOT NULL DEFAULT '', username TEXT NOT NULL DEFAULT '',
      profile_image BYTEA, profile_image_mime TEXT
    )`);
    const subjects = ['groups-it-owner', 'groups-it-member', 'groups-it-outsider'];
    await pool.query('INSERT INTO stemma_google_identities (google_subject) SELECT unnest($1::text[])', [subjects]);
    await pool.query(`INSERT INTO stemma_student_profiles (google_subject, username, nick_name) VALUES
      ('groups-it-owner', 'owner_user', 'Owner One'),
      ('groups-it-member', 'member_user', 'Member Two'),
      ('groups-it-outsider', 'outsider_user', 'Outsider Three')`);
    await pool.query(`UPDATE stemma_student_profiles SET profile_image = $1, profile_image_mime = 'image/png' WHERE username = 'outsider_user'`, [Buffer.from('stored profile photo')]);

    const createStore = groupsApi.createGroupStore ?? groupsApi.createGroupsStore;
    assert.equal(typeof createStore, 'function', 'groups API exports a PostgreSQL store factory');
    const groupsStore = createStore(pool);
    const pulseStore = createPulseStore(pool);
    const directChatStore = createDirectChatStore(pool);
    await groupsStore.migrate();
    await groupsStore.migrate();
    await pulseStore.migrate();
    await directChatStore.migrate();
    harness = await createHarness({ groupsStore, pulseStore, directChatStore });
    const [owner, member, outsider] = await Promise.all(subjects.map((subject, index) =>
      harness.cookieFor(`groups-it-session-${index}`, google(subject))));
    const { origin } = harness;
    const get = (path, cookie) => fetch(`${origin}${path}`, { headers: { cookie } });
    const createGroup = (cookie, body, requestOrigin = origin) => postJson(`${origin}/api/pulse/groups`, cookie, requestOrigin, body);
    const join = (id, cookie, invite) => postJson(`${origin}/api/pulse/groups/${id}/join`, cookie, origin, invite ? { invite } : {});
    const sendGroup = (id, cookie, text) => postJson(`${origin}/api/pulse/groups/${id}/messages`, cookie, origin, { text });

    assert.equal((await get('/api/pulse/groups', owner)).status, 200);
    assert.deepEqual(await (await get('/api/pulse/groups/availability?slug=free-slug', owner)).json(), { available: true });
    assert.deepEqual(await (await get('/api/pulse/groups/availability?slug=private_urls', owner)).json(), { available: false });
    const candidateList = await get('/api/pulse/groups/candidates', owner);
    const candidates = await candidateList.json();
    assert.deepEqual(candidates.users.map(user => user.username), ['member_user', 'outsider_user']);
    assert.equal(candidates.users.find(user => user.username === 'outsider_user').photoUrl, '/api/pulse/groups/candidates/outsider_user/photo');
    const outsiderPhoto = await get('/api/pulse/groups/candidates/outsider_user/photo', owner);
    assert.equal(outsiderPhoto.status, 200);
    assert.equal((await outsiderPhoto.arrayBuffer()).byteLength, Buffer.byteLength('stored profile photo'));

    const avatarBytes = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
    const preselectedToken = 'K'.repeat(43);
    const twoStepResponse = await createGroup(owner, { name: 'Two Step Circle', description: '', visibility: 'private',
      inviteToken: preselectedToken, memberUsernames: ['outsider_user'], avatarDataUrl: `data:image/gif;base64,${avatarBytes.toString('base64')}` });
    assert.equal(twoStepResponse.status, 201);
    const twoStepGroup = (await twoStepResponse.json()).group;
    assert.equal(twoStepGroup.inviteUrl, `/private_urls/${preselectedToken}`);
    assert.equal(twoStepGroup.avatarUrl, `/api/pulse/groups/${twoStepGroup.id}/avatar`);
    const persistedDetails = await (await get(`/api/pulse/groups/${twoStepGroup.id}`, owner)).json();
    assert.equal(persistedDetails.group.avatarUrl, twoStepGroup.avatarUrl, 'durable avatar URL survives detail serialization');
    assert.equal(persistedDetails.group.inviteUrl, twoStepGroup.inviteUrl, 'generated private URL survives detail serialization');
    assert.ok(twoStepGroup.slug.startsWith('private-'), 'private group slug is generated when omitted');
    assert.equal(twoStepGroup.memberCount, 2, 'owner and selected existing user are added within creation transaction');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM stemma_groups_memberships WHERE group_id=$1::bigint', [twoStepGroup.id])).rows[0].n, 2);
    assert.equal((await get(`/api/pulse/groups/${twoStepGroup.id}/avatar`, member)).status, 404, 'private avatar denies nonmembers');
    const groupAvatar = await get(`/api/pulse/groups/${twoStepGroup.id}/avatar`, owner);
    assert.equal(groupAvatar.status, 200);
    assert.equal(groupAvatar.headers.get('content-type'), 'image/gif');
    assert.deepEqual(Buffer.from(await groupAvatar.arrayBuffer()), avatarBytes);
    assert.equal((await get(`/api/pulse/groups/private_urls/${preselectedToken}`, member)).status, 200);
    assert.equal((await get(`/api/pulse/groups/invite/${preselectedToken}`, member)).status, 200, 'legacy invitation resolver still works');
    assert.equal((await patchJson(`${origin}/api/pulse/groups/${twoStepGroup.id}`, owner, origin,
      { avatarDataUrl: `data:image/gif;base64,${avatarBytes.toString('base64')}` })).status, 200, 'owner can replace avatar through settings PATCH');
    const groupsBeforeInvalid = (await pool.query('SELECT count(*)::int AS n FROM stemma_groups')).rows[0].n;
    const membershipsBeforeInvalid = (await pool.query('SELECT count(*)::int AS n FROM stemma_groups_memberships')).rows[0].n;
    const invalidSelection = await createGroup(owner, { name: 'Atomic Failure', slug: 'atomic-failure', description: '', visibility: 'private', memberUsernames: ['missing_user'] });
    assert.equal(invalidSelection.status, 400, 'invalid selected usernames fail cleanly');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM stemma_groups')).rows[0].n, groupsBeforeInvalid,
      'invalid selection leaves no partial group');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM stemma_groups_memberships')).rows[0].n, membershipsBeforeInvalid,
      'invalid selection rolls back owner membership and group insert atomically');
    const publicCreate = await createGroup(owner, { name: 'Open Study Circle', slug: 'study-circle', description: 'Public study group', visibility: 'public' });
    assert.equal(publicCreate.status, 201);
    const publicGroup = (await publicCreate.json()).group;
    assert.equal(publicGroup.visibility, 'public');
    assert.equal(publicGroup.isOwner, true);
    assert.equal(publicGroup.publicUrl, '/study-circle');
    assert.deepEqual(await (await get('/api/pulse/groups/availability?slug=STUDY-CIRCLE', owner)).json(), { available: false });

    const privateCreate = await createGroup(owner, { name: 'Private Book Circle', slug: 'book-circle', description: 'Invitation only', visibility: 'private' });
    assert.equal(privateCreate.status, 201);
    const privateGroup = (await privateCreate.json()).group;
    assert.equal(privateGroup.visibility, 'private');
    assert.equal(privateGroup.isOwner, true);
    assert.ok(privateGroup.inviteUrl);
    const inviteToken = privateGroup.inviteUrl.split('/').at(-1);
    const ownerCreatedPrivateDetail = await get(`/api/pulse/groups/${privateGroup.id}`, owner);
    assert.equal(ownerCreatedPrivateDetail.status, 200);
    assert.equal((await ownerCreatedPrivateDetail.json()).group.inviteUrl, privateGroup.inviteUrl,
      'private detail preserves the invite URL returned at creation for its owner');

    let response = await get('/api/pulse/groups/search?q=Circle', outsider);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).groups.map(group => group.slug), ['study-circle'], 'public-name search never discovers private groups');
    response = await get('/api/pulse/groups/resolve/study-circle', outsider);
    assert.equal(response.status, 200, 'public slug resolver finds public groups');
    assert.equal((await response.json()).group.id, publicGroup.id);
    assert.equal((await get('/api/pulse/groups/resolve/book-circle', outsider)).status, 404, 'private slug resolver hides private groups');
    assert.equal((await get(`/api/pulse/groups/${privateGroup.id}`, outsider)).status, 404, 'private ID is unavailable to nonmembers');
    assert.equal((await get(`/api/pulse/groups/invite/${'x'.repeat(43)}`, outsider)).status, 404, 'unknown invite token is denied');
    response = await get(`/api/pulse/groups/invite/${inviteToken}`, outsider);
    assert.equal(response.status, 200, 'a valid invitation resolves a private group');
    assert.equal((await response.json()).group.id, privateGroup.id);
    assert.equal('members' in await (await get(`/api/pulse/groups/invite/${inviteToken}`, outsider)).json(), false, 'invite preview does not disclose member identities');
    response = await get(`/api/pulse/groups/${privateGroup.id}?invite=${inviteToken}`, outsider);
    assert.equal(response.status, 200, 'a valid invite token also authorizes private ID preview');
    assert.equal((await response.json()).group.id, privateGroup.id);

    assert.equal((await createGroup(owner, { name: 'Reserved', slug: 'groups-ui', description: '', visibility: 'public' })).status, 400, 'reserved route slugs are rejected');
    assert.equal((await createGroup(owner, { name: 'Invalid', slug: 'ab', description: '', visibility: 'public' })).status, 400, 'malformed slugs are rejected');
    assert.equal((await createGroup(owner, { name: 'Slug collision', slug: 'STUDY-CIRCLE', description: '', visibility: 'private' })).status, 409, 'slugs are unique case-insensitively');
    assert.equal((await createGroup(owner, { name: 'CSRF rejected', slug: 'csrf-rejected', description: '', visibility: 'public' }, null)).status, 403, 'state-changing group requests require same-origin verification');

    assert.equal((await join(publicGroup.id, member)).status, 200);
    assert.equal((await join(publicGroup.id, member)).status, 200, 'joining twice is idempotent');
    let memberDetail = await get(`/api/pulse/groups/${publicGroup.id}`, member);
    assert.equal((await memberDetail.json()).group.memberCount, 2);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM stemma_groups_memberships WHERE group_id=$1::bigint AND member_subject=$2', [publicGroup.id, subjects[1]])).rows[0].n, 1, 'idempotent join creates one membership');

    response = await sendGroup(publicGroup.id, owner, 'Hello from owner');
    assert.equal(response.status, 201);
    const ownerMessage = (await response.json()).message;
    assert.equal(ownerMessage.author.username, 'owner_user');
    assert.equal(ownerMessage.author.nickName, 'Owner One');
    response = await sendGroup(publicGroup.id, member, 'Hello from member');
    assert.equal(response.status, 201);
    const memberMessage = (await response.json()).message;
    assert.equal(memberMessage.author.username, 'member_user');
    assert.equal(memberMessage.author.nickName, 'Member Two');
    assert.equal((await sendGroup(publicGroup.id, outsider, 'Not a member')).status, 404, 'nonmembers cannot send to public groups');
    response = await get(`/api/pulse/groups/${publicGroup.id}/messages`, outsider);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).messages, [], 'public visibility does not grant access to message history');

    assert.equal((await patchJson(`${origin}/api/pulse/groups/${publicGroup.id}`, member, origin, { name: 'Unauthorized rename' })).status, 404, 'nonowners cannot change settings');
    response = await patchJson(`${origin}/api/pulse/groups/${publicGroup.id}`, owner, origin, { visibility: 'private' });
    assert.equal(response.status, 200, 'owner may change visibility');
    const nowPrivate = (await response.json()).group;
    assert.equal(nowPrivate.visibility, 'private');
    assert.ok(nowPrivate.inviteUrl);
    const transitionedInvite = nowPrivate.inviteUrl.split('/').at(-1);
    assert.equal((await get('/api/pulse/groups/resolve/study-circle', member)).status, 404, 'changing to private hides the old public slug route');
    assert.equal((await get(`/api/pulse/groups/${publicGroup.id}`, outsider)).status, 404);
    response = await get(`/api/pulse/groups/${publicGroup.id}/messages`, outsider);
    assert.deepEqual((await response.json()).messages, [], 'history remains member-only after privatization');
    assert.equal((await postJson(`${origin}/api/pulse/groups/${publicGroup.id}/leave`, member, origin, {})).status, 200);
    response = await get(`/api/pulse/groups/${publicGroup.id}/messages`, member);
    assert.deepEqual((await response.json()).messages, [], 'leaving immediately revokes read access');
    assert.equal((await sendGroup(publicGroup.id, member, 'After leaving')).status, 404, 'leaving immediately revokes send access');
    assert.equal((await join(publicGroup.id, member)).status, 404, 'private members cannot rejoin without an invitation');
    assert.equal((await join(publicGroup.id, member, transitionedInvite)).status, 200, 'private members can rejoin with the valid invitation');
    assert.equal((await join(publicGroup.id, member, transitionedInvite)).status, 200, 'private invite join remains idempotent');
    response = await get(`/api/pulse/groups/${publicGroup.id}`, owner);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).group.inviteUrl, nowPrivate.inviteUrl,
      'private detail preserves the invite URL returned by the owner settings update');
    response = await get(`/api/pulse/groups/${publicGroup.id}`, member);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).group.inviteUrl, nowPrivate.inviteUrl,
      'private member detail retains the owner-issued invite URL after joining');

    // Add enough persisted messages to cross the 50-row API page size without approaching its request rate limit.
    await pool.query(`INSERT INTO stemma_groups_messages (group_id, author_subject, text)
      SELECT $1::bigint, $2, 'page-seed-' || n FROM generate_series(1, 52) AS n`, [publicGroup.id, subjects[0]]);
    response = await get(`/api/pulse/groups/${publicGroup.id}/messages`, owner);
    const pageOne = await response.json();
    assert.equal(pageOne.messages.length, 50);
    assert.equal(pageOne.hasMore, true);
    assert.equal(pageOne.messages[0].text, 'page-seed-52');
    assert.deepEqual(pageOne.messages[0].author, { username: 'owner_user', nickName: 'Owner One' });
    response = await get(`/api/pulse/groups/${publicGroup.id}/messages?before=${pageOne.messages.at(-1).id}`, owner);
    const pageTwo = await response.json();
    assert.equal(pageTwo.messages.length, 4, 'cursor pagination returns only the remaining older rows');
    assert.equal(pageTwo.hasMore, false);
    assert.ok(pageOne.messages.every(message => !pageTwo.messages.some(older => older.id === message.id)), 'message pages do not overlap');
    assert.deepEqual(pageTwo.messages.map(message => message.text), ['page-seed-2', 'page-seed-1', 'Hello from member', 'Hello from owner']);

    const transferCreate = await createGroup(owner, { name: 'Ownership Transfer Group', slug: 'transfer-group', description: '', visibility: 'private' });
    assert.equal(transferCreate.status, 201);
    const transferGroup = (await transferCreate.json()).group;
    const transferToken = transferGroup.inviteUrl.split('/').at(-1);
    assert.equal((await join(transferGroup.id, member, transferToken)).status, 200);
    assert.equal((await join(transferGroup.id, outsider, transferToken)).status, 200);
    assert.equal((await postJson(`${origin}/api/pulse/groups/${transferGroup.id}/leave`, owner, origin, {})).status, 200);
    response = await get('/api/pulse/groups', member);
    const transferred = (await response.json()).groups.find(group => group.id === transferGroup.id);
    assert.equal(transferred.isOwner, true, 'when the owner leaves, earliest remaining member receives ownership');
    assert.equal((await patchJson(`${origin}/api/pulse/groups/${transferGroup.id}`, member, origin, { name: 'Transferred Ownership' })).status, 200);
    assert.equal((await patchJson(`${origin}/api/pulse/groups/${transferGroup.id}`, outsider, origin, { name: 'Not Owner' })).status, 404);

    // Legacy direct conversations and Saved Messages continue working against this same isolated database/schema.
    response = await postJson(`${origin}/api/pulse/conversations`, owner, origin, { username: 'member_user' });
    assert.equal(response.status, 201);
    const conversationId = (await response.json()).conversation.id;
    response = await postJson(`${origin}/api/pulse/conversations/${conversationId}/messages`, owner, origin, { text: 'Legacy direct message' });
    assert.equal(response.status, 201);
    response = await get(`/api/pulse/conversations/${conversationId}/messages`, member);
    assert.equal((await response.json()).messages[0].text, 'Legacy direct message');
    response = await postJson(`${origin}/api/pulse/saved`, owner, origin, { text: 'Legacy Saved Message' });
    assert.equal(response.status, 201);
    response = await get('/api/pulse/saved', owner);
    assert.equal((await response.json()).messages[0].text, 'Legacy Saved Message');
  } finally {
    if (harness) await harness.close();
    if (pool) await pool.end().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await admin.end();
  }
});
