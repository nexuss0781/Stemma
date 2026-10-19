import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { createApp, buildConfig } from '../server.js';
const root = new URL('../', import.meta.url);
const [source, css, html, app] = await Promise.all(['pulse-ui.js', 'pulse.css', 'index.html', 'app.js'].map(name => readFile(new URL(name, root), 'utf8')));
function load() {
  const effects = [];
  const context = vm.createContext({ fetch: () => effects.push('fetch'), XMLHttpRequest: () => effects.push('xhr') });
  vm.runInContext(source, context);
  return { pulse: context.StemmaPulse, effects };
}
test('Pulse has five accessible icon-only categories, with All selected by default', () => {
  const { pulse, effects } = load();
  const markup = pulse.render();
  assert.deepEqual(Array.from(pulse.categories, item => item.label), ['All', 'User', 'Group', 'Channel', 'App']);
  assert.equal((markup.match(/role="tab"/g) || []).length, 5);
  assert.equal((markup.match(/role="tabpanel"/g) || []).length, 5);
  assert.match(markup, /id="pulse-tab-0"[^>]*aria-selected="true"[^>]*tabindex="0"/);
  assert.equal((markup.match(/inert aria-hidden="true"/g) || []).length, 19);
  assert.doesNotMatch(markup, /aria-label="Story"|id="pulse-panel-5"|pulse-story-grid/,
    'Story is not a category tab or panel');
  assert.match(markup, /class="pulse-stories"/);
  assert.equal((markup.match(/class="pulse-story-ring/g) || []).length, 120,
    'each category has two horizontally scrollable story stages');
  assert.equal((markup.match(/class="pulse-preview-tile"/g) || []).length, 15,
    'each category retains three preview tiles');
  assert.equal(markup.replace(/<[^>]*>/g, '').trim(), '', 'all content is skeletons, with no visible text');
  assert.deepEqual(effects, [], 'rendering has no network effects');
  assert.doesNotMatch(source, /\bfetch\(|XMLHttpRequest|WebSocket|\/api\//);
});
test('the layered create affordance is inline SVG and remains decorative, not interactive', () => {
  const markup = load().pulse.render();
  const affordance = markup.match(/<(div|span)\b(?=[^>]*\bclass="[^"]*\bpulse-create-affordance\b)[^>]*>([\s\S]*?)<\/\1>/);
  assert.ok(affordance, 'the create affordance is a non-control circle element');
  assert.match(affordance[0], /aria-hidden="true"/,
    'the visual-only affordance is hidden from assistive technology');
  assert.doesNotMatch(affordance[0], /\b(?:role|tabindex|data-pulse-[\w-]+|onclick)=/i,
    'the affordance exposes no interactive semantics or action hook');
  assert.match(affordance[2], /<svg\b[^>]*>[\s\S]*?<\/(?:svg)>/,
    'the layered-plus artwork is embedded as inline SVG');
  assert.doesNotMatch(affordance[2], /<use\b/i,
    'the create artwork is inline rather than an external symbol reference');
});
test('each of the five categories renders as its selected panel without changing skeleton content', () => {
  const { pulse } = load();
  for (let index = 0; index < 5; index++) {
    const markup = pulse.render(index);
    assert.match(markup, new RegExp(`id="pulse-tab-${index}"[^>]*aria-selected="true"`));
    assert.match(markup, new RegExp(`translate3d\\(-${index * 100}%,0,0\\)`));
    assert.equal((markup.match(/aria-selected="true"/g) || []).length, 1);
    assert.match(markup, /pulse-app-grid/);
    assert.match(markup, /class="pulse-stories"/);
    assert.match(markup, /class="pulse-preview-tile"/);
    assert.doesNotMatch(markup, /pulse-story-grid/);
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
  assert.match(html, /src="pulse-ui.js\?v=4" defer/);
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

test('Pulse reveals four ordered in-place pull stages and retains a two-column skeleton grid', () => {
  const markup = load().pulse.render();
  assert.equal((markup.match(/class="pulse-stage /g) || []).length, 20);
  assert.match(markup, /pulse-stage-minimal[\s\S]*pulse-stage-stories[\s\S]*pulse-stage-previews[\s\S]*pulse-stage-grid/);
  assert.match(css, /pulse-stage \{ position: absolute; inset: 0/);
  assert.match(source, /gesture.dy > 0 \? 1 : -1/);
  assert.match(source, /stage.inert = i !== next/);
  assert.doesNotMatch(css, /scroll-snap-type: y/);
  assert.match(css, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
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
