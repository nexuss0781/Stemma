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
  assert.match(source, /if \(!document\.hidden\) \{ await loadChannels\(\); if \(!view\.hidden\) \{ await loadPosts\(\);/);
  const backend = read('channels-api.js');
  assert.match(backend, /nextBefore: hasMore \? page\.at\(-1\)\.id : null/);
  assert.match(backend, /id < \$2::bigint/);
});

test('subscription, mute, leave, pin, and read-cursor controls use explicit persisted API contracts', () => {
  assert.match(source, /data-channel-subscribe/);
  assert.match(source, /data-channel-mute/);
  assert.match(source, /data-channel-leave/);
  assert.match(source, /data-channel-pin/);
  assert.match(source, /action = 'subscription'; body = \{ subscribed: true \}/);
  assert.match(source, /action = 'subscription'; body = \{ subscribed: false \}/);
  assert.match(source, /action = 'preferences'; body = \{ muted: !current\.muted \}/);
  assert.match(source, /action = 'pin'; body = \{ postId: current\.pinnedPost\?\.id === pin\.dataset\.channelPin \? null : pin\.dataset\.channelPin \}/);
  assert.match(source, /encodeURIComponent\(id\)\}\/read`, \{ method: 'POST'[\s\S]*JSON\.stringify\(\{ postId: last \}\)/);
  assert.match(source, /unreadAfter = current\.isSubscribed && !current\.isOwner \? \(current\.lastReadPostId \|\| '0'\) : null/);
  assert.match(source, /BigInt\(post\.id\) > BigInt\(unreadAfter\)/,
    'the divider is derived from real post IDs after the persisted read cursor');
  assert.match(source, /Number\(current\.subscriberCount \|\| 0\)\.toLocaleString\(\)/,
    'subscriber display must use the server-provided count rather than a fabricated number');
  const backend = read('channels-api.js');
  assert.match(backend, /\/subscription'[\s\S]*validateExactBooleanBody\(req\.body, 'subscribed'\)/);
  assert.match(backend, /\/preferences'[\s\S]*validateExactBooleanBody\(req\.body, 'muted'\)/);
  assert.match(backend, /\/read'[\s\S]*validateReadBody\(req\.body\)/);
  assert.match(backend, /\/pin'[\s\S]*validatePinBody\(req\.body\)/);
});

test('channel focus mode portals the screen, makes the app inert, and restores navigation and list scroll', () => {
  assert.match(source, /view\.before\(portal\); document\.body\.append\(view\)/,
    'the focused channel screen is moved outside the inert app shell');
  assert.match(source, /app\.inert = true/);
  assert.match(source, /portal\.replaceWith\(view\); portal = null; if \(app\) app\.inert = appInert/);
  assert.match(source, /savedScroll = \[\.\.\.shell\.querySelectorAll\('\.pulse-panel, \.pulse-feed, \.pulse-viewport, \.pulse-unified-list'\)\]/,
    'the scrollable Channel list itself must be captured, not only its non-scrolling ancestors');
  assert.match(source, /for \(const \[el, top, left\] of savedScroll\) \{ el\.scrollTop = top; el\.scrollLeft = left; \}/);
  assert.match(source, /StemmaParentNavigation\?\.enter\('pulse-channel', \(\) => back\(true\)/,
    'browser Back closes the focused view through parent navigation');
  assert.match(source, /StemmaParentNavigation\?\.back\('pulse-channel'\)/,
    'the in-view Back button uses the same navigation stack');
  assert.match(source, /returnFocus = trigger \|\| shell\.querySelector\('\[aria-selected="true"\]\[data-pulse-tab\]'\)/);
  assert.match(source, /if \(returnFocus\?\.isConnected\) returnFocus\.focus\(\{ preventScroll: true \}\)/);
});

test('owner attachments are gated and channel posts render image and video previews safely', () => {
  assert.match(source, /endpoint: \(\) => current\?\.isOwner \? `\$\{api\}\/\$\{encodeURIComponent\(current\.id\)\}\/attachments` : null/);
  assert.match(source, /ready: \(\) => Boolean\(current\?\.isOwner && !sending\)/);
  assert.match(source, /if \(\/\^video\\\/\(mp4\|webm\)\$\/\.test\(a\.mimeType\)/,
    'video attachments use an inline video player');
  assert.match(source, /root\.StemmaChatAttachments\?\.render\(a\)/,
    'supported image attachments use the shared safe renderer');
  const attachmentUi = read('chat-attachments-ui.js');
  assert.match(attachmentUi, /root\.StemmaChatAttachments/);
  assert.match(attachmentUi, /\^\\\/api\\\/pulse\\\/attachments\\\/\[a-f0-9-\]\{36\}/i,
    'only same-origin attachment API URLs are rendered');
  const attachments = read('attachments-api.js');
  assert.match(attachments, /app\.post\('\/api\/pulse\/channels\/:id\/attachments'/);
  assert.match(attachments, /Only the channel owner may post attachments/);
  assert.match(attachments, /app\.get\('\/api\/pulse\/attachments\/:id', requireGoogleSession/,
    'downloads require an authenticated reader');
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
