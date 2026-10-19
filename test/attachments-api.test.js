import assert from 'node:assert/strict';
import { once } from 'node:events';
import crypto from 'node:crypto';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import signature from 'cookie-signature';
import session from 'express-session';
import pg from 'pg';
import { buildConfig, createApp } from '../server.js';
import { createAttachmentStore, validateAttachmentBody, MAX_ATTACHMENT_BYTES } from '../attachments-api.js';

const SESSION_SECRET = 'attachments-api-tests-use-a-long-session-secret';
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ATTACHMENT_ID = 'e34bac58-083f-4b68-9f33-ea86dc33e052';
const google = subject => ({ provider: 'google', subject });

async function createHarness({ attachmentStore, pulseStore = null, directChatStore = null }) {
  const config = buildConfig({ NODE_ENV: 'test', SESSION_SECRET });
  const sessionStore = new session.MemoryStore();
  const app = createApp({ config, sessionStore, attachmentStore, pulseStore, directChatStore });
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

const jsonPost = (url, cookie, origin, body) => fetch(url, {
  method: 'POST', headers: { ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}), 'content-type': 'application/json' }, body: JSON.stringify(body)
});
const fileBody = (name = 'sample.png', data = PNG) => ({ name, mimeType: 'image/png', data: data.toString('base64') });

test('attachment upload validation checks extension, MIME allowlist, signatures, UTF-8 and 5 MiB limit', () => {
  assert.deepEqual(validateAttachmentBody(fileBody()), { name: 'sample.png', mimeType: 'image/png', size: PNG.length, data: PNG });
  for (const value of [
    { ...fileBody(), name: 'page.svg' },
    { ...fileBody(), name: 'page.html', mimeType: 'text/html' },
    { ...fileBody(), mimeType: 'application/x-msdownload' },
    { ...fileBody(), name: 'sample.jpg' },
    { ...fileBody(), data: Buffer.from('<script>alert(1)</script>').toString('base64') },
    { ...fileBody(), data: 'not base64' },
    { ...fileBody(), unexpected: true },
    fileBody('bad.png', Buffer.concat([PNG, Buffer.alloc(MAX_ATTACHMENT_BYTES)]))
  ]) assert.equal(validateAttachmentBody(value), null);
  assert.equal(validateAttachmentBody({ name: 'docs.csv', mimeType: 'text/csv', data: Buffer.from('a,b\n1,2').toString('base64') }).mimeType, 'text/csv');
  assert.equal(validateAttachmentBody({ name: 'bad.txt', mimeType: 'text/plain', data: Buffer.from([0xff, 0xfe]).toString('base64') }), null);
  assert.equal(validateAttachmentBody({ ...fileBody(), name: 'unsafe\u202efile.png' }).name, 'unsafefile.png');
  assert.equal(validateAttachmentBody({ name: 'full.txt', mimeType: 'text/plain', data: Buffer.alloc(MAX_ATTACHMENT_BYTES, 65).toString('base64') }).size, MAX_ATTACHMENT_BYTES);
  assert.equal(validateAttachmentBody({ ...fileBody(), replyToId: '9' }), null, 'Saved Messages cannot accept a chat reply reference');
  assert.equal(validateAttachmentBody({ ...fileBody(), replyToId: '9' }, { allowReplyTo: true }).replyToId, '9');
});

test('attachment endpoints enforce authentication, same-origin uploads, scoped metadata and safe download headers', async t => {
  const calls = [];
  const store = {
    async createConversationAttachment(subject, id, attachment) {
      calls.push(['chat', subject, id, attachment.name]);
      if (subject !== 'participant' || id !== '17') return null;
      return { id: '84', text: `Attachment: ${attachment.name}`, createdAt: new Date('2026-01-02T00:00:00Z'), authorSubject: subject,
        attachment: { id: ATTACHMENT_ID, url: `/api/pulse/attachments/${ATTACHMENT_ID}`, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size } };
    },
    async createSavedAttachment(subject, attachment) {
      calls.push(['saved', subject, attachment.name]);
      return { id: '23', text: `Attachment: ${attachment.name}`, createdAt: new Date('2026-01-03T00:00:00Z'),
        attachment: { id: ATTACHMENT_ID, url: `/api/pulse/attachments/${ATTACHMENT_ID}`, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size } };
    },
    async getAttachmentForSubject(subject, id) {
      calls.push(['get', subject, id]);
      if (subject !== 'participant' || id !== ATTACHMENT_ID) return null;
      return { id, name: 'sample.png', mimeType: 'image/png', size: PNG.length, data: PNG };
    },
    async getAttachmentsForMessages(subject, scope, ids) {
      calls.push(['metadata', subject, scope, ids]);
      if (subject !== 'participant' || !['saved', '17'].includes(scope)) return [];
      const messageId = scope === 'saved' ? '23' : '84';
      return [{ id: ATTACHMENT_ID, url: `/api/pulse/attachments/${ATTACHMENT_ID}`, name: 'sample.png', mimeType: 'image/png', size: PNG.length, messageId }];
    }
  };
  const pulseStore = {
    async listSavedMessages() { return [{ id: '23', text: 'Attachment: sample.png', createdAt: new Date('2026-01-03T00:00:00Z') }]; }
  };
  const directChatStore = {
    async listConversations() { return [{ id: '17', username: 'peer', nickName: 'Peer', lastMessageId: '84', lastMessageText: 'Attachment: sample.png', lastMessageAt: new Date('2026-01-02T00:00:00Z') }]; },
    async listMessages() { return [{ id: '84', text: 'Attachment: sample.png', createdAt: new Date('2026-01-02T00:00:00Z'), authorSubject: 'participant' }]; }
  };
  const h = await createHarness({ attachmentStore: store, pulseStore, directChatStore });
  t.after(() => h.close());
  const participant = await h.cookieFor('participant-session', google('participant'));
  const outsider = await h.cookieFor('outsider-session', google('outsider'));

  assert.equal((await jsonPost(`${h.origin}/api/pulse/saved/attachments`, null, h.origin, fileBody())).status, 401);
  assert.equal((await jsonPost(`${h.origin}/api/pulse/saved/attachments`, participant, null, fileBody())).status, 403);
  let response = await jsonPost(`${h.origin}/api/pulse/saved/attachments`, participant, h.origin, fileBody());
  assert.equal(response.status, 201);
  assert.deepEqual((await response.json()).message.attachment, { id: ATTACHMENT_ID, url: `/api/pulse/attachments/${ATTACHMENT_ID}`, name: 'sample.png', mimeType: 'image/png', size: 8 });
  response = await jsonPost(`${h.origin}/api/pulse/conversations/17/attachments`, participant, h.origin, fileBody());
  assert.equal(response.status, 201);
  assert.deepEqual((await response.json()).message, { id: '84', text: 'Attachment: sample.png', createdAt: '2026-01-02T00:00:00.000Z', mine: true,
    attachment: { id: ATTACHMENT_ID, url: `/api/pulse/attachments/${ATTACHMENT_ID}`, name: 'sample.png', mimeType: 'image/png', size: 8 } });
  assert.equal((await jsonPost(`${h.origin}/api/pulse/conversations/17/attachments`, outsider, h.origin, fileBody())).status, 404);
  response = await fetch(`${h.origin}/api/pulse/saved`, { headers: { cookie: participant } });
  assert.deepEqual((await response.json()).messages[0].attachment, { id: ATTACHMENT_ID, url: `/api/pulse/attachments/${ATTACHMENT_ID}`, name: 'sample.png', mimeType: 'image/png', size: 8 });
  response = await fetch(`${h.origin}/api/pulse/conversations/17/messages`, { headers: { cookie: participant } });
  assert.deepEqual((await response.json()).messages[0].attachment, { id: ATTACHMENT_ID, url: `/api/pulse/attachments/${ATTACHMENT_ID}`, name: 'sample.png', mimeType: 'image/png', size: 8 });
  response = await fetch(`${h.origin}/api/pulse/conversations`, { headers: { cookie: participant } });
  assert.deepEqual((await response.json()).conversations[0].lastMessage.attachment, { id: ATTACHMENT_ID, url: `/api/pulse/attachments/${ATTACHMENT_ID}`, name: 'sample.png', mimeType: 'image/png', size: 8 });
  response = await fetch(`${h.origin}/api/pulse/attachments/${ATTACHMENT_ID}`, { headers: { cookie: outsider } });
  assert.equal(response.status, 404);
  response = await fetch(`${h.origin}/api/pulse/attachments/${ATTACHMENT_ID}`, { headers: { cookie: participant } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.match(response.headers.get('cache-control'), /private, no-store/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('content-disposition'), /^inline;/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG);
  assert.deepEqual(calls.find(call => call[0] === 'metadata'), ['metadata', 'participant', 'saved', ['23']]);
});

test('PostgreSQL attachments persist across store recreation and authorize saved owners and chat participants', {
  skip: process.env.STEMMA_ATTACHMENTS_POSTGRES_TEST !== '1', timeout: 120000
}, async t => {
  const { Pool } = pg;
  const schema = `stemma_attach_${crypto.randomUUID().replaceAll('-', '')}`;
  const connection = { host: '127.0.0.1', port: 5432, database: 'stemma_notification_test', user: 'stemma_notification_test', password: 'local-notification-test-only', max: 4, connectionTimeoutMillis: 5000 };
  const admin = new Pool(connection);
  let pool;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = { ...connection, options: `-c search_path=${schema}` };
    pool = new Pool(scoped);
    await pool.query(`CREATE TABLE stemma_google_identities (google_subject VARCHAR(255) PRIMARY KEY, verified_email VARCHAR(320) NOT NULL DEFAULT '')`);
    await pool.query(`CREATE TABLE stemma_pulse_saved_messages (id BIGSERIAL PRIMARY KEY, google_subject VARCHAR(255) NOT NULL REFERENCES stemma_google_identities ON DELETE CASCADE, text TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    await pool.query(`CREATE TABLE stemma_direct_chat_conversations (id BIGSERIAL PRIMARY KEY, participant_a VARCHAR(255) NOT NULL, participant_b VARCHAR(255) NOT NULL)`);
    await pool.query(`CREATE TABLE stemma_direct_chat_messages (id BIGSERIAL PRIMARY KEY, conversation_id BIGINT NOT NULL REFERENCES stemma_direct_chat_conversations ON DELETE CASCADE, author_subject VARCHAR(255) NOT NULL REFERENCES stemma_google_identities ON DELETE CASCADE, text TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    await pool.query(await readFile(new URL('../migrations/008_direct_chat_replies.sql', import.meta.url), 'utf8'));
    await pool.query(`INSERT INTO stemma_google_identities (google_subject) VALUES ('attach-owner'), ('attach-peer'), ('attach-outsider')`);
    await pool.query(`INSERT INTO stemma_direct_chat_conversations (participant_a, participant_b) VALUES ('attach-owner', 'attach-peer')`);
    let store = createAttachmentStore(pool);
    await store.migrate();
    await store.migrate();
    const bytes = PNG;
    const attachment = { name: 'persist.png', mimeType: 'image/png', size: bytes.length, data: bytes };
    const saved = await store.createSavedAttachment('attach-owner', attachment);
    const chat = await store.createConversationAttachment('attach-peer', '1', attachment);
    assert.ok(saved && chat);
    const reply = await store.createConversationAttachment('attach-owner', '1', { ...attachment, replyToId: chat.id });
    assert.deepEqual(reply.replyTo, { id: chat.id, text: 'Attachment: persist.png', mine: false, available: true });
    assert.equal((await pool.query('SELECT reply_to_message_id::text AS id FROM stemma_direct_chat_messages WHERE id=$1', [reply.id])).rows[0].id, chat.id);
    assert.equal(await store.createConversationAttachment('attach-outsider', '1', { ...attachment, replyToId: chat.id }), null);
    assert.equal(await store.createConversationAttachment('attach-owner', '1', { ...attachment, replyToId: '999999' }), null);
    assert.equal(await store.getAttachmentForSubject('attach-owner', saved.attachment.id).then(Boolean), true);
    assert.equal(await store.getAttachmentForSubject('attach-peer', saved.attachment.id).then(Boolean), false);
    assert.equal(await store.getAttachmentForSubject('attach-outsider', chat.attachment.id).then(Boolean), false);
    assert.equal(await store.getAttachmentForSubject('attach-owner', chat.attachment.id).then(Boolean), true);
    await pool.end(); pool = new Pool(scoped);
    store = createAttachmentStore(pool);
    const reopened = await store.getAttachmentForSubject('attach-owner', saved.attachment.id);
    assert.deepEqual(reopened.data, PNG, 'bytea survives database pool/store recreation');
    assert.deepEqual((await store.getAttachmentsForMessages('attach-owner', 'saved', [saved.id])).map(item => item.messageId), [saved.id]);
  } finally {
    if (pool) await pool.end().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await admin.end();
  }
});
