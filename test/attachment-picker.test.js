import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const picker = read('chat-attachments-ui.js');
const direct = read('direct-chat-ui.js');
const saved = read('pulse-data-ui.js');
const groups = read('groups-ui.js');
const styles = read('pulse.css');

test('shared picker exposes native Gallery/File and review-before-send controls', () => {
  assert.match(picker, /const MAX_BYTES\s*=\s*5\s*\*\s*1024\s*\*\s*1024/);
  assert.match(picker, /dialog\.className = 'pulse-attachment-dialog'/);
  assert.match(picker, /data-modal-input/);
  assert.match(picker, /data-attachment-category="\$\{name\}"/);
  assert.match(picker, /\['Gallery'/);
  assert.match(picker, /\['File'/);
  assert.match(picker, /index\s*>\s*1\s*\?\s*'disabled aria-disabled="true"/);
  assert.match(picker, /data-attachment-send/);
  assert.match(picker, /data-attachment-count/);
  assert.match(picker, /file\.size\s*>\s*MAX_BYTES/);
  assert.match(picker, /unsupported file type/);
  assert.match(picker, /localInput\.click\(\)/);
  assert.match(picker, /data-preview-close/);
  assert.match(picker, /checkbox\.addEventListener\('change'/);
  assert.match(picker, /root\.StemmaParentNavigation\?\.enter\(key, close/);
  assert.match(picker, /event\.key === 'Escape'/);
});

test('direct chat mounts shared picker on its conversation-scoped attachment endpoint with reply context', () => {
  assert.match(direct, /StemmaChatAttachments\?\.control\(\)/);
  assert.match(direct, /StemmaChatAttachments\?\.mount\(form/);
  assert.match(direct, /\/api\/pulse\/conversations\/\$\{encodeURIComponent\(conversation\.id\)\}\/attachments/);
  assert.match(direct, /extraBody:\s*\(\)\s*=>\s*selectedReply\s*\?\s*\{\s*replyToId:\s*selectedReply\.id/);
});

test('Saved Messages mounts shared picker on its account-scoped attachment endpoint', () => {
  assert.match(saved, /StemmaChatAttachments\?\.control\(\)/);
  assert.match(saved, /StemmaChatAttachments\?\.mount\(form/);
  assert.match(saved, /\/api\/pulse\/saved\/attachments/);
});

test('group chat mounts shared picker on its group-scoped attachment endpoint', () => {
  assert.match(groups, /StemmaChatAttachments\?\.control\(\)/,
    'group composer must include the shared attachment control');
  assert.match(groups, /StemmaChatAttachments\?\.mount\(/,
    'group chat must mount the shared picker');
  assert.match(groups, /const api = '\/api\/pulse\/groups'/);
  assert.match(groups, /\$\{api\}\/\$\{encodeURIComponent\(current\.id\)\}\/attachments/,
    'group picker must resolve the active group attachment endpoint');
});

test('attachment dialog has compact and desktop responsive styling', () => {
  assert.match(styles, /\.pulse-attachment-dialog/);
  assert.match(styles, /@media\s*\(min-width:\s*720px\)/);
  assert.match(styles, /@media\s*\(max-height:\s*650px\)/);
});
