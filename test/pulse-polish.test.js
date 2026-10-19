import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const [chatSource, dataSource, css] = await Promise.all(
  ['direct-chat-ui.js', 'pulse-data-ui.js', 'pulse.css'].map(name => readFile(new URL(name, root), 'utf8'))
);

function rule(selector, { last = false } = {}) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...css.matchAll(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, 'g'))];
  assert.ok(matches.length, `stylesheet contains ${selector}`);
  return matches[last ? matches.length - 1 : 0][1];
}

test('Pulse direct-chat markup exposes a compact peer identity and accessible private conversation shell', () => {
  const api = {};
  api.window = api;
  vm.runInNewContext(chatSource, api);
  const markup = api.StemmaDirectChat.view();

  assert.match(markup, /<section class="pulse-direct-chat" aria-label="Direct chat" hidden>/);
  assert.match(markup, /<span class="pulse-person-mark pulse-direct-peer" aria-hidden="true"><\/span>/,
    'the peer avatar is decorative and populated only after a conversation is selected');
  assert.match(markup, /<div class="pulse-direct-identity"><h2 class="pulse-direct-title">Chat<\/h2><p class="pulse-direct-handle"><\/p><\/div>/,
    'nickname/title and username/handle have separate semantic slots');
  assert.match(markup, /<span class="pulse-direct-private">1:1<\/span>/,
    'the header identifies a one-to-one conversation');
  assert.match(markup, /role="region" aria-label="Conversation messages"/);
  assert.match(markup, /role="list" aria-label="Messages"><\/div>/);
  assert.match(markup, /role="status" aria-live="polite"/);

  const identity = chatSource.slice(chatSource.indexOf('const peer = next.peer || next;'), chatSource.indexOf('panel.hidden = false'));
  assert.match(identity, /title\.textContent = peer\.nickName \|\| `@\$\{peer\.username \|\| ''\}`/);
  assert.match(identity, /handle\.textContent = peer\.username \? `@\$\{peer\.username\}` : ''/);
  assert.match(identity, /peer\.nickName \|\| peer\.username/);
  assert.doesNotMatch(identity, /peer\.(?:firstName|middleName|lastName|legalName|email|department|studentId)/,
    'chat identity uses only the nickname and @username, never private profile details');
});

test('Pulse conversation rows pair nickname with @username and keep the row compact and accessible', () => {
  const start = dataSource.indexOf('function renderConversations()');
  const end = dataSource.indexOf('function shortTime(', start);
  assert.ok(start >= 0 && end > start, 'conversation row rendering has a bounded implementation');
  const paint = dataSource.slice(start, end);
  assert.match(paint, /node\('button', 'pulse-conversation pulse-direct-row'\)/,
    'a conversation is rendered as a keyboard-operable button');
  assert.match(paint, /avatar\.setAttribute\('aria-hidden', 'true'\)/,
    'the decorative initial does not duplicate the accessible row name');
  assert.match(paint, /node\('span', 'pulse-direct-row-heading'\)/);
  assert.match(paint, /node\('strong', '', peer\.nickName \|\| `@\$\{peer\.username \|\| ''\}`\)/);
  assert.match(paint, /node\('span', 'pulse-direct-row-handle', `@\$\{peer\.username\}`\)/);
  const peerFields = [...paint.matchAll(/peer\.([A-Za-z_$][\w$]*)/g)].map(match => match[1]);
  assert.deepEqual([...new Set(peerFields)].sort(), ['nickName', 'username'],
    'conversation rows read no legal name, email, or other profile fields');

  assert.match(rule('.pulse-direct-row, .pulse-saved-row'), /min-height:\s*82px/);
  assert.match(rule('.pulse-direct-row-heading'), /display:\s*flex/);
  assert.match(rule('.pulse-direct-row-heading strong'), /text-overflow:\s*ellipsis/);
  assert.match(rule('.pulse-direct-row-handle'), /text-overflow:\s*ellipsis/);
  assert.match(rule('.pulse-direct-row .pulse-person-mark'), /background:\s*var\(--brand-gold\)/);
});

test('All/User lists use the full-width paper-soft surface and compact final row override', () => {
  const shell = rule('.app-shell:has(.pulse-feed:not([hidden]) :is(#pulse-tab-0, #pulse-tab-1)[aria-selected="true"])', { last: true });
  const feed = rule('.pulse-feed:has(:is(#pulse-tab-0, #pulse-tab-1)[aria-selected="true"])', { last: true });
  const row = rule(':is(#pulse-panel-0, #pulse-panel-1) :is(.pulse-direct-row, .pulse-saved-row)', { last: true });
  const avatar = rule(':is(#pulse-panel-0, #pulse-panel-1) .pulse-person-mark', { last: true });

  assert.match(shell, /padding-inline:\s*0/);
  assert.match(shell, /background:\s*var\(--paper-soft\)/);
  assert.match(feed, /border:\s*0/);
  assert.match(feed, /border-radius:\s*0/);
  assert.match(feed, /box-shadow:\s*none/);
  assert.match(feed, /background:\s*var\(--paper-soft\)/);
  assert.match(rule('.pulse-view:has(.pulse-feed:not([hidden]) :is(#pulse-tab-0, #pulse-tab-1)[aria-selected="true"]) .pulse-content-grid', { last: true }), /width:\s*100%/);
  assert.match(row, /min-height:\s*64px/,
    'the final All/User override supersedes the earlier 82px base row height');
  assert.match(row, /padding:\s*9px\s+0/);
  assert.match(row, /border:\s*0/);
  assert.match(avatar, /flex-basis:\s*42px/);
  assert.match(avatar, /width:\s*42px/);
  assert.match(avatar, /height:\s*42px/);
});

test('conversation list omits ready-empty copy but keeps loading and error status messages', () => {
  const start = dataSource.indexOf('function renderConversations()');
  const end = dataSource.indexOf('function shortTime(', start);
  const paint = dataSource.slice(start, end);

  assert.doesNotMatch(paint, /No conversations yet|No conversations found|Start a conversation/,
    'a successful empty result has no ready-empty message');
  assert.match(paint, /conversationsState === 'loading' \? 'Loading conversations…' : conversationsState === 'error' \? 'Conversations could not be loaded\. Check your connection and try again\.' : ''/);
  assert.match(paint, /empty\.hidden = !message/,
    'the status element remains visible for loading/error text and hidden for ready-empty results');
});

test('Pulse chat bubbles retain gold incoming and burgundy outgoing colors from the existing palette', () => {
  const incoming = rule('.pulse-direct-message', { last: true });
  const outgoing = rule('.pulse-direct-message.is-mine', { last: true });
  assert.match(incoming, /background:\s*var\(--brand-gold\)/,
    'incoming bubbles use the established gold');
  assert.match(incoming, /color:\s*var\(--brand-burgundy-deep\)/);
  assert.match(outgoing, /background:\s*var\(--brand-burgundy\)/,
    'outgoing bubbles use the established burgundy');
  assert.match(outgoing, /color:\s*var\(--brand-gold-light\)/);
  assert.match(incoming, /border-radius:/);
  assert.match(outgoing, /border-radius:/);
  assert.doesNotMatch(css, /#[\da-f]{3,8}\b|rgba?\(/i,
    'Pulse polish continues to use the application palette tokens rather than hard-coded colors');
});
