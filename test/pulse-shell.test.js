import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { createApp, buildConfig } from '../server.js';
const root = new URL('../', import.meta.url);
const [source, dataSource, css, html, app, groupsSource] = await Promise.all(['pulse-ui.js', 'pulse-data-ui.js', 'pulse.css', 'index.html', 'app.js', 'groups-ui.js'].map(name => readFile(new URL(name, root), 'utf8')));
function load(fetchImpl) {
  const effects = [];
  const context = vm.createContext({ fetch: fetchImpl || (() => effects.push('fetch')), XMLHttpRequest: () => effects.push('xhr') });
  vm.runInContext(groupsSource, context);
  vm.runInContext(dataSource, context);
  vm.runInContext(source, context);
  return { pulse: context.StemmaPulse, data: context.StemmaPulseData, effects };
}
function withoutSavedRowText(markup) {
  return markup.replace(/<button\b(?=[^>]*\bclass="[^"]*\bpulse-saved-row\b)[^>]*>[\s\S]*?<\/button>/gi, '');
}
function panelsFrom(markup) {
  const starts = [...markup.matchAll(/<section class="pulse-panel"/g)].map(match => match.index);
  return starts.map((start, index) => markup.slice(start, starts[index + 1] ?? markup.indexOf('</div>\n        <div class="pulse-create-previews"', start)));
}
function stagesFrom(panel) {
  return [...panel.matchAll(/<section\b(?=[^>]*\bclass="pulse-stage\b)[^>]*>([\s\S]*?)<\/section>/g)].map(match => match[0]);
}
test('Pulse has five accessible icon-only categories, with All selected by default', () => {
  const { pulse, effects } = load();
  const markup = pulse.render();
  assert.deepEqual(Array.from(pulse.categories, item => item.label), ['All', 'User', 'Group', 'Channel', 'App']);
  assert.equal((markup.match(/class="pulse-tab" role="tab"/g) || []).length, 5);
  assert.equal((markup.match(/role="tabpanel"/g) || []).length, 5);
  assert.match(markup, /id="pulse-tab-0"[^>]*aria-selected="true"[^>]*tabindex="0"/);
  assert.equal((markup.match(/inert aria-hidden="true"/g) || []).length, 19);
  const panels = panelsFrom(markup);
  assert.doesNotMatch(panels.join(''), /aria-label="Story"|id="pulse-panel-5"|pulse-story-grid|pulse-stories|pulse-story-ring|pulse-preview-tile|pulse-discovery-grid|pulse-app-grid|skeleton-shimmer/,
    'the feed contains no story, discovery, app-grid, or skeleton placeholders');
  assert.equal(panels.length, 5);
  assert.equal((panels[0].match(/class="pulse-stage /g) || []).length, 4,
    'All retains the four gesture-stage containers');
  assert.equal((panels[0].match(/\bpulse-saved-row\b/g) || []).length, 4,
    'the same actual Saved Messages row appears in each All stage');
  assert.equal(withoutSavedRowText(panels[0]).replace(/<[^>]*>/g, '').trim(), '',
    'All contains no visible non-row feed copy');
  assert.match(panels[2], /Loading groups…/,
    'the Groups view can show its async loading status');
  assert.match(markup, /class="pulse-create-group"[^>]*data-group-create[^>]*>[^<]*<span aria-hidden="true">＋<\/span> New group<\/button>/,
    'create-menu copy belongs to the separately scoped Groups action');
  assert.deepEqual(effects, [], 'rendering has no network effects');
  assert.doesNotMatch(source, /\bfetch\(|XMLHttpRequest|WebSocket|\/api\//);
});
test('All stages render only the Saved Messages row with an inline bookmark-stack icon and initially empty preview', () => {
  const markup = load().pulse.render();
  const panels = panelsFrom(markup);
  const allStages = stagesFrom(panels[0]);
  assert.equal(allStages.length, 4);
  for (const stage of allStages) {
    const rows = [...stage.matchAll(/<button\b(?=[^>]*\bclass="[^"]*\bpulse-saved-row\b)[^>]*>[\s\S]*?<\/button>/gi)];
    assert.equal(rows.length, 1, 'each retained All stage contains one Saved Messages row');
    const row = rows[0][0];
    assert.match(row, /\bdata-pulse-saved(?:\s|=|>)/);
    assert.match(row, /<strong>Saved Messages<\/strong>/);
    assert.doesNotMatch(row, /Your private notes/,
      'the row does not use the former generic subtitle');
    assert.match(row, /<svg\b(?=[^>]*\bclass="pulse-bookmark-stack")(?=[^>]*\bviewBox="0 0 32 32")[^>]*>[\s\S]*?<\/svg>/,
      'the supplied stacked-bookmark artwork is inline SVG');
    assert.match(row, /<path\b[^>]*\bfill="currentColor"/,
      'the bookmark uses the existing foreground palette');
    assert.match(row, /<path\b[^>]*\bstroke="currentColor"/,
      'the stack detail uses the existing foreground palette');
    assert.doesNotMatch(row, /<use\b/i, 'the bookmark is not an external symbol reference');
    const preview = row.match(/<span\b(?=[^>]*\bclass="pulse-saved-preview")[^>]*>([\s\S]*?)<\/span>/);
    assert.ok(preview, 'the message preview has its own semantic element');
    assert.match(preview[0], /\bhidden(?:\s|>)/);
    assert.equal(preview[1], '', 'the preview starts empty until the private note fetch resolves');
  }
  const saved = markup.match(/<section class="pulse-saved"[\s\S]*?<\/section>/);
  assert.ok(saved, 'the private Saved Messages view is rendered');
  assert.match(saved[0], /aria-label="Saved Messages"[^>]*\bhidden/);
  assert.match(saved[0], /Only you can see these notes/);
  assert.match(saved[0], /class="pulse-saved-items" role="list"/);
  assert.match(saved[0], /<textarea[^>]*\bdisabled/);
  assert.match(dataSource, /request\('\/api\/pulse\/saved' \+ before\)/,
    'notes are loaded from the signed-in user’s private saved-messages collection');
  assert.match(dataSource, /request\('\/api\/pulse\/saved', \{ method: 'POST'/,
    'the compose action saves notes only to that private collection');
});
test('User retains direct conversations; Group exposes group rows while Channel and App stay empty', () => {
  const markup = load().pulse.render();
  const panels = panelsFrom(markup);
  assert.equal(panels.length, 5);
  for (const [index, panel] of panels.entries()) {
    const stages = stagesFrom(panel);
    assert.equal(stages.length, 4, `category ${index} retains all four gesture stages`);
    if (index === 0) continue;
    for (const [stageIndex, stage] of stages.entries()) {
      if (index === 1) {
        assert.equal(stage.replace(/<[^>]*>/g, '').trim(), '', `User stage ${stageIndex} stays empty until direct conversations load`);
        assert.match(stage, /aria-label="Direct conversations"/);
        assert.match(stage, /<div class="pulse-direct-list" data-pulse-conversations role="list" aria-label="Direct conversations"><\/div>/,
          'each User stage mounts the empty direct-conversation list for async population');
        assert.doesNotMatch(stage, /pulse-saved-row|pulse-stories|pulse-preview|pulse-discovery|skeleton|pulse-app-grid/);
      } else if (index === 2) {
        assert.match(stage, /data-group-lists role="list" aria-label="Group conversations"/,
          `Group stage ${stageIndex} exposes an async group-list target`);
        assert.doesNotMatch(stage, /pulse-saved-row|pulse-direct-list|pulse-stories|pulse-preview|skeleton|pulse-app-grid/);
      } else {
        assert.equal(stage.replace(/<[^>]*>/g, '').trim(), '', `category ${index} has no visible feed content`);
        assert.doesNotMatch(stage, /pulse-saved-row|pulse-conversation\b|pulse-direct-list|pulse-stories|pulse-preview|pulse-discovery|skeleton|pulse-app-grid/,
          `category ${index} stage ${stageIndex} has no saved row, chat, story, discovery, app-grid, or skeleton placeholder`);
      }
    }
  }
});
test('saved-message preview paints the newest private note into each All stage and stays blank when none exist', async () => {
  async function runPreview(messages) {
    const previews = Array.from({ length: 4 }, () => ({ textContent: '', hidden: true }));
    const listeners = [];
    const target = () => ({ addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, replaceChildren() {}, append() {} });
    const feed = target(), search = target(), saved = target(), field = target(), results = target(), searchStatus = target();
    const history = target(), items = target(), status = target(), text = target(), send = target(), older = target(), more = target();
    const form = { ...target(), querySelector: () => send };
    saved.querySelector = selector => ({ '.pulse-saved-history': history, '.pulse-saved-items': items, '.pulse-data-status': status, 'form': form, 'textarea': text, '.pulse-load-older': older, '.pulse-saved-back': target() })[selector] || null;
    const shell = {
      querySelector: selector => ({ '.pulse-feed': feed, '.pulse-saved': saved, '.pulse-search': search, '#pulse-search-input': field, '.pulse-user-results': results, '.pulse-user-status': searchStatus, '.pulse-users-more': more, '.pulse-search-close': target() })[selector] || null,
      querySelectorAll: selector => selector === '.pulse-saved-preview' ? previews : []
    };
    const controller = new AbortController();
    const { data } = load(async () => ({ ok: true, status: 200, json: async () => ({ messages }) }));
    data.mount(shell, { listen: (element, type, handler) => listeners.push({ element, type, handler }), signal: controller.signal, closeSearch() {} });
    await new Promise(resolve => setTimeout(resolve, 0));
    return { previews, listeners };
  }
  const latest = await runPreview([
    { id: '2', text: '  latest\n saved   note  ' },
    { id: '1', text: 'older note' }
  ]);
  assert.deepEqual(latest.previews.map(preview => preview.textContent), Array(4).fill('latest saved note'));
  assert.deepEqual(latest.previews.map(preview => preview.hidden), Array(4).fill(false));
  const empty = await runPreview([]);
  assert.deepEqual(empty.previews.map(preview => preview.textContent), Array(4).fill(''));
  assert.deepEqual(empty.previews.map(preview => preview.hidden), Array(4).fill(true));
});
test('the create-preview toggle is accessible and retains its inline layered-plus SVG', () => {
  const markup = load().pulse.render();
  const toggle = markup.match(/<button\b(?=[^>]*\bclass="[^"]*\bpulse-create-affordance\b)[^>]*>([\s\S]*?)<\/button>/);
  assert.ok(toggle, 'the create affordance is a button');
  assert.match(toggle[0], /aria-label="Toggle create previews"/);
  assert.match(toggle[0], /aria-expanded="false"/);
  assert.match(toggle[0], /aria-controls="pulse-create-previews"/);
  assert.match(toggle[1], /<svg\b[^>]*>[\s\S]*?<\/svg>/,
    'the layered-plus artwork is embedded as inline SVG');
  assert.doesNotMatch(toggle[1], /<use\b/i,
    'the create artwork is inline rather than an external symbol reference');
});
test('create menu offers only the functional New group action and remains hidden until opened', () => {
  const markup = load().pulse.render();
  const previews = markup.match(/<(div|section)\b(?=[^>]*\bclass="[^"]*\bpulse-create-previews\b)(?=[^>]*\bid="pulse-create-previews")[^>]*>([\s\S]*?)<\/\1>/);
  assert.ok(previews, 'the preview container is present with the controlled id');
  assert.match(previews[0], /aria-hidden="true"/);
  assert.match(previews[0], /\binert(?:\s|>)/);
  assert.match(previews[2], /<button[^>]*class="pulse-create-group"[^>]*data-group-create[^>]*>[^<]*<span aria-hidden="true">＋<\/span> New group<\/button>/,
    'the single menu entry is actionable and creates only groups');
  assert.doesNotMatch(previews[2], /Channel|App|skeleton|pulse-create-preview/,
    'unfinished Channel and App actions are not presented as enabled');
  assert.equal((previews[2].match(/data-group-create/g) || []).length, 1);
});
test('create previews toggle from the shell and support Escape and outside dismissal', () => {
  assert.match(source, /classList\.toggle\(['"]is-create-open['"]/,
    'mount behavior toggles the shell open class');
  assert.match(source, /['"]Escape['"]/, 'Escape is handled by the Pulse source');
  assert.match(source, /listen\((?:document|window),\s*['"](?:pointerdown|click)['"]/,
    'outside interaction is observed at document or window scope');
  assert.match(source, /listen\(document,\s*['"]pointerdown['"][\s\S]*?setCreateOpen\(false\)/,
    'an outside pointer interaction closes the create previews');
});
test('the New group menu has a restrained transition and honors reduced motion', async () => {
  const groupsCss = await readFile(new URL('../groups.css', import.meta.url), 'utf8');
  assert.match(groupsCss, /\.is-create-open \.pulse-create-group[^{}]*\{[^}]*visibility:\s*visible/);
  assert.match(groupsCss, /\.pulse-create-group[^{}]*\{[^}]*transition:/);
  assert.match(groupsCss, /@media\s*\(prefers-reduced-motion:\s*reduce\)[^{]*\{[^}]*\.pulse-create-group[^{}]*\{[^}]*transition:\s*none/);
});
test('each of the five categories can be selected without changing the Saved Messages-only feed', () => {
  const { pulse } = load();
  for (let index = 0; index < 5; index++) {
    const markup = pulse.render(index);
    assert.match(markup, new RegExp(`id="pulse-tab-${index}"[^>]*aria-selected="true"`));
    assert.match(markup, new RegExp(`translate3d\\(-${index * 100}%,0,0\\)`));
    assert.equal((markup.split('<section class="pulse-search"')[0].match(/aria-selected="true"/g) || []).length, 1);
    const panels = panelsFrom(markup);
    assert.equal(panels.length, 5);
    assert.equal(stagesFrom(panels[index]).length, 4);
    if (index === 0) assert.equal((panels[index].match(/\bpulse-saved-row\b/g) || []).length, 4);
    else assert.doesNotMatch(panels[index], /pulse-saved-row|pulse-stories|pulse-preview-tile|pulse-discovery-grid|pulse-app-grid|skeleton-shimmer/);
  }
});
test('Pulse isolates swipe gestures, supports keyboard tabs, and respects reduced motion', () => {
  assert.match(app, /closest\('\.payment-carousel, \.bill-page, \.pulse-shell'\)/);
  assert.match(source, /ArrowLeft.*ArrowRight.*Home.*End/);
  assert.match(source, /pointercancel/);
  assert.match(source, /AbortController/);
  assert.match(css, /touch-action: auto/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(html, /symbol id="i-pulse"/);
  assert.match(html, /src="\/direct-chat-ui.js\?v=\d+" defer><\/script>\s*<script src="\/pulse-data-ui.js\?v=\d+" defer><\/script>\s*<script src="\/pulse-ui.js\?v=\d+" defer/,
    'the data client loads before Pulse rendering');
  assert.match(html, /<script src="\/groups-ui.js\?v=\d+" defer><\/script>/,
    'the Groups client uses a root-relative asset URL');
  assert.doesNotMatch(css, /#[\da-f]{3,8}\b|rgba?\(/i, 'Pulse uses existing palette tokens only');
});
test('Pulse rounds its category bar and highlights only the selected category in existing burgundy and gold', () => {
  const bar = css.match(/\.pulse-tabs \{([^}]+)\}/)[1];
  const idle = css.match(/\.pulse-tab \{([^}]+)\}/)[1];
  const selected = css.match(/\.pulse-tab\[aria-selected="true"\] \{([^}]+)\}/)[1];
  assert.match(bar, /border-radius: 18px/);
  assert.match(selected, /border-radius: 12px/);
  assert.match(selected, /background: var\(--brand-burgundy\)/);
  assert.match(selected, /color: var\(--brand-gold\)/);
  assert.match(selected, /box-shadow: none/);
  assert.match(idle, /background: transparent/);
  assert.match(idle, /color: var\(--brand-burgundy\)/);
  assert.match(idle, /border-radius: 0/);
});
test('Pulse source and styles are publicly served as static assets only', async () => {
  const server = http.createServer(createApp({ config: buildConfig({ NODE_ENV: 'test', SESSION_SECRET: 'pulse-static-test-secret-at-least-32-bytes' }) }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    for (const [name, type, expected] of [['pulse-ui.js', 'application/javascript', source], ['pulse.css', 'text/css', css]]) {
      const response = await fetch(`${origin}/${name}`);
      assert.equal(response.status, 200);
      assert.ok(response.headers.get('content-type').startsWith(type));
      assert.equal(await response.text(), expected);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Pulse retains four ordered in-place pull stages while hiding all story and grid placeholders', () => {
  const markup = load().pulse.render();
  assert.equal((markup.match(/class="pulse-stage /g) || []).length, 20);
  assert.match(markup, /pulse-stage-minimal[\s\S]*pulse-stage-stories[\s\S]*pulse-stage-previews[\s\S]*pulse-stage-grid/);
  assert.doesNotMatch(panelsFrom(markup).join(''), /pulse-stories|pulse-story-ring|pulse-preview-tile|pulse-discovery-grid|pulse-app-grid|skeleton-shimmer/);
  assert.match(css, /pulse-stage \{ position: absolute; inset: 0/);
  assert.match(source, /gesture.dy > 0 \? 1 : -1/);
  assert.match(source, /stage.inert = i !== next/);
  assert.doesNotMatch(css, /scroll-snap-type: y/);
  assert.match(source, /event.target.closest\('\.pulse-stories'\)/);
  assert.match(source, /!event.target.closest\('\.pulse-tab'\)/);
});

test('Pulse announces layouts without visible content and safely handles capture transfer', () => {
  assert.match(source, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(source, /announcement.textContent/);
  assert.match(source, /event.target === viewport && drag/);
  assert.match(css, /pulse-announcement \{[^}]*clip-path: inset\(50%\)/);
  assert.match(css, /overflow: clip/);
  assert.match(source, /wheelLocked/);
});

test('Pulse swipe refinement keeps stages mounted and interpolates live drag progress before release', () => {
  const markup = load().pulse.render();
  assert.equal((markup.match(/class="pulse-stage /g) || []).length, 20,
    'all four stage elements remain present in each category panel');
  assert.match(source, /requestAnimationFrame\s*\(/,
    'pointer-driven visual updates are frame-scheduled rather than release-only');
  assert.match(source, /\.dataset\.progress\b/,
    'continuous progress is exposed on the panel for stage interpolation');
  assert.match(source, /is-interacting/,
    'the active panel can identify an in-progress gesture');
  assert.match(source, /pointercancel/,
    'canceled gestures have a separate rollback path from successful release');
  assert.match(source, /prefers-reduced-motion:\s*reduce/,
    'stage transitions continue to honor the reduced-motion preference');
});
