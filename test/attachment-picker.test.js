import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const picker = read('chat-attachments-ui.js');
const direct = read('direct-chat-ui.js');
const saved = read('pulse-data-ui.js');
const groups = read('groups-ui.js');
const styles = read('pulse.css');

test('shared picker exposes Gallery/File and review-before-send controls by default', () => {
  assert.match(picker, /const MAX_BYTES\s*=\s*5\s*\*\s*1024\s*\*\s*1024/);
  assert.match(picker, /dialog\.className = 'pulse-attachment-dialog'/);
  assert.match(picker, /data-modal-input/);
  assert.match(picker, /data-attachment-category="\$\{name\}"/);
  assert.match(picker, /const categories = \[\['Gallery'/);
  assert.match(picker, /if \(!galleryOnly\) categories\.push\(\['File'/);
  assert.match(picker, /data-attachment-camera/);
  assert.doesNotMatch(picker, /<label[^>]*>Source<\/label>|<select[^>]*aria-label="Album or source"/);
  assert.doesNotMatch(picker, /\['Location'|\['Article'|\['Poll'|\['Contact'/);
  assert.match(picker, /data-attachment-send/);
  assert.match(picker, /data-attachment-count/);
  assert.match(picker, /file\.size\s*>\s*maxBytes/);
  assert.match(picker, /unsupported file type/);
  assert.match(picker, /localInput\.click\(\)/);
  assert.match(picker, /data-preview-close/);
  assert.match(picker, /checkbox\.addEventListener\('change'/);
  assert.match(picker, /root\.StemmaParentNavigation\?\.enter\(key, close/);
  assert.match(picker, /event\.key === 'Escape'/);
});

test('Likee picker can expose only Gallery and retains the caller-supplied media size limit', () => {
  assert.match(picker, /galleryOnly \? '' : '<button type="button" data-attachment-camera/);
  assert.match(picker, /galleryOnly \? '' : '<input type="file" data-camera-input/);
  assert.match(picker, /maxBytes: options\.maxBytes \?\? MAX_BYTES/);
  assert.match(picker, /file\.size > maxBytes/);
  assert.match(direct, /StemmaChatAttachments/);

  const likee = read('likee-ui.js');
  assert.match(likee, /galleryOnly: true, maxBytes: 256 \* 1024 \* 1024/);
  assert.match(likee, /blob\.size > 256 \* 1024 \* 1024/);
  assert.match(likee, /media\.duration > 240/);
  assert.match(likee, /Videos up to 4 minutes \(240 seconds\).*256 MiB/);
  assert.match(likee, /body: blob, contentType: mimeType, headers: \{ 'X-Likee-Caption': encodeURIComponent\(caption\.value\.trim\(\)\) \}, timeout: 0/);
});

test('shared uploader preserves JSON defaults and supports Blob transport options', () => {
  assert.match(picker, /contentType = 'application\/json', headers = \{\}, timeout = 180000/);
  assert.match(picker, /request\.timeout = timeout/);
  assert.match(picker, /request\.setRequestHeader\('Content-Type', contentType\)/);
  assert.match(picker, /typeof body === 'string' \|\| isBlob \? body : JSON\.stringify\(body\)/);
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
