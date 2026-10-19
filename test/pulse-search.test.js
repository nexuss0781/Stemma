import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const [source, css] = await Promise.all(['pulse-ui.js', 'pulse.css'].map(name => readFile(new URL(name, root), 'utf8')));
const effects = [];
const context = vm.createContext({ fetch: () => effects.push('fetch'), XMLHttpRequest: () => effects.push('xhr') });
vm.runInContext(source, context);
const rendered = context.StemmaPulse.render();
const searchPanel = rendered.match(/<([a-z][\w-]*)\b(?=[^>]*\bid="pulse-search")(?=[^>]*\bclass="[^"]*\bpulse-search(?:\s|"))[\s\S]*?<\/\1>/i);
assert.ok(searchPanel, 'the dedicated Pulse search panel is rendered by Pulse');
const markup = searchPanel[0];

function classOpenings(fragment, className) {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...fragment.matchAll(new RegExp(`<([a-z][\\w-]*)\\b(?=[^>]*\\bclass="[^"]*\\b${escaped}(?:\\s|"))[^>]*>`, 'gi'))];
}

test('Pulse search is a hidden, skeleton-only search view with its required controls', () => {
  assert.match(searchPanel[0], /^<section\b/i, 'the search view is a section');
  assert.match(searchPanel[0].split('>')[0], /\bhidden\b/, 'the view starts hidden');
  assert.match(markup, /<input\b(?=[^>]*\bid="pulse-search-input")(?=[^>]*\btype="search")[^>]*>/i,
    'a search field is present');
  assert.equal(classOpenings(markup, 'pulse-search-close').length, 1,
    'one close affordance is present');
  assert.match(markup, /class="[^"]*\bpulse-search-close\b[^"]*"[^>]*\baria-label="[^"]+"|\baria-label="[^"]+"[^>]*class="[^"]*\bpulse-search-close\b/i,
    'the close affordance has an accessible name');
  assert.match(markup, /\bRecent\b/, 'the recent section is headed Recent');
  assert.match(markup, /\bClear All\b/, 'the clear affordance is labeled Clear All');

  const visibleText = markup.replace(/<span\b(?=[^>]*class="[^"]*\bpulse-announcement\b)[^>]*>[\s\S]*?<\/span>/gi, '')
    .replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  assert.equal(visibleText, 'RecentClear All',
    'the search view contains only its section labels, with no real search results or recent items');
  assert.doesNotMatch(markup, /<(?:a|form|img|iframe|script|video|audio)\b/i,
    'the view has no navigation, media, form submission, or embedded active content');
  assert.deepEqual(effects, [], 'rendering the search view has no network effects');
  assert.doesNotMatch(source, /\b(?:fetch\s*\(|XMLHttpRequest|WebSocket|\/api\/)/i,
    'the Pulse module contains no network client or API endpoint');
});

test('Pulse search categories are icon-only and provide local tab affordances', () => {
  const tabs = classOpenings(markup, 'pulse-search-tab');
  assert.equal(tabs.length, 5, 'the five Pulse category tabs are present');
  const tabTags = [...markup.matchAll(/<button\b(?=[^>]*\bdata-pulse-search-tab(?:\s|=|>))[^>]*>[\s\S]*?<\/button>/gi)];
  assert.equal(tabTags.length, 5, 'each category affordance is a button');
  for (const tab of tabTags) {
    const button = tab[0];
    assert.match(button, /<svg\b[\s\S]*?<\/svg>/i, 'each category button contains an icon');
    assert.equal(button.replace(/<[^>]*>/g, '').trim(), '', 'category buttons show no text labels');
    assert.match(button, /\baria-label="[^"]+"/i, 'each icon-only category has an accessible name');
  }
  assert.match(markup, /data-pulse-search-tab="0"/,
    'category selection is represented as a local data attribute');
  assert.match(source, /data-pulse-search-tab/,
    'category selection is scoped to the local search-tab preview controls');
});

test('suggestions render as a horizontal rail of circular skeleton placeholders', () => {
  const suggestions = classOpenings(markup, 'pulse-search-suggestions');
  assert.equal(suggestions.length, 1, 'one suggestions rail is present');
  const railStart = suggestions[0].index;
  const nextSection = markup.indexOf('<div class="pulse-search-recent-heading', railStart);
  const rail = markup.slice(railStart, nextSection < 0 ? markup.length : nextSection);
  const bones = classOpenings(rail, 'pulse-bone');
  assert.ok(bones.length >= 4, 'the rail contains multiple skeleton circles');
  assert.match(css, /\.pulse-search-suggestions\s*>\s*div\s*\{[^}]*display:\s*flex/i,
    'the suggestion placeholders are laid out horizontally');
  assert.match(css, /\.pulse-search-circle\s*\{[^}]*border-radius:\s*50%/i,
    'suggestion placeholders are styled as circles');
  assert.doesNotMatch(rail.replace(/<[^>]*>/g, '').trim(), /\S/,
    'suggestion placeholders contain no visible labels or real content');
});

test('Recent contains six skeleton rows and disabled circular X affordances only', () => {
  const rows = classOpenings(markup, 'pulse-search-recent-row');
  const removes = classOpenings(markup, 'pulse-search-remove');
  assert.equal(rows.length, 6, 'exactly six recent skeleton rows are rendered');
  assert.equal(removes.length, 6, 'each row has one circular X affordance');
  for (const row of rows) {
    const rowStart = row.index;
    const nextRow = markup.indexOf('class="pulse-search-recent-row', rowStart + 30);
    const nextRowOpen = nextRow < 0 ? markup.length : markup.lastIndexOf('<', nextRow);
    const rowMarkup = markup.slice(rowStart, nextRowOpen);
    assert.ok(classOpenings(rowMarkup, 'pulse-bone').length > 0,
      'each recent row is represented by skeleton placeholders');
    assert.doesNotMatch(rowMarkup.replace(/<[^>]*>/g, '').trim(), /\S/,
      'recent skeleton rows contain no real names or query text');
  }
  const removeButtons = [...markup.matchAll(/<button\b(?=[^>]*\bclass="[^"]*\bpulse-search-remove\b)[^>]*>[\s\S]*?<\/button>/gi)];
  assert.equal(removeButtons.length, 6, 'remove affordances are buttons');
  for (const removeButton of removeButtons) {
    const button = removeButton[0];
    assert.match(button, /\bdisabled(?:\s|>)/i, 'remove affordances are disabled visual placeholders');
    assert.match(button, /<svg\b[\s\S]*?<\/svg>/i, 'each remove affordance displays an X icon');
    assert.equal(button.replace(/<[^>]*>/g, '').trim(), '', 'remove affordances contain no visible text');
  }
  const clear = markup.match(/<button\b(?=[^>]*\bclass="[^"]*\bpulse-search-clear\b)[^>]*>[\s\S]*?<\/button>/i);
  assert.ok(clear, 'Clear All is a button-shaped visual affordance');
  assert.match(clear[0], /\bdisabled(?:\s|>)/i, 'Clear All is disabled rather than wired to a workflow');
  assert.doesNotMatch(markup, /\bonclick\s*=|data-pulse-search-(?:clear|remove)\b/i,
    'clear and remove affordances do not expose action hooks');
});
