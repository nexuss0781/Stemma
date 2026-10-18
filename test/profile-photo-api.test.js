import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import signature from 'cookie-signature';
import session from 'express-session';
import { buildConfig, createApp } from '../server.js';

const SESSION_SECRET = 'photo-route-tests-have-a-long-session-secret-value';
function png() {
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let bit = 0; bit < 8; bit += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc = bytes => {
    let c = 0xffffffff;
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, bytes) => {
    const typeBytes = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(bytes.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc(Buffer.concat([typeBytes, bytes])));
    return Buffer.concat([len, typeBytes, bytes, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', Buffer.from([0x78, 0x9c, 0x63, 0, 0, 0, 2, 0, 1])), chunk('IEND', Buffer.alloc(0))]);
}
async function createHarness({ store } = {}) {
  const config = buildConfig({ NODE_ENV: 'test', SESSION_SECRET });
  const sessions = new session.MemoryStore();
  const app = createApp({ config, sessionStore: sessions, studentProfileStore: store });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function cookie(id, subject, provider = 'google') {
    const data = { cookie: { httpOnly: true, path: '/', sameSite: 'lax', secure: false }, stemmaUser: { provider, subject, email: 'ignored@example.test' } };
    await new Promise((resolve, reject) => sessions.set(id, data, error => error ? reject(error) : resolve()));
    return `stemma.sid=${encodeURIComponent(`s:${signature.sign(id, SESSION_SECRET)}`)}`;
  }
  return { origin, server, cookie, async close() { server.close(); await once(server, 'close'); } };
}

function memoryStore({ subjects = ['google-A', 'google-B'], fail = false } = {}) {
  const rows = new Set(subjects);
  const photos = new Map();
  const writes = [];
  return {
    photos, writes,
    async getStudentPhoto(subject) {
      if (fail) throw new Error('internal database error');
      return photos.get(subject) ?? null;
    },
    async saveStudentPhoto(subject, image, options) {
      if (fail) throw new Error('internal database error');
      writes.push({ subject, image, options });
      if (!rows.has(subject)) return { saved: false, reason: 'not-found' };
      if (options.onlyIfAbsent && photos.has(subject)) return { saved: false, reason: 'exists' };
      photos.set(subject, { ...image, data: Buffer.from(image.data) });
      return { saved: true };
    }
  };
}

test('photo API authenticates, protects same-origin writes, validates bytes, and serves only the session subject image', async t => {
  const store = memoryStore();
  const h = await createHarness({ store }); t.after(() => h.close());
  const a = await h.cookie('a', 'google-A');
  const b = await h.cookie('b', 'google-B');
  const fayda = await h.cookie('fayda', 'google-A', 'fayda');
  const endpoint = `${h.origin}/api/student-profile/photo`;
  const validBytes = png();

  const unauth = await fetch(endpoint);
  assert.equal(unauth.status, 401);
  const nonGoogle = await fetch(endpoint, { headers: { cookie: fayda } });
  assert.equal(nonGoogle.status, 403);
  const empty = await fetch(endpoint, { headers: { cookie: a } });
  assert.equal(empty.status, 404);
  assert.deepEqual(await empty.json(), { error: 'Profile photo not found.' });

  const wrongOrigin = await fetch(endpoint, { method: 'PUT', headers: { cookie: a, origin: 'https://attacker.example', 'content-type': 'image/png' }, body: validBytes });
  assert.equal(wrongOrigin.status, 403);
  const noOrigin = await fetch(endpoint, { method: 'PUT', headers: { cookie: a, 'content-type': 'image/png' }, body: validBytes });
  assert.equal(noOrigin.status, 403);
  const unsupported = await fetch(endpoint, { method: 'PUT', headers: { cookie: a, origin: h.origin, 'content-type': 'image/gif' }, body: validBytes });
  assert.equal(unsupported.status, 415);
  const invalid = await fetch(endpoint, { method: 'PUT', headers: { cookie: a, origin: h.origin, 'content-type': 'image/png' }, body: Buffer.from('<svg/>') });
  assert.equal(invalid.status, 400);
  const tooLarge = await fetch(endpoint, { method: 'PUT', headers: { cookie: a, origin: h.origin, 'content-type': 'image/png' }, body: Buffer.alloc(1024 * 1024 + 1) });
  assert.equal(tooLarge.status, 413);
  assert.match(tooLarge.headers.get('content-type'), /^application\/json/);
  assert.equal(store.writes.length, 0);

  const imported = await fetch(endpoint, { method: 'PUT', headers: { cookie: a, origin: h.origin, 'content-type': 'image/png', 'if-none-match': '*' }, body: validBytes });
  assert.equal(imported.status, 200);
  assert.deepEqual(await imported.json(), { saved: true });
  assert.deepEqual(store.writes[0].subject, 'google-A');
  assert.deepEqual(store.writes[0].options, { onlyIfAbsent: true });
  assert.equal(store.writes[0].image.mimeType, 'image/png');

  const ownPhoto = await fetch(endpoint, { headers: { cookie: a, 'x-account-key': 'google-B' } });
  assert.equal(ownPhoto.status, 200);
  assert.equal(ownPhoto.headers.get('content-type'), 'image/png');
  assert.equal(ownPhoto.headers.get('cache-control'), 'private, no-store');
  assert.equal(ownPhoto.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await ownPhoto.arrayBuffer()), validBytes);
  const otherPhoto = await fetch(endpoint, { headers: { cookie: b } });
  assert.equal(otherPhoto.status, 404);

  const existingImport = await fetch(endpoint, { method: 'PUT', headers: { cookie: a, origin: h.origin, 'content-type': 'image/png', 'if-none-match': '*' }, body: validBytes });
  assert.equal(existingImport.status, 412);
  assert.deepEqual(await existingImport.json(), { error: 'A profile photo already exists.' });
  assert.equal(store.writes[1].subject, 'google-A');
  const replacement = await fetch(endpoint, { method: 'PUT', headers: { cookie: a, origin: h.origin, 'content-type': 'image/png' }, body: validBytes });
  assert.equal(replacement.status, 200);
  assert.deepEqual(store.writes[2].options, { onlyIfAbsent: false });
});

test('photo API reports missing profile row as 409 and storage failures as consistent JSON 503', async t => {
  const missing = memoryStore({ subjects: [] });
  const h = await createHarness({ store: missing }); t.after(() => h.close());
  const cookie = await h.cookie('missing', 'no-profile-row');
  const response = await fetch(`${h.origin}/api/student-profile/photo`, {
    method: 'PUT', headers: { cookie, origin: h.origin, 'content-type': 'image/png' }, body: png()
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'Student profile must exist before a photo can be saved.' });

  const broken = await createHarness({ store: memoryStore({ fail: true }) }); t.after(() => broken.close());
  const brokenCookie = await broken.cookie('broken', 'google-A');
  const get = await fetch(`${broken.origin}/api/student-profile/photo`, { headers: { cookie: brokenCookie } });
  assert.equal(get.status, 503);
  assert.deepEqual(await get.json(), { error: 'Student profile service is unavailable.' });
  const put = await fetch(`${broken.origin}/api/student-profile/photo`, {
    method: 'PUT', headers: { cookie: brokenCookie, origin: broken.origin, 'content-type': 'image/png' }, body: png()
  });
  assert.equal(put.status, 503);
  assert.deepEqual(await put.json(), { error: 'Student profile service is unavailable.' });
});
