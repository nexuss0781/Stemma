import assert from 'node:assert/strict';
import { once } from 'node:events';
import crypto from 'node:crypto';
import test from 'node:test';
import signature from 'cookie-signature';
import session from 'express-session';
import pg from 'pg';
import { buildConfig, createApp } from '../server.js';
import { createChannelStore } from '../channels-api.js';

const SESSION_SECRET = 'channels-postgres-integration-test-session-secret';
const google = subject => ({ provider: 'google', subject });

async function createHarness(channelStore) {
  const config = buildConfig({ NODE_ENV: 'test', SESSION_SECRET });
  const sessionStore = new session.MemoryStore();
  const app = createApp({ config, sessionStore, channelStore });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function cookieFor(id, user) {
    const data = { cookie: { originalMaxAge: null, expires: null, httpOnly: true, path: '/', sameSite: 'lax', secure: false }, stemmaUser: user };
    await new Promise((resolve, reject) => sessionStore.set(id, data, error => error ? reject(error) : resolve()));
    return `stemma.sid=${encodeURIComponent(`s:${signature.sign(id, SESSION_SECRET)}`)}`;
  }
  return { origin, cookieFor, async close() { if (server.listening) { server.close(); await once(server, 'close'); } } };
}
const postJson = (url, cookie, origin, body) => fetch(url, {
  method: 'POST', headers: { ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}), 'content-type': 'application/json' }, body: JSON.stringify(body)
});

test('PostgreSQL Channels owner-only posting, all-user reads, and paginated posts', {
  skip: process.env.STEMMA_CHANNELS_DB_TEST !== '1',
  timeout: 120000
}, async () => {
  const { Pool } = pg;
  const schema = `stemma_channels_it_${crypto.randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^stemma_channels_it_[a-f0-9]{32}$/);
  // This fixed local integration-test database is intentionally isolated from production; all mutations use a temporary schema.
  const connection = {
    host: '127.0.0.1', port: 5432, database: 'stemma_notification_test',
    user: 'stemma_notification_test', password: 'local-notification-test-only',
    max: 5, connectionTimeoutMillis: 5000
  };
  const admin = new Pool(connection);
  let pool;
  let harness;
  let schemaCreated = false;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    schemaCreated = true;
    pool = new Pool({ ...connection, options: `-c search_path=${schema}` });
    await pool.query(`CREATE TABLE stemma_google_identities (
      google_subject VARCHAR(255) PRIMARY KEY, verified_email VARCHAR(320) NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    await pool.query(`CREATE TABLE stemma_student_profiles (
      google_subject VARCHAR(255) PRIMARY KEY REFERENCES stemma_google_identities (google_subject),
      nick_name TEXT NOT NULL DEFAULT '', username TEXT NOT NULL DEFAULT ''
    )`);
    const subjects = ['channels-it-owner', 'channels-it-outsider'];
    await pool.query('INSERT INTO stemma_google_identities (google_subject) SELECT unnest($1::text[])', [subjects]);
    await pool.query(`INSERT INTO stemma_student_profiles (google_subject, nick_name, username)
      VALUES ('channels-it-owner', 'Channel Owner', 'owner.handle'), ('channels-it-outsider', '', 'outsider.handle')`);
    const channelStore = createChannelStore(pool);
    await channelStore.migrate();
    await channelStore.migrate();
    await pool.query(`CREATE TABLE stemma_pulse_attachments (
      id UUID PRIMARY KEY, channel_post_id BIGINT UNIQUE REFERENCES stemma_pulse_channel_posts (id) ON DELETE CASCADE,
      name TEXT NOT NULL, mime_type TEXT NOT NULL, byte_size INTEGER NOT NULL
    )`);
    harness = await createHarness(channelStore);
    const [owner, outsider] = await Promise.all(subjects.map((subject, index) => harness.cookieFor(`channels-it-session-${index}`, google(subject))));
    const { origin } = harness;
    const get = (path, cookie) => fetch(`${origin}${path}`, { headers: { cookie } });
    const create = body => postJson(`${origin}/api/pulse/channels`, owner, origin, body);

    const created = await create({ name: 'Integration Channel' });
    assert.equal(created.status, 201);
    const channel = (await created.json()).channel;
    assert.equal(channel.name, 'Integration Channel');
    assert.equal(channel.isOwner, true);
    assert.equal(channel.subscriberCount, 0, 'creating a channel does not fabricate a subscriber');
    assert.equal(channel.ownerName, 'Channel Owner');
    assert.equal(channel.avatarUrl, null, 'no channel avatar is fabricated');
    assert.equal('ownerSubject' in channel, false);
    const channelId = channel.id;

    let response = await get('/api/pulse/channels', outsider);
    assert.equal(response.status, 200);
    const listed = (await response.json()).channels;
    assert.equal(listed.some(item => item.id === channelId), true, 'all authenticated users can discover all channels');
    assert.equal(listed.find(item => item.id === channelId).isOwner, false);
    response = await get(`/api/pulse/channels/${channelId}`, outsider);
    assert.equal(response.status, 200, 'any authenticated user can read channel detail');
    assert.equal((await response.json()).channel.subscriberCount, 0);

    response = await postJson(`${origin}/api/pulse/channels/${channelId}/subscription`, outsider, origin, { subscribed: true });
    assert.equal(response.status, 200);
    let membership = (await response.json()).channel;
    assert.equal(membership.isSubscribed, true);
    assert.equal(membership.subscriberCount, 1);
    assert.equal(membership.muted, false);
    assert.equal((await (await get(`/api/pulse/channels/${channelId}`, owner)).json()).channel.isSubscribed, false,
      'subscription state is per authenticated subject');
    response = await postJson(`${origin}/api/pulse/channels/${channelId}/preferences`, outsider, origin, { muted: true });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).channel.muted, true, 'mute state is persisted in the subscriber row');
    assert.equal((await postJson(`${origin}/api/pulse/channels/${channelId}/preferences`, owner, origin, { muted: true })).status, 409,
      'preferences require an active subscription');

    response = await postJson(`${origin}/api/pulse/channels/${channelId}/posts`, outsider, origin, { text: 'Forbidden by API' });
    assert.equal(response.status, 403);
    assert.equal(await channelStore.createPost('channels-it-outsider', channelId, 'Forbidden by SQL'), null,
      'store INSERT predicate denies non-owner even when called outside the route');
    response = await postJson(`${origin}/api/pulse/channels/${channelId}/posts`, owner, origin, { text: 'Owner post' });
    assert.equal(response.status, 201);
    assert.deepEqual(Object.keys((await response.json()).post), ['id', 'text', 'createdAt']);
    const firstPostId = (await (await get(`/api/pulse/channels/${channelId}/posts`, outsider)).json()).posts[0].id;
    response = await postJson(`${origin}/api/pulse/channels/${channelId}/posts`, owner, origin, { text: 'Second owner post' });
    assert.equal(response.status, 201);
    const secondPostId = (await response.json()).post.id;
    response = await postJson(`${origin}/api/pulse/channels/${channelId}/read`, outsider, origin, { postId: secondPostId });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).lastReadPostId, secondPostId);
    response = await postJson(`${origin}/api/pulse/channels/${channelId}/read`, outsider, origin, { postId: firstPostId });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).lastReadPostId, secondPostId, 'read cursor cannot move backward');
    membership = (await (await get(`/api/pulse/channels/${channelId}`, outsider)).json()).channel;
    assert.equal(membership.lastReadPostId, secondPostId, 'read cursor persists in subscriber detail');
    assert.equal(membership.muted, true, 'mute preference persists independently of cursor updates');
    response = await postJson(`${origin}/api/pulse/channels/${channelId}/read`, owner, origin, { postId: secondPostId });
    assert.equal(response.status, 409, 'read cursors belong to subscribers');
    const otherChannel = (await (await create({ name: 'Other channel' })).json()).channel;
    assert.equal((await postJson(`${origin}/api/pulse/channels/${otherChannel.id}/read`, outsider, origin, { postId: secondPostId })).status, 404,
      'a cursor may only refer to a post belonging to that channel');

    assert.equal((await postJson(`${origin}/api/pulse/channels/${channelId}/pin`, outsider, origin, { postId: secondPostId })).status, 403);
    assert.equal(await channelStore.setPinnedPost('channels-it-outsider', channelId, secondPostId), false,
      'SQL predicate independently rejects non-owner pin attempts');
    assert.equal((await postJson(`${origin}/api/pulse/channels/${channelId}/pin`, owner, origin, { postId: '999999' })).status, 400);
    response = await postJson(`${origin}/api/pulse/channels/${channelId}/pin`, owner, origin, { postId: secondPostId });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).channel.pinnedPost.id, secondPostId, 'only a real channel post is serialized as pinned');
    response = await postJson(`${origin}/api/pulse/channels/${channelId}/pin`, owner, origin, { postId: null });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).channel.pinnedPost, null, 'pin can be cleared explicitly');

    response = await postJson(`${origin}/api/pulse/channels/${channelId}/subscription`, outsider, origin, { subscribed: false });
    assert.equal(response.status, 200);
    membership = (await response.json()).channel;
    assert.equal(membership.subscriberCount, 0);
    assert.equal(membership.isSubscribed, false);
    assert.equal(membership.muted, false);
    assert.equal(membership.lastReadPostId, null);
    assert.equal((await postJson(`${origin}/api/pulse/channels/${channelId}/subscription`, outsider, origin, { subscribed: false })).status, 200,
      'leave is safely repeatable');

    // Insert a controlled batch via the isolated test DB to exercise fixed-size keyset pagination.
    await pool.query(`INSERT INTO stemma_pulse_channel_posts (channel_id, text)
      SELECT $1::bigint, 'page fixture ' || n::text FROM generate_series(1, 52) n`, [channelId]);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM stemma_pulse_channel_posts WHERE channel_id = $1::bigint', [channelId])).rows[0].n, 54,
      'only the two owner posts and isolated test fixtures exist before pagination');
    response = await get(`/api/pulse/channels/${channelId}/posts`, outsider);
    assert.equal(response.status, 200);
    let page = await response.json();
    assert.equal(page.posts.length, 50);
    assert.equal(page.hasMore, true);
    assert.equal(page.nextBefore, page.posts.at(-1).id);
    assert.equal(page.posts[0].id, '54');
    assert.equal(page.posts.at(-1).id, '5');
    response = await get(`/api/pulse/channels/${channelId}/posts?before=${page.nextBefore}`, outsider);
    page = await response.json();
    assert.equal(page.posts.length, 4, 'remaining three fixture posts plus owner post are returned');
    assert.equal(page.hasMore, false);

    const persisted = await pool.query(`SELECT owner_subject FROM stemma_pulse_channels WHERE id = $1::bigint`, [channelId]);
    assert.equal(persisted.rows[0].owner_subject, 'channels-it-owner');
    assert.equal(JSON.stringify(await (await get(`/api/pulse/channels/${channelId}`, outsider)).json()).includes('owner_subject'), false);
  } finally {
    if (harness) await harness.close();
    if (pool) await pool.end();
    if (schemaCreated) await admin.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => {});
    await admin.end();
  }
});
