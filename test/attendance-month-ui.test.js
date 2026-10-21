import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const read = file => fs.readFile(new URL('../system-apps/attendance/' + file, import.meta.url), 'utf8');

test('Monthly grid replaces the daily class register and summary cards with a month dropdown directly above it', async () => {
  const html = await read('index.html');
  assert.match(html, /<select id="attendance-month"><\/select>[\s\S]*?<\/div>\s*<div class="monthly-grid-wrap"/);
  assert.match(html, /id="previous-month"[^>]*aria-label="Previous month"/);
  assert.match(html, /id="next-month"[^>]*aria-label="Next month"/);
  assert.match(html, /aria-label="Attendance status report"/);
  assert.match(html, /class="back-arrow"/);
  assert.doesNotMatch(html, /Class register|report-metrics|30 days/i);
  assert.match(html, /no class or absence is inferred/);
});

test('Monthly report only labels saved records and provides phone scrolling, sticky names and readable print bands', async () => {
  const source = await read('app.ts');
  const css = await read('app.css');
  assert.match(source, /\/month\?month=/);
  assert.match(source, /monthState\.days\.find\(day => day\.date === date\)/);
  assert.match(source, /return saved\?\.presentIds\.length \? "unmarked" : saved \? "neutral" : "unknown"/);
  assert.doesNotMatch(source, /"absent"|"no-class"|"is-red"/);
  assert.match(source, /start < dates\.length; start \+= 11/);
  assert.match(source, /prefers-reduced-motion/);
  assert.match(css, /position: sticky; left: 0/);
  assert.match(css, /overflow-x: auto/);
  assert.match(css, /--cyan: #079fb7/);
  assert.match(css, /size: A4 landscape/);
  assert.match(css, /\.day-toggle[^}]*min-height: 55px; min-width: 44px/);
});
