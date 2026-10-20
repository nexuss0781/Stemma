import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';

const source = await readFile(new URL('../profile-photo.js', import.meta.url), 'utf8');

function createIndexedDB() {
  const databases = new Map();
  const events = [];
  let mode = 'normal';

  class FakeDatabase {
    constructor(name, record) {
      this.name = name;
      this.record = record;
      this.closed = false;
      this.objectStoreNames = { contains: storeName => storeName === 'photos' && record.hasStore };
    }
    createObjectStore(storeName) {
      assert.equal(storeName, 'photos');
      this.record.hasStore = true;
      return {};
    }
    transaction(storeName, transactionMode) {
      assert.equal(storeName, 'photos');
      if (this.closed) throw new Error('database is closed');
      const staged = [];
      const transaction = {
        error: null,
        objectStore(name) {
          assert.equal(name, 'photos');
          return {
            get(key) {
              return makeRequest(() => thisRecord.values.get(key), staged, transaction, events, 'get');
            },
            put(value, key) {
              assert.equal(transactionMode, 'readwrite');
              return makeRequest(() => {
                staged.push(() => thisRecord.values.set(key, value));
                return key;
              }, staged, transaction, events, 'put');
            },
            delete(key) {
              assert.equal(transactionMode, 'readwrite');
              return makeRequest(() => {
                staged.push(() => thisRecord.values.delete(key));
                return undefined;
              }, staged, transaction, events, 'delete');
            }
          };
        }
      };
      const thisRecord = this.record;
      setTimeout(() => {
        if (this.closed) {
          transaction.error = new Error('database closed before completion');
          transaction.onabort?.({ target: transaction });
          return;
        }
        for (const commit of staged) commit();
        events.push('transaction-complete');
        transaction.oncomplete?.({ target: transaction });
      }, 5);
      return transaction;
    }
    close() { this.closed = true; }
  }

  function makeRequest(getResult, staged, transaction, eventLog, operation) {
    const request = { result: undefined, error: null, onsuccess: null, onerror: null };
    setTimeout(() => {
      try {
        request.result = getResult();
        eventLog.push(`${operation}-success`);
        request.onsuccess?.({ target: request });
      } catch (error) {
        request.error = error;
        transaction.error = error;
        request.onerror?.({ target: request });
      }
    }, 0);
    return request;
  }

  const factory = {
    databases,
    events,
    set mode(value) { mode = value; },
    open(name) {
      const request = { result: null, error: null };
      if (mode === 'throw') throw new Error('open threw');
      setTimeout(() => {
        if (mode === 'blocked') {
          request.onblocked?.({ target: request });
          return;
        }
        if (mode === 'error') {
          request.error = new Error('open failed');
          request.onerror?.({ target: request });
          return;
        }
        let record = databases.get(name);
        if (!record) {
          record = { hasStore: false, values: new Map() };
          databases.set(name, record);
          request.result = new FakeDatabase(name, record);
          request.onupgradeneeded?.({ target: request });
        } else {
          request.result = new FakeDatabase(name, record);
        }
        request.onsuccess?.({ target: request });
      }, 0);
      return request;
    }
  };
  return factory;
}

function createHarness(indexedDB = createIndexedDB(), options = {}) {
  const canvases = [];
  const canvasConfig = { contextAvailable: true, encodings: [], defaultBlobType: 'image/png', defaultSize: 32 };
  const document = {
    createElement(tag) {
      assert.equal(tag, 'canvas');
      const canvas = {
        width: 0,
        height: 0,
        getContext(type) {
          assert.equal(type, '2d');
          return canvasConfig.contextAvailable ? {
            drawImage(...args) { canvas.drawArgs = args; }
          } : null;
        },
        toBlob(callback, type, quality) {
          canvasConfig.encodings.push({ type, quality, width: canvas.width, height: canvas.height });
          const next = canvasConfig.responses?.shift();
          if (next === null) callback(null);
          else callback(next ?? new Blob(['encoded'], { type: canvasConfig.defaultBlobType, size: canvasConfig.defaultSize }));
        }
      };
      canvases.push(canvas);
      return canvas;
    }
  };
  const context = vm.createContext({
    Blob,
    document,
    indexedDB,
    ...options
  });
  vm.runInContext(source, context, { filename: 'profile-photo.js' });
  return { Store: context.DeviceProfilePhotoStore, indexedDB, canvases, canvasConfig };
}

const png = (size = 4) => new Blob([new Uint8Array(size)], { type: 'image/png' });

 test('device photos are isolated by account, committed before put resolves, and removable', async () => {
  const h = createHarness();
  const store = new h.Store();
  const first = png();
  const second = new Blob(['jpeg'], { type: 'image/jpeg' });

  await store.put('verified-one@example.test', first);
  assert.ok(h.indexedDB.events.includes('transaction-complete'), 'put resolves only after transaction completion');
  await store.put('verified-two@example.test', second);
  assert.equal(await store.get('verified-one@example.test'), first);
  assert.equal(await store.get('verified-two@example.test'), second);
  assert.equal(await store.get('not-signed-in'), null, 'there is no global or cross-account fallback');
  await store.remove('verified-one@example.test');
  assert.equal(await store.get('verified-one@example.test'), null);
  assert.equal(await store.get('verified-two@example.test'), second, 'removal affects only the selected account');
});

test('account keys and photo blobs are validated on writes and reads', async () => {
  const h = createHarness();
  const store = new h.Store();
  for (const key of ['', '  ', null, 123]) {
    await assert.rejects(store.get(key), error => error.name === 'TypeError');
    await assert.rejects(store.put(key, png()), error => error.name === 'TypeError');
    await assert.rejects(store.remove(key), error => error.name === 'TypeError');
  }
  for (const invalid of [
    { value: 'not a blob' },
    new Blob(['svg'], { type: 'image/svg+xml' }),
    new Blob(['gif'], { type: 'image/gif' }),
    new Blob([], { type: 'image/png' }),
    new Blob([new Uint8Array(10 * 1024 * 1024 + 1)], { type: 'image/webp' })
  ]) {
    await assert.rejects(store.put('account-a', invalid), /Blob|PNG|JPEG|WebP|empty|10 MiB/);
  }

  await store.put('seed-account', png());
  const record = h.indexedDB.databases.get('stemma-device-profile-photos');
  record.values.set('corrupt-account', new Blob(['svg'], { type: 'image/svg+xml' }));
  await assert.rejects(store.get('corrupt-account'), /PNG, JPEG, or WebP/,
    'stored records are validated before returning to the caller');
});

test('unavailable, blocked, and failing IndexedDB operations reject clearly', async () => {
  const unavailable = createHarness(null).Store;
  await assert.rejects(new unavailable().get('account-a'), /IndexedDB is unavailable/);

  const factory = createIndexedDB();
  const store = new (createHarness(factory).Store)();
  factory.mode = 'blocked';
  await assert.rejects(store.get('account-a'), /blocked/);
  factory.mode = 'error';
  await assert.rejects(store.put('account-a', png()), /open failed/);
  factory.mode = 'throw';
  await assert.rejects(store.remove('account-a'), /open threw/);
});

test('prepare resizes decoded images without changing aspect ratio and requests WebP at quality .88', async () => {
  const h = createHarness();
  class FakeImage {
    constructor(width, height) {
      this.naturalWidth = width;
      this.naturalHeight = height;
    }
  }
  const result = await h.Store.prepare(new FakeImage(1600, 800));
  assert.equal(result.type, 'image/png', 'PNG returned by canvas is accepted as the WebP fallback');
  assert.deepEqual([h.canvases[0].width, h.canvases[0].height], [768, 384]);
  assert.deepEqual(h.canvasConfig.encodings, [{ type: 'image/webp', quality: 0.88, width: 768, height: 384 }]);

  const portrait = createHarness();
  const webp = new Blob(['webp'], { type: 'image/webp' });
  portrait.canvasConfig.responses = [webp];
  const prepared = await portrait.Store.prepare({ naturalWidth: 320, naturalHeight: 1200 });
  assert.equal(prepared, webp);
  assert.deepEqual([portrait.canvases[0].width, portrait.canvases[0].height], [205, 768]);

  const boundary = createHarness();
  const oneMiB = new Blob([new Uint8Array(1024 * 1024)], { type: 'image/webp' });
  boundary.canvasConfig.responses = [oneMiB];
  assert.equal(await boundary.Store.prepare({ naturalWidth: 640, naturalHeight: 640 }), oneMiB,
    'avatar preparation accepts output at the exact 1 MiB upload limit');
});

test('prepare rejects invalid dimensions, unavailable canvas, null encodes, and oversized output', async () => {
  const h = createHarness();
  await assert.rejects(h.Store.prepare({ naturalWidth: 0, naturalHeight: 12 }), /dimensions/);
  h.canvasConfig.contextAvailable = false;
  await assert.rejects(h.Store.prepare({ naturalWidth: 40, naturalHeight: 20 }), /Canvas image preparation/);

  const nullEncode = createHarness();
  nullEncode.canvasConfig.responses = [null];
  await assert.rejects(nullEncode.Store.prepare({ naturalWidth: 40, naturalHeight: 20 }), /could not encode/);

  const oversized = createHarness();
  oversized.canvasConfig.responses = [
    new Blob([new Uint8Array(2 * 1024 * 1024)], { type: 'image/webp' }),
    new Blob([new Uint8Array(700 * 1024)], { type: 'image/webp' })
  ];
  const reduced = await oversized.Store.prepare({ naturalWidth: 400, naturalHeight: 200 });
  assert.ok(reduced.size <= 1024 * 1024, 'large PNG/WebP output is adaptively reduced for the server');
  assert.ok(oversized.canvases[0].width < 400, 'adaptive reduction preserves proportions by shrinking both axes');
});
