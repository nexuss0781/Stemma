import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../pulse.css', import.meta.url), 'utf8');
const groups = readFileSync(new URL('../groups.css', import.meta.url), 'utf8');
const ui = readFileSync(new URL('../groups-ui.js', import.meta.url), 'utf8');
const pulse = readFileSync(new URL('../pulse-ui.js', import.meta.url), 'utf8');
const rule = (source, selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...source.matchAll(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`, 'g'))].at(-1)?.[1] || '';
};

test('Saved Messages uses the same thin line separator as direct conversations, without a special top frame', () => {
  const saved = rule(css, '#pulse-panel-0 .pulse-saved-row');
  const direct = rule(css, ':is(#pulse-panel-0, #pulse-panel-1) .pulse-direct-row');
  assert.match(saved, /border-bottom:\s*1px solid var\(--line\)/);
  assert.match(direct, /border-bottom:\s*1px solid var\(--line\)/);
  assert.doesNotMatch(saved, /border-(?:block|top)|brand-burgundy/);
  assert.match(pulse, /kind === 'all' \? `<button[^>]+pulse-saved-row/);
});

test('Pulse group names, metadata and chevrons are readable on the cream list surface', () => {
  assert.match(rule(groups, '.pulse-feed .group-list-copy strong'), /color:\s*var\(--brand-burgundy-deep\)/);
  assert.match(rule(groups, '.pulse-feed .group-list-copy span'), /var\(--brand-burgundy\) 68%/);
  assert.match(rule(groups, '.pulse-feed .group-list-arrow'), /color:\s*var\(--brand-burgundy\)/);
  assert.match(rule(groups, '.pulse-feed .group-list-row'), /border-color:\s*var\(--line\)/);
});

test('Group list still uses actual names, existing avatar and correct group id without new actions', () => {
  const renderer = ui.slice(ui.indexOf('function renderRows('), ui.indexOf('async function loadGroups('));
  assert.match(renderer, /group\.name \|\| 'Group'/);
  assert.match(renderer, /photo\(avatar, group, initial\(group\)\)/);
  assert.match(renderer, /row\.dataset\.groupOpen = group\.id/);
  assert.doesNotMatch(renderer, /delete|remove|destroy|fixture|mock/i);
});
