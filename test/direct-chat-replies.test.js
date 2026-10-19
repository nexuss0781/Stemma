import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import signature from 'cookie-signature';
import session from 'express-session';
import { buildConfig, createApp } from '../server.js';
import { createDirectChatStore } from '../direct-chat-api.js';

const SESSION_SECRET = 'direct-chat-replies-tests-use-a-long-session-secret';

async function createHarness(directChatStore) {
  const sessions = new session.MemoryStore();
  const app = createApp({ config: buildConfig({ NODE_ENV: 'test', SESSION_SECRET }), sessionStore: sessions, directChatStore });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const id = 'reply-user-session';
  await new Promise((resolve, reject) => sessions.set(id, {
    cookie: { httpOnly: true, path: '/', sameSite: 'lax', secure: false },
    stemmaUser: { provider: 'google', subject: 'reply-viewer' }
  }, error => error ? reject(error) : resolve()));
  const cookie = `stemma.sid=${encodeURIComponent(`s:${signature.sign(id, SESSION_SECRET)}`)}`;
  return { origin, cookie, async close() { server.close(); await once(server, 'close'); } };
}

const post = (url, cookie, origin, body) => fetch(url, {
  method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify(body)
});

test('reply DTOs expose only same-chat preview data and retain unavailable reference ids', async t => {
  const store = {
    async listMessages() {
      return [
        { id: '42', text: 'response', createdAt: new Date('2026-03-01T00:00:00Z'), authorSubject: 'reply-viewer', replyToId: '40', replyToText: 'original', replyToAuthorSubject: 'peer-private-id' },
        { id: '41', text: 'older response', createdAt: new Date('2026-02-28T00:00:00Z'), authorSubject: 'peer-private-id', replyToId: '39' }
      ];
    },
    async sendMessage(subject, conversationId, text, replyToId) {
      assert.deepEqual([subject, conversationId, text, replyToId], ['reply-viewer', '12', 'new response', '40']);
      return { id: '43', text, createdAt: new Date('2026-03-02T00:00:00Z'), authorSubject: subject,
        replyToId, replyToText: 'original', replyToAuthorSubject: 'peer-private-id', hidden: 'must-not-leak' };
    }
  };
  const h = await createHarness(store);
  t.after(() => h.close());
  const history = await fetch(`${h.origin}/api/pulse/conversations/12/messages`, { headers: { cookie: h.cookie } });
  assert.deepEqual(await history.json(), { messages: [
    { id: '42', text: 'response', createdAt: '2026-03-01T00:00:00.000Z', mine: true,
      replyTo: { id: '40', text: 'original', mine: false, available: true } },
    { id: '41', text: 'older response', createdAt: '2026-02-28T00:00:00.000Z', mine: false,
      replyTo: { id: '39', available: false } }
  ], hasMore: false });

  const response = await post(`${h.origin}/api/pulse/conversations/12/messages`, h.cookie, h.origin, { text: ' new response ', replyToId: '40' });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { message: { id: '43', text: 'new response', createdAt: '2026-03-02T00:00:00.000Z', mine: true,
    replyTo: { id: '40', text: 'original', mine: false, available: true } } });
  for (const body of [
    { text: 'valid', replyToId: 40 }, { text: 'valid', replyToId: '0' },
    { text: 'valid', replyToId: '9223372036854775808' }, { text: 'valid', replyToId: 'not-an-id' },
    { text: 'valid', unexpected: true }
  ]) assert.equal((await post(`${h.origin}/api/pulse/conversations/12/messages`, h.cookie, h.origin, body)).status, 400);
});

test('reply writes bind the reference and require the target to be in the same conversation; migrate loads 008 after 006', async () => {
  const calls = [];
  const store = createDirectChatStore({ async query(sql, values) { calls.push({ sql, values }); return { rows: [] }; } });
  await store.migrate();
  assert.match(calls[0].sql, /stemma_direct_chat_messages/);
  assert.match(calls[1].sql, /reply_to_message_id/);
  calls.length = 0;
  assert.equal(await store.sendMessage('viewer', '12', 'response', '40'), null);
  assert.deepEqual(calls[0].values, ['12', 'viewer', 'response', '40']);
  assert.match(calls[0].sql, /target\.id = \$4::bigint AND target\.conversation_id = c\.id/);
  assert.match(calls[0].sql, /reply_to_message_id/);
  assert.match(calls[0].sql, /LEFT JOIN stemma_direct_chat_messages target/);
});
