import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import pg from 'pg';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { validateProfileImage } from './profile-image.js';
import { registerFriendBillsApi } from './friend-bills-api.js';
import { createNotificationStore, registerNotificationsApi } from './notifications-api.js';
import { createPulseStore, registerPulseApi } from './pulse-api.js';
import { createDirectChatStore, registerDirectChatApi } from './direct-chat-api.js';
import { createAttachmentStore, registerAttachmentsApi } from './attachments-api.js';
import { createGroupStore, registerGroupsApi, isValidGroupSlug } from './groups-api.js';
import { createStoryStore, registerStoriesApi } from './stories-api.js';
import {
  createRemoteJWKSet,
  importJWK,
  jwtVerify,
  SignJWT
} from 'jose';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const { Pool } = pg;
const SESSION_COOKIE = 'stemma.sid';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const TRANSACTION_TTL_MS = 5 * 60 * 1000;
const MAX_TRANSACTIONS_PER_SESSION = 5;
const MAX_PROVIDER_RESPONSE_BYTES = 128 * 1024;
const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const GOOGLE_ISSUER = 'https://accounts.google.com';
const GOOGLE_DISCOVERY_URL = `${GOOGLE_ISSUER}/.well-known/openid-configuration`;

function trimTrailingSlashes(value) {
  return value.replace(/\/+$/, '');
}

function validGroupReturnTo(value) {
  if (typeof value !== 'string') return false;
  if (value.startsWith('/invite/')) return /^\/invite\/[A-Za-z0-9_-]{40,64}$/.test(value);
  if (value.startsWith('/private_urls/')) return /^\/private_urls\/[A-Za-z0-9_-]{40,64}$/.test(value);
  return value.startsWith('/') && !value.includes('?') && !value.includes('#') && isValidGroupSlug(value.slice(1));
}

function parseOrigin(value, name) {
  if (!value) return '';
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${name} must be an origin URL without a path, query, or fragment.`);
  }
  return url.origin;
}

export function buildConfig(env = process.env) {
  const issuer = (env.FAYDA_ISSUER || '').trim();
  const callbackUri = (env.FAYDA_REDIRECT_URI || '').trim();
  const callbackOrigin = callbackUri ? new URL(callbackUri).origin : '';
  const scopes = (env.FAYDA_SCOPES || 'openid').trim().split(/\s+/).filter(Boolean);
  const assertionTtl = Number.parseInt(env.FAYDA_ASSERTION_TTL_SECONDS || '60', 10);
  const trustProxy = Number.parseInt(env.TRUST_PROXY || '0', 10);
  const appOrigin = parseOrigin(env.APP_ORIGIN || callbackOrigin, 'APP_ORIGIN');

  return {
    nodeEnv: env.NODE_ENV || 'development',
    port: Number.parseInt(env.PORT || '3000', 10),
    sessionSecret: env.SESSION_SECRET || '',
    sessionCookieSecure: env.SESSION_COOKIE_SECURE === 'true',
    postgres: {
      host: (env.DB_HOST || '').trim(),
      port: Number.parseInt(env.DB_PORT || '0', 10),
      database: (env.DB_NAME || '').trim(),
      username: (env.DB_USERNAME || '').trim(),
      password: env.DB_PASSWORD || ''
    },
    appOrigin,
    trustProxy: Number.isInteger(trustProxy) && trustProxy >= 0 ? trustProxy : 0,
    fayda: {
      issuer,
      discoveryUrl: (env.FAYDA_DISCOVERY_URL || (issuer ? `${trimTrailingSlashes(issuer)}/.well-known/openid-configuration` : '')).trim(),
      clientId: (env.FAYDA_CLIENT_ID || '').trim(),
      clientKeyId: (env.FAYDA_CLIENT_KEY_ID || '').trim(),
      privateJwkJson: env.FAYDA_CLIENT_PRIVATE_JWK || '',
      privateJwkPath: (env.FAYDA_CLIENT_PRIVATE_JWK_PATH || '').trim(),
      redirectUri: callbackUri,
      scopes,
      acrValues: (env.FAYDA_ACR_VALUES || '').trim(),
      uiLocales: (env.FAYDA_UI_LOCALES || '').trim(),
      assertionTtlSeconds: Number.isInteger(assertionTtl) && assertionTtl >= 30 && assertionTtl <= 300 ? assertionTtl : 60
    },
    google: {
      clientId: (env.GOOGLE_CLIENT_ID || '').trim(),
      clientSecret: env.GOOGLE_CLIENT_SECRET || '',
      redirectUri: (env.GOOGLE_REDIRECT_URI || (appOrigin ? `${appOrigin}/auth/google/callback` : '')).trim()
    }
  };
}

function validateHttpsUrl(value, label, nodeEnv) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL.`);
  }
  const testLoopbackHttp = nodeEnv === 'test' && url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  if ((!testLoopbackHttp && url.protocol !== 'https:') || url.username || url.password || url.hash) {
    throw new Error(`${label} must use HTTPS and must not contain credentials or a fragment.`);
  }
  return url;
}

function isFaydaConfigured(config) {
  const provider = config.fayda;
  return Boolean(
    provider.issuer && provider.discoveryUrl && provider.clientId &&
    (provider.privateJwkJson || provider.privateJwkPath) && provider.redirectUri
  );
}

function isGoogleConfigured(config) {
  return Boolean(config.google.clientId && config.google.clientSecret && config.google.redirectUri);
}

function validateConfig(config) {
  if (typeof config.sessionSecret !== 'string' || Buffer.byteLength(config.sessionSecret, 'utf8') < 32) {
    throw new Error('SESSION_SECRET must be set to a random value of at least 32 bytes.');
  }
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
    throw new Error('PORT must be a valid TCP port.');
  }
  if (config.nodeEnv === 'production') {
    if (!config.appOrigin || !config.appOrigin.startsWith('https://')) {
      throw new Error('APP_ORIGIN must be an HTTPS origin in production.');
    }
    const database = config.postgres;
    if (!database.host || !Number.isInteger(database.port) || database.port < 1 || database.port > 65535 ||
        !database.database || !database.username || !database.password) {
      throw new Error('DB_HOST, DB_PORT, DB_NAME, DB_USERNAME, and DB_PASSWORD are required for PostgreSQL-backed production sessions.');
    }
    if (config.fayda.redirectUri && !config.fayda.redirectUri.startsWith('https://')) {
      throw new Error('FAYDA_REDIRECT_URI must use HTTPS in production.');
    }
    if (config.google.redirectUri && !config.google.redirectUri.startsWith('https://')) {
      throw new Error('GOOGLE_REDIRECT_URI must use HTTPS in production.');
    }
  }
  if (config.fayda.scopes.length === 0 || !config.fayda.scopes.includes('openid') || config.fayda.scopes.some(scope => !/^[A-Za-z0-9:_-]+$/.test(scope))) {
    throw new Error('FAYDA_SCOPES must contain openid and valid scope names.');
  }
  if (isFaydaConfigured(config)) {
    const issuer = validateHttpsUrl(config.fayda.issuer, 'FAYDA_ISSUER', config.nodeEnv);
    const discovery = validateHttpsUrl(config.fayda.discoveryUrl, 'FAYDA_DISCOVERY_URL', config.nodeEnv);
    const redirect = validateHttpsUrl(config.fayda.redirectUri, 'FAYDA_REDIRECT_URI', config.nodeEnv);
    if (redirect.search || redirect.hash || redirect.origin !== config.appOrigin) {
      throw new Error('FAYDA_REDIRECT_URI must be a query-free callback URL on APP_ORIGIN.');
    }
    if (issuer.search || issuer.hash || discovery.search || discovery.hash || !config.fayda.clientId || config.fayda.clientId.length > 512) {
      throw new Error('Fayda configuration contains an invalid issuer, discovery URL, or client ID.');
    }
  }
  if (Boolean(config.google.clientId) !== Boolean(config.google.clientSecret)) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured together.');
  }
  if (config.google.clientId || config.google.clientSecret) {
    if (!config.google.clientId || config.google.clientId.length > 512 || !config.google.clientSecret) {
      throw new Error('GOOGLE_CLIENT_ID must be set and valid when Google sign-in is configured.');
    }
    const redirect = validateHttpsUrl(config.google.redirectUri, 'GOOGLE_REDIRECT_URI', config.nodeEnv);
    if (redirect.search || redirect.hash || redirect.origin !== config.appOrigin) {
      throw new Error('GOOGLE_REDIRECT_URI must be a query-free callback URL on APP_ORIGIN.');
    }
  }
}

function setNoStore(res) {
  res.set('Cache-Control', 'no-store, max-age=0');
  res.set('Pragma', 'no-cache');
  res.set('Referrer-Policy', 'no-referrer');
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function sessionOperation(req, operation) {
  return new Promise((resolve, reject) => {
    req.session[operation](error => error ? reject(error) : resolve());
  });
}

export function createGoogleIdentityStore(pool) {
  return {
    async migrate() {
      const migration = await fs.readFile(path.join(ROOT, 'migrations', '001_google_identities.sql'), 'utf8');
      await pool.query(migration);
    },
    async upsertGoogleIdentity({ subject, verifiedEmail }) {
      const result = await pool.query(
        `INSERT INTO stemma_google_identities (google_subject, verified_email)
         VALUES ($1, $2)
         ON CONFLICT (google_subject) DO UPDATE SET
           verified_email = EXCLUDED.verified_email,
           updated_at = CURRENT_TIMESTAMP
         RETURNING google_subject AS subject, verified_email AS "verifiedEmail"`,
        [subject, verifiedEmail]
      );
      return result.rows[0] ?? null;
    },
    async getGoogleIdentity(subject) {
      const result = await pool.query(
        `SELECT google_subject AS subject, verified_email AS "verifiedEmail"
         FROM stemma_google_identities
         WHERE google_subject = $1
         LIMIT 1`,
        [subject]
      );
      return result.rows[0] ?? null;
    }
  };
}

export function createStudentProfileStore(pool) {
  return {
    async migrate() {
      const migration = await fs.readFile(path.join(ROOT, 'migrations', '002_student_profiles.sql'), 'utf8');
      await pool.query(migration);
      await pool.query(`ALTER TABLE stemma_student_profiles
        ADD COLUMN IF NOT EXISTS nick_name TEXT NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS username TEXT NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS bio TEXT NOT NULL DEFAULT ''`);
      const photoMigration = await fs.readFile(path.join(ROOT, 'migrations', '003_profile_images.sql'), 'utf8');
      await pool.query(photoMigration);
    },
    async upsertStudentProfile(subject, profile) {
      const result = await pool.query(
        `INSERT INTO stemma_student_profiles
           (google_subject, first_name, middle_name, last_name, student_id, department, nick_name, username, bio)
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, ''), COALESCE($8, ''), COALESCE($9, ''))
         ON CONFLICT (google_subject) DO UPDATE SET
           first_name = EXCLUDED.first_name,
           middle_name = EXCLUDED.middle_name,
           last_name = EXCLUDED.last_name,
           student_id = EXCLUDED.student_id,
           department = EXCLUDED.department,
           nick_name = COALESCE($7, stemma_student_profiles.nick_name),
           username = COALESCE($8, stemma_student_profiles.username),
           bio = COALESCE($9, stemma_student_profiles.bio),
           updated_at = CURRENT_TIMESTAMP
         RETURNING first_name AS "firstName", middle_name AS "middleName",
                   last_name AS "lastName", student_id AS "studentId", department,
                   nick_name AS "nickName", username, bio`,
        [subject, profile.firstName, profile.middleName, profile.lastName, profile.studentId, profile.department,
          profile.nickName ?? null, profile.username ?? null, profile.bio ?? null]
      );
      return result.rows[0] ?? null;
    },
    async getStudentProfile(subject) {
      const result = await pool.query(
        `SELECT first_name AS "firstName", middle_name AS "middleName",
                last_name AS "lastName", student_id AS "studentId", department,
                nick_name AS "nickName", username, bio
         FROM stemma_student_profiles
         WHERE google_subject = $1
         LIMIT 1`,
        [subject]
      );
      return result.rows[0] ?? null;
    },
    async getStudentPhoto(subject) {
      const result = await pool.query(
        `SELECT profile_image AS data, profile_image_mime AS "mimeType",
                profile_image_width AS width, profile_image_height AS height
         FROM stemma_student_profiles
         WHERE google_subject = $1 AND profile_image IS NOT NULL
         LIMIT 1`,
        [subject]
      );
      const row = result.rows[0];
      return row ? { data: Buffer.from(row.data), mimeType: row.mimeType, width: row.width, height: row.height } : null;
    },
    async saveStudentPhoto(subject, image, { onlyIfAbsent = false } = {}) {
      const result = await pool.query(
        `UPDATE stemma_student_profiles
         SET profile_image = $2, profile_image_mime = $3,
             profile_image_width = $4, profile_image_height = $5,
             updated_at = CURRENT_TIMESTAMP
         WHERE google_subject = $1${onlyIfAbsent ? ' AND profile_image IS NULL' : ''}
         RETURNING google_subject`,
        [subject, image.data, image.mimeType, image.width, image.height]
      );
      if (result.rows[0]) return { saved: true };
      const exists = await pool.query('SELECT 1 FROM stemma_student_profiles WHERE google_subject = $1 LIMIT 1', [subject]);
      return exists.rows.length ? { saved: false, reason: 'exists' } : { saved: false, reason: 'not-found' };
    }
  };
}

const STUDENT_PROFILE_LIMITS = Object.freeze({
  firstName: 80,
  middleName: 80,
  lastName: 80,
  studentId: 64,
  department: 100
});
const OPTIONAL_STUDENT_PROFILE_FIELDS = Object.freeze(['nickName', 'username', 'bio']);

function validateStudentProfile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const required = Object.keys(STUDENT_PROFILE_LIMITS);
  const allowed = [...required, ...OPTIONAL_STUDENT_PROFILE_FIELDS];
  const keys = Object.keys(value);
  if (keys.some(key => !allowed.includes(key)) ||
      required.some(key => !Object.hasOwn(value, key))) return null;
  const profile = {};
  for (const key of required) {
    if (typeof value[key] !== 'string' || /[\u0000-\u001f\u007f-\u009f]/u.test(value[key])) return null;
    const trimmed = value[key].trim();
    if ([...trimmed].length > STUDENT_PROFILE_LIMITS[key] || !trimmed) return null;
    profile[key] = trimmed;
  }
  for (const key of OPTIONAL_STUDENT_PROFILE_FIELDS) {
    if (!Object.hasOwn(value, key)) continue;
    if (typeof value[key] !== 'string') return null;
    if (key === 'bio' && /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u.test(value[key])) return null;
    const trimmed = value[key].trim();
    if (key === 'nickName' && (!trimmed || [...trimmed].length > 60)) return null;
    if (key === 'username' && !/^[A-Za-z0-9_.]{3,30}$/.test(trimmed)) return null;
    if (key === 'bio' && [...trimmed].length > 280) return null;
    profile[key] = trimmed;
  }
  return profile;
}

async function readLimitedBody(response, maxBytes = MAX_PROVIDER_RESPONSE_BYTES) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error('Provider response exceeded the allowed size.');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchText(fetchImpl, url, options = {}, maxBytes = MAX_PROVIDER_RESPONSE_BYTES) {
  const response = await fetchImpl(url, {
    ...options,
    redirect: 'error',
    signal: AbortSignal.timeout(10_000)
  });
  const text = await readLimitedBody(response, maxBytes);
  return { response, text };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Provider returned an invalid JSON document.');
  }
}

function validateProviderMetadata(metadata, config) {
  const provider = config.fayda;
  if (!metadata || metadata.issuer !== provider.issuer) {
    throw new Error('Provider discovery issuer did not match the configured issuer.');
  }
  if (!Array.isArray(metadata.response_types_supported) || !metadata.response_types_supported.includes('code')) {
    throw new Error('Provider does not advertise authorization-code responses.');
  }
  if (Array.isArray(metadata.token_endpoint_auth_methods_supported) && !metadata.token_endpoint_auth_methods_supported.includes('private_key_jwt')) {
    throw new Error('Provider metadata does not advertise private_key_jwt client authentication.');
  }
  if (Array.isArray(metadata.id_token_signing_alg_values_supported) && !metadata.id_token_signing_alg_values_supported.includes('RS256')) {
    throw new Error('Provider metadata does not advertise RS256 ID-token signatures.');
  }
  const endpoints = {};
  for (const [key, label] of [
    ['authorization_endpoint', 'authorization endpoint'],
    ['token_endpoint', 'token endpoint'],
    ['userinfo_endpoint', 'UserInfo endpoint'],
    ['jwks_uri', 'JWKS URI']
  ]) {
    if (typeof metadata[key] !== 'string') throw new Error(`Provider is missing its ${label}.`);
    endpoints[key] = validateHttpsUrl(metadata[key], label, config.nodeEnv);
  }
  return { ...metadata, ...Object.fromEntries(Object.entries(endpoints).map(([key, url]) => [key, url.href])) };
}

function validateGoogleMetadata(metadata, config) {
  if (!metadata || metadata.issuer !== GOOGLE_ISSUER) {
    throw new Error('Google discovery issuer did not match the expected issuer.');
  }
  if (!Array.isArray(metadata.response_types_supported) || !metadata.response_types_supported.includes('code')) {
    throw new Error('Google does not advertise authorization-code responses.');
  }
  if (!Array.isArray(metadata.code_challenge_methods_supported) || !metadata.code_challenge_methods_supported.includes('S256')) {
    throw new Error('Google does not advertise S256 PKCE support.');
  }
  if (Array.isArray(metadata.id_token_signing_alg_values_supported) && !metadata.id_token_signing_alg_values_supported.includes('RS256')) {
    throw new Error('Google metadata does not advertise RS256 ID-token signatures.');
  }
  const endpoints = {};
  for (const [key, host] of [
    ['authorization_endpoint', 'accounts.google.com'],
    ['token_endpoint', 'oauth2.googleapis.com'],
    ['jwks_uri', 'www.googleapis.com']
  ]) {
    if (typeof metadata[key] !== 'string') throw new Error('Google discovery is missing a required endpoint.');
    const endpoint = validateHttpsUrl(metadata[key], `Google ${key}`, config.nodeEnv);
    if (endpoint.hostname !== host) throw new Error('Google discovery returned an unexpected endpoint host.');
    endpoints[key] = endpoint.href;
  }
  return { ...metadata, ...endpoints };
}

function normalizeGoogleProfile(claims) {
  let avatarUrl = '';
  if (typeof claims.picture === 'string' && claims.picture.length <= 2048) {
    try {
      const picture = new URL(claims.picture);
      const host = picture.hostname.toLowerCase();
      if (picture.protocol === 'https:' && !picture.username && !picture.password && !picture.port &&
          (host === 'googleusercontent.com' || host.endsWith('.googleusercontent.com'))) {
        avatarUrl = picture.href;
      }
    } catch {}
  }
  return {
    name: typeof claims.name === 'string' ? claims.name.trim().slice(0, 256) : '',
    email: claims.email_verified === true && typeof claims.email === 'string' ? claims.email.trim().slice(0, 320) : '',
    avatarUrl
  };
}

async function readPrivateJwk(provider) {
  let raw = provider.privateJwkJson;
  if (!raw && provider.privateJwkPath) {
    const keyPath = path.resolve(provider.privateJwkPath);
    const stat = await fs.stat(keyPath);
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      throw new Error('Private JWK file permissions are too broad; use mode 0600.');
    }
    raw = await fs.readFile(keyPath, 'utf8');
  }
  let jwk;
  try {
    jwk = JSON.parse(raw);
  } catch {
    throw new Error('The configured private JWK is not valid JSON.');
  }
  if (!jwk || jwk.kty !== 'RSA' || typeof jwk.d !== 'string' || typeof jwk.n !== 'string' || typeof jwk.e !== 'string' || (jwk.alg && jwk.alg !== 'RS256') || (jwk.use && jwk.use !== 'sig')) {
    throw new Error('The configured private JWK must be an RSA signing key for RS256.');
  }
  return { signingKey: await importJWK(jwk, 'RS256'), keyId: provider.clientKeyId || (typeof jwk.kid === 'string' ? jwk.kid : '') };
}

async function createClientAssertion(provider, tokenEndpoint, key, keyId = '') {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  if (keyId) header.kid = keyId;
  return new SignJWT({})
    .setProtectedHeader(header)
    .setIssuer(provider.clientId)
    .setSubject(provider.clientId)
    .setAudience(tokenEndpoint)
    .setIssuedAt(now)
    .setExpirationTime(now + provider.assertionTtlSeconds)
    .setJti(crypto.randomUUID())
    .sign(key);
}

export function createApp({ config = buildConfig(), sessionStore, googleIdentityStore, studentProfileStore, notificationStore = null, pulseStore = null, directChatStore = null, attachmentStore = null, groupStore = null, storyStore = null, friendBillStore = null, fetchImpl = fetch, jwksFactory = createRemoteJWKSet } = {}) {
  validateConfig(config);
  if (config.nodeEnv === 'production' && !sessionStore) {
    throw new Error('A persistent PostgreSQL session store is required in production.');
  }
  if (config.nodeEnv === 'production' && isGoogleConfigured(config) && !googleIdentityStore) {
    throw new Error('A persistent PostgreSQL Google identity store is required when Google sign-in is configured.');
  }
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  const cspDirectives = {
    defaultSrc: ["'self'"],
    baseUri: ["'self'"],
    objectSrc: ["'none'"],
    frameAncestors: ["'none'"],
    formAction: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", 'data:', 'blob:', 'https://*.googleusercontent.com'],
    mediaSrc: ["'self'", 'blob:'],
    connectSrc: ["'self'"]
  };
  if (config.nodeEnv === 'production') cspDirectives.upgradeInsecureRequests = [];
  app.use(helmet({
    contentSecurityPolicy: { directives: cspDirectives },
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginResourcePolicy: { policy: 'same-origin' }
  }));
  app.use(session({
    name: SESSION_COOKIE,
    secret: config.sessionSecret,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: config.nodeEnv === 'production' || config.sessionCookieSecure,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_TTL_MS
    }
  }));

  const discoveryCache = { value: null, expiresAt: 0, pending: null };
  const googleDiscoveryCache = { value: null, expiresAt: 0, pending: null };
  let remoteJwks = null;
  let googleRemoteJwks = null;
  let signingKeyPromise = null;

  async function getProviderMetadata() {
    if (!isFaydaConfigured(config)) throw new Error('Fayda sign-in is not configured.');
    if (discoveryCache.value && Date.now() < discoveryCache.expiresAt) return discoveryCache.value;
    if (discoveryCache.pending) return discoveryCache.pending;
    discoveryCache.pending = (async () => {
      const discoveryUrl = validateHttpsUrl(config.fayda.discoveryUrl, 'FAYDA_DISCOVERY_URL', config.nodeEnv);
      const { response, text } = await fetchText(fetchImpl, discoveryUrl, { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('Provider discovery request failed.');
      const metadata = validateProviderMetadata(parseJson(text), config);
      discoveryCache.value = metadata;
      discoveryCache.expiresAt = Date.now() + 15 * 60 * 1000;
      return metadata;
    })();
    try {
      return await discoveryCache.pending;
    } finally {
      discoveryCache.pending = null;
    }
  }

  async function getGoogleMetadata() {
    if (!isGoogleConfigured(config)) throw new Error('Google sign-in is not configured.');
    if (googleDiscoveryCache.value && Date.now() < googleDiscoveryCache.expiresAt) return googleDiscoveryCache.value;
    if (googleDiscoveryCache.pending) return googleDiscoveryCache.pending;
    googleDiscoveryCache.pending = (async () => {
      const { response, text } = await fetchText(fetchImpl, GOOGLE_DISCOVERY_URL, { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('Google discovery request failed.');
      const metadata = validateGoogleMetadata(parseJson(text), config);
      googleDiscoveryCache.value = metadata;
      googleDiscoveryCache.expiresAt = Date.now() + 15 * 60 * 1000;
      return metadata;
    })();
    try {
      return await googleDiscoveryCache.pending;
    } finally {
      googleDiscoveryCache.pending = null;
    }
  }

  function getJwks(metadata) {
    if (!remoteJwks) remoteJwks = jwksFactory(new URL(metadata.jwks_uri), {
      timeoutDuration: 5_000,
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60 * 1000
    });
    return remoteJwks;
  }

  function getGoogleJwks(metadata) {
    if (!googleRemoteJwks) googleRemoteJwks = jwksFactory(new URL(metadata.jwks_uri), {
      timeoutDuration: 5_000,
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60 * 1000
    });
    return googleRemoteJwks;
  }

  async function getClientSigningKey() {
    if (!signingKeyPromise) signingKeyPromise = readPrivateJwk(config.fayda);
    return signingKeyPromise;
  }

  const authLimiter = rateLimit({
    windowMs: 60_000,
    limit: 20,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => {
      setNoStore(res);
      res.status(429).json({ error: 'Too many sign-in attempts. Please wait and try again.' });
    }
  });

  app.get('/healthz', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ status: 'ok', faydaConfigured: isFaydaConfigured(config), googleConfigured: isGoogleConfigured(config) });
  });

  app.get('/auth/session', asyncRoute(async (req, res) => {
    setNoStore(res);
    const stemmaUser = req.session?.stemmaUser ?? null;
    const googleUser = stemmaUser?.provider === 'google' ? stemmaUser : null;
    const googleProfile = googleUser?.profile;
    if (googleUser && googleIdentityStore) {
      const verifiedEmail = typeof googleProfile?.email === 'string' ? googleProfile.email : '';
      const storedIdentity = await googleIdentityStore.getGoogleIdentity(googleUser.subject);
      if (!storedIdentity || (verifiedEmail && storedIdentity.verifiedEmail !== verifiedEmail)) {
        await googleIdentityStore.upsertGoogleIdentity({ subject: googleUser.subject, verifiedEmail });
      }
    }
    const hasGoogleProfile = Boolean(googleProfile && (googleProfile.name || googleProfile.email || googleProfile.avatarUrl));
    res.json({
      authenticated: Boolean(stemmaUser),
      authProvider: stemmaUser?.provider ?? null,
      faydaConfigured: isFaydaConfigured(config),
      providerConfigured: isFaydaConfigured(config),
      googleConfigured: isGoogleConfigured(config),
      googleProfile: hasGoogleProfile ? { ...googleProfile } : null
    });
  }));

  function requireGoogleSession(req, res, next) {
    setNoStore(res);
    const user = req.session?.stemmaUser;
    if (!user) return res.status(401).json({ error: 'Authentication required.' });
    if (user.provider !== 'google' || typeof user.subject !== 'string' || !user.subject) {
      return res.status(403).json({ error: 'This request could not be verified.' });
    }
    return next();
  }

  registerNotificationsApi(app, { notificationStore, requireGoogleSession, config });
  registerPulseApi(app, { pulseStore, attachmentStore, requireGoogleSession, config });
  registerStoriesApi(app, { storyStore, requireGoogleSession, config });
  registerDirectChatApi(app, { directChatStore, attachmentStore, requireGoogleSession, config });
  registerGroupsApi(app, { groupsStore: groupStore, attachmentStore, requireGoogleSession, config });
  registerAttachmentsApi(app, { attachmentStore, requireGoogleSession, config });

  function requireProfileStore(_req, res, next) {
    if (!studentProfileStore) return res.status(503).json({ error: 'Student profile service is unavailable.' });
    return next();
  }

  registerFriendBillsApi(app, {
    requireGoogleSession,
    studentProfileStore,
    friendBillStore,
    validateProfileImage
  });

  app.get('/api/student-profile', requireGoogleSession, requireProfileStore, asyncRoute(async (req, res) => {
    try {
      const profile = await studentProfileStore.getStudentProfile(req.session.stemmaUser.subject);
      return res.json({ profile: profile ?? null });
    } catch {
      return res.status(503).json({ error: 'Student profile service is unavailable.' });
    }
  }));

  app.put('/api/student-profile', requireGoogleSession, (req, res, next) => {
    const requestOrigin = req.get('origin');
    const expectedOrigin = config.appOrigin || `${req.protocol}://${req.get('host')}`;
    if (!requestOrigin || requestOrigin !== expectedOrigin) {
      setNoStore(res);
      return res.status(403).json({ error: 'This request could not be verified.' });
    }
    if (!req.is('application/json')) {
      setNoStore(res);
      return res.status(415).json({ error: 'A JSON request body is required.' });
    }
    return next();
  }, requireProfileStore, express.json({ limit: '4kb', strict: true }), asyncRoute(async (req, res) => {
    setNoStore(res);
    const profile = validateStudentProfile(req.body);
    if (!profile) return res.status(400).json({ error: 'Student profile data is invalid.' });
    try {
      const savedProfile = await studentProfileStore.upsertStudentProfile(req.session.stemmaUser.subject, profile);
      if (!savedProfile) return res.status(503).json({ error: 'Student profile service is unavailable.' });
      return res.json({ profile: savedProfile });
    } catch {
      return res.status(503).json({ error: 'Student profile service is unavailable.' });
    }
  }));

  app.get('/api/student-profile/photo', requireGoogleSession, requireProfileStore, asyncRoute(async (req, res) => {
    setNoStore(res);
    try {
      const photo = await studentProfileStore.getStudentPhoto(req.session.stemmaUser.subject);
      if (!photo) return res.status(404).json({ error: 'Profile photo not found.' });
      res.set({
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Type': photo.mimeType
      });
      return res.status(200).send(photo.data);
    } catch {
      return res.status(503).json({ error: 'Student profile service is unavailable.' });
    }
  }));

  app.put('/api/student-profile/photo', requireGoogleSession, (req, res, next) => {
    const requestOrigin = req.get('origin');
    const expectedOrigin = config.appOrigin || `${req.protocol}://${req.get('host')}`;
    if (!requestOrigin || requestOrigin !== expectedOrigin) {
      setNoStore(res);
      return res.status(403).json({ error: 'This request could not be verified.' });
    }
    const contentType = req.get('content-type') || '';
    const mediaType = contentType.split(';', 1)[0].trim().toLowerCase();
    if (!/^image\/[a-z0-9.+-]+$/.test(mediaType)) {
      setNoStore(res);
      return res.status(400).json({ error: 'Profile photo request headers are invalid.' });
    }
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(mediaType)) {
      setNoStore(res);
      return res.status(415).json({ error: 'Profile photos must be PNG, JPEG, or WebP images.' });
    }
    return next();
  }, requireProfileStore, express.raw({ type: () => true, limit: '1mb' }), asyncRoute(async (req, res) => {
    setNoStore(res);
    const image = validateProfileImage(req.body, req.get('content-type').split(';', 1)[0].trim());
    if (!image) return res.status(400).json({ error: 'Profile photo data is invalid.' });
    const onlyIfAbsent = req.get('if-none-match') === '*';
    try {
      const result = await studentProfileStore.saveStudentPhoto(
        req.session.stemmaUser.subject,
        image,
        { onlyIfAbsent }
      );
      if (result?.saved) return res.json({ saved: true });
      if (result?.reason === 'exists' && onlyIfAbsent) return res.status(412).json({ error: 'A profile photo already exists.' });
      if (result?.reason === 'not-found') return res.status(409).json({ error: 'Student profile must exist before a photo can be saved.' });
      return res.status(503).json({ error: 'Student profile service is unavailable.' });
    } catch {
      return res.status(503).json({ error: 'Student profile service is unavailable.' });
    }
  }));

  app.get('/auth/fayda/start', authLimiter, asyncRoute(async (req, res) => {
    setNoStore(res);
    if (!isFaydaConfigured(config)) return res.redirect(303, '/?auth=unavailable');

    let metadata;
    try {
      metadata = await getProviderMetadata();
    } catch {
      return res.redirect(303, '/?auth=unavailable');
    }

    const state = crypto.randomBytes(32).toString('base64url');
    const nonce = crypto.randomBytes(32).toString('base64url');
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    const now = Date.now();
    const transactions = req.session.oidcTransactions || {};
    for (const [key, transaction] of Object.entries(transactions)) {
      if (!transaction || transaction.expiresAt <= now) delete transactions[key];
    }
    const ordered = Object.entries(transactions).sort((a, b) => a[1].createdAt - b[1].createdAt);
    while (ordered.length >= MAX_TRANSACTIONS_PER_SESSION) {
      const [oldestState] = ordered.shift();
      delete transactions[oldestState];
    }
    transactions[state] = { provider: 'fayda', nonce, codeVerifier, createdAt: now, expiresAt: now + TRANSACTION_TTL_MS };
    req.session.oidcTransactions = transactions;
    await sessionOperation(req, 'save');

    const authorizationUrl = new URL(metadata.authorization_endpoint);
    authorizationUrl.searchParams.set('client_id', config.fayda.clientId);
    authorizationUrl.searchParams.set('redirect_uri', config.fayda.redirectUri);
    authorizationUrl.searchParams.set('response_type', 'code');
    authorizationUrl.searchParams.set('response_mode', 'query');
    authorizationUrl.searchParams.set('scope', config.fayda.scopes.join(' '));
    authorizationUrl.searchParams.set('state', state);
    authorizationUrl.searchParams.set('nonce', nonce);
    authorizationUrl.searchParams.set('code_challenge', codeChallenge);
    authorizationUrl.searchParams.set('code_challenge_method', 'S256');
    if (config.fayda.acrValues) authorizationUrl.searchParams.set('acr_values', config.fayda.acrValues);
    if (config.fayda.uiLocales) authorizationUrl.searchParams.set('ui_locales', config.fayda.uiLocales);
    return res.redirect(303, authorizationUrl.href);
  }));

  app.get('/auth/fayda/callback', authLimiter, asyncRoute(async (req, res) => {
    setNoStore(res);
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    if (!/^[A-Za-z0-9_-]{43}$/.test(state) || !req.session) return res.redirect(303, '/?auth=failed');

    const transactions = req.session.oidcTransactions || {};
    const transaction = transactions[state];
    if (!transaction || transaction.provider !== 'fayda' || transaction.expiresAt <= Date.now()) return res.redirect(303, '/?auth=failed');

    // Consume and persist the one-time transaction before inspecting provider errors or exchanging code.
    delete transactions[state];
    req.session.oidcTransactions = transactions;
    await sessionOperation(req, 'save');

    if (typeof req.query.error === 'string' || typeof req.query.code !== 'string' || req.query.code.length < 1 || req.query.code.length > 2048) {
      return res.redirect(303, '/?auth=failed');
    }

    try {
      const metadata = await getProviderMetadata();
      const tokenEndpoint = metadata.token_endpoint;
      const key = await getClientSigningKey();
      const clientAssertion = await createClientAssertion(config.fayda, tokenEndpoint, key.signingKey, key.keyId);
      const tokenForm = new URLSearchParams({
        grant_type: 'authorization_code',
        code: req.query.code,
        redirect_uri: config.fayda.redirectUri,
        client_id: config.fayda.clientId,
        code_verifier: transaction.codeVerifier,
        client_assertion_type: ASSERTION_TYPE,
        client_assertion: clientAssertion
      });
      const tokenResult = await fetchText(fetchImpl, tokenEndpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: tokenForm
      });
      if (!tokenResult.response.ok) throw new Error('Token exchange failed.');
      const tokenData = parseJson(tokenResult.text);
      if (!tokenData || typeof tokenData.id_token !== 'string' || typeof tokenData.access_token !== 'string') {
        throw new Error('Token response did not include required tokens.');
      }

      const jwks = getJwks(metadata);
      const { payload: idToken } = await jwtVerify(tokenData.id_token, jwks, {
        issuer: config.fayda.issuer,
        audience: config.fayda.clientId,
        algorithms: ['RS256'],
        clockTolerance: 60
      });
      const nowSeconds = Math.floor(Date.now() / 1000);
      if (typeof idToken.sub !== 'string' || !idToken.sub || idToken.nonce !== transaction.nonce ||
          !Number.isInteger(idToken.iat) || idToken.iat > nowSeconds + 60 || idToken.iat < nowSeconds - 900) {
        throw new Error('ID token claims failed validation.');
      }

      const userInfoResult = await fetchText(fetchImpl, metadata.userinfo_endpoint, {
        headers: {
          Accept: 'application/jwt',
          Authorization: `Bearer ${tokenData.access_token}`
        }
      });
      if (!userInfoResult.response.ok) throw new Error('UserInfo request failed.');
      const userInfoJwt = userInfoResult.text.trim();
      if (!userInfoJwt || userInfoJwt.split('.').length !== 3) throw new Error('UserInfo was not a signed JWT.');
      const { payload: userInfo } = await jwtVerify(userInfoJwt, jwks, {
        issuer: config.fayda.issuer,
        audience: config.fayda.clientId,
        algorithms: ['RS256'],
        clockTolerance: 60
      });
      if (typeof userInfo.sub !== 'string' || userInfo.sub !== idToken.sub) {
        throw new Error('UserInfo subject did not match the ID token.');
      }

      // Store only the verified external key and the time of authentication; discard all provider tokens and claims.
      await sessionOperation(req, 'regenerate');
      req.session.stemmaUser = {
        provider: 'fayda',
        issuer: config.fayda.issuer,
        subject: idToken.sub,
        authenticatedAt: nowSeconds
      };
      await sessionOperation(req, 'save');
      return res.redirect(303, '/?auth=success');
    } catch {
      // Never return or log provider error text, tokens, assertions, or identity claims.
      return res.redirect(303, '/?auth=failed');
    }
  }));

  app.get('/auth/google/start', authLimiter, asyncRoute(async (req, res) => {
    setNoStore(res);
    if (!isGoogleConfigured(config)) return res.redirect(303, '/?auth=unavailable');

    const returnTo = validGroupReturnTo(req.query.returnTo) ? req.query.returnTo : '/';
    let metadata;
    try {
      metadata = await getGoogleMetadata();
    } catch {
      return res.redirect(303, '/?auth=unavailable');
    }

    const state = crypto.randomBytes(32).toString('base64url');
    const nonce = crypto.randomBytes(32).toString('base64url');
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    const now = Date.now();
    const transactions = req.session.oidcTransactions || {};
    for (const [key, transaction] of Object.entries(transactions)) {
      if (!transaction || transaction.expiresAt <= now) delete transactions[key];
    }
    const ordered = Object.entries(transactions).sort((a, b) => a[1].createdAt - b[1].createdAt);
    while (ordered.length >= MAX_TRANSACTIONS_PER_SESSION) {
      const [oldestState] = ordered.shift();
      delete transactions[oldestState];
    }
    transactions[state] = { provider: 'google', nonce, codeVerifier, returnTo, createdAt: now, expiresAt: now + TRANSACTION_TTL_MS };
    req.session.oidcTransactions = transactions;
    await sessionOperation(req, 'save');

    const authorizationUrl = new URL(metadata.authorization_endpoint);
    authorizationUrl.searchParams.set('client_id', config.google.clientId);
    authorizationUrl.searchParams.set('redirect_uri', config.google.redirectUri);
    authorizationUrl.searchParams.set('response_type', 'code');
    authorizationUrl.searchParams.set('scope', 'openid email profile');
    authorizationUrl.searchParams.set('state', state);
    authorizationUrl.searchParams.set('nonce', nonce);
    authorizationUrl.searchParams.set('code_challenge', codeChallenge);
    authorizationUrl.searchParams.set('code_challenge_method', 'S256');
    return res.redirect(303, authorizationUrl.href);
  }));

  app.get('/auth/google/callback', authLimiter, asyncRoute(async (req, res) => {
    setNoStore(res);
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    if (!/^[A-Za-z0-9_-]{43}$/.test(state) || !req.session) return res.redirect(303, '/?auth=failed');

    const transactions = req.session.oidcTransactions || {};
    const transaction = transactions[state];
    if (!transaction || transaction.provider !== 'google' || transaction.expiresAt <= Date.now()) {
      return res.redirect(303, '/?auth=failed');
    }

    delete transactions[state];
    req.session.oidcTransactions = transactions;
    await sessionOperation(req, 'save');

    if (typeof req.query.error === 'string' || typeof req.query.code !== 'string' || req.query.code.length < 1 || req.query.code.length > 2048) {
      return res.redirect(303, '/?auth=failed');
    }

    try {
      const metadata = await getGoogleMetadata();
      const tokenForm = new URLSearchParams({
        grant_type: 'authorization_code',
        code: req.query.code,
        redirect_uri: config.google.redirectUri,
        client_id: config.google.clientId,
        client_secret: config.google.clientSecret,
        code_verifier: transaction.codeVerifier
      });
      const tokenResult = await fetchText(fetchImpl, metadata.token_endpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: tokenForm
      });
      if (!tokenResult.response.ok) throw new Error('Google token exchange failed.');
      const tokenData = parseJson(tokenResult.text);
      if (!tokenData || typeof tokenData.id_token !== 'string') throw new Error('Google token response did not include an ID token.');

      const { payload: idToken } = await jwtVerify(tokenData.id_token, getGoogleJwks(metadata), {
        issuer: [GOOGLE_ISSUER, 'accounts.google.com'],
        audience: config.google.clientId,
        algorithms: ['RS256'],
        clockTolerance: 60
      });
      const nowSeconds = Math.floor(Date.now() / 1000);
      if (typeof idToken.sub !== 'string' || !idToken.sub || idToken.nonce !== transaction.nonce ||
          (idToken.azp !== undefined && idToken.azp !== config.google.clientId) ||
          !Number.isInteger(idToken.iat) || idToken.iat > nowSeconds + 60 || idToken.iat < nowSeconds - 900) {
        throw new Error('Google ID-token claims failed validation.');
      }

      const profile = normalizeGoogleProfile(idToken);
      if (googleIdentityStore) {
        await googleIdentityStore.upsertGoogleIdentity({ subject: idToken.sub, verifiedEmail: profile.email });
      }
      await sessionOperation(req, 'regenerate');
      req.session.stemmaUser = {
        provider: 'google',
        issuer: GOOGLE_ISSUER,
        subject: idToken.sub,
        authenticatedAt: nowSeconds,
        profile
      };
      await sessionOperation(req, 'save');
      const destination = validGroupReturnTo(transaction.returnTo) ? transaction.returnTo : '/';
      return res.redirect(303, `${destination}?auth=success`);
    } catch {
      return res.redirect(303, '/?auth=failed');
    }
  }));

  app.post('/auth/logout', asyncRoute(async (req, res) => {
    setNoStore(res);
    const requestOrigin = req.get('origin');
    const expectedOrigin = config.appOrigin || `${req.protocol}://${req.get('host')}`;
    if (!requestOrigin || requestOrigin !== expectedOrigin) {
      return res.status(403).json({ error: 'This request could not be verified.' });
    }
    if (!req.session) return res.status(204).end();
    await sessionOperation(req, 'destroy');
    res.clearCookie(SESSION_COOKIE, {
      path: '/',
      httpOnly: true,
      secure: config.nodeEnv === 'production' || config.sessionCookieSecure,
      sameSite: 'lax'
    });
    return res.status(204).end();
  }));

  app.get(['/', '/index.html'], (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(ROOT, 'index.html'));
  });
  app.get('/app.js', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300');
    res.type('application/javascript').sendFile(path.join(ROOT, 'app.js'));
  });
  app.get('/payment-ui.js', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300');
    res.type('application/javascript').sendFile(path.join(ROOT, 'payment-ui.js'));
  });
  for (const asset of ['profile-photo.js', 'profile-ui.js', 'navigation-memory.js', 'parent-navigation.js', 'friend-ui.js', 'notifications-ui.js', 'pulse-ui.js', 'story-video-capture.js', 'stories-ui.js', 'direct-chat-ui.js', 'chat-attachments-ui.js', 'groups-ui.js']) {
    app.get(`/${asset}`, (_req, res) => {
      res.set('Cache-Control', ['parent-navigation.js', 'direct-chat-ui.js', 'chat-attachments-ui.js'].includes(asset) ? 'no-store' : 'public, max-age=300');
      res.type('application/javascript').sendFile(path.join(ROOT, asset));
    });
  }
  app.get('/pulse-data-ui.js', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.type('application/javascript').sendFile(path.join(ROOT, 'pulse-data-ui.js'));
  });
  app.get('/pulse.css', (_req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.type('text/css').sendFile(path.join(ROOT, 'pulse.css'));
  });
  app.get('/stories.css', (_req, res) => {
    res.set({ 'Cache-Control': 'no-cache', 'Referrer-Policy': 'no-referrer' });
    res.type('text/css').sendFile(path.join(ROOT, 'stories.css'));
  });
  app.get('/styles.css', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300');
    res.type('text/css').sendFile(path.join(ROOT, 'styles.css'));
  });
  app.get('/groups.css', (_req, res) => {
    res.set({ 'Cache-Control': 'no-cache', 'Referrer-Policy': 'no-referrer' });
    res.type('text/css').sendFile(path.join(ROOT, 'groups.css'));
  });
  app.use('/assets', express.static(path.join(ROOT, 'assets'), {
    dotfiles: 'deny',
    index: false,
    fallthrough: true,
    maxAge: '1d',
    immutable: false
  }));

  app.get('/invite/:token', (req, res, next) => {
    if (!/^[A-Za-z0-9_-]{40,64}$/.test(req.params.token)) return next();
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    return res.sendFile(path.join(ROOT, 'index.html'));
  });
  app.get('/private_urls/:token', (req, res, next) => {
    if (!/^[A-Za-z0-9_-]{40,64}$/.test(req.params.token)) return next();
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    return res.sendFile(path.join(ROOT, 'index.html'));
  });
  app.get('/:slug', (req, res, next) => {
    if (!isValidGroupSlug(req.params.slug)) return next();
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    return res.sendFile(path.join(ROOT, 'index.html'));
  });
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found.' });
  });
  app.use((error, req, res, _next) => {
    if (res.headersSent) return;
    setNoStore(res);
    if (req.path === '/api/student-profile' || req.path === '/api/student-profile/photo' || req.path === '/api/notifications/read' || req.path === '/api/pulse/saved' || req.path === '/api/pulse/conversations' || req.path === '/api/pulse/stories' || /^\/api\/pulse\/stories\/[^/]+(?:\/(?:media|avatar))?$/.test(req.path) || /^\/api\/pulse\/(?:saved\/attachments|attachments\/[^/]+|conversations\/[^/]+\/(?:messages|attachments))$/.test(req.path) || req.path === '/api/pulse/groups') {
      if (error?.status === 413 || error?.type === 'entity.too.large') {
        return res.status(413).json({ error: req.path.includes('/attachments') ? 'Attachments must not exceed 5 MiB.' : req.path === '/api/notifications/read' ? 'Notification read request is too large.' : req.path === '/api/pulse/stories' ? 'Story attachments must not exceed 5 MiB.' : req.path === '/api/pulse/saved' || req.path.includes('/conversations') ? 'Message request is too large.' : req.path.endsWith('/photo') ? 'Profile photo must not exceed 1 MiB.' : req.path === '/api/pulse/groups' ? 'Group avatar data must not exceed 1 MiB.' : 'Student profile request is too large.' });
      }
      if (error?.status === 400 || error?.type === 'entity.parse.failed') {
        return res.status(400).json({ error: req.path.includes('/attachments') ? 'Attachment request is invalid.' : req.path === '/api/notifications/read' ? 'Notification read request is invalid.' : req.path === '/api/pulse/stories' ? 'Story request is invalid.' : req.path === '/api/pulse/saved' || req.path.includes('/conversations') ? 'Message request is invalid.' : req.path.endsWith('/photo') ? 'Profile photo request is invalid.' : req.path === '/api/pulse/groups' ? 'Group creation request is invalid.' : 'Student profile data is invalid.' });
      }
    }
    res.status(500).json({ error: 'The request could not be completed.' });
  });

  return app;
}

async function startServer() {
  const config = buildConfig();
  validateConfig(config);
  let postgresPool;
  let sessionStore;
  let googleIdentityStore;
  let studentProfileStore;
  let notificationStore;
  let pulseStore;
  let directChatStore;
  let attachmentStore;
  let groupStore;
  let storyStore;
  if (config.postgres.host) {
    postgresPool = new Pool({
      host: config.postgres.host,
      port: config.postgres.port,
      database: config.postgres.database,
      user: config.postgres.username,
      password: config.postgres.password,
      ssl: { rejectUnauthorized: false },
      max: 5,
      connectionTimeoutMillis: 10_000
    });
    await postgresPool.query('SELECT 1');
    googleIdentityStore = createGoogleIdentityStore(postgresPool);
    await googleIdentityStore.migrate();
    studentProfileStore = createStudentProfileStore(postgresPool);
    await studentProfileStore.migrate();
    notificationStore = createNotificationStore(postgresPool);
    await notificationStore.migrate();
    pulseStore = createPulseStore(postgresPool);
    await pulseStore.migrate();
    directChatStore = createDirectChatStore(postgresPool);
    await directChatStore.migrate();
    groupStore = createGroupStore(postgresPool);
    await groupStore.migrate();
    storyStore = createStoryStore(postgresPool);
    await storyStore.migrate();
    attachmentStore = createAttachmentStore(postgresPool);
    await attachmentStore.migrate();
    const PgStore = connectPgSimple(session);
    sessionStore = new PgStore({
      pool: postgresPool,
      tableName: 'stemma_sessions',
      createTableIfMissing: true,
      ttl: Math.floor(SESSION_TTL_MS / 1000)
    });
  }
  const app = createApp({ config, sessionStore, googleIdentityStore, studentProfileStore, notificationStore, pulseStore, directChatStore, attachmentStore, groupStore, storyStore });
  const server = app.listen(config.port, '0.0.0.0', () => {
    process.stdout.write(`Stemma server listening on port ${config.port}; Fayda sign-in ${isFaydaConfigured(config) ? 'configured' : 'not configured'}; Google sign-in ${isGoogleConfigured(config) ? 'configured' : 'not configured'}.\n`);
  });
  const shutdown = async () => {
    server.close(async () => {
      if (postgresPool) await postgresPool.end().catch(() => {});
      process.exit(0);
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer().catch(() => {
    process.stderr.write('Stemma could not start. Check the server configuration and session-store availability.\n');
    process.exitCode = 1;
  });
}
