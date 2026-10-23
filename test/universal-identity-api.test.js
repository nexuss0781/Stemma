import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import test from 'node:test';
import { registerUniversalIdentityApi } from '../universal-identity-api.js';

async function makeHarness() {
  const app = express();
  const calls = [];
  const identityStore = {
    async isUsernameAvailable(username) { calls.push(['available', username]); return username.toLowerCase() === 'ready_handle'; },
    async getByIdentifier(identifier) {
      calls.push(['resolve', identifier]);
      return { identityId: '0bd91d03-482b-4ac4-8c2b-41a2a57680bc', id: '0bd91d03-482b-4ac4-8c2b-41a2a57680bc', username: 'ready_handle', kind: 'account', displayName: 'Ready' };
    }
  };
  const requireGoogleSession = (req, res, next) => req.get('x-test-auth') === 'google'
    ? next() : res.status(401).json({ error: 'Authentication required.' });
  registerUniversalIdentityApi(app, { identityStore, requireGoogleSession });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { origin: `http://127.0.0.1:${server.address().port}`, calls, close: async () => { server.close(); await once(server, 'close'); } };
}

test('universal identity endpoints require authentication and reject short names', async t => {
  const harness = await makeHarness();
  t.after(() => harness.close());
  const unauth = await fetch(`${harness.origin}/api/identity/availability?username=ready_handle`);
  assert.equal(unauth.status, 401);
  const short = await fetch(`${harness.origin}/api/identity/availability?username=abcd`, { headers: { 'x-test-auth': 'google' } });
  assert.deepEqual(await short.json(), { available: false });
  assert.deepEqual(harness.calls, []);
});

test('availability is case insensitive and identity resolution accepts handles and UUIDs', async t => {
  const harness = await makeHarness();
  t.after(() => harness.close());
  const headers = { 'x-test-auth': 'google' };
  const availability = await fetch(`${harness.origin}/api/identity/availability?username=READY_HANDLE`, { headers });
  assert.deepEqual(await availability.json(), { available: true });
  const byHandle = await fetch(`${harness.origin}/api/identity/resolve/ReAdY_hAnDlE`, { headers });
  const handleResult = await byHandle.json();
  assert.equal(handleResult.identity.username, 'ready_handle');
  assert.equal(handleResult.identity.identityId, '0bd91d03-482b-4ac4-8c2b-41a2a57680bc');
  assert.equal(Object.hasOwn(handleResult.identity, 'entityKey'), false);
  const byUuid = await fetch(`${harness.origin}/api/identity/resolve/0bd91d03-482b-4ac4-8c2b-41a2a57680bc`, { headers });
  assert.equal((await byUuid.json()).identity.username, 'ready_handle');
  assert.deepEqual(harness.calls.map(call => call[0]), ['available', 'resolve', 'resolve']);
});
