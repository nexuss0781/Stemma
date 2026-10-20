import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../stories-ui.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../stories.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('story composer presents a fullscreen playable preview with one explicit Send action', () => {
  assert.match(source, /class="stemma-story-dialog stemma-story-composer"/);
  assert.match(source, /class="story-compose-preview" hidden/);
  assert.match(source, /class="story-description-label">Description <span>optional<\/span>/);
  assert.match(source, /<button class="story-submit" type="submit" disabled>Send story<\/button>/);
  assert.doesNotMatch(source, /class="story-next"|Continue|Post story/);
  assert.match(css, /\.stemma-story-composer\s*\{[^}]*width:\s*100vw[^}]*height:\s*100dvh/);
  assert.match(html, /stories-ui\.js\?v=\d+/);
});

test('selecting long video exposes accessible bounds and locally records only a short MP4 before POST', () => {
  assert.match(source, /data-trim-start aria-label="Clip start time"/);
  assert.match(source, /data-trim-end aria-label="Clip end time"/);
  assert.match(source, /sourceDuration > MAX_SECONDS/);
  assert.match(source, /MAX_CLIP_SECONDS = 49\.5/);
  assert.match(source, /const capture = root\.StemmaStoryVideoCapture/);
  assert.match(source, /await capture\.capture\(player\)/);
  assert.match(source, /MediaRecorder\.isTypeSupported/);
  assert.match(source, /return new File\(\[blob\], 'stemma-story-clip\.mp4', \{ type: 'video\/mp4' \}\)/);
  assert.match(source, /const readyFile = sourceDuration > MAX_SECONDS \? await makeTrimmedClip\(\) : file/);
  assert.equal((source.match(/fetch\('\/api\/pulse\/stories', \{ method: 'POST'/g) || []).length, 1);
  assert.match(source, /stream\.getAudioTracks\(\)/);
  assert.match(source, /readyFile\.size > MAX_BYTES/);
});

test('story preview tiles are square and the populated grid retains internal vertical scrolling', () => {
  assert.match(css, /\.story-preview-card\s*\{[^}]*aspect-ratio:\s*1\s*;/);
  assert.match(css, /\.pulse-stage-grid\s*\{\s*touch-action:\s*pinch-zoom/);
  assert.match(css, /\.pulse-stage-grid \.pulse-story-grid\s*\{\s*touch-action:\s*pinch-zoom/);
  assert.match(css, /\.pulse-stage-grid \.pulse-story-grid\.is-scrollable\s*\{\s*touch-action:\s*pan-y pinch-zoom/);
  assert.match(source, /grid\.scrollHeight > grid\.clientHeight \+ 1/);
});
