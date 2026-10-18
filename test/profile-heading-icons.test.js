import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../styles.css', import.meta.url), 'utf8');

test('Profile heading keeps its title and uses two labeled display-only sprite icons', () => {
  const heading = html.match(/<div class="page-heading">([\s\S]*?)\n      <\/div>/)?.[1];
  assert.ok(heading);
  assert.match(heading, /<h1 class="page-title" id="page-title" hidden>Payment<\/h1>/);
  for (const [label, symbol] of [['About', 'info'], ['Notifications', 'bell']]) {
    assert.match(heading, new RegExp(`role="img" aria-label="${label}"`));
    assert.match(heading, new RegExp(`<svg class="icon" aria-hidden="true"><use href="#i-${symbol}"`));
    assert.match(html, new RegExp(`<symbol id="i-${symbol}" viewBox="0 0 24 24">`));
  }
  assert.equal((heading.match(/class="profile-heading-icon"/g) || []).length, 2);
  assert.doesNotMatch(heading, /<button|<a\b|tabindex|onclick|data-tab|data-route/);
});

test('icons appear only on Profile and preserve the shared grid on all other pages', () => {
  assert.match(css, /\.page-heading \{ display: contents; \}/);
  assert.match(css, /\.profile-heading-icons \{ display: none; \}/);
  assert.match(css, /\.app-main\.profile-view \.page-heading \{ display: flex; align-items: center; justify-content: space-between; gap: 12px; min-width: 0; \}/);
  assert.match(css, /\.app-main\.profile-view \.profile-heading-icons \{ display: flex; align-items: center; gap: 8px; flex-shrink: 0; \}/);
  assert.match(css, /\.profile-heading-icon \{[^}]*color: var\(--brand-burgundy\);[^}]*background: rgba\(251,243,214,\.92\)/);
});
