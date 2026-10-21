import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const [source, css, pulseSource, html] = await Promise.all(
  ['stories-ui.js', 'stories.css', 'pulse-ui.js', 'index.html'].map(name => readFile(new URL(name, root), 'utf8'))
);

function loadStories() {
  const context = vm.createContext({});
  vm.runInContext(source, context);
  return context.StemmaStories;
}

test('Stories exposes empty accessible stage containers only for All and User', () => {
  const stories = loadStories();
  assert.deepEqual(Object.keys(stories).sort(), ['mount', 'stageView']);
  for (const category of ['all', 'user']) {
    assert.equal(stories.stageView(category, 0), '');
    assert.match(stories.stageView(category, 1), /pulse-story-circles[^>]*data-story-stage="1"[^>]*role="region"[^>]*aria-label="Active stories"><\/div>/);
    assert.match(stories.stageView(category, 2), /pulse-story-previews[^>]*data-story-stage="2"[^>]*role="region"[^>]*aria-label="Story previews"><\/div>/);
    assert.match(stories.stageView(category, 3), /pulse-story-grid[^>]*data-story-stage="3"[^>]*role="region"[^>]*aria-label="Active story grid"><\/div>/);
  }
  for (const category of ['group', 'channel', 'app']) {
    for (const stage of [1, 2, 3]) assert.equal(stories.stageView(category, stage), '');
  }
});

test('Pulse mounts four in-order stages and starts with no fabricated story cards, users, media, or loading skeletons', () => {
  const api = { StemmaStories: loadStories() };
  api.window = api;
  vm.runInNewContext(pulseSource, api);
  const markup = api.StemmaPulse.render();
  const starts = [...markup.matchAll(/<section class="pulse-panel"/g)].map(match => match.index);
  const panels = starts.map((start, index) => markup.slice(start, starts[index + 1] ?? markup.indexOf('<div class="pulse-create-previews"', start)));
  const feed = panels.join('');
  assert.equal((markup.match(/class="pulse-stage /g) || []).length, 20);
  assert.match(markup, /pulse-stage-minimal[\s\S]*pulse-stage-stories[\s\S]*pulse-stage-previews[\s\S]*pulse-stage-grid/);
  assert.equal((feed.match(/data-story-stage="[123]"/g) || []).length, 6,
    'All and User each have the circular rail, preview rail, and grid containers');
  assert.doesNotMatch(feed, /data-story-open=|story-preview-card|story-grid-card|pulse-story-ring|story-card-media|skeleton-shimmer|pulse-bone/,
    'only empty structural containers exist before the stories response arrives');
  assert.equal((feed.match(/pulse-saved-row/g) || []).length, 1,
    'Saved Messages appears once, only in All’s minimal stage');
  for (const [index, label] of ['Circular story rail', 'Story preview rail', 'Two-column story grid'].entries()) {
    assert.match(feed, new RegExp(`aria-label="${label}"`));
  }
});

test('Story layouts use circular avatars, square preview tiles, and a two-column grid', () => {
  assert.match(css, /\.pulse-stage-stories \.pulse-story-avatar\s*\{[^}]*width:\s*62px[^}]*height:\s*62px/);
  assert.match(css, /\.pulse-stage-stories \.pulse-story-avatar\s*\{[^}]*border-radius:\s*50%|\.story-avatar-wrap\s*\{[^}]*border-radius:\s*50%/);
  assert.match(css, /\.story-preview-card\s*\{[^}]*aspect-ratio:\s*1(?:\s*\/\s*1)?\s*;/,
    'stage 2 story previews are square tiles');
  assert.match(css, /\.pulse-story-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/,
    'stage 3 stories use a two-column grid');
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)[^{]*\{[^}]*transition:\s*none/);
});

test('Story creation stays an explicit composer action beside the existing New group action', () => {
  const api = { StemmaStories: loadStories() };
  api.window = api;
  vm.runInNewContext(pulseSource, api);
  const markup = api.StemmaPulse.render();
  assert.match(markup, /class="pulse-create-group"[^>]*data-group-create[^>]*>[\s\S]*?New group<\/button>/);
  assert.match(markup, /class="pulse-create-story"[^>]*data-story-create[^>]*>[\s\S]*?Story<\/button>/);
  assert.match(source, /event\.target\.closest\('\[data-story-create\]'\)/,
    'the Story action opens the composer rather than inserting demo content');
  assert.match(source, /<h2 id="story-compose-title">Share a story<\/h2>/);
  assert.match(source, /<input type="file" name="media"[^>]*required>/);
  assert.match(html, /<script src="\/stories-ui\.js\?v=\d+" defer><\/script>/);
});

test('Stories are server-backed, expiry-filtered, user-private, and validated without fabricated fallback content', () => {
  assert.match(source, /fetch\('\/api\/pulse\/stories', \{ credentials: 'same-origin'/);
  assert.match(source, /payload\.stories\)\) throw new Error\('The stories response was incomplete\.'/);
  assert.match(source, /const next = payload\.stories\.filter\(item => item && item\.id && Date\.parse\(item\.expiresAt\) > now\(\)\)/);
  assert.match(source, /if \(changed\) render\(\); scheduleExpiry\(\)/);
  assert.match(source, /story\.mine \? 'You' : nameOf\(story\)/);
  assert.match(source, /v\.actions\.hidden = !current\.mine/,
    'delete controls are shown only for the signed-in user’s own story');
  assert.match(source, /MAX_BYTES = 5 \* 1024 \* 1024/);
  assert.match(source, /MAX_SECONDS = 50/);
  assert.match(source, /c\.desc\.value\.length > 1000/);
  assert.match(source, /method: 'POST', credentials: 'same-origin'/);
  assert.match(source, /const mediaUrl = story => `\/api\/pulse\/stories\/\$\{encodeURIComponent\(story\.id\)\}\/media`/);
  assert.doesNotMatch(source, /\b(?:demoStories|mockStories|sampleStories|fakeStories)\b/i);
});
