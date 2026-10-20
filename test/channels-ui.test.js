import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const source = read('channels-ui.js');
const pulse = read('pulse-ui.js');
const pulseData = read('pulse-data-ui.js');
const css = read('channels.css');

function loadModule() {
  const context = vm.createContext({ window: {}, globalThis: {}, document: {} });
  vm.runInContext(source, context);
  return context.window.StemmaChannels;
}

class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.className = '';
    this.textContent = '';
    this.dataset = {};
    this.attributes = {};
    this.children = [];
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  append(...elements) { this.children.push(...elements); }
}

test('channel view exposes read-only and owner-compose states and a wired New Channel dialog', () => {
  const html = loadModule().view();
  assert.match(html, /data-channel-read-only hidden/);
  assert.match(html, /class="channel-compose" hidden/);
  assert.match(html, /textarea[^>]*required disabled/);
  assert.match(html, /data-channel-form/);
  assert.match(html, /data-channel-cancel/);
  assert.match(source, /event\.target\.closest\('\[data-channel-create\]'\)\) openCreate\(\)/);
  assert.match(source, /method: 'POST'[\s\S]*JSON\.stringify\(\{ name \}\)/);
  assert.match(source, /if \(creating\) return/);
  assert.match(source, /if \(creating\) event\.preventDefault\(\)/);
  assert.match(source, /if \(!creating\) dialog\.close\(\)/,
    'parent navigation must not dismiss a pending creation request');
  assert.match(source, /if \(event\.target\.closest\('\[data-channel-cancel\]'\) && !creating\) dialog\.close\(\)/);
});

test('real channel records render in every Channel list and notify All to recompose', () => {
  const start = source.indexOf('    function paintRows(');
  const end = source.indexOf('    async function loadChannels()', start);
  assert.ok(start >= 0 && end > start, 'row renderer is present');
  const calls = [];
  const lists = [{ children: [], replaceChildren(...items) { this.children = items; }, append(item) { this.children.push(item); } }];
  const shell = {
    querySelectorAll(selector) { assert.equal(selector, '[data-channel-lists]'); return lists; },
    dispatchEvent(event) { calls.push(event.type); }
  };
  const context = vm.createContext({
    channels: [
      { id: '21', name: 'Public updates', isOwner: false, lastPost: { text: 'Latest update', createdAt: '2026-10-20T10:00:00Z' } },
      { id: '22', name: 'My channel', isOwner: true }
    ],
    shell,
    node: (tag, cls, value) => { const el = new FakeElement(tag); el.className = cls; if (value != null) el.textContent = value; return el; },
    glyph: name => `<svg>${name}</svg>`,
    document: { createElement: tag => new FakeElement(tag) },
    Event: class { constructor(type) { this.type = type; } }
  });
  vm.runInContext(`${source.slice(start, end)}\npaintRows();`, context);
  const rows = lists[0].children;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].dataset.channelOpen, '21');
  assert.equal(rows[0].children[1].children[0].textContent, 'Public updates');
  assert.equal(rows[0].children[1].children[1].textContent, 'Latest update');
  assert.equal(rows[1].dataset.channelOpen, '22');
  assert.equal(rows[1].children[1].children[1].textContent, 'Your channel · No posts yet');
  assert.deepEqual(calls, ['pulse:channels-updated']);
  assert.match(pulseData, /\[data-channel-lists\] > \[data-channel-open\]/,
    'All must merge the actual channel rows rather than placeholders');
  assert.match(pulseData, /listen\(shell, 'pulse:channels-updated', composeAll\)/);
});

test('owner authorization controls composing and server remains the authority for publishing', () => {
  assert.match(source, /current\.isOwner \? 'Your channel · Only you can post'/);
  assert.match(source, /compose\.hidden = !current\.isOwner/);
  assert.match(source, /input\.disabled = publish\.disabled = !current\.isOwner/);
  assert.match(source, /if \(!current\?\.isOwner \|\| sending\) return/);
  assert.match(source, /\$\{api\}\/\$\{encodeURIComponent\(id\)\}\/posts/);
  const backend = read('channels-api.js');
  assert.match(backend, /if \(!channel\.isOwner\) return res\.status\(403\)/,
    'the API independently rejects posts by non-owners');
  assert.match(backend, /app\.get\('\/api\/pulse\/channels\/[^\n]*requireGoogleSession/,
    'channel reading requires a signed-in session');
});

test('stale navigation results are ignored; channel posts use the API before-cursor and polling', () => {
  assert.match(source, /const version = \+\+revision; current = null/);
  assert.match(source, /if \(signal\.aborted \|\| version !== revision\) return/);
  assert.match(source, /earlier && cursor \? `\?before=\$\{encodeURIComponent\(cursor\)\}`/);
  assert.match(source, /cursor = data\.nextBefore \|\| null; hasMore = Boolean\(data\.hasMore\)/);
  assert.match(source, /older\.hidden = !hasMore/);
  assert.match(source, /setTimeout\(tick, 8000\)/);
  assert.match(source, /if \(!document\.hidden\) \{ await loadChannels\(\); if \(!view\.hidden\) await loadPosts\(\); \}/);
  const backend = read('channels-api.js');
  assert.match(backend, /nextBefore: hasMore \? page\.at\(-1\)\.id : null/);
  assert.match(backend, /id < \$2::bigint/);
});

test('Pulse retains All, direct, group, channel, Saved Messages, stories, and palette navigation without new dependencies', () => {
  assert.match(pulse, /\{ label: 'All'/);
  assert.match(pulse, /\{ label: 'User'/);
  assert.match(pulse, /\{ label: 'Group'/);
  assert.match(pulse, /\{ label: 'Channel'/);
  assert.match(pulse, /data-pulse-saved/);
  assert.match(pulse, /StemmaStories\.stageView/);
  assert.match(pulse, /StemmaGroups \? root\.StemmaGroups\.view\(\)/);
  assert.match(pulse, /StemmaChannels \? root\.StemmaChannels\.view\(\)/);
  assert.doesNotMatch(source, /^\s*(?:import|require\s*\()/m);
  assert.match(css, /\.channel-view\[hidden\]/);
  assert.match(css, /@media \(max-width: 480px\)/);
});
