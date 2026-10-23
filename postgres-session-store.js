import session from 'express-session';

const TRANSIENT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const EXPIRED_SESSION_PRUNE_INTERVAL_MS = 15 * 60 * 1000;
const AUTHENTICATED_COOKIE_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000;
const DURABLE_EXPIRY = 'infinity';
const TABLE = 'stemma_sessions';

function isMobileHandoff(sess) {
  return sess?.kind === 'mobile-auth-handoff' ||
    (typeof sess?.state === 'string' && typeof sess?.codeChallenge === 'string' && Number.isFinite(Number(sess?.expiresAt)));
}

function expiryFor(sess) {
  // Handoffs are credentials, not durable authenticated browser sessions.
  // Their explicit short lifetime takes precedence over stemmaUser presence.
  if (isMobileHandoff(sess)) {
    const expiry = Number(sess.expiresAt);
    if (Number.isFinite(expiry) && expiry > 0) return new Date(expiry);
  } else if (sess?.stemmaUser) {
    return DURABLE_EXPIRY;
  }
  const expiry = sess?.cookie?.expires ? new Date(sess.cookie.expires) : null;
  if (expiry && Number.isFinite(expiry.getTime())) return expiry;
  return new Date(Date.now() + TRANSIENT_SESSION_TTL_MS);
}

function parseSession(value) {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function restoreAuthenticatedCookieLifetime(sess) {
  if (!sess?.stemmaUser || isMobileHandoff(sess)) return sess;
  sess.cookie ??= {};
  const expiresAt = new Date(Date.now() + AUTHENTICATED_COOKIE_MAX_AGE_MS);
  sess.cookie.maxAge = AUTHENTICATED_COOKIE_MAX_AGE_MS;
  sess.cookie.originalMaxAge = AUTHENTICATED_COOKIE_MAX_AGE_MS;
  sess.cookie.expires = expiresAt.toISOString();
  return sess;
}

export class PostgresSessionStore extends session.Store {
  constructor(pool) {
    super();
    this.pool = pool;
    this.pruneTimer = setInterval(() => {
      this.pruneExpired().catch(() => {});
    }, EXPIRED_SESSION_PRUNE_INTERVAL_MS);
    this.pruneTimer.unref?.();
  }

  async migrate() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        sid varchar NOT NULL PRIMARY KEY,
        sess json NOT NULL,
        expire timestamp(6) NULL
      )
    `);
    // connect-pg-simple previously created this column NOT NULL. Only still-live
    // authenticated browser sessions become durable; expired rows stay expired,
    // and handoffs are always governed by their own short expiration. PostgreSQL
    // infinity remains valid to older connect-pg-simple versions during rollout.
    await this.pool.query(`ALTER TABLE ${TABLE} ALTER COLUMN expire DROP NOT NULL`);
    await this.pool.query(`
      UPDATE ${TABLE}
      SET expire = 'infinity'::timestamp
      WHERE (expire IS NULL OR expire >= CURRENT_TIMESTAMP)
        AND sess->>'stemmaUser' IS NOT NULL
        AND sess->>'kind' IS DISTINCT FROM 'mobile-auth-handoff'
        AND sid NOT LIKE 'stemma.mobile.handoff.%'
        AND expire IS DISTINCT FROM 'infinity'::timestamp
    `);
    // Reuse connect-pg-simple's historical index name where it already exists.
    await this.pool.query(`CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON ${TABLE} (expire)`);
  }

  get(sid, callback) {
    this.pool.query(
      `SELECT sess, expire = 'infinity'::timestamp AS durable FROM ${TABLE} WHERE sid = $1 AND (expire IS NULL OR expire >= CURRENT_TIMESTAMP)`,
      [sid]
    ).then(async ({ rows }) => {
      const sess = rows[0]?.sess;
      if (sess === undefined) {
        callback(null, undefined);
        return;
      }
      const restored = restoreAuthenticatedCookieLifetime(parseSession(sess));
      if (restored?.stemmaUser && !isMobileHandoff(restored) && rows[0].durable !== true) {
        // An older app instance can rewrite infinity to its practical cookie
        // expiry during rollout. Repair only a still-live row; never revive an
        // expired authenticated session.
        await this.pool.query(
          `UPDATE ${TABLE} SET expire = 'infinity'::timestamp
           WHERE sid = $1 AND (expire IS NULL OR expire >= CURRENT_TIMESTAMP)
             AND (expire IS NULL OR expire <> 'infinity'::timestamp)`,
          [sid]
        );
      }
      callback(null, restored);
    }).catch(callback);
  }

  set(sid, sess, callback) {
    const expire = expiryFor(sess);
    this.pool.query(
      `INSERT INTO ${TABLE} (sid, sess, expire) VALUES ($1, $2, $3)
       ON CONFLICT (sid) DO UPDATE SET sess = EXCLUDED.sess, expire = EXCLUDED.expire`,
      [sid, sess, expire]
    ).then(() => callback?.(null), error => callback?.(error));
  }

  touch(sid, sess, callback) {
    // Authenticated sessions are durable and need no DB write on each request;
    // express-session may still refresh the client's practical cookie lifetime.
    if (sess?.stemmaUser && !isMobileHandoff(sess)) {
      callback?.(null);
      return;
    }
    this.pool.query(
      `UPDATE ${TABLE} SET expire = $2 WHERE sid = $1`,
      [sid, expiryFor(sess)]
    ).then(() => callback?.(null), error => callback?.(error));
  }

  async consumeMobileHandoff(key, state, codeChallenge) {
    const { rows } = await this.pool.query(
      `DELETE FROM ${TABLE}
       WHERE sid = $1
         AND expire >= CURRENT_TIMESTAMP
         AND (sess->>'kind' = 'mobile-auth-handoff'
              OR (sess->>'kind' IS NULL AND sid LIKE 'stemma.mobile.handoff.%'))
         AND sess->>'state' = $2
         AND sess->>'codeChallenge' = $3
         AND CASE
           WHEN sess->>'expiresAt' ~ '^[0-9]+([.][0-9]+)?$'
             THEN (sess->>'expiresAt')::numeric > $4
           ELSE FALSE
         END
       RETURNING sess`,
      [key, state, codeChallenge, Date.now()]
    );
    return rows[0] ? parseSession(rows[0].sess) : null;
  }

  destroy(sid, callback) {
    this.pool.query(`DELETE FROM ${TABLE} WHERE sid = $1`, [sid])
      .then(() => callback?.(null), error => callback?.(error));
  }

  async pruneExpired() {
    await this.pool.query(`DELETE FROM ${TABLE} WHERE expire < CURRENT_TIMESTAMP`);
  }

  close() {
    clearInterval(this.pruneTimer);
  }
}
