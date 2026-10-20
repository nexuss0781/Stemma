import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../pulse-data-ui.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../pulse.css', import.meta.url), 'utf8');
const row = (id, time = '') => ({ id, dataset: { pulseActivity: time }, cloneNode() { return { ...this, cloned: true }; } });
function composition(saved, peers) {
  let result;
  const allList = { replaceChildren(...rows) { result = rows; } };
  const shell = { querySelectorAll(selector) {
    assert.equal(selector, '[data-pulse-conversations] > [data-pulse-conversation], [data-group-lists] > [data-group-open]');
    return peers;
  } };
  const fn = source.slice(source.indexOf('    const activity ='), source.indexOf("    listen(shell, 'pulse:groups-updated'"));
  const context = vm.createContext({ allList, savedRow: saved, shell });
  vm.runInContext(fn + '\ncomposeAll();', context);
  return result;
}
test('All merges Saved, direct and actual group rows by available activity, without category buckets', () => {
  const saved = row('saved', '2026-10-20T10:00:00Z');
  const result = composition(saved, [row('direct', '2026-10-20T11:00:00Z'), row('group', '2026-10-20T12:00:00Z'), row('undated')]);
  assert.deepEqual(result.map(r => r.id), ['group', 'direct', 'saved', 'undated']);
  assert.equal(result[2], saved, 'the actual Saved row keeps its preview and focus identity');
  assert.ok(result[0].cloned && result[1].cloned, 'filtered sources remain intact');
});
test('Undated and equal-time items have deterministic order; absent types are never fabricated', () => {
  const saved = row('saved');
  assert.deepEqual(composition(saved, []).map(r => r.id), ['saved']);
  assert.deepEqual(composition(saved, [row('direct'), row('group')]).map(r => r.id), ['saved', 'direct', 'group']);
});
test('All recomposes when groups arrive and when saved or conversation activity changes', () => {
  assert.match(source, /listen\(shell, 'pulse:groups-updated', composeAll\)/);
  assert.match(source, /paintPreview\(data\.messages\[0\]\?\.text, data\.messages\[0\]\?\.createdAt\)/);
  assert.match(source, /paintPreview\(data\.message\.text, data\.message\.createdAt\)/);
  assert.match(source, /row\.dataset\.pulseActivity = conversation\.lastMessage\?\.createdAt/);
});
test('Shared row rules remove category gaps, frames and independent scrollers', () => {
  assert.match(css, /\.pulse-feed \.pulse-panel \.pulse-unified-list\s*\{[^}]*gap: 0;[^}]*overflow-y: auto;[^}]*border: 0;/s);
  assert.match(css, /\.pulse-feed \.pulse-unified-list > \.pulse-conversation\s*\{[^}]*min-height: 64px;[^}]*margin: 0;[^}]*border-bottom: 1px solid var\(--line\);[^}]*box-shadow: none;/s);
});
