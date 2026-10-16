import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGoogleIdentityStore } from '../server.js';

test('Google identity migration is additive and persists only subject and verified email', async () => {
  const statements = [];
  const identityRow = {
    subject: 'google-stable-subject-456',
    verifiedEmail: 'verified@example.com'
  };
  const pool = {
    async query(text, values) {
      statements.push({ text, values });
      if (text.includes('INSERT INTO stemma_google_identities')) return { rows: [identityRow] };
      if (text.includes('SELECT google_subject')) return { rows: [identityRow] };
      return { rows: [] };
    }
  };
  const store = createGoogleIdentityStore(pool);

  await store.migrate();
  assert.deepEqual(await store.upsertGoogleIdentity({
    subject: identityRow.subject,
    verifiedEmail: identityRow.verifiedEmail
  }), identityRow);
  assert.deepEqual(await store.getGoogleIdentity(identityRow.subject), identityRow);

  assert.match(statements[0].text, /CREATE TABLE IF NOT EXISTS stemma_google_identities/i);
  assert.doesNotMatch(statements[0].text, /\bDROP\s+(TABLE|SCHEMA|DATABASE)\b/i);
  assert.doesNotMatch(statements[0].text, /display_name|avatar_url/i);
  assert.match(statements[1].text, /ON CONFLICT \(google_subject\) DO UPDATE/i);
  assert.deepEqual(statements[1].values, [identityRow.subject, identityRow.verifiedEmail]);
  assert.match(statements[2].text, /WHERE google_subject = \$1/);
  assert.deepEqual(statements[2].values, [identityRow.subject]);
});
