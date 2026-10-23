const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const esbuild = require('esbuild');
const { webcrypto } = require('node:crypto');
const disk = new Map();
const writes = [];
const mock = {
  async load({ key }) { return { value: disk.get(key) ?? null }; },
  async save({ key, value }) { writes.push(key); disk.set(key, value); },
  async remove({ key }) { disk.delete(key); },
  async flushCookies() {}
};
const source = fs.readFileSync(__dirname + '/native-cache.js', 'utf8').replace("import { registerPlugin } from '@capacitor/core';", 'const registerPlugin=()=>mock;');
const compiled = esbuild.transformSync(source, { format: 'cjs', target: 'node22' }).code;
const sandbox = { exports: {}, module: { exports: {} }, mock, crypto: webcrypto, TextEncoder, console };
vm.runInNewContext(compiled, sandbox);
const { DurableResponseCache } = sandbox.module.exports;
(async () => {
  const cache = new DurableResponseCache();
  await cache.initialize();
  await cache.activate('alice@example.invalid');
  const path = '/api/pulse/deduped-fixture';
  const body = { pulse: [{ id: 'same-payload', value: 4 }] };
  await cache.put(path, body, 100);
  const responseKey = 'response-' + Array.from(new Uint8Array(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode('alice@example.invalid\n' + path))), x => x.toString(16).padStart(2, '0')).join('');
  assert.equal(writes.filter(key => key === responseKey).length, 1, 'first response writes its payload');

  await cache.put(path, body, 200);
  assert.equal(writes.filter(key => key === responseKey).length, 1, 'identical body skips a redundant durable response write');
  assert.equal(writes.filter(key => key === 'response-index-v2').length, 3, 'index refresh preserves the newer saved-at timestamp');
  assert.equal((await cache.get(path)).at, 200, 'warm cache reports refreshed timestamp');

  const restarted = new DurableResponseCache();
  await restarted.initialize();
  const saved = await restarted.get(path);
  assert.equal(saved.at, 200, 'cold read uses the refreshed index timestamp');
  assert.deepEqual(JSON.parse(JSON.stringify(saved.body)), body);
  await restarted.put(path, { pulse: [{ id: 'changed-payload' }] }, 300);
  assert.equal(writes.filter(key => key === responseKey).length, 2, 'changed body is written to durable response file');
  console.log(JSON.stringify({ unchangedBodyWriteSkipped: true, savedAtRefreshed: true, coldRestartTimestamp: true, changedBodyWritten: true }));
})().catch(error => { console.error(error); process.exitCode = 1; });
