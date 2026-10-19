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
  assert.equal((markup.match(/class="pulse-tab" role="tab"/g) || []).length, 5);
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
  assert.equal(markup.split('<section class="pulse-search"')[0].replace(/<[^>]*>/g, '').trim(), '', 'all content is skeletons, with no visible text');
  assert.deepEqual(effects, [], 'rendering has no network effects');
  assert.doesNotMatch(source, /\bfetch\(|XMLHttpRequest|WebSocket|\/api\//);
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
test('create previews are three hidden, inert, decorative skeleton placeholders only', () => {
  const markup = load().pulse.render();
  const previews = markup.match(/<(div|section)\b(?=[^>]*\bclass="[^"]*\bpulse-create-previews\b)(?=[^>]*\bid="pulse-create-previews")[^>]*>([\s\S]*?)<\/\1>/);
  assert.ok(previews, 'the preview container is present with the controlled id');
  assert.match(previews[0], /aria-hidden="true"/);
  assert.match(previews[0], /\binert(?:\s|>)/);
  const items = [...previews[2].matchAll(/<span\b(?=[^>]*\bclass="(?:[^\"]*\s)?pulse-create-preview(?:\s[^\"]*)?")[^>]*>([\s\S]*?)<\/span>/g)];
  assert.equal(items.length, 3, 'exactly three preview placeholders are rendered');
  for (const [, content] of items) {
    assert.equal(content.replace(/<[^>]*>/g, '').trim(), '', 'placeholders contain no visible labels');
    assert.doesNotMatch(content, /<(?:a|button|input|select|textarea)\b|\b(?:role|tabindex|onclick|data-pulse-[\w-]+)=/i,
      'placeholders expose no controls or action hooks');
  }
  assert.equal(markup.split('<section class="pulse-search"')[0].replace(/<[^>]*>/g, '').trim(), '', 'the Pulse shell remains text-free');
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
test('create preview transitions stagger bottom-up and are disabled for reduced motion', () => {
  assert.match(css, /[^{}]*\.pulse-create-preview:nth-child\(3\)[^{]*\{[^}]*transition-delay:\s*0ms/);
  assert.match(css, /[^{}]*\.pulse-create-preview:nth-child\(2\)[^{]*\{[^}]*transition-delay:\s*70ms/);
  assert.match(css, /[^{}]*\.pulse-create-preview:nth-child\(1\)[^{]*\{[^}]*transition-delay:\s*140ms/);
  const reducedMotion = css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(reducedMotion, 'a reduced-motion media query is defined');
  assert.match(reducedMotion[1], /\.pulse-create-preview[^{]*\{[^}]*transition:\s*none/,
    'reduced motion disables the per-item preview transition');
});
test('each of the five categories renders as its selected panel without changing skeleton content', () => {
  const { pulse } = load();
  for (let index = 0; index < 5; index++) {
    const markup = pulse.render(index);
    assert.match(markup, new RegExp(`id="pulse-tab-${index}"[^>]*aria-selected="true"`));
    assert.match(markup, new RegExp(`translate3d\\(-${index * 100}%,0,0\\)`));
    assert.equal((markup.split('<section class="pulse-search"')[0].match(/aria-selected="true"/g) || []).length, 1);
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
  assert.match(html, /src="pulse-ui.js\?v=7" defer/);
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
