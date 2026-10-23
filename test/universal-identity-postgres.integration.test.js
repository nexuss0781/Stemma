import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { createUniversalIdentityStore } from '../universal-identity-api.js';

const connection = {
  host: '127.0.0.1', port: 5432, database: 'stemma_notification_test',
  user: 'stemma_notification_test', password: 'local-notification-test-only',
  max: 5, connectionTimeoutMillis: 5000
};
const schemaName = prefix => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;

async function makeSchema(admin, schema) {
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ ...connection, options: `-c search_path=${schema}` });
  await pool.query(`CREATE TABLE stemma_google_identities (
    google_subject VARCHAR(255) PRIMARY KEY,
    verified_email VARCHAR(320) NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await pool.query(`CREATE TABLE stemma_student_profiles (
    google_subject VARCHAR(255) PRIMARY KEY REFERENCES stemma_google_identities(google_subject) ON DELETE CASCADE,
    username TEXT NOT NULL DEFAULT '', nick_name TEXT NOT NULL DEFAULT ''
  )`);
  await pool.query(`CREATE TABLE stemma_groups (
    id BIGSERIAL PRIMARY KEY, slug TEXT NOT NULL, name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '', visibility TEXT NOT NULL DEFAULT 'public'
  )`);
  await pool.query(`CREATE TABLE stemma_pulse_channels (
    id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, owner_subject VARCHAR(255) NOT NULL DEFAULT ''
  )`);
  return pool;
}

async function dropSchema(admin, pool, schema) {
  await pool?.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
}

test('universal identity migration is concurrent-safe, idempotent and enforces canonical UUID claims', {
  skip: process.env.STEMMA_UNIVERSAL_IDENTITY_DB_TEST !== '1', timeout: 120000
}, async () => {
  const admin = new pg.Pool(connection);
  const schema = schemaName('stemma_identity_it');
  let pool;
  try {
    pool = await makeSchema(admin, schema);
    await pool.query(`INSERT INTO stemma_google_identities (google_subject) VALUES ('identity-it-account-a'), ('identity-it-account-b')`);
    await pool.query(`INSERT INTO stemma_student_profiles (google_subject, username, nick_name)
      VALUES ('identity-it-account-a', 'Alpha_Handle', 'Alpha'), ('identity-it-account-b', '', 'Beta')`);
    await pool.query(`INSERT INTO stemma_groups (id, slug, name, visibility, description) VALUES
      (101, 'Study_Group', 'Study Group', 'public', 'must not appear in public identity resolve'),
      (102, 'tiny', 'Private Group', 'private', 'private data')`);
    await pool.query(`INSERT INTO stemma_pulse_channels (id, name, owner_subject) VALUES (7, 'Main Channel', 'identity-it-account-a')`);
    const store = createUniversalIdentityStore(pool);

    await Promise.all([store.migrate(), store.migrate()]);
    const initial = await pool.query(`SELECT entity_type, entity_key, username, identity_id::text AS uuid
      FROM stemma_universal_identities ORDER BY entity_type, entity_key`);
    assert.equal(initial.rowCount, 6, 'two accounts, two groups, one channel and one registered system app are claimed');
    const initialIds = new Map(initial.rows.map(row => [`${row.entity_type}:${row.entity_key}`, row.uuid]));
    const accountA = await store.getBySubject('identity-it-account-a');
    assert.equal(accountA.username, 'alpha_handle');
    assert.equal((await store.getBySubject('identity-it-account-b')).username, 'user_' + crypto.createHash('md5').update('identity-it-account-b').digest('hex').slice(0, 10));
    assert.equal((await store.getByIdentifier('ALPHA_HANDLE')).kind, 'account');
    assert.equal((await store.getByIdentifier('teacher-attendance')).kind, 'system_app');
    assert.equal(await store.getByIdentifier('tiny'), null, 'private group identity is not resolvable');
    const publicGroup = await store.getByIdentifier('study_group');
    assert.equal(publicGroup.kind, 'group');
    assert.equal(Object.hasOwn(publicGroup, 'entityKey'), false);
    assert.equal(Object.hasOwn(publicGroup, 'description'), false);
    assert.equal((await store.getByIdentifier('channel-7')).kind, 'channel');

    await store.migrate();
    const afterRetry = await pool.query(`SELECT entity_type, entity_key, identity_id::text AS uuid FROM stemma_universal_identities`);
    assert.equal(afterRetry.rowCount, initial.rowCount);
    for (const row of afterRetry.rows) assert.equal(row.uuid, initialIds.get(`${row.entity_type}:${row.entity_key}`), 'retry preserves immutable UUIDs');

    await pool.query(`UPDATE stemma_student_profiles SET username = 'New_Handle' WHERE google_subject = 'identity-it-account-a'`);
    assert.equal((await pool.query(`SELECT username FROM stemma_student_profiles WHERE google_subject='identity-it-account-a'`)).rows[0].username, 'new_handle');
    assert.equal((await store.getByIdentifier('NEW_HANDLE')).identityId, accountA.identityId);
    await pool.query(`UPDATE stemma_groups SET slug='New_Study' WHERE id=101`);
    assert.equal((await pool.query('SELECT slug FROM stemma_groups WHERE id=101')).rows[0].slug, 'new_study');
    assert.equal((await store.getByIdentifier('new_study')).identityId, initialIds.get('group:101'));
    await pool.query(`UPDATE stemma_pulse_channels SET username='Main_Channel' WHERE id=7`);
    assert.equal((await pool.query('SELECT username FROM stemma_pulse_channels WHERE id=7')).rows[0].username, 'main_channel');
    assert.equal((await store.getByIdentifier('main_channel')).identityId, initialIds.get('channel:7'));

    await assert.rejects(pool.query(`UPDATE stemma_groups SET slug='teacher-attendance' WHERE id=101`), error => error.code === '23505');
    await assert.rejects(pool.query(`UPDATE stemma_universal_identities SET identity_id=gen_random_uuid() WHERE entity_type='account' AND entity_key='identity-it-account-a'`), error => error.code === '23514');
    await assert.rejects(pool.query(`UPDATE stemma_universal_identities SET entity_key='changed' WHERE entity_type='account' AND entity_key='identity-it-account-a'`), error => error.code === '23514');
    await assert.rejects(pool.query(`INSERT INTO stemma_student_profiles (google_subject, username) VALUES ('identity-it-account-a', 'four') ON CONFLICT DO NOTHING`), error => error.code === '23514');
    await assert.rejects(pool.query(`UPDATE stemma_groups SET slug='four' WHERE id=101`), error => error.code === '23514');
    await assert.rejects(pool.query(`UPDATE stemma_pulse_channels SET username='four' WHERE id=7`), error => error.code === '23514');

    const race = await Promise.allSettled([
      pool.query(`UPDATE stemma_student_profiles SET username='Shared_Race' WHERE google_subject='identity-it-account-a'`),
      pool.query(`UPDATE stemma_groups SET slug='SHARED_RACE' WHERE id=101`)
    ]);
    assert.equal(race.filter(result => result.status === 'fulfilled').length, 1, 'one concurrent cross-type claimant wins');
    assert.equal(race.filter(result => result.status === 'rejected' && result.reason.code === '23505').length, 1, 'the other concurrent claim is rejected by the global database index');
    await pool.query(`UPDATE stemma_student_profiles SET username='new_handle' WHERE google_subject='identity-it-account-a'`);
    await pool.query(`UPDATE stemma_groups SET slug='new_study' WHERE id=101`);
    await pool.query(`UPDATE stemma_student_profiles SET username='channel-7' WHERE google_subject='identity-it-account-b'`);
    await store.migrate();
    assert.equal((await store.getByIdentifier('MAIN_CHANNEL')).identityId, initialIds.get('channel:7'), 'restart respects a channel custom handle rather than claiming its old generated name');

    await pool.query(`DELETE FROM stemma_google_identities WHERE google_subject='identity-it-account-b'`);
    assert.equal(await store.getByIdentifier('channel-7'), null,
      'deleted claims are retained as name-reserving tombstones but do not resolve');
  } finally {
    await dropSchema(admin, pool, schema);
    await admin.end();
  }
});

test('migration collision errors roll back every schema and data change', {
  skip: process.env.STEMMA_UNIVERSAL_IDENTITY_DB_TEST !== '1', timeout: 120000
}, async () => {
  const admin = new pg.Pool(connection);
  const schema = schemaName('stemma_identity_collision_it');
  let pool;
  try {
    pool = await makeSchema(admin, schema);
    await pool.query(`INSERT INTO stemma_google_identities (google_subject) VALUES ('collision-one'), ('collision-two')`);
    await pool.query(`INSERT INTO stemma_student_profiles (google_subject, username) VALUES ('collision-one', 'Same_Name'), ('collision-two', 'same_name')`);
    await assert.rejects(createUniversalIdentityStore(pool).migrate(), error => error.code === '23505' && /collide case-insensitively/.test(error.message));
    assert.equal((await pool.query("SELECT to_regclass('stemma_universal_identities') IS NOT NULL AS exists")).rows[0].exists, false,
      'transaction rollback leaves no partially-created identity table');
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM stemma_student_profiles')).rows[0].count, 2);
  } finally {
    await dropSchema(admin, pool, schema);
    await admin.end();
  }
});
