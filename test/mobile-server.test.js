import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import session from 'express-session';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { buildConfig, createApp } from '../server.js';

async function closeServer(server) {
  if (!server?.listening) return;
  server.close();
  await once(server, 'close');
}

function cookieFrom(response) {
  const setCookie = response.headers.getSetCookie?.()[0] || response.headers.get('set-cookie');
  assert.ok(setCookie, 'expected a session cookie');
  return setCookie.split(';', 1)[0];
}

function setCookieHeader(response) {
  const setCookie = response.headers.getSetCookie?.()[0] || response.headers.get('set-cookie');
  assert.ok(setCookie, 'expected a Set-Cookie header');
  return setCookie;
}

test('mobile Google sign-in exchanges a PKCE-bound one-time code for the backend session cookie', async () => {
  const providerKeys = await generateKeyPair('RS256', { modulusLength: 2048 });
  const publicJwk = await exportJWK(providerKeys.publicKey);
  Object.assign(publicJwk, { kid: 'mobile-google-test', alg: 'RS256', use: 'sig' });
  const portServer = createServer();
  portServer.listen(0, '127.0.0.1');
  await once(portServer, 'listening');
  const port = portServer.address().port;
  await closeServer(portServer);
  const appOrigin = `http://127.0.0.1:${port}`;
  const clientId = 'stemma-mobile-test.apps.googleusercontent.com';
  const config = buildConfig({
    NODE_ENV: 'test', PORT: String(port), SESSION_SECRET: 'test-only-session-secret-with-more-than-32-bytes',
    APP_ORIGIN: appOrigin, GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: 'google-test-secret'
  });
  let oauthRequest;
  const fetchImpl = async (url, options = {}) => {
    if (url === 'https://accounts.google.com/.well-known/openid-configuration') {
      return new Response(JSON.stringify({
        issuer: 'https://accounts.google.com', authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
        token_endpoint: 'https://oauth2.googleapis.com/token', jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
        response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], id_token_signing_alg_values_supported: ['RS256']
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === 'https://oauth2.googleapis.com/token') {
      const form = new URLSearchParams(options.body);
      assert.equal(form.get('code'), 'mobile-google-code');
      assert.equal(form.get('redirect_uri'), `${appOrigin}/auth/google/callback`);
      const idToken = await new SignJWT({ nonce: oauthRequest.searchParams.get('nonce'), name: 'Mobile Test', email: 'mobile@example.test', email_verified: true })
        .setProtectedHeader({ alg: 'RS256', kid: publicJwk.kid })
        .setIssuer('https://accounts.google.com').setAudience(clientId).setSubject('mobile-google-subject')
        .setIssuedAt().setExpirationTime('5m').sign(providerKeys.privateKey);
      return new Response(JSON.stringify({ access_token: 'unused', id_token: idToken }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected provider URL: ${url}`);
  };
  const app = createApp({
    config, sessionStore: new session.MemoryStore(), fetchImpl,
    jwksFactory: () => async () => providerKeys.publicKey
  });
  const server = app.listen(port, '127.0.0.1');
  await once(server, 'listening');
  const state = crypto.randomBytes(32).toString('base64url');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  try {
    const start = await fetch(`${appOrigin}/auth/mobile/start?provider=google&state=${state}&challenge=${challenge}`, { redirect: 'manual' });
    assert.equal(start.status, 303);
    const googleStart = await fetch(start.headers.get('location'), { redirect: 'manual' });
    assert.equal(googleStart.status, 303);
    const cookie = cookieFrom(googleStart);
    oauthRequest = new URL(googleStart.headers.get('location'));
    assert.equal(oauthRequest.searchParams.get('code_challenge_method'), 'S256');
    const callback = await fetch(`${appOrigin}/auth/google/callback?code=mobile-google-code&state=${encodeURIComponent(oauthRequest.searchParams.get('state'))}`, {
      headers: { cookie }, redirect: 'manual'
    });
    assert.equal(callback.status, 303);
    const deepLink = new URL(callback.headers.get('location'));
    assert.equal(deepLink.protocol, 'app.stemma.mobile:');
    assert.equal(deepLink.hostname, 'auth');
    assert.equal(deepLink.searchParams.get('state'), state);
    assert.match(deepLink.searchParams.get('code'), /^[A-Za-z0-9_-]{43}$/);

    const exchangeUrl = `${appOrigin}/auth/mobile/exchange`;
    const body = { code: deepLink.searchParams.get('code'), state, verifier };
    const wrongOrigin = await fetch(exchangeUrl, { method: 'POST', headers: { origin: 'https://attacker.example', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(wrongOrigin.status, 403);
    const wrongVerifier = await fetch(exchangeUrl, { method: 'POST', headers: { origin: appOrigin, 'content-type': 'application/json' }, body: JSON.stringify({ ...body, verifier: crypto.randomBytes(32).toString('base64url') }) });
    assert.equal(wrongVerifier.status, 400);
    const redeem = () => fetch(exchangeUrl, { method: 'POST', headers: { origin: appOrigin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const simultaneous = await Promise.all([redeem(), redeem()]);
    assert.deepEqual(simultaneous.map(response => response.status).sort(), [200, 400]);
    const exchange = simultaneous.find(response => response.status === 200);
    assert.deepEqual(await exchange.json(), { authenticated: true });
    const appCookie = cookieFrom(exchange);
    const expires = Date.parse(setCookieHeader(exchange).match(/expires=([^;]+)/i)?.[1] || '');
    assert.ok(expires > Date.now() + 399 * 24 * 60 * 60 * 1000, 'authenticated session cookie lasts close to the practical 400-day browser limit');
    assert.ok(expires < Date.now() + 401 * 24 * 60 * 60 * 1000);
    const sessionResponse = await fetch(`${appOrigin}/auth/session`, { headers: { cookie: appCookie } });
    assert.equal((await sessionResponse.json()).authenticated, true);
    const replay = await fetch(exchangeUrl, { method: 'POST', headers: { origin: appOrigin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(replay.status, 400);

    const logout = await fetch(`${appOrigin}/auth/logout`, {
      method: 'POST', headers: { origin: appOrigin, cookie: appCookie }
    });
    assert.equal(logout.status, 204);
    assert.match(setCookieHeader(logout), /expires=thu, 01 jan 1970/i, 'logout clears the browser cookie');
    const afterLogout = await fetch(`${appOrigin}/auth/session`, { headers: { cookie: appCookie } });
    assert.equal((await afterLogout.json()).authenticated, false, 'logout revokes the authenticated server session');
  } finally {
    await closeServer(server);
  }
});
