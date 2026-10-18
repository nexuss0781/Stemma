import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const css = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
const scope = '.app-shell:has(.app-main.profile-view) ';
function declarations(selector, prefixScope = scope) {
  const prefix = `${prefixScope}${selector} {`;
  const start = css.indexOf(prefix);
  assert.notEqual(start, -1, `Missing rule: ${prefix}`);
  return css.slice(start + prefix.length, css.indexOf('}', start));
}

function luminance(hex) {
  const rgb = hex.match(/[a-f\d]{2}/gi).map(value => parseInt(value, 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return rgb.reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
}

test('Profile cards and navigation share darker gold with solid burgundy boundaries', () => {
  assert.match(css, /\.app-shell:has\(\.app-main.profile-view\) \{ --profile-surface-gold: #c6a34f; \}/);
  for (const rule of [declarations('.bottom-nav'), declarations('.student-profile-section', ''), declarations('.student-profile-empty-card', '')]) {
    assert.match(rule, /background: var\(--profile-surface-gold\);/);
    assert.doesNotMatch(rule, /background: (?:rgba?\(|#|var\(--brand-gold(?:-light)?\)|var\(--brand-burgundy\))/);
  }
  assert.match(declarations('.bottom-nav'), /border-color: var\(--brand-burgundy\)/);
  for (const selector of ['.student-profile-section', '.student-profile-empty-card']) {
    assert.match(declarations(selector, ''), /border: 1px solid var\(--brand-burgundy\)/);
  }
  assert.match(declarations('.nav-item'), /color: #49332e/);
  assert.match(declarations('.nav-indicator'), /background: var\(--brand-burgundy\)/);
  assert.match(declarations('.nav-item[aria-current="page"]'), /color: var\(--brand-gold\)/);
  assert.match(declarations('.nav-item:hover:not([aria-current="page"])'), /color: #49332e/);
  assert.match(declarations('.nav-item:focus-visible'), /outline: 2px solid var\(--brand-burgundy\)/);
});

test('darker Profile surfaces remain distinct from the page and keep normal text readable', () => {
  const surface = luminance('c6a34f');
  assert.ok(luminance('F2E49A') - surface > 0.25, 'surface must visibly darken the established page gold');
  for (const text of ['49332e', '681b1d']) {
    assert.ok((surface + 0.05) / (luminance(text) + 0.05) >= 4.5, 'Profile text meets WCAG AA contrast');
  }
  assert.match(declarations('.student-profile-detail dt', ''), /color: #49332e/);
  assert.match(declarations('.student-profile-detail dd', ''), /color: #49332e/);
});

test('the page stays the established gold and other routes retain their navigation styling', () => {
  assert.match(css, /--brand-gold: #F1DF9B;/);
  assert.match(css, /--brand-cream: #F2E49A;/);
  assert.match(css, /html, body \{ background: var\(--brand-cream\); \}/);
  assert.match(css, /\.bottom-nav \{ border-color: rgba\(104,27,29,\.17\); background: rgba\(251,243,214,\.92\);/);
  const profileRules = css.split('\n').filter(line => line.startsWith(scope));
  assert.equal(profileRules.length, 7);
  assert.ok(profileRules.every(line => !/student-profile|html|body/.test(line)));
});
