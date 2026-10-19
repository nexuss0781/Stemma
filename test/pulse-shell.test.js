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
test('Pulse has six accessible icon-only categories, with All selected by default', () => {
  const { pulse, effects } = load();
  const markup = pulse.render();
  assert.deepEqual(Array.from(pulse.categories, item => item.label), ['All', 'User', 'Group', 'Channel', 'App', 'Story']);
  assert.equal((markup.match(/role="tab"/g) || []).length, 6);
  assert.equal((markup.match(/role="tabpanel"/g) || []).length, 6);
  assert.match(markup, /id="pulse-tab-0"[^>]*aria-selected="true"[^>]*tabindex="0"/);
  assert.equal((markup.match(/inert aria-hidden="true"/g) || []).length, 5);
  assert.equal(markup.replace(/<[^>]*>/g, '').trim(), '', 'all content is skeletons, with no visible text');
  assert.deepEqual(effects, [], 'rendering has no network effects');
  assert.doesNotMatch(source, /\bfetch\(|XMLHttpRequest|WebSocket|\/api\//);
});
test('each category renders as its selected panel without changing skeleton content', () => {
  const { pulse } = load();
  for (let index = 0; index < 6; index++) {
    const markup = pulse.render(index);
    assert.match(markup, new RegExp(`id="pulse-tab-${index}"[^>]*aria-selected="true"`));
    assert.match(markup, new RegExp(`translate3d\\(-${index * 100}%,0,0\\)`));
    assert.equal((markup.match(/aria-selected="true"/g) || []).length, 1);
    assert.match(markup, /pulse-app-grid/);
    assert.match(markup, /pulse-story-grid/);
  }
});
test('Pulse isolates swipe gestures, supports keyboard tabs, and respects reduced motion', () => {
  assert.match(app, /closest\('\.payment-carousel, \.bill-page, \.pulse-shell'\)/);
  assert.match(source, /ArrowLeft.*ArrowRight.*Home.*End/);
  assert.match(source, /pointercancel/);
  assert.match(source, /AbortController/);
  assert.match(css, /touch-action: pan-y pinch-zoom/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(html, /symbol id="i-pulse"/);
  assert.match(html, /src="pulse-ui.js\?v=1" defer/);
  assert.doesNotMatch(css, /#[\da-f]{3,8}\b|rgba?\(/i, 'Pulse uses existing palette tokens only');
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
