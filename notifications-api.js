import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WELCOME_KEY = 'app-welcome-v1';
const WELCOME_TITLE = 'Welcome to Stemma';
const WELCOME_MESSAGE = "Welcome to Stemma! We’re glad you’re here. This app brings your payment tools, transaction history, and profile together in one place. You can explore the payment area, review the history available for your account, and update your profile details whenever you like. Please remember that payment examples in this demo do not move real money. This welcome note does not add any sample or past transactions to your history. We hope you enjoy getting familiar with the app.";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_READ_IDS = 5000;

export function createNotificationStore(pool) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('A PostgreSQL pool is required.');
  return {
    async migrate() {
      const migration = await fs.readFile(path.join(ROOT, 'migrations', '004_student_notifications.sql'), 'utf8');
      await pool.query(migration);
    },
    async listNotifications(subject) {
      await pool.query(
        `INSERT INTO stemma_student_notifications (google_subject, notification_key, title, message)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (google_subject, notification_key) DO NOTHING`,
        [subject, WELCOME_KEY, WELCOME_TITLE, WELCOME_MESSAGE]
      );
      const result = await pool.query(
        `SELECT id::text AS id, title, message, created_at AS "createdAt", read_at AS "readAt",
                CASE WHEN notification_key = 'app-welcome-v1' THEN 'system' ELSE NULL END AS type
         FROM stemma_student_notifications
         WHERE google_subject = $1
         ORDER BY created_at DESC, id DESC`,
        [subject]
      );
      return result.rows;
    },
    async markNotificationsRead(subject, ids) {
      if (!ids.length) return [];
      const result = await pool.query(
        `UPDATE stemma_student_notifications
         SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
         WHERE google_subject = $1 AND id = ANY($2::uuid[])
         RETURNING id::text AS id, read_at AS "readAt"`,
        [subject, ids]
      );
      return result.rows;
    }
  };
}

function sameOriginGuard(config) {
  return (req, res, next) => {
    const requestOrigin = req.get('origin');
    const expectedOrigin = config.appOrigin || `${req.protocol}://${req.get('host')}`;
    if (!requestOrigin || requestOrigin !== expectedOrigin) {
      res.set('Cache-Control', 'private, no-store, max-age=0');
      return res.status(403).json({ error: 'This request could not be verified.' });
    }
    if (!req.is('application/json')) {
      res.set('Cache-Control', 'private, no-store, max-age=0');
      return res.status(415).json({ error: 'A JSON request body is required.' });
    }
    return next();
  };
}

function validateReadBody(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !Array.isArray(value.ids)) return null;
  if (value.ids.length > MAX_READ_IDS || value.ids.some(id => typeof id !== 'string' || !UUID_PATTERN.test(id))) return null;
  const ids = [...new Set(value.ids.map(id => id.toLowerCase()))];
  return ids;
}

export function registerNotificationsApi(app, { notificationStore = null, requireGoogleSession, config }) {
  if (typeof requireGoogleSession !== 'function') throw new TypeError('Google-session middleware is required.');

  app.get('/api/notifications', requireGoogleSession, async (req, res) => {
    res.set('Cache-Control', 'private, no-store, max-age=0');
    if (!notificationStore) return res.json({ notifications: [], sourceAvailable: false });
    try {
      const notifications = await notificationStore.listNotifications(req.session.stemmaUser.subject);
      return res.json({ notifications, sourceAvailable: true });
    } catch {
      return res.status(503).json({ error: 'Notification service is unavailable.' });
    }
  });

  app.post('/api/notifications/read', requireGoogleSession, sameOriginGuard(config), express.json({ limit: '256kb', strict: true }), async (req, res) => {
    res.set('Cache-Control', 'private, no-store, max-age=0');
    if (!notificationStore) return res.status(503).json({ error: 'Notification service is unavailable.' });
    const ids = validateReadBody(req.body);
    if (!ids) return res.status(400).json({ error: 'Notification read request is invalid.' });
    try {
      const updated = await notificationStore.markNotificationsRead(req.session.stemmaUser.subject, ids);
      const readIds = updated.map(row => row.id);
      const readAt = updated[0]?.readAt instanceof Date ? updated[0].readAt.toISOString() : updated[0]?.readAt ?? new Date().toISOString();
      return res.json({ readIds, readAt });
    } catch {
      return res.status(503).json({ error: 'Notification service is unavailable.' });
    }
  });
}
