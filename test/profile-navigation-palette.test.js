import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const css = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
const scope = '.app-shell:has(.app-main.profile-view) ';
function declarations(selector) {
  const prefix = `${scope}${selector} {`;
  const start = css.indexOf(prefix);
  assert.notEqual(start, -1, `Missing Profile-only rule: ${selector}`);
  return css.slice(start + prefix.length, css.indexOf('}', start));
}

test('Profile navigation uses existing burgundy and gold, without a white surface', () => {
  assert.match(declarations('.bottom-nav'), /background: var\(--brand-burgundy\)/);
  assert.match(declarations('.bottom-nav'), /border-color: var\(--brand-gold\)/);
  assert.match(declarations('.nav-item'), /color: var\(--brand-gold\)/);
  assert.match(declarations('.nav-indicator'), /background: var\(--brand-gold\)/);
  assert.match(declarations('.nav-item[aria-current="page"]'), /color: var\(--brand-burgundy\)/);
  assert.match(declarations('.nav-item:hover:not([aria-current="page"])'), /color: var\(--brand-gold\)/);
  assert.match(declarations('.nav-item:focus-visible'), /outline: 2px solid var\(--brand-gold\)/);
});

test('the page stays the established gold and other routes retain their navigation styling', () => {
  assert.match(css, /--brand-cream: #F2E49A;/);
  assert.match(css, /html, body \{ background: var\(--brand-cream\); \}/);
  assert.match(css, /\.bottom-nav \{ border-color: rgba\(104,27,29,\.17\); background: rgba\(251,243,214,\.92\);/);
  const profileRules = css.split('\n').filter(line => line.startsWith(scope));
  assert.equal(profileRules.length, 6);
  assert.ok(profileRules.every(line => !/student-profile|html|body/.test(line)));
});
