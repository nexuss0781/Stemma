import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';

const source = await readFile(new URL('../profile-photo.js', import.meta.url), 'utf8');

function createStore(fetch) {
  const context = vm.createContext({ Blob, fetch });
  vm.runInContext(source, context, { filename: 'profile-photo.js' });
  return { Store: context.AuthenticatedProfilePhotoStore, Error: context.ProfilePhotoHttpError };
}
const response = (status, { type = '', body = new Blob(), json = null, headers = {} } = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: name => headers[name.toLowerCase()] ?? (name.toLowerCase() === 'content-type' ? type : null) },
  blob: async () => body,
  json: async () => json
});

test('authenticated photo GET returns validated image blobs and only 404 means absent', async () => {
  const png = new Blob(['photo'], { type: 'image/png' });
  const calls = [];
  const h = createStore(async (...args) => {
    calls.push(args);
    return response(200, { type: 'image/png', body: png, headers: { 'content-length': String(png.size) } });
  });
  const store = new h.Store();
  assert.equal(await store.get(), png);
  assert.equal(calls[0][1].method, 'GET');
  assert.equal(calls[0][1].credentials, 'same-origin');
  assert.equal(calls[0][1].cache, 'no-store');
  assert.equal(calls[0][1].headers.Accept, 'image/png, image/jpeg, image/webp');
  assert.equal(calls[0][0], '/api/student-profile/photo');
  for (const [status, expected] of [[404, null], [401, 401], [503, 503]]) {
    const instance = new (createStore(async () => response(status)).Store)();
    if (status === 404) assert.equal(await instance.get(), expected);
    else await assert.rejects(instance.get(), error => error.status === expected);
  }
});

test('authenticated photo GET rejects unsupported MIME, invalid lengths, and oversized blobs', async () => {
  for (const result of [
    response(200, { type: 'image/gif', body: new Blob(['gif'], { type: 'image/gif' }) }),
    response(200, { type: 'image/png', body: new Blob(['tiny'], { type: 'image/png' }), headers: { 'content-length': '999' } }),
    response(200, { type: 'image/png', body: new Blob([new Uint8Array(1024 * 1024 + 1)], { type: 'image/png' }) }),
    response(200, { type: 'image/png', body: new Blob(['tiny'], { type: 'image/png' }), headers: { 'content-length': 'not-a-number' } })
  ]) {
    const store = new (createStore(async () => result).Store)();
    await assert.rejects(store.get(), /unsupported|length|size|1 MiB/i);
  }
});

test('authenticated photo PUT sends raw Blob with canonical MIME and optional create-only precondition', async () => {
  const photo = new Blob(['raw-image-bytes'], { type: 'image/webp' });
  const calls = [];
  const store = new (createStore(async (...args) => {
    calls.push(args);
    return response(200, { json: { saved: true } });
  }).Store)();
  assert.deepEqual(await store.put(photo), { saved: true });
  assert.deepEqual(await store.put(photo, { onlyIfAbsent: true }), { saved: true });
  for (const [url, options] of calls) {
    assert.equal(url, '/api/student-profile/photo');
    assert.equal(options.method, 'PUT');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.body, photo, 'upload body is the Blob itself, never Base64 or multipart');
    assert.equal(options.headers['Content-Type'], 'image/webp');
    assert.equal('accountId' in options.headers, false);
  }
  assert.equal(calls[0][1].headers['If-None-Match'], undefined);
  assert.equal(calls[1][1].headers['If-None-Match'], '*');
});

test('PUT failure statuses and invalid client payloads never report a successful save', async () => {
  for (const status of [401, 409, 412, 503]) {
    const store = new (createStore(async () => response(status)).Store)();
    await assert.rejects(store.put(new Blob(['photo'], { type: 'image/png' })), error => error.status === status);
  }
  const store = new (createStore(async () => response(200, { json: { saved: false } })).Store)();
  await assert.rejects(store.put(new Blob(['photo'], { type: 'image/png' })), /did not confirm/);
  const noResponse = new (createStore(async () => response(204)).Store)();
  assert.equal((await noResponse.put(new Blob(['photo'], { type: 'image/jpeg' }))).saved, true);
  for (const blob of [
    new Blob(['svg'], { type: 'image/svg+xml' }),
    new Blob([], { type: 'image/png' }),
    new Blob([new Uint8Array(1024 * 1024 + 1)], { type: 'image/png' })
  ]) await assert.rejects(store.put(blob), /PNG, JPEG, or WebP|1 MiB/);
});

test('default native-style fetch remains bound to the browser global for reads and uploads', async () => {
  const context = vm.createContext({ Blob, absent: response(404), saved: response(200, { json: { saved: true } }) });
  vm.runInContext(`globalThis.fetch = async function (_url, options) {
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    return options.method === 'GET' ? globalThis.absent : globalThis.saved;
  };`, context);
  vm.runInContext(source, context, { filename: 'profile-photo.js' });
  const store = new context.AuthenticatedProfilePhotoStore();
  assert.equal(await store.get(), null);
  assert.equal((await store.put(new Blob(['photo'], { type: 'image/png' }))).saved, true);
});
