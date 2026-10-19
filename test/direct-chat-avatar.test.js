import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import signature from 'cookie-signature';
import session from 'express-session';
import { buildConfig, createApp } from '../server.js';
import { createDirectChatStore } from '../direct-chat-api.js';

const SESSION_SECRET = 'chat-avatar-tests-use-a-long-session-secret-value';
const photoBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0x50, 0x48, 0x4f, 0x54, 0x4f]);

async function createHarness(directChatStore) {
  const sessions = new session.MemoryStore();
  const app = createApp({ config: buildConfig({ NODE_ENV: 'test', SESSION_SECRET }), sessionStore: sessions, directChatStore });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function cookieFor(id, subject) {
    const data = { cookie: { httpOnly: true, path: '/', sameSite: 'lax', secure: false }, stemmaUser: { provider: 'google', subject } };
    await new Promise((resolve, reject) => sessions.set(id, data, error => error ? reject(error) : resolve()));
    return `stemma.sid=${encodeURIComponent(`s:${signature.sign(id, SESSION_SECRET)}`)}`;
  }
  return { origin, cookieFor, async close() { server.close(); await once(server, 'close'); } };
}

test('peer-photo endpoint returns bytes only for authenticated conversation members and hides absent/outsider photos', async t => {
  const participants = new Map([['90', ['alpha-private-subject', 'beta-private-subject']], ['91', ['alpha-private-subject', 'gamma-private-subject']]]);
  const photos = new Map([['alpha-private-subject', photoBytes], ['beta-private-subject', photoBytes]]);
  const lookups = [];
  const store = {
    async getPeerPhoto(subject, conversationId) {
      lookups.push([subject, conversationId]);
      const pair = participants.get(conversationId);
      if (!pair?.includes(subject)) return null;
      const peer = pair.find(value => value !== subject);
      const data = photos.get(peer);
      return data ? { data, mimeType: 'image/png', subject: peer, email: 'must-not-leak@example.invalid' } : null;
    }
  };
  const h = await createHarness(store);
  t.after(() => h.close());
  const alpha = await h.cookieFor('alpha-session', 'alpha-private-subject');
  const beta = await h.cookieFor('beta-session', 'beta-private-subject');
  const outsider = await h.cookieFor('outsider-session', 'outsider-private-subject');
  const endpoint = `${h.origin}/api/pulse/conversations/90/peer-photo`;

  const anonymous = await fetch(endpoint);
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get('cache-control'), /no-store/);
  assert.equal(lookups.length, 0, 'anonymous request does not reach the store');

  const forAlpha = await fetch(endpoint, { headers: { cookie: alpha } });
  assert.equal(forAlpha.status, 200);
  assert.equal(forAlpha.headers.get('content-type'), 'image/png');
  assert.match(forAlpha.headers.get('cache-control'), /private, no-store/);
  assert.equal(forAlpha.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await forAlpha.arrayBuffer()), photoBytes);

  const forBeta = await fetch(endpoint, { headers: { cookie: beta } });
  assert.equal(forBeta.status, 200, 'either conversation participant may view the other participant photo');
  assert.deepEqual(Buffer.from(await forBeta.arrayBuffer()), photoBytes);

  const outsiderResponse = await fetch(endpoint, { headers: { cookie: outsider } });
  const noPhotoResponse = await fetch(`${h.origin}/api/pulse/conversations/91/peer-photo`, { headers: { cookie: alpha } });
  assert.equal(outsiderResponse.status, 404);
  assert.equal(noPhotoResponse.status, 404);
  assert.deepEqual(await outsiderResponse.json(), { error: 'Profile photo not found.' });
  assert.deepEqual(await noPhotoResponse.json(), { error: 'Profile photo not found.' });
  assert.deepEqual(lookups, [
    ['alpha-private-subject', '90'], ['beta-private-subject', '90'],
    ['outsider-private-subject', '90'], ['alpha-private-subject', '91']
  ]);
  assert.equal((await fetch(`${h.origin}/api/pulse/conversations/0/peer-photo`, { headers: { cookie: alpha } })).status, 400);
});

test('PostgreSQL peer-photo query binds the viewer and returns only an authorized peer image', async () => {
  let call;
  const data = Buffer.from(photoBytes);
  const store = createDirectChatStore({
    async query(sql, values) {
      call = { sql, values };
      return { rows: [{ data, mimeType: 'image/png' }] };
    }
  });
  const result = await store.getPeerPhoto('viewer-subject-private', '90');
  assert.deepEqual(call.values, ['90', 'viewer-subject-private']);
  assert.match(call.sql, /c\.id = \$1::bigint/);
  assert.match(call.sql, /c\.participant_a = \$2 OR c\.participant_b = \$2/);
  assert.match(call.sql, /p\.google_subject = CASE/);
  assert.match(call.sql, /p\.profile_image IS NOT NULL/);
  assert.doesNotMatch(call.sql, /SELECT\s+(?:c\.|p\.google_subject|.*email)/i);
  assert.deepEqual(result, { data, mimeType: 'image/png' });
});
