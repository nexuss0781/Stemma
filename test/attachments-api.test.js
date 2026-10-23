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
import { createChannelStore } from '../channels-api.js';

const SESSION_SECRET = 'attachments-api-tests-use-a-long-session-secret';
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ATTACHMENT_ID = 'e34bac58-083f-4b68-9f33-ea86dc33e052';
const google = subject => ({ provider: 'google', subject });

async function createHarness({ attachmentStore, pulseStore = null, directChatStore = null, groupStore = null, channelStore = null }) {
  const config = buildConfig({ NODE_ENV: 'test', SESSION_SECRET });
  const sessionStore = new session.MemoryStore();
  const app = createApp({ config, sessionStore, attachmentStore, pulseStore, directChatStore, groupStore, channelStore });
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

test('group attachments upload into the shared store and remain scoped to current members', async t => {
  const created = [];
  const groupMessage = { id: '91', text: 'Attachment: sample.png', createdAt: new Date('2026-02-03T00:00:00Z'), authorSubject: 'group-member', username: 'member', nickName: 'Member', attachment: { id: ATTACHMENT_ID, url: `/api/pulse/attachments/${ATTACHMENT_ID}`, name: 'sample.png', mimeType: 'image/png', size: PNG.length } };
  const store = {
    async createGroupAttachment(subject, id, attachment) {
      created.push([subject, id, attachment.name]);
      return subject === 'group-member' && id === '17' ? groupMessage : null;
    },
    async getAttachmentForSubject(subject, id) {
      return subject === 'group-member' && id === ATTACHMENT_ID ? { id, name: 'sample.png', mimeType: 'image/png', size: PNG.length, data: PNG } : null;
    },
    async getAttachmentsForMessages(subject, scope, ids) {
      if (subject !== 'group-member' || scope !== 'group:17' || !ids.includes('91')) return [];
      return [{ id: ATTACHMENT_ID, messageId: '91', name: 'sample.png', mimeType: 'image/png', size: PNG.length }];
    }
  };
  const GROUP_UUID = '3c615f4c-01b7-4bd8-9b91-940c4396785d';
  const groups = { async getLegacyId(id) { return id === GROUP_UUID ? '17' : id; }, async listMessages(subject, id) { return subject === 'group-member' && ['17', GROUP_UUID].includes(id) ? [groupMessage] : []; } };
  const h = await createHarness({ attachmentStore: store, groupStore: groups });
  t.after(() => h.close());
  const member = await h.cookieFor('group-member-session', google('group-member'));
  const outsider = await h.cookieFor('group-outsider-session', google('group-outsider'));

  let response = await jsonPost(`${h.origin}/api/pulse/groups/17/attachments`, member, h.origin, fileBody());
  assert.equal(response.status, 201);
  assert.deepEqual((await response.json()).message, { id: '91', text: 'Attachment: sample.png', createdAt: '2026-02-03T00:00:00.000Z', mine: true,
    author: { username: 'member', nickName: 'Member' }, attachment: groupMessage.attachment });
  assert.equal((await jsonPost(`${h.origin}/api/pulse/groups/17/attachments`, outsider, h.origin, fileBody())).status, 404);
  response = await jsonPost(`${h.origin}/api/pulse/groups/${GROUP_UUID}/attachments`, member, h.origin, fileBody());
  assert.equal(response.status, 201, 'UUID group routes resolve to legacy bigint before attachment FK writes');
  assert.deepEqual(created, [['group-member', '17', 'sample.png'], ['group-outsider', '17', 'sample.png'], ['group-member', '17', 'sample.png']]);
  response = await fetch(`${h.origin}/api/pulse/groups/${GROUP_UUID}/messages`, { headers: { cookie: member } });
  assert.deepEqual((await response.json()).messages[0].attachment, groupMessage.attachment, 'attachment scope resolves UUID to the underlying bigint group id');

  response = await fetch(`${h.origin}/api/pulse/groups/17/messages`, { headers: { cookie: member } });
  assert.deepEqual((await response.json()).messages[0].attachment, groupMessage.attachment);
  response = await fetch(`${h.origin}/api/pulse/attachments/${ATTACHMENT_ID}`, { headers: { cookie: member } });
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG);
  response = await fetch(`${h.origin}/api/pulse/attachments/${ATTACHMENT_ID}`, { headers: { cookie: outsider } });
  assert.equal(response.status, 404);
});

test('channel attachments are owner-only, accept optional captions, and downloads require a signed-in session', async t => {
  const created = [];
  const store = {
    async createChannelAttachment(subject, id, attachment) {
      created.push([subject, id, attachment.caption, attachment.name]);
      if (subject !== 'channel-owner' || id !== '17') return null;
      return { id: '91', text: attachment.caption || attachment.name, createdAt: new Date('2026-02-04T00:00:00Z'),
        attachment: { id: ATTACHMENT_ID, url: `/api/pulse/attachments/${ATTACHMENT_ID}`, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size } };
    },
    async getAttachmentForSubject(subject, id) {
      return ['channel-owner', 'channel-reader'].includes(subject) && id === ATTACHMENT_ID
        ? { id, name: 'sample.png', mimeType: 'image/png', size: PNG.length, data: PNG } : null;
    }
  };
  const CHANNEL_UUID = '6f4c2ed1-89a8-4dcc-8776-a22402ac5fc9';
  const channelStore = { async getLegacyId(id) { return id === CHANNEL_UUID ? '17' : id; } };
  const h = await createHarness({ attachmentStore: store, channelStore });
  t.after(() => h.close());
  const owner = await h.cookieFor('channel-owner-session', google('channel-owner'));
  const reader = await h.cookieFor('channel-reader-session', google('channel-reader'));

  let response = await jsonPost(`${h.origin}/api/pulse/channels/17/attachments`, reader, h.origin, fileBody());
  assert.equal(response.status, 403, 'a forged non-owner request is rejected');
  response = await jsonPost(`${h.origin}/api/pulse/channels/${CHANNEL_UUID}/attachments`, owner, h.origin, { ...fileBody(), caption: '  A channel image  ' });
  assert.equal(response.status, 201);
  assert.deepEqual((await response.json()).message, { id: '91', text: 'A channel image', createdAt: '2026-02-04T00:00:00.000Z',
    attachment: { id: ATTACHMENT_ID, url: `/api/pulse/attachments/${ATTACHMENT_ID}`, name: 'sample.png', mimeType: 'image/png', size: 8 } });
  assert.deepEqual(created, [['channel-reader', '17', '', 'sample.png'], ['channel-owner', '17', 'A channel image', 'sample.png']]);
  response = await jsonPost(`${h.origin}/api/pulse/channels/17/attachments`, owner, h.origin, { ...fileBody(), caption: 'x'.repeat(4001) });
  assert.equal(response.status, 400, 'captions longer than 4000 characters are rejected');

  response = await fetch(`${h.origin}/api/pulse/attachments/${ATTACHMENT_ID}`);
  assert.equal(response.status, 401, 'anonymous downloads remain denied');
  response = await fetch(`${h.origin}/api/pulse/attachments/${ATTACHMENT_ID}`, { headers: { cookie: reader } });
  assert.equal(response.status, 200, 'any authenticated channel reader can download channel media');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG);
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
    await pool.query(`CREATE TABLE stemma_groups (id BIGSERIAL PRIMARY KEY)`);
    await pool.query(`CREATE TABLE stemma_groups_memberships (id BIGSERIAL PRIMARY KEY, group_id BIGINT NOT NULL REFERENCES stemma_groups ON DELETE CASCADE, member_subject VARCHAR(255) NOT NULL REFERENCES stemma_google_identities ON DELETE CASCADE)`);
    await pool.query(`CREATE TABLE stemma_groups_messages (id BIGSERIAL PRIMARY KEY, group_id BIGINT NOT NULL REFERENCES stemma_groups ON DELETE CASCADE, author_subject VARCHAR(255) NOT NULL REFERENCES stemma_google_identities ON DELETE CASCADE, text TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    await pool.query(`CREATE TABLE stemma_student_profiles (google_subject VARCHAR(255) PRIMARY KEY, nick_name TEXT, username TEXT)`);
    await pool.query(`INSERT INTO stemma_google_identities (google_subject) VALUES ('attach-owner'), ('attach-peer'), ('attach-outsider')`);
    await pool.query(`INSERT INTO stemma_direct_chat_conversations (participant_a, participant_b) VALUES ('attach-owner', 'attach-peer')`);
    const channels = createChannelStore(pool);
    await channels.migrate();
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
    const channel = await channels.createChannel('attach-owner', 'Attachment integration channel');
    assert.equal(await store.createChannelAttachment('attach-peer', channel.id, { ...attachment, caption: 'forged reader upload' }), null,
      'the database INSERT predicate denies non-owner uploads');
    const channelPost = await store.createChannelAttachment('attach-owner', channel.id, { ...attachment, caption: 'Channel image caption' });
    assert.equal(channelPost.text, 'Channel image caption');
    assert.equal(await store.getAttachmentForSubject('attach-outsider', channelPost.attachment.id).then(Boolean), true,
      'channel attachment downloads are available to any authenticated signed-in reader');
    assert.deepEqual((await store.getAttachmentsForMessages('attach-outsider', `channel:${channel.id}`, [channelPost.id])).map(item => item.messageId), [channelPost.id]);
    const filenamePost = await store.createChannelAttachment('attach-owner', channel.id, attachment);
    assert.equal(filenamePost.text, attachment.name, 'filename is used when caption is omitted');
    await pool.end(); pool = new Pool(scoped);
    store = createAttachmentStore(pool);
    await store.migrate();
    await store.migrate();
    assert.deepEqual((await store.getAttachmentForSubject('attach-peer', channelPost.attachment.id)).data, PNG,
      'repeated startup migrations preserve existing channel media and its private signed-in download');
    const reopened = await store.getAttachmentForSubject('attach-owner', saved.attachment.id);
    assert.deepEqual(reopened.data, PNG, 'bytea survives database pool/store recreation');
    assert.deepEqual((await store.getAttachmentsForMessages('attach-owner', 'saved', [saved.id])).map(item => item.messageId), [saved.id]);
  } finally {
    if (pool) await pool.end().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await admin.end();
  }
});
