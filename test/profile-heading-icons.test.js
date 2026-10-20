import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../styles.css', import.meta.url), 'utf8');

test('Profile heading keeps its title and only one accessible notification button', () => {
  const heading = html.match(/<div class="page-heading">([\s\S]*?)\n      <\/div>/)?.[1];
  assert.ok(heading);
  assert.match(heading, /<h1 class="page-title" id="page-title" hidden>Payment<\/h1>/);
  assert.match(heading, /<button[^>]*id="profile-notifications-button"[^>]*type="button"[^>]*aria-label="Notifications"[^>]*aria-controls="notifications-page"/);
  assert.doesNotMatch(heading, /id="profile-notifications-button"[^>]*aria-haspopup="dialog"/);
  assert.match(heading, /<use href="#i-bell"/);
  assert.equal((heading.match(/class="profile-heading-icon"/g) || []).length, 1);
  assert.doesNotMatch(heading, /About|#i-info|role="img"/);
  assert.match(html, /<main[^>]*id="notifications-page"[^>]*hidden/);
  assert.match(html, /id="notifications-back"[^>]*aria-label="Back to previous page"/);
  assert.match(html, /id="notifications-content"[^>]*aria-live="polite"/);
  assert.doesNotMatch(html, /id="notifications-dialog"|id="notifications-close"/);
  assert.match(html, /src="\/notifications-ui\.js\?v=\d+" defer/);
});

test('bell appears at far right only on Profile and other pages preserve their grid', () => {
  assert.match(css, /\.page-heading \{ display: contents; \}/);
  assert.match(css, /\.profile-heading-icons \{ display: none; \}/);
  assert.match(css, /\.app-main\.profile-view \.page-heading \{ display: flex; align-items: center; justify-content: space-between; gap: 12px; min-width: 0; \}/);
  assert.match(css, /\.app-main\.profile-view \.profile-heading-icons \{ display: flex; align-items: center; gap: 8px; flex-shrink: 0; \}/);
  assert.match(css, /\.profile-heading-icon \{[^}]*width: 34px; height: 34px;[^}]*border-radius: 12px;[^}]*color: var\(--brand-gold\);[^}]*background: var\(--brand-burgundy\)/);
});
