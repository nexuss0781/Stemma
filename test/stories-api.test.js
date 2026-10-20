import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import crypto from 'node:crypto';
import test from 'node:test';
import signature from 'cookie-signature';
import session from 'express-session';
import pg from 'pg';
import { buildConfig, createApp } from '../server.js';
import { createStoryStore, readVideoDuration, validateStoryBody } from '../stories-api.js';
import { MAX_ATTACHMENT_BYTES } from '../attachments-api.js';

const SESSION_SECRET = 'stories-api-tests-use-a-long-session-secret';
const STORY_ID = '1f00aa00-0a00-4a00-8a00-000000000001';
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const google = subject => ({ provider: 'google', subject });

async function createHarness(storyStore) {
  const config = buildConfig({ NODE_ENV: 'test', SESSION_SECRET });
  const sessionStore = new session.MemoryStore();
  const app = createApp({ config, sessionStore, storyStore });
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
const imageBody = (data = PNG, extra = {}) => ({ name: 'story.png', mimeType: 'image/png', data: data.toString('base64'), ...extra });
const post = (url, cookie, origin, body) => fetch(url, { method: 'POST', headers: { ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}), 'content-type': 'application/json' }, body: JSON.stringify(body) });

function box(type, payload) {
  const output = Buffer.alloc(8 + payload.length);
  output.writeUInt32BE(output.length, 0);
  output.write(type, 4, 4, 'ascii');
  payload.copy(output, 8);
  return output;
}
function durationHeader(type, timescale, duration) {
  const payload = Buffer.alloc(20);
  payload.writeUInt32BE(timescale, 12);
  payload.writeUInt32BE(duration, 16);
  return box(type, payload);
}
function makeMp4({ durationMs = 50_000, handler = 'vide', mdhdMs = durationMs, sttsMs = durationMs, fragmented = false } = {}) {
  const ftyp = box('ftyp', Buffer.from('isom\0\0\0\0isom', 'ascii'));
  const movieHeader = durationHeader('mvhd', 1000, durationMs);
  const mediaHeader = durationHeader('mdhd', 1000, mdhdMs);
  const handlerPayload = Buffer.alloc(12);
  handlerPayload.write(handler, 8, 4, 'ascii');
  const mediaHandler = box('hdlr', handlerPayload);
  const sttsPayload = Buffer.alloc(16);
  sttsPayload.writeUInt32BE(1, 4);
  sttsPayload.writeUInt32BE(50, 8);
  sttsPayload.writeUInt32BE(sttsMs / 50, 12);
  const stts = box('stts', sttsPayload);
  const visualEntryFields = Buffer.alloc(78);
  visualEntryFields.writeUInt16BE(640, 24);
  visualEntryFields.writeUInt16BE(480, 26);
  const visualEntry = box('avc1', Buffer.concat([visualEntryFields, box('avcC', Buffer.from([1, 100, 0, 31, 255, 224, 0]))]));
  const stsdPayload = Buffer.alloc(8);
  stsdPayload.writeUInt32BE(1, 4);
  const stsd = box('stsd', Buffer.concat([stsdPayload, visualEntry]));
  const stszPayload = Buffer.alloc(12);
  stszPayload.writeUInt32BE(1, 4);
  stszPayload.writeUInt32BE(50, 8);
  const stsz = box('stsz', stszPayload);
  const stscPayload = Buffer.alloc(20);
  stscPayload.writeUInt32BE(1, 4);
  stscPayload.writeUInt32BE(1, 8);
  stscPayload.writeUInt32BE(50, 12);
  stscPayload.writeUInt32BE(1, 16);
  const stsc = box('stsc', stscPayload);
  const buildMovie = chunkOffset => {
    const stcoPayload = Buffer.alloc(12);
    stcoPayload.writeUInt32BE(1, 4);
    stcoPayload.writeUInt32BE(chunkOffset, 8);
    const stco = box('stco', stcoPayload);
    const stbl = box('stbl', Buffer.concat([stsd, stts, stsc, stsz, stco]));
    const minf = box('minf', stbl);
    const mdia = box('mdia', Buffer.concat([mediaHeader, mediaHandler, minf]));
    const trak = box('trak', mdia);
    return box('moov', Buffer.concat([movieHeader, trak]));
  };
  const placeholder = buildMovie(0);
  const chunkOffset = ftyp.length + placeholder.length + 8;
  const movie = buildMovie(chunkOffset);
  const media = box('mdat', Buffer.alloc(50, 1));
  return Buffer.concat([ftyp, movie, ...(fragmented ? [box('moof', Buffer.alloc(8))] : []), media]);
}
function makeFragmentedMp4({ sampleDurationMs = 1000, sampleCount = 50, handler = 'vide', mdhdMs = 0, omitDefaultDuration = false } = {}) {
  const ftyp = box('ftyp', Buffer.from('iso6\0\0\0\0iso6', 'ascii'));
  const movieHeader = durationHeader('mvhd', 1000, 0);
  const trackHeaderPayload = Buffer.alloc(20);
  trackHeaderPayload.writeUInt32BE(1, 12);
  const trackHeader = box('tkhd', trackHeaderPayload);
  const mediaHeader = durationHeader('mdhd', 1000, mdhdMs);
  const handlerPayload = Buffer.alloc(12);
  handlerPayload.write(handler, 8, 4, 'ascii');
  const mediaHandler = box('hdlr', handlerPayload);
  const visualFields = Buffer.alloc(78);
  visualFields.writeUInt16BE(640, 24);
  visualFields.writeUInt16BE(480, 26);
  const visualEntry = box('avc1', Buffer.concat([visualFields, box('avcC', Buffer.from([1, 100, 0, 31, 255, 224, 0]))]));
  const stsdPayload = Buffer.alloc(8);
  stsdPayload.writeUInt32BE(1, 4);
  const stsd = box('stsd', Buffer.concat([stsdPayload, visualEntry]));
  const emptyTable = type => box(type, Buffer.alloc(8));
  const emptyStszPayload = Buffer.alloc(12);
  const stbl = box('stbl', Buffer.concat([stsd, emptyTable('stts'), emptyTable('stsc'), box('stsz', emptyStszPayload), emptyTable('stco')]));
  const minf = box('minf', stbl);
  const mdia = box('mdia', Buffer.concat([mediaHeader, mediaHandler, minf]));
  const track = box('trak', Buffer.concat([trackHeader, mdia]));
  const trexPayload = Buffer.alloc(24);
  trexPayload.writeUInt32BE(1, 4);
  trexPayload.writeUInt32BE(1, 8);
  trexPayload.writeUInt32BE(omitDefaultDuration ? 0 : sampleDurationMs, 12);
  trexPayload.writeUInt32BE(1, 16);
  const movieExtends = box('mvex', box('trex', trexPayload));
  const movie = box('moov', Buffer.concat([movieHeader, track, movieExtends]));
  const tfhdPayload = Buffer.alloc(8);
  tfhdPayload.writeUIntBE(0x020000, 1, 3);
  tfhdPayload.writeUInt32BE(1, 4);
  const tfhd = box('tfhd', tfhdPayload);
  const tfdtPayload = Buffer.alloc(8);
  const tfdt = box('tfdt', tfdtPayload);
  const makeMoof = dataOffset => {
    const trunPayload = Buffer.alloc(12);
    trunPayload[0] = 0;
    trunPayload.writeUIntBE(0x000001, 1, 3);
    trunPayload.writeUInt32BE(sampleCount, 4);
    trunPayload.writeInt32BE(dataOffset, 8);
    const trun = box('trun', trunPayload);
    const mfhdPayload = Buffer.alloc(8);
    mfhdPayload.writeUInt32BE(1, 4);
    return box('moof', Buffer.concat([box('mfhd', mfhdPayload), box('traf', Buffer.concat([tfhd, tfdt, trun]))]));
  };
  const provisional = makeMoof(0);
  const moof = makeMoof(provisional.length + 8);
  const media = box('mdat', Buffer.alloc(sampleCount, 1));
  return Buffer.concat([ftyp, movie, moof, media]);
}

 test('story attachment validation accepts safe images and measured normal MP4/MOV through exactly 50 seconds', () => {
  assert.deepEqual(validateStoryBody(imageBody()), { name: 'story.png', mimeType: 'image/png', size: PNG.length, data: PNG, description: '' });
  const video = makeMp4();
  assert.equal(readVideoDuration(video), 50);
  assert.equal(validateStoryBody({ name: 'clip.mp4', mimeType: 'video/mp4', data: video.toString('base64'), description: '  hello  ' }).description, 'hello');
  assert.equal(readVideoDuration(makeFragmentedMp4()), 50, 'fragment durations are derived from trex/tfhd defaults and trun samples');
  assert.throws(() => readVideoDuration(makeFragmentedMp4({ sampleCount: 51 })), /50 seconds or shorter/);
  const invalidVideos = [
    makeMp4({ durationMs: 50_050, mdhdMs: 50_050, sttsMs: 50_050 }),
    makeMp4({ handler: 'soun' }),
    makeMp4({ mdhdMs: 52_000 }),
    makeMp4({ fragmented: true }),
    makeFragmentedMp4({ sampleDurationMs: 1001 }),
    makeFragmentedMp4({ handler: 'soun' }),
    makeFragmentedMp4({ omitDefaultDuration: true }),
    makeFragmentedMp4({ mdhdMs: 52_000 }),
    Buffer.from('not an mp4')
  ];
  for (const data of invalidVideos) assert.equal(validateStoryBody({ name: 'bad.mp4', mimeType: 'video/mp4', data: data.toString('base64') }), null);
  for (const body of [
    { ...imageBody(), mimeType: 'image/svg+xml', name: 'x.svg' },
    { ...imageBody(), name: 'x.jpg' },
    { ...imageBody(Buffer.concat([PNG, Buffer.alloc(MAX_ATTACHMENT_BYTES)])) },
    { ...imageBody(), description: 'x'.repeat(1001) },
    { ...imageBody(), description: 'bad\0text' },
    { ...imageBody(), extra: true }
  ]) assert.equal(validateStoryBody(body), null);
});

test('native Chromium captureStream trim uses fragment timing despite recorder mdhd track headers', () => {
  const clip = readFileSync(new URL('./fixtures/stories-browser-trim.mp4', import.meta.url));
  const duration = readVideoDuration(clip);
  assert.ok(Math.abs(duration - 2.1331) < 0.001, `unexpected fragment-derived duration: ${duration}`);
  assert.ok(validateStoryBody({ name: 'trim.mp4', mimeType: 'video/mp4', data: clip.toString('base64') }));
});

test('long Chromium browser trim uses validated fragment duration despite rounded paired-track headers', () => {
  const clip = readFileSync(new URL('./fixtures/stories-browser-long-trim.mp4', import.meta.url));
  const duration = readVideoDuration(clip);
  assert.ok(Math.abs(duration - 49.532033) < 0.001, `unexpected fragment-derived duration: ${duration}`);
  assert.ok(validateStoryBody({ name: 'long-trim.mp4', mimeType: 'video/mp4', data: clip.toString('base64') }));
});

test('stories API requires sign-in and same-origin writes, provides global active feed/media, and permits deletion only by owner', async t => {
  let exists = true;
  const calls = [];
  const story = { id: STORY_ID, url: `/api/pulse/stories/${STORY_ID}/media`, mimeType: 'image/png', description: 'hello',
    createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-03T00:00:00.000Z', mine: false,
    owner: { nickName: 'Owner', username: 'writer', avatarUrl: `/api/pulse/stories/${STORY_ID}/avatar` } };
  const store = {
    async listStories(subject) { calls.push(['list', subject]); return { stories: exists ? [story] : [], serverNow: new Date('2026-01-02T00:00:00Z') }; },
    async createStory(subject, attachment) { calls.push(['create', subject, attachment.description]); return { ...story, mine: true }; },
    async deleteStory(subject, id) { calls.push(['delete', subject, id]); if (subject !== 'owner' || !exists) return false; exists = false; return true; },
    async getStoryMedia(id) { calls.push(['media', id]); return exists ? { id, mimeType: 'image/png', data: PNG, size: PNG.length } : null; },
    async getStoryAvatar(id) { calls.push(['avatar', id]); return exists ? { mimeType: 'image/png', data: PNG } : null; }
  };
  const h = await createHarness(store);
  t.after(() => h.close());
  const owner = await h.cookieFor('story-owner', google('owner'));
  const peer = await h.cookieFor('story-peer', google('peer'));
  assert.equal((await fetch(`${h.origin}/api/pulse/stories`)).status, 401);
  let response = await post(`${h.origin}/api/pulse/stories`, owner, null, imageBody());
  assert.equal(response.status, 403);
  assert.match(response.headers.get('cache-control'), /no-store/);
  response = await post(`${h.origin}/api/pulse/stories`, owner, h.origin, imageBody());
  assert.equal(response.status, 201);
  assert.deepEqual(calls.find(row => row[0] === 'create'), ['create', 'owner', '']);

  response = await fetch(`${h.origin}/api/pulse/stories`, { headers: { cookie: peer } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.deepEqual(await response.json(), { stories: [story], serverNow: '2026-01-02T00:00:00.000Z' });
  response = await fetch(`${h.origin}/api/pulse/stories/${STORY_ID}/media`, { headers: { cookie: peer } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG);
  response = await fetch(`${h.origin}/api/pulse/stories/${STORY_ID}/media`, { headers: { cookie: peer, range: 'bytes=1-3' } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), `bytes 1-3/${PNG.length}`);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG.subarray(1, 4));
  response = await fetch(`${h.origin}/api/pulse/stories/${STORY_ID}/avatar`, { headers: { cookie: peer } });
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG);

  response = await fetch(`${h.origin}/api/pulse/stories/${STORY_ID}`, { method: 'DELETE', headers: { cookie: peer, origin: h.origin } });
  assert.equal(response.status, 404);
  response = await fetch(`${h.origin}/api/pulse/stories/${STORY_ID}`, { method: 'DELETE', headers: { cookie: owner } });
  assert.equal(response.status, 403, 'deletion requires same-origin CSRF verification');
  response = await fetch(`${h.origin}/api/pulse/stories/${STORY_ID}`, { method: 'DELETE', headers: { cookie: owner, origin: h.origin } });
  assert.equal(response.status, 204);
  assert.equal((await fetch(`${h.origin}/api/pulse/stories/${STORY_ID}/media`, { headers: { cookie: peer } })).status, 404);
});

test('PostgreSQL stories persist and expire at exactly created_at + 48 hours, including media/avatar endpoints', {
  skip: process.env.STEMMA_STORIES_POSTGRES_TEST !== '1', timeout: 120000
}, async t => {
  const { Pool } = pg;
  const schema = `stemma_stories_${crypto.randomUUID().replaceAll('-', '')}`;
  const connection = { host: '127.0.0.1', port: 5432, database: 'stemma_notification_test', user: 'stemma_notification_test', password: 'local-notification-test-only', max: 5, connectionTimeoutMillis: 5000 };
  const admin = new Pool(connection);
  let pool;
  let h;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = { ...connection, options: `-c search_path=${schema}` };
    pool = new Pool(scoped);
    await pool.query(`CREATE TABLE stemma_google_identities (google_subject VARCHAR(255) PRIMARY KEY, verified_email VARCHAR(320) NOT NULL DEFAULT '')`);
    await pool.query(`CREATE TABLE stemma_student_profiles (
      google_subject VARCHAR(255) PRIMARY KEY REFERENCES stemma_google_identities ON DELETE CASCADE,
      nick_name TEXT NOT NULL DEFAULT '', username TEXT NOT NULL DEFAULT '',
      profile_image BYTEA, profile_image_mime TEXT
    )`);
    await pool.query(`INSERT INTO stemma_google_identities (google_subject) VALUES ('story-alpha'), ('story-beta')`);
    await pool.query(`INSERT INTO stemma_student_profiles (google_subject, nick_name, username, profile_image, profile_image_mime)
      VALUES ('story-alpha', 'Alpha', 'alpha', $1, 'image/png')`, [PNG]);
    const store = createStoryStore(pool);
    await store.migrate();
    await store.migrate();
    h = await createHarness(store);
    const alpha = await h.cookieFor('story-alpha-session', google('story-alpha'));
    const beta = await h.cookieFor('story-beta-session', google('story-beta'));
    let response = await post(`${h.origin}/api/pulse/stories`, alpha, h.origin, imageBody());
    assert.equal(response.status, 201);
    const { story } = await response.json();
    assert.equal(story.owner.username, 'alpha');
    assert.equal(story.owner.avatarUrl, `/api/pulse/stories/${story.id}/avatar`);
    const feed = await fetch(`${h.origin}/api/pulse/stories`, { headers: { cookie: beta } });
    assert.equal((await feed.json()).stories[0].id, story.id, 'another signed-in account can see the global story');
    assert.equal((await fetch(`${h.origin}${story.url}`, { headers: { cookie: beta } })).status, 200);
    assert.equal((await fetch(`${h.origin}${story.owner.avatarUrl}`, { headers: { cookie: beta } })).status, 200);
    const stored = await pool.query(`SELECT created_at, expires_at, expires_at = created_at + INTERVAL '48 hours' AS exact FROM stemma_pulse_stories WHERE id=$1::uuid`, [story.id]);
    assert.equal(stored.rows[0].exact, true);
    await pool.query(`UPDATE stemma_pulse_stories SET created_at = statement_timestamp() - INTERVAL '48 hours' WHERE id=$1::uuid`, [story.id]);
    const expired = await pool.query(`SELECT expires_at <= statement_timestamp() AS expired FROM stemma_pulse_stories WHERE id=$1::uuid`, [story.id]);
    assert.equal(expired.rows[0].expired, true);
    assert.equal((await fetch(`${h.origin}${story.url}`, { headers: { cookie: beta } })).status, 404);
    assert.equal((await fetch(`${h.origin}${story.owner.avatarUrl}`, { headers: { cookie: beta } })).status, 404);
    const expiredFeed = await fetch(`${h.origin}/api/pulse/stories`, { headers: { cookie: beta } });
    assert.equal((await expiredFeed.json()).stories.length, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM stemma_pulse_stories WHERE id=$1::uuid', [story.id])).rows[0].n, 0, 'feed opportunistically removes expired rows');
  } finally {
    if (h) await h.close();
    if (pool) await pool.end().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await admin.end();
  }
});
