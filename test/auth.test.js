import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import session from 'express-session';
import {
  exportJWK,
  generateKeyPair,
  jwtVerify,
  SignJWT
} from 'jose';
import { buildConfig, createApp } from '../server.js';

async function closeServer(server) {
  if (!server?.listening) return;
  server.close();
  await once(server, 'close');
}

async function getFreePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await closeServer(server);
  return port;
}

function setJson(res, value, status = 200) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function cookieFrom(response) {
  const setCookie = response.headers.getSetCookie?.()[0] || response.headers.get('set-cookie');
  assert.ok(setCookie, 'expected a session cookie');
  return setCookie.split(';', 1)[0];
}

test('Fayda eSignet authorization code flow is state-bound, verified, and one-time', async () => {
  const providerKeys = await generateKeyPair('RS256', { modulusLength: 2048 });
  const clientKeys = await generateKeyPair('RS256', { modulusLength: 2048 });
  const providerPublicJwk = await exportJWK(providerKeys.publicKey);
  providerPublicJwk.kid = 'provider-signing-key';
  providerPublicJwk.alg = 'RS256';
  providerPublicJwk.use = 'sig';
  const clientPublicKey = clientKeys.publicKey;
  const clientPrivateJwk = await exportJWK(clientKeys.privateKey);
  clientPrivateJwk.alg = 'RS256';
  clientPrivateJwk.use = 'sig';
  clientPrivateJwk.kid = 'stemma-client-key';

  let providerOrigin;
  let authRequest;
  let tokenExchanges = 0;
  let userInfoRequests = 0;
  const clientId = 'stemma-test-client';
  const provider = createServer(async (req, res) => {
    const url = new URL(req.url, providerOrigin);
    if (url.pathname === '/.well-known/openid-configuration') {
      return setJson(res, {
        issuer: providerOrigin,
        authorization_endpoint: `${providerOrigin}/authorize`,
        token_endpoint: `${providerOrigin}/token`,
        userinfo_endpoint: `${providerOrigin}/userinfo`,
        jwks_uri: `${providerOrigin}/jwks`,
        response_types_supported: ['code'],
        response_modes_supported: ['query'],
        token_endpoint_auth_methods_supported: ['private_key_jwt'],
        id_token_signing_alg_values_supported: ['RS256']
      });
    }
    if (url.pathname === '/jwks') return setJson(res, { keys: [providerPublicJwk] });
    if (url.pathname === '/token' && req.method === 'POST') {
      tokenExchanges += 1;
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const form = new URLSearchParams(raw);
      assert.equal(form.get('grant_type'), 'authorization_code');
      assert.equal(form.get('client_id'), clientId);
      assert.equal(form.get('redirect_uri'), authRequest.searchParams.get('redirect_uri'));
      assert.equal(form.get('code'), 'test-auth-code');
      assert.equal(form.get('client_assertion_type'), 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
      const assertion = form.get('client_assertion');
      assert.ok(assertion);
      const { payload: assertionClaims } = await jwtVerify(assertion, clientPublicKey, {
        algorithms: ['RS256'],
        audience: `${providerOrigin}/token`
      });
      assert.equal(assertionClaims.iss, clientId);
      assert.equal(assertionClaims.sub, clientId);
      assert.ok(assertionClaims.exp - assertionClaims.iat <= 60);

      const verifier = form.get('code_verifier');
      const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url');
      assert.equal(challenge, authRequest.searchParams.get('code_challenge'));
      assert.equal(authRequest.searchParams.get('code_challenge_method'), 'S256');

      const idToken = await new SignJWT({ nonce: authRequest.searchParams.get('nonce') })
        .setProtectedHeader({ alg: 'RS256', kid: providerPublicJwk.kid })
        .setIssuer(providerOrigin)
        .setAudience(clientId)
        .setSubject('fayda-pairwise-subject-123')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(providerKeys.privateKey);
      return setJson(res, { access_token: 'opaque-access-token', token_type: 'Bearer', id_token: idToken, expires_in: 300 });
    }
    if (url.pathname === '/userinfo') {
      userInfoRequests += 1;
      assert.equal(req.headers.authorization, 'Bearer opaque-access-token');
      const userInfo = await new SignJWT({ name: 'A name that must not enter the local session' })
        .setProtectedHeader({ alg: 'RS256', kid: providerPublicJwk.kid })
        .setIssuer(providerOrigin)
        .setAudience(clientId)
        .setSubject('fayda-pairwise-subject-123')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(providerKeys.privateKey);
      res.writeHead(200, { 'content-type': 'application/jwt' });
      return res.end(userInfo);
    }
    res.writeHead(404);
    res.end();
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  providerOrigin = `http://127.0.0.1:${provider.address().port}`;

  const appPort = await getFreePort();
  const appOrigin = `http://127.0.0.1:${appPort}`;
  const config = buildConfig({
    NODE_ENV: 'test',
    PORT: String(appPort),
    SESSION_SECRET: 'test-only-session-secret-with-more-than-32-bytes',
    APP_ORIGIN: appOrigin,
    FAYDA_ISSUER: providerOrigin,
    FAYDA_CLIENT_ID: clientId,
    FAYDA_CLIENT_PRIVATE_JWK: JSON.stringify(clientPrivateJwk),
    FAYDA_REDIRECT_URI: `${appOrigin}/auth/fayda/callback`
  });
  const app = createApp({
    config,
    jwksFactory: () => async () => providerKeys.publicKey
  });
  const appServer = app.listen(appPort, '127.0.0.1');
  await once(appServer, 'listening');

  try {
    const begin = await fetch(`${appOrigin}/auth/fayda/start`, { redirect: 'manual' });
    assert.equal(begin.status, 303);
    const initialCookie = cookieFrom(begin);
    authRequest = new URL(begin.headers.get('location'));
    assert.equal(authRequest.searchParams.get('response_type'), 'code');
    assert.equal(authRequest.searchParams.get('scope'), 'openid');
    assert.equal(authRequest.searchParams.get('redirect_uri'), `${appOrigin}/auth/fayda/callback`);
    assert.match(authRequest.searchParams.get('state'), /^[A-Za-z0-9_-]{43}$/);
    assert.match(authRequest.searchParams.get('nonce'), /^[A-Za-z0-9_-]{43}$/);
    assert.match(authRequest.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
    assert.equal(authRequest.searchParams.get('claims'), null);
    assert.equal(authRequest.searchParams.get('acr_values'), null);

    const invalid = await fetch(`${appOrigin}/auth/fayda/callback?code=test-auth-code&state=${'A'.repeat(43)}`, {
      headers: { cookie: initialCookie },
      redirect: 'manual'
    });
    assert.equal(invalid.status, 303);
    assert.equal(invalid.headers.get('location'), '/?auth=failed');
    assert.equal(tokenExchanges, 0, 'state mismatch must not exchange the code');

    const callback = await fetch(`${appOrigin}/auth/fayda/callback?code=test-auth-code&state=${encodeURIComponent(authRequest.searchParams.get('state'))}`, {
      headers: { cookie: initialCookie },
      redirect: 'manual'
    });
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.get('location'), '/?auth=success');
    assert.equal(tokenExchanges, 1);
    assert.equal(userInfoRequests, 1);
    const authenticatedCookie = cookieFrom(callback);
    assert.notEqual(authenticatedCookie, initialCookie, 'session ID must rotate after sign-in');

    const sessionResponse = await fetch(`${appOrigin}/auth/session`, { headers: { cookie: authenticatedCookie } });
    assert.deepEqual(await sessionResponse.json(), { authenticated: true, authProvider: 'fayda', faydaConfigured: true, providerConfigured: true, googleConfigured: false, googleProfile: null });

    const replay = await fetch(`${appOrigin}/auth/fayda/callback?code=test-auth-code&state=${encodeURIComponent(authRequest.searchParams.get('state'))}`, {
      headers: { cookie: authenticatedCookie },
      redirect: 'manual'
    });
    assert.equal(replay.status, 303);
    assert.equal(replay.headers.get('location'), '/?auth=failed');
    assert.equal(tokenExchanges, 1, 'a consumed callback must not be exchanged again');

    const blockedLogout = await fetch(`${appOrigin}/auth/logout`, { method: 'POST', headers: { cookie: authenticatedCookie, origin: 'https://attacker.example' } });
    assert.equal(blockedLogout.status, 403);
    const logout = await fetch(`${appOrigin}/auth/logout`, { method: 'POST', headers: { cookie: authenticatedCookie, origin: appOrigin } });
    assert.equal(logout.status, 204);
    const afterLogout = await fetch(`${appOrigin}/auth/session`, { headers: { cookie: authenticatedCookie } });
    assert.deepEqual(await afterLogout.json(), { authenticated: false, authProvider: null, faydaConfigured: true, providerConfigured: true, googleConfigured: false, googleProfile: null });

    const cancellationBegin = await fetch(`${appOrigin}/auth/fayda/start`, { redirect: 'manual' });
    const cancellationCookie = cookieFrom(cancellationBegin);
    const cancellationState = new URL(cancellationBegin.headers.get('location')).searchParams.get('state');
    const cancellation = await fetch(`${appOrigin}/auth/fayda/callback?error=access_denied&error_description=do-not-reflect&state=${encodeURIComponent(cancellationState)}`, {
      headers: { cookie: cancellationCookie },
      redirect: 'manual'
    });
    assert.equal(cancellation.status, 303);
    assert.equal(cancellation.headers.get('location'), '/?auth=failed');
    assert.equal(tokenExchanges, 1, 'authorization errors must never trigger a token exchange');
  } finally {
    await closeServer(appServer);
    await closeServer(provider);
  }
});

test('Google OIDC authorization code flow uses PKCE, verifies identity, and consumes state once', async () => {
  const providerKeys = await generateKeyPair('RS256', { modulusLength: 2048 });
  const providerPublicJwk = await exportJWK(providerKeys.publicKey);
  providerPublicJwk.kid = 'google-test-signing-key';
  providerPublicJwk.alg = 'RS256';
  providerPublicJwk.use = 'sig';

  const appPort = await getFreePort();
  const appOrigin = `http://127.0.0.1:${appPort}`;
  const clientId = 'stemma-google-test.apps.googleusercontent.com';
  const clientSecret = 'google-test-client-secret';
  const redirectUri = `${appOrigin}/auth/google/callback`;
  const config = buildConfig({
    NODE_ENV: 'test',
    PORT: String(appPort),
    SESSION_SECRET: 'test-only-session-secret-with-more-than-32-bytes',
    APP_ORIGIN: appOrigin,
    GOOGLE_CLIENT_ID: clientId,
    GOOGLE_CLIENT_SECRET: clientSecret
  });
  let authRequest;
  let tokenExchanges = 0;
  const metadata = {
    issuer: 'https://accounts.google.com',
    authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    token_endpoint: 'https://oauth2.googleapis.com/token',
    jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
    response_types_supported: ['code', 'id_token'],
    code_challenge_methods_supported: ['plain', 'S256'],
    id_token_signing_alg_values_supported: ['RS256']
  };
  const fetchImpl = async (url, options = {}) => {
    if (url === 'https://accounts.google.com/.well-known/openid-configuration') {
      return new Response(JSON.stringify(metadata), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === 'https://oauth2.googleapis.com/token') {
      tokenExchanges += 1;
      const form = new URLSearchParams(options.body);
      assert.equal(form.get('grant_type'), 'authorization_code');
      assert.equal(form.get('client_id'), clientId);
      assert.equal(form.get('client_secret'), clientSecret);
      assert.equal(form.get('redirect_uri'), redirectUri);
      assert.equal(form.get('code'), 'google-test-code');
      const verifier = form.get('code_verifier');
      const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url');
      assert.equal(challenge, authRequest.searchParams.get('code_challenge'));
      const idToken = await new SignJWT({
        nonce: authRequest.searchParams.get('nonce'),
        name: 'Google Account Name',
        email: 'person@gmail.com',
        email_verified: true,
        picture: 'https://lh3.googleusercontent.com/a/example-avatar'
      })
        .setProtectedHeader({ alg: 'RS256', kid: providerPublicJwk.kid })
        .setIssuer('https://accounts.google.com')
        .setAudience(clientId)
        .setSubject('google-stable-subject-123')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(providerKeys.privateKey);
      return new Response(JSON.stringify({ access_token: 'unused-test-access-token', id_token: idToken }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    throw new Error(`Unexpected Google test fetch: ${url}`);
  };
  const sessionStore = new session.MemoryStore();
  const app = createApp({
    config,
    sessionStore,
    fetchImpl,
    jwksFactory: () => async () => providerKeys.publicKey
  });
  const appServer = app.listen(appPort, '127.0.0.1');
  await once(appServer, 'listening');

  try {
    const begin = await fetch(`${appOrigin}/auth/google/start`, { redirect: 'manual' });
    assert.equal(begin.status, 303);
    const initialCookie = cookieFrom(begin);
    authRequest = new URL(begin.headers.get('location'));
    assert.equal(authRequest.origin, 'https://accounts.google.com');
    assert.equal(authRequest.searchParams.get('response_type'), 'code');
    assert.equal(authRequest.searchParams.get('scope'), 'openid email profile');
    assert.equal(authRequest.searchParams.get('redirect_uri'), redirectUri);
    assert.match(authRequest.searchParams.get('state'), /^[A-Za-z0-9_-]{43}$/);
    assert.match(authRequest.searchParams.get('nonce'), /^[A-Za-z0-9_-]{43}$/);
    assert.match(authRequest.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
    assert.equal(authRequest.searchParams.get('code_challenge_method'), 'S256');

    const invalid = await fetch(`${appOrigin}/auth/google/callback?code=google-test-code&state=${'A'.repeat(43)}`, {
      headers: { cookie: initialCookie },
      redirect: 'manual'
    });
    assert.equal(invalid.status, 303);
    assert.equal(invalid.headers.get('location'), '/?auth=failed');
    assert.equal(tokenExchanges, 0, 'state mismatch must not exchange the code');

    const callback = await fetch(`${appOrigin}/auth/google/callback?code=google-test-code&state=${encodeURIComponent(authRequest.searchParams.get('state'))}`, {
      headers: { cookie: initialCookie },
      redirect: 'manual'
    });
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.get('location'), '/?auth=success');
    assert.equal(tokenExchanges, 1);
    const authenticatedCookie = cookieFrom(callback);
    assert.notEqual(authenticatedCookie, initialCookie, 'session ID must rotate after sign-in');

    const sessionResponse = await fetch(`${appOrigin}/auth/session`, { headers: { cookie: authenticatedCookie } });
    assert.deepEqual(await sessionResponse.json(), {
      authenticated: true,
      authProvider: 'google',
      faydaConfigured: false,
      providerConfigured: false,
      googleConfigured: true,
      googleProfile: {
        name: 'Google Account Name',
        email: 'person@gmail.com',
        avatarUrl: 'https://lh3.googleusercontent.com/a/example-avatar'
      }
    });

    const encodedSessionValue = authenticatedCookie.split('=', 2)[1];
    const legacySessionId = decodeURIComponent(encodedSessionValue).match(/^s:([^.]+)\./)?.[1];
    assert.ok(legacySessionId);
    const legacySession = await new Promise((resolve, reject) => {
      sessionStore.get(legacySessionId, (error, value) => error ? reject(error) : resolve(value));
    });
    assert.ok(legacySession?.stemmaUser);
    delete legacySession.stemmaUser.profile;
    await new Promise((resolve, reject) => {
      sessionStore.set(legacySessionId, legacySession, error => error ? reject(error) : resolve());
    });
    const legacySessionResponse = await fetch(`${appOrigin}/auth/session`, { headers: { cookie: authenticatedCookie } });
    assert.deepEqual(await legacySessionResponse.json(), {
      authenticated: true,
      authProvider: 'google',
      faydaConfigured: false,
      providerConfigured: false,
      googleConfigured: true,
      googleProfile: null
    });

    const replay = await fetch(`${appOrigin}/auth/google/callback?code=google-test-code&state=${encodeURIComponent(authRequest.searchParams.get('state'))}`, {
      headers: { cookie: authenticatedCookie },
      redirect: 'manual'
    });
    assert.equal(replay.status, 303);
    assert.equal(replay.headers.get('location'), '/?auth=failed');
    assert.equal(tokenExchanges, 1, 'a consumed callback must not be exchanged again');

    const cancellationBegin = await fetch(`${appOrigin}/auth/google/start`, { redirect: 'manual' });
    const cancellationCookie = cookieFrom(cancellationBegin);
    const cancellationState = new URL(cancellationBegin.headers.get('location')).searchParams.get('state');
    const cancellation = await fetch(`${appOrigin}/auth/google/callback?error=access_denied&state=${encodeURIComponent(cancellationState)}`, {
      headers: { cookie: cancellationCookie },
      redirect: 'manual'
    });
    assert.equal(cancellation.status, 303);
    assert.equal(cancellation.headers.get('location'), '/?auth=failed');
    assert.equal(tokenExchanges, 1, 'provider cancellation must never trigger a token exchange');
  } finally {
    await closeServer(appServer);
  }
});

test('Google OAuth sets a secure session cookie behind the configured HTTPS proxy', async () => {
  const appPort = await getFreePort();
  const appOrigin = `http://127.0.0.1:${appPort}`;
  const config = buildConfig({
    NODE_ENV: 'test',
    PORT: String(appPort),
    SESSION_SECRET: 'test-only-session-secret-with-more-than-32-bytes',
    APP_ORIGIN: appOrigin,
    SESSION_COOKIE_SECURE: 'true',
    TRUST_PROXY: '1',
    GOOGLE_CLIENT_ID: 'stemma-proxy-test.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'google-test-client-secret'
  });
  const googleMetadata = {
    issuer: 'https://accounts.google.com',
    authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    token_endpoint: 'https://oauth2.googleapis.com/token',
    jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
    id_token_signing_alg_values_supported: ['RS256']
  };
  const app = createApp({
    config,
    fetchImpl: async url => {
      assert.equal(String(url), 'https://accounts.google.com/.well-known/openid-configuration');
      return new Response(JSON.stringify(googleMetadata), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });
  const appServer = app.listen(appPort, '127.0.0.1');
  await once(appServer, 'listening');

  try {
    const begin = await fetch(`${appOrigin}/auth/google/start`, {
      headers: { 'x-forwarded-proto': 'https' },
      redirect: 'manual'
    });
    assert.equal(begin.status, 303);
    const setCookie = begin.headers.get('set-cookie');
    assert.ok(setCookie, 'proxy-aware OAuth start must set the transaction session cookie');
    assert.match(setCookie, /; Secure(?:;|$)/i);
    assert.match(setCookie, /; HttpOnly(?:;|$)/i);
    assert.match(setCookie, /; SameSite=Lax(?:;|$)/i);
    const authorizationUrl = new URL(begin.headers.get('location'));
    assert.equal(authorizationUrl.searchParams.get('redirect_uri'), `${appOrigin}/auth/google/callback`);
    assert.match(authorizationUrl.searchParams.get('state'), /^[A-Za-z0-9_-]{43}$/);
  } finally {
    await closeServer(appServer);
  }
});

test('production startup rejects weak session secrets and missing PostgreSQL session storage', () => {
  const base = {
    NODE_ENV: 'production',
    APP_ORIGIN: 'https://stemma.example',
    PORT: '3000'
  };
  const weakSecret = buildConfig({ ...base, SESSION_SECRET: 'too-short' });
  assert.throws(() => createApp({ config: weakSecret }), /SESSION_SECRET/);

  const noPostgres = buildConfig({
    ...base,
    SESSION_SECRET: 'production-test-secret-that-is-at-least-32-bytes-long',
    DB_HOST: '',
    DB_PORT: '',
    DB_NAME: '',
    DB_USERNAME: '',
    DB_PASSWORD: ''
  });
  assert.throws(() => createApp({ config: noPostgres }), /DB_HOST/);

  const postgresConfigured = buildConfig({
    ...base,
    SESSION_SECRET: 'production-test-secret-that-is-at-least-32-bytes-long',
    DB_HOST: 'db.example',
    DB_PORT: '5432',
    DB_NAME: 'stemma',
    DB_USERNAME: 'stemma',
    DB_PASSWORD: 'test-only-database-password'
  });
  assert.throws(() => createApp({ config: postgresConfigured }), /persistent PostgreSQL session store/);
});
