import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import signature from 'cookie-signature';
import session from 'express-session';
import { buildConfig, createApp } from '../server.js';
import { createChannelStore } from '../channels-api.js';

const SESSION_SECRET = 'channels-api-tests-use-a-long-session-secret';
const google = subject => ({ provider: 'google', subject });
const date = value => new Date(value);

async function harness(channelStore) {
  const config = buildConfig({ NODE_ENV: 'test', SESSION_SECRET });
  const sessionStore = new session.MemoryStore();
  const app = createApp({ config, sessionStore, channelStore });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function cookieFor(id, user) {
    const data = { cookie: { originalMaxAge: null, expires: null, httpOnly: true, path: '/', sameSite: 'lax', secure: false }, ...(user ? { stemmaUser: user } : {}) };
    await new Promise((resolve, reject) => sessionStore.set(id, data, error => error ? reject(error) : resolve()));
    return `stemma.sid=${encodeURIComponent(`s:${signature.sign(id, SESSION_SECRET)}`)}`;
  }
  return { origin, cookieFor, async close() { if (server.listening) { server.close(); await once(server, 'close'); } } };
}
const get = (url, cookie) => fetch(url, { headers: cookie ? { cookie } : {} });
const post = (url, cookie, origin, body) => fetch(url, { method: 'POST', headers: { ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}), 'content-type': 'application/json' }, body: JSON.stringify(body) });

const channel = (id, ownerSubject, overrides = {}) => ({
  id, name: `Channel ${id}`, isOwner: false, ownerSubject,
  createdAt: date('2026-01-01T00:00:00Z'), updatedAt: date('2026-01-01T00:00:00Z'),
  lastPostId: null, lastPostText: null, lastPostCreatedAt: null, ...overrides
});

test('Channels auth, all-channel listing, sanitized contracts, validation, owner posting, and cursor pagination', async t => {
  const calls = [];
  const rows = new Map([
    ['8', channel('8', 'owner-a', { isOwner: true, lastPostId: '101', lastPostText: 'last', lastPostCreatedAt: date('2026-01-02T00:00:00Z') })],
    ['9', channel('9', 'owner-b')]
  ]);
  const posts = Array.from({ length: 51 }, (_, i) => ({ id: String(1051 - i), text: `post-${i}`, createdAt: date('2026-01-03T00:00:00Z'), authorSubject: 'secret-subject' }));
  const store = {
    async listChannels(subject) { calls.push(['list', subject]); return [...rows.values()].map(row => ({ ...row, isOwner: row.ownerSubject === subject })); },
    async createChannel(subject, name) { calls.push(['create', subject, name]); const created = channel('10', subject, { name, isOwner: true }); rows.set('10', created); return created; },
    async getChannel(subject, id) { calls.push(['get', subject, id]); const row = rows.get(id); return row ? { ...row, isOwner: row.ownerSubject === subject } : null; },
    async listPosts(id, before, limit) { calls.push(['posts', id, before, limit]); return posts.filter(row => before === null || BigInt(row.id) < BigInt(before)).slice(0, limit); },
    async createPost(subject, id, text) { calls.push(['post', subject, id, text]); return rows.get(id)?.ownerSubject === subject ? { id: '1100', text, createdAt: date('2026-01-04T00:00:00Z'), authorSubject: subject } : null; }
  };
  const h = await harness(store); t.after(() => h.close());
  const owner = await h.cookieFor('channels-owner', google('owner-a'));
  const other = await h.cookieFor('channels-other', google('owner-b'));
  assert.equal((await get(`${h.origin}/api/pulse/channels`)).status, 401);
  let response = await get(`${h.origin}/api/pulse/channels`, owner);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /private, no-store/);
  assert.deepEqual((await response.json()).channels.map(item => item.id), ['8', '9']);
  assert.deepEqual(calls.at(-1), ['list', 'owner-a']);
  const serialized = JSON.stringify(await (await get(`${h.origin}/api/pulse/channels`, owner)).json());
  assert.doesNotMatch(serialized, /ownerSubject|owner-a|owner-b|authorSubject|secret-subject/);

  response = await post(`${h.origin}/api/pulse/channels`, owner, h.origin, { name: '  New channel  ' });
  assert.equal(response.status, 201);
  assert.deepEqual((await response.json()).channel, {
    id: '10', name: 'New channel', isOwner: true, createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z', lastPost: null, subscriberCount: 0,
    isSubscribed: false, muted: false, lastReadPostId: null, pinnedPost: null,
    ownerName: null, avatarUrl: null
  });
  assert.deepEqual(calls.find(call => call[0] === 'create'), ['create', 'owner-a', 'New channel']);
  for (const body of [{}, { name: ' ' }, { name: 'x'.repeat(81) }, { name: 'okay', ownerSubject: 'forged' }, { name: 'nul\0name' }]) {
    assert.equal((await post(`${h.origin}/api/pulse/channels`, owner, h.origin, body)).status, 400);
  }
  assert.equal((await post(`${h.origin}/api/pulse/channels`, owner, null, { name: 'No origin' })).status, 403);
  response = await fetch(`${h.origin}/api/pulse/channels`, { method: 'POST', headers: { cookie: owner, origin: h.origin }, body: JSON.stringify({ name: 'No JSON' }) });
  assert.equal(response.status, 415, 'mutating requests require JSON');

  response = await get(`${h.origin}/api/pulse/channels/8`, other);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).channel.isOwner, false);
  assert.equal((await get(`${h.origin}/api/pulse/channels/0`, owner)).status, 400);
  assert.equal((await get(`${h.origin}/api/pulse/channels/9223372036854775808`, owner)).status, 400);
  assert.equal((await get(`${h.origin}/api/pulse/channels/1x`, owner)).status, 400);
  assert.equal((await get(`${h.origin}/api/pulse/channels/999`, owner)).status, 404);

  response = await get(`${h.origin}/api/pulse/channels/8/posts`, other);
  assert.equal(response.status, 200, 'any signed-in user may read posts');
  let result = await response.json();
  assert.equal(result.posts.length, 50);
  assert.equal(result.hasMore, true);
  assert.equal(result.nextBefore, result.posts.at(-1).id);
  assert.deepEqual(Object.keys(result.posts[0]), ['id', 'text', 'createdAt']);
  response = await get(`${h.origin}/api/pulse/channels/8/posts?before=${result.nextBefore}`, other);
  result = await response.json();
  assert.equal(result.posts.length, 1);
  assert.equal(result.hasMore, false);
  assert.equal(result.nextBefore, null);
  assert.deepEqual(calls.find(call => call[0] === 'posts'), ['posts', '8', null, 51]);
  assert.equal((await get(`${h.origin}/api/pulse/channels/8/posts?before=01`, owner)).status, 400);
  assert.equal((await get(`${h.origin}/api/pulse/channels/8/posts?before=9223372036854775808`, owner)).status, 400);

  response = await post(`${h.origin}/api/pulse/channels/8/posts`, other, h.origin, { text: 'Not owner' });
  assert.equal(response.status, 403);
  response = await post(`${h.origin}/api/pulse/channels/8/posts`, owner, h.origin, { text: '  owner post  ' });
  assert.equal(response.status, 201);
  assert.deepEqual((await response.json()).post, { id: '1100', text: 'owner post', createdAt: '2026-01-04T00:00:00.000Z' });
  assert.deepEqual(calls.find(call => call[0] === 'post'), ['post', 'owner-a', '8', 'owner post']);
  for (const body of [{ text: '' }, { text: 'x'.repeat(4001) }, { text: 'valid', authorSubject: 'forged' }, { text: 'bad\0text' }]) {
    assert.equal((await post(`${h.origin}/api/pulse/channels/8/posts`, owner, h.origin, body)).status, 400);
  }
  assert.equal((await post(`${h.origin}/api/pulse/channels/8/posts`, owner, null, { text: 'no csrf' })).status, 403);
});

test('Channels SQL store scopes post INSERT to the channel owner and supports repeatable migrations', async () => {
  const calls = [];
  const fakePool = { async query(sql, values) { calls.push({ sql, values }); return { rows: [] }; } };
  const store = createChannelStore(fakePool);
  assert.equal(await store.createPost('not-owner', '31', 'blocked'), null);
  assert.match(calls[0].sql, /INSERT INTO stemma_pulse_channel_posts[\s\S]*SELECT c\.id, \$3::text FROM stemma_pulse_channels c[\s\S]*c\.owner_subject = \$2/);
  assert.deepEqual(calls[0].values, ['31', 'not-owner', 'blocked']);
  await store.migrate();
  assert.match(calls.at(-2).sql, /CREATE TABLE IF NOT EXISTS stemma_pulse_channels/);
  assert.match(calls.at(-1).sql, /CREATE TABLE IF NOT EXISTS stemma_pulse_channel_subscribers/);
  assert.match(calls.at(-1).sql, /ON DELETE SET NULL \(last_read_post_id\)/);
});

test('Channels static assets are explicitly served with safe cache policy', async t => {
  const h = await harness(null); t.after(() => h.close());
  const script = await fetch(`${h.origin}/channels-ui.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /javascript/);
  const css = await fetch(`${h.origin}/channels.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
  assert.equal(css.headers.get('cache-control'), 'no-cache');
});

test('Channels rate limits are 120/minute per signed-in subject rather than shared IP', async t => {
  const emptyStore = {
    async listChannels() { return []; }, async createChannel() { return null; },
    async getChannel() { return null; }, async listPosts() { return []; }, async createPost() { return null; }
  };
  const h = await harness(emptyStore); t.after(() => h.close());
  const first = await h.cookieFor('channels-limit-first', google('limit-first'));
  const second = await h.cookieFor('channels-limit-second', google('limit-second'));
  let response;
  for (let i = 0; i < 120; i += 1) response = await get(`${h.origin}/api/pulse/channels`, first);
  assert.equal(response.status, 200);
  response = await get(`${h.origin}/api/pulse/channels`, first);
  assert.equal(response.status, 429);
  response = await get(`${h.origin}/api/pulse/channels`, second);
  assert.equal(response.status, 200, 'another authenticated user has a separate allowance despite sharing the same IP');
});
