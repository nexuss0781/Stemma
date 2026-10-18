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

function paletteHex(token) {
  const match = css.match(new RegExp(`--${token}: #([a-f\\d]{6});`, 'i'));
  assert.ok(match, `Missing existing palette token: ${token}`);
  return match[1];
}

test('Profile cards and navigation share existing shaded soft light with burgundy boundaries and no new token', () => {
  assert.doesNotMatch(css, /--profile-surface-gold|#c6a34f/i);
  for (const rule of [declarations('.bottom-nav'), declarations('.student-profile-section', ''), declarations('.student-profile-empty-card', '')]) {
    assert.match(rule, /background: color-mix\(in srgb, var\(--paper-soft\) 94%, var\(--brand-burgundy\)\);/);
    assert.doesNotMatch(rule, /white|#fff|255\s*,\s*255\s*,\s*255/i);
    assert.doesNotMatch(rule, /background: (?:rgba?\(|#|var\(--brand-gold-light\)|var\(--brand-burgundy\))/);
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

test('existing burgundy boundaries distinguish soft-light surfaces from the page and retain readable text', () => {
  const soft = paletteHex('paper-soft').match(/../g).map(value => parseInt(value, 16));
  const burgundy = paletteHex('brand-burgundy').match(/../g).map(value => parseInt(value, 16));
  const mixed = soft.map((value, index) => Math.round(value * .94 + burgundy[index] * .06).toString(16).padStart(2, '0')).join('');
  const surface = luminance(mixed);
  assert.ok(surface < luminance(paletteHex('paper-soft')), 'surface is slightly darker than existing soft light');
  const page = luminance(paletteHex('brand-cream'));
  const boundary = luminance(paletteHex('brand-burgundy'));
  assert.ok((page + 0.05) / (boundary + 0.05) >= 3, 'burgundy border contrasts against the page');
  assert.ok((surface + 0.05) / (boundary + 0.05) >= 3, 'burgundy border contrasts against the card');
  for (const text of ['49332e', paletteHex('brand-burgundy')]) {
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
  assert.equal(profileRules.length, 6);
  assert.ok(profileRules.every(line => !/student-profile|html|body/.test(line)));
});
