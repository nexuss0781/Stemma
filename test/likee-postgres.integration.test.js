import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import crypto from 'node:crypto';
import test from 'node:test';
import signature from 'cookie-signature';
import session from 'express-session';
import pg from 'pg';
import { buildConfig, createApp, createGoogleIdentityStore, createStudentProfileStore } from '../server.js';
import { createDirectChatStore } from '../direct-chat-api.js';
import { createLikeeStore } from '../likee-api.js';

const SESSION_SECRET = 'likee-postgres-integration-test-session-secret';
const google = subject => ({ provider: 'google', subject });
const postJson = (url, cookie, origin, body) => fetch(url, {
  method: 'POST',
  headers: { ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}), 'content-type': 'application/json' },
  body: JSON.stringify(body)
});

async function createHarness(likeeStore, directChatStore) {
  const config = buildConfig({ NODE_ENV: 'test', SESSION_SECRET });
  const sessionStore = new session.MemoryStore();
  const app = createApp({ config, sessionStore, likeeStore, directChatStore });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function cookieFor(id, subject) {
    const data = {
      cookie: { originalMaxAge: null, expires: null, httpOnly: true, path: '/', sameSite: 'lax', secure: false },
      stemmaUser: google(subject)
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

test('PostgreSQL Likee authenticated video, feed, actions, comments, follow and safe multi-chat sharing', {
  skip: process.env.STEMMA_LIKEE_DB_TEST !== '1',
  timeout: 120000
}, async () => {
  const { Pool } = pg;
  const schema = `stemma_likee_it_${crypto.randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^stemma_likee_it_[a-f0-9]{32}$/);
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

    const identities = createGoogleIdentityStore(pool);
    const profiles = createStudentProfileStore(pool);
    await identities.migrate();
    await profiles.migrate();
    // These are synthetic local integration actors only; all created data stays in this disposable schema.
    const actors = [
      ['likee-it-creator', 'Likee Test Creator', 'likee_test_creator'],
      ['likee-it-member', 'Likee Test Member', 'likee_test_member'],
      ['likee-it-outsider', 'Likee Test Outsider', 'likee_test_outsider'],
      ['likee-it-peer', 'Likee Test Peer', 'likee_test_peer']
    ];
    for (const [subject, nickName, username] of actors) {
      await identities.upsertGoogleIdentity({ subject, verifiedEmail: `${subject}@example.invalid` });
      await profiles.upsertStudentProfile(subject, {
        firstName: 'Integration', middleName: '', lastName: 'Test', studentId: subject,
        department: 'Likee integration tests', nickName, username, bio: ''
      });
    }

    const directChatStore = createDirectChatStore(pool);
    const likeeStore = createLikeeStore(pool);
    await directChatStore.migrate();
    await likeeStore.migrate();
    await likeeStore.migrate(); // migration remains safe on a fresh isolated schema when applied repeatedly
    harness = await createHarness(likeeStore, directChatStore);
    const [creator, member, outsider] = await Promise.all([
      harness.cookieFor('likee-it-session-creator', 'likee-it-creator'),
      harness.cookieFor('likee-it-session-member', 'likee-it-member'),
      harness.cookieFor('likee-it-session-outsider', 'likee-it-outsider')
    ]);
    const { origin } = harness;
    const get = (path, cookie) => fetch(`${origin}${path}`, { headers: { cookie } });

    // A minimal structurally plausible ISO-BMFF ftyp box is enough to test byte-for-byte storage;
    // it is test payload, not a real student video or a live feed item.
    const media = readFileSync(new URL('./fixtures/stories-browser-trim.mp4', import.meta.url));
    const upload = await postJson(`${origin}/api/likee/videos`, creator, origin, {
      caption: 'TEST fixture: isolated Likee roundtrip', mimeType: 'video/mp4', data: media.toString('base64')
    });
    assert.equal(upload.status, 201, 'authenticated upload persists to the isolated PostgreSQL schema');
    const created = (await upload.json()).video;
    assert.match(created.id, /^[0-9a-f-]{36}$/i);
    assert.equal(created.mediaUrl, `/api/likee/videos/${created.id}/media`);

    let response = await get('/api/likee/videos', creator);
    assert.equal(response.status, 200);
    let videos = (await response.json()).videos;
    assert.equal(videos.length, 1);
    assert.equal(videos[0].id, created.id);
    assert.equal(videos[0].caption, 'TEST fixture: isolated Likee roundtrip');
    assert.equal(videos[0].mimeType, 'video/mp4');
    assert.equal(videos[0].mine, true);
    assert.equal(videos[0].likes, 0);
    assert.equal(videos[0].comments, 0);
    assert.equal(videos[0].bookmarks, 0);
    assert.equal(videos[0].reposts, 0);
    assert.equal('ownerSubject' in videos[0], false);

    response = await get(created.mediaUrl, creator);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'video/mp4');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), media, 'authenticated media response bytes exactly match uploaded bytes');
    response = await get(`${created.mediaUrl}`, '');
    assert.notEqual(response.status, 200, 'media cannot be fetched without the synthetic authenticated session');

    response = await postJson(`${origin}/api/likee/videos/${created.id}/like`, member, origin, { active: true });
    assert.equal(response.status, 200);
    response = await postJson(`${origin}/api/likee/videos/${created.id}/repost`, member, origin, { active: true });
    assert.equal(response.status, 200);
    response = await postJson(`${origin}/api/likee/videos/${created.id}/bookmark`, member, origin, { active: true });
    assert.equal(response.status, 200);
    response = await postJson(`${origin}/api/likee/videos/${created.id}/follow`, member, origin, { active: true });
    assert.equal(response.status, 200);
    let memberVideo = (await response.json()).video;
    assert.equal(memberVideo.following, true);
    assert.equal(memberVideo.liked, true);
    assert.equal(memberVideo.reposted, true);
    assert.equal(memberVideo.bookmarked, true);
    assert.equal(memberVideo.likes, 1);
    assert.equal(memberVideo.reposts, 1);
    assert.equal(memberVideo.bookmarks, 1);
    assert.equal((await postJson(`${origin}/api/likee/videos/${created.id}/follow`, creator, origin, { active: true })).status, 400,
      'self-follow is rejected');

    response = await postJson(`${origin}/api/likee/videos/${created.id}/comments`, member, origin, { text: 'TEST fixture comment' });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).comment.text, 'TEST fixture comment');
    const comments = await (await get(`/api/likee/videos/${created.id}/comments`, creator)).json();
    assert.equal(comments.comments.length, 1);
    assert.equal(comments.comments[0].mine, false);
    assert.equal(comments.comments[0].text, 'TEST fixture comment');

    response = await get('/api/likee/videos', member);
    videos = (await response.json()).videos;
    assert.equal(videos.length, 1);
    memberVideo = videos[0];
    assert.equal(memberVideo.mine, false);
    assert.equal(memberVideo.following, true);
    assert.equal(memberVideo.liked, true);
    assert.equal(memberVideo.comments, 1);

    const firstChat = await directChatStore.createConversation('likee-it-creator', 'likee_test_member');
    const secondChat = await directChatStore.createConversation('likee-it-creator', 'likee_test_peer');
    const outsiderChat = await directChatStore.createConversation('likee-it-outsider', 'likee_test_peer');
    assert.ok(firstChat && secondChat && outsiderChat);
    assert.notEqual(firstChat.id, secondChat.id);
    const requestId = crypto.randomUUID();
    const sharePath = `${origin}/api/likee/videos/${created.id}/share`;
    const denied = await postJson(sharePath, creator, origin, {
      conversationIds: [firstChat.id, outsiderChat.id], requestId: crypto.randomUUID()
    });
    assert.equal(denied.status, 403, 'one non-member conversation denies the entire multi-chat share');
    const untouched = await pool.query(`SELECT count(*)::int AS n FROM stemma_direct_chat_messages WHERE conversation_id = ANY($1::bigint[])`, [[firstChat.id, outsiderChat.id]]);
    assert.equal(untouched.rows[0].n, 0, 'denied share leaves no partial chat messages');

    response = await postJson(sharePath, creator, origin, { conversationIds: [firstChat.id, secondChat.id], requestId });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()), { shared: [firstChat.id, secondChat.id], alreadyShared: false });
    const persistedMessages = await pool.query(`SELECT conversation_id::text AS id,author_subject,text
      FROM stemma_direct_chat_messages WHERE conversation_id = ANY($1::bigint[]) ORDER BY conversation_id`, [[firstChat.id, secondChat.id]]);
    assert.equal(persistedMessages.rows.length, 2);
    for (const row of persistedMessages.rows) {
      assert.equal(row.author_subject, 'likee-it-creator');
      assert.equal(row.text, `Likee video\n#likee/video/${created.id}`);
    }
    response = await postJson(sharePath, creator, origin, { conversationIds: [firstChat.id, secondChat.id], requestId });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()), { shared: [firstChat.id, secondChat.id], alreadyShared: true },
      'replaying the same authenticated request id and payload is idempotent');
    const afterReplay = await pool.query(`SELECT count(*)::int AS n FROM stemma_direct_chat_messages WHERE conversation_id = ANY($1::bigint[])`, [[firstChat.id, secondChat.id]]);
    assert.equal(afterReplay.rows[0].n, 2, 'idempotent retry does not duplicate chat messages');
    response = await postJson(sharePath, creator, origin, { conversationIds: [firstChat.id], requestId });
    assert.equal(response.status, 409, 'request id cannot be reused with a different payload');

    const persistedVideo = await pool.query('SELECT data, byte_size FROM stemma_likee_videos WHERE id = $1::uuid', [created.id]);
    assert.deepEqual(Buffer.from(persistedVideo.rows[0].data), media);
    assert.equal(persistedVideo.rows[0].byte_size, media.length);

    const photoBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    response = await postJson(`${origin}/api/likee/videos`, creator, origin, {
      caption: 'TEST fixture: Likee photo persistence', mimeType: 'image/png', data: photoBytes.toString('base64')
    });
    assert.equal(response.status, 201, 'the expanded database mime constraint permits a stored photo');
    const photo = (await response.json()).video;
    const photoDto = await (await get(`/api/likee/videos/${photo.id}`, creator)).json();
    assert.equal(photoDto.video.mimeType, 'image/png');
    response = await get(photo.mediaUrl, creator);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), photoBytes);
    const persistedPhoto = await pool.query('SELECT data, byte_size, mime_type FROM stemma_likee_videos WHERE id = $1::uuid', [photo.id]);
    assert.deepEqual(Buffer.from(persistedPhoto.rows[0].data), photoBytes);
    assert.equal(persistedPhoto.rows[0].byte_size, photoBytes.length);
    assert.equal(persistedPhoto.rows[0].mime_type, 'image/png');
  } finally {
    if (harness) await harness.close();
    if (pool) await pool.end();
    if (schemaCreated) await admin.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => {});
    await admin.end();
  }
});
