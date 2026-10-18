import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const html = await readFile(new URL('index.html', root), 'utf8');
const app = await readFile(new URL('app.js', root), 'utf8');
const styles = await readFile(new URL('styles.css', root), 'utf8');

function photoPreviewBlock() {
  const start = app.indexOf('// Onboarding photo preview');
  const end = app.indexOf('// End onboarding photo preview', start);
  assert.notEqual(start, -1, 'app.js must mark the start of its onboarding photo-preview block');
  assert.notEqual(end, -1, 'app.js must mark the end of its onboarding photo-preview block');
  assert.ok(end > start, 'photo-preview block markers must be in order');
  return app.slice(start, end + '// End onboarding photo preview'.length);
}

class FakeElement {
  constructor(id = '') {
    this.id = id;
    this.hidden = false;
    this.value = '';
    this.files = [];
    this.src = '';
    this.textContent = '';
    this.attributes = new Map();
    this.listeners = new Map();
    this.clickCount = 0;
    this.classNames = new Set();
    this.classList = {
      add: name => this.classNames.add(name),
      remove: name => this.classNames.delete(name),
      toggle: (name, force) => {
        const shouldAdd = force === undefined ? !this.classNames.has(name) : Boolean(force);
        if (shouldAdd) this.classNames.add(name);
        else this.classNames.delete(name);
        return shouldAdd;
      },
      contains: name => this.classNames.has(name)
    };
  }
  addEventListener(type, listener) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  dispatch(type, props = {}) {
    const event = { type, target: this, currentTarget: this, ...props };
    for (const listener of this.listeners.get(type) ?? []) listener.call(this, event);
    return event;
  }
  click() {
    this.clickCount += 1;
    this.dispatch('click');
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === 'src') this.src = '';
  }
}

class FakeImage extends FakeElement {
  constructor() {
    super('new-image');
    FakeImage.instances.push(this);
  }
  load() { this.dispatch('load'); this.onload?.call(this, { type: 'load', target: this }); }
  fail() { this.dispatch('error'); this.onerror?.call(this, { type: 'error', target: this }); }
}
FakeImage.instances = [];

function createPreviewHarness() {
  const ids = [
    'student-photo-button', 'student-photo-input', 'student-photo-preview',
    'student-photo-placeholder', 'student-photo-label', 'student-photo-status'
  ];
  const elements = Object.fromEntries(ids.map(id => [id, new FakeElement(id)]));
  elements['student-photo-preview'].hidden = true;
  elements['student-photo-input'].type = 'file';
  elements['student-photo-label'].textContent = 'Add photo';
  elements['student-photo-button'].setAttribute('aria-label', 'Choose profile photo');
  const form = new FakeElement('student-details-form');
  const revoked = [];
  let nextUrl = 0;
  FakeImage.instances = [];
  const context = vm.createContext({
    studentForm: form,
    document: { getElementById: id => elements[id] ?? null },
    window: new FakeElement('window'),
    Image: FakeImage,
    URL: {
      createObjectURL(file) { assert.ok(file, 'an actual selected file is required'); return `blob:photo-${++nextUrl}`; },
      revokeObjectURL(url) { revoked.push(url); }
    },
    console
  });
  vm.runInContext(photoPreviewBlock(), context, { filename: 'app.js onboarding photo preview' });
  return { elements, form, window: context.window, revoked, get images() { return FakeImage.instances; } };
}

function file(name, type = 'image/png', size = 1024) {
  return { name, type, size };
}

function select(harness, selectedFile) {
  const input = harness.elements['student-photo-input'];
  input.files = selectedFile ? [selectedFile] : [];
  input.value = selectedFile ? 'C:\\fakepath\\' + selectedFile.name : '';
  input.dispatch('change');
}

function assertReset(harness) {
  const e = harness.elements;
  assert.equal(e['student-photo-preview'].hidden, true);
  assert.equal(e['student-photo-preview'].src, '');
  assert.equal(e['student-photo-placeholder'].hidden, false);
  assert.equal(e['student-photo-label'].textContent, 'Add photo');
  assert.equal(e['student-photo-button'].getAttribute('aria-label'), 'Choose profile photo');
}

test('student photo controls are native, accessible, local-only, and outside the profile form', () => {
  const formStart = html.indexOf('<form class="student-form" id="student-details-form"');
  const formEnd = html.indexOf('</form>', formStart);
  assert.ok(formStart >= 0 && formEnd > formStart, 'student details form exists');
  const formMarkup = html.slice(formStart, formEnd);
  const photoMarkupStart = html.indexOf('id="student-photo-button"');
  const photoMarkupEnd = html.indexOf('id="student-photo-note"', photoMarkupStart);
  assert.ok(photoMarkupStart >= 0 && photoMarkupEnd > photoMarkupStart, 'photo controls and preview-only note exist');
  assert.ok(photoMarkupStart < formStart || photoMarkupStart > formEnd, 'photo controls are outside the student details form');
  assert.doesNotMatch(formMarkup, /type=["']file["']/i, 'native form submission cannot include a photo file');
  assert.match(html, /<button\b[^>]*id="student-photo-button"[^>]*type="button"[^>]*aria-label="Choose profile photo"/);
  assert.match(html, /<input\b(?=[^>]*id="student-photo-input")(?=[^>]*type="file")(?=[^>]*accept="image\/\*")(?=[^>]*class="student-photo-file")[^>]*>/);
  assert.match(styles, /\.student-photo-file\s*\{[^}]*clip:\s*rect\(0,0,0,0\)[^}]*\}/,
    'the native file input is visually hidden while its button remains keyboard-operable');
  assert.match(html, /<img\b(?=[^>]*id="student-photo-preview")(?=[^>]*hidden)[^>]*>/);
  assert.match(html, /id="student-photo-placeholder"/);
  assert.match(html, /id="student-photo-label">Add photo</);
  assert.match(html, /id="student-photo-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /id="student-photo-note"[^>]*>\s*Preview only\s*[·.]\s*Images up to 10 MB\s*</);

  const block = photoPreviewBlock();
  assert.doesNotMatch(block, /\bfetch\s*\(|XMLHttpRequest|sendBeacon|FormData|localStorage|sessionStorage/i,
    'photo-preview behavior must not upload or persist the selected image');
  assert.match(app, /Object\.fromEntries\(new FormData\(studentForm\)\)/,
    'the existing student save payload remains derived from native student-form fields');
  assert.doesNotMatch(app, /FormData\([^)]*student-photo|student-photo-input[^\n]*name=/,
    'photo selection must not be added to the student save payload');
});

test('photo preview validates selection, loads before swapping, replaces and revokes object URLs', () => {
  const h = createPreviewHarness();
  const e = h.elements;
  assertReset(h);

  e['student-photo-button'].click();
  assert.equal(e['student-photo-input'].clickCount, 1, 'the button opens the native file picker');

  select(h, file('portrait.png', 'image/png', 2048));
  assert.equal(e['student-photo-input'].value, '', 'clearing the input allows choosing the same file again');
  assert.equal(h.images.length, 1);
  assert.equal(e['student-photo-preview'].hidden, true, 'unloaded images are not shown');
  assert.equal(e['student-photo-placeholder'].hidden, false);
  h.images[0].load();
  assert.equal(e['student-photo-preview'].src, 'blob:photo-1');
  assert.equal(e['student-photo-preview'].hidden, false);
  assert.equal(e['student-photo-placeholder'].hidden, true);
  assert.equal(e['student-photo-label'].textContent, 'Replace photo');
  assert.equal(e['student-photo-button'].getAttribute('aria-label'), 'Replace profile photo');

  select(h, file('new-photo.jpeg', 'image/jpeg', 4096));
  assert.equal(e['student-photo-preview'].src, 'blob:photo-1', 'old preview remains visible until its replacement loads');
  assert.deepEqual(h.revoked, []);
  h.images[1].load();
  assert.equal(e['student-photo-preview'].src, 'blob:photo-2');
  assert.deepEqual(h.revoked, ['blob:photo-1'], 'replacing a preview releases the previous object URL');

  const imageCount = h.images.length;
  for (const invalid of [
    file('document.pdf', 'application/pdf', 100),
    file('misleading.png', 'text/plain', 100),
    file('unknown', '', 100),
    file('empty.gif', 'image/gif', 0),
    file('too-large.jpg', 'image/jpeg', 10 * 1024 * 1024 + 1)
  ]) {
    select(h, invalid);
    assert.equal(h.images.length, imageCount, `${invalid.name} must be rejected before image decoding`);
    assert.equal(e['student-photo-preview'].src, 'blob:photo-2', 'invalid input preserves the existing preview');
    assert.ok(e['student-photo-status'].textContent, 'invalid input explains the problem accessibly');
  }

  select(h, file('extension-only.webp', '', 10 * 1024 * 1024));
  assert.equal(h.images.length, imageCount + 1, 'recognized image extensions are accepted when MIME type is empty');
  h.images[2].load();
  assert.equal(e['student-photo-preview'].src, 'blob:photo-3');
  assert.deepEqual(h.revoked, ['blob:photo-1', 'blob:photo-2']);
});

test('decode errors and picker cancellation preserve the current photo; stale races are ignored and cleanup runs', async () => {
  const h = createPreviewHarness();
  const e = h.elements;

  select(h, file('first.png'));
  h.images[0].load();
  const stablePreview = e['student-photo-preview'].src;

  select(h, file('broken.jpg', 'image/jpeg'));
  h.images[1].fail();
  assert.equal(e['student-photo-preview'].src, stablePreview, 'a decode error keeps the prior successful preview');
  assert.equal(e['student-photo-preview'].hidden, false);
  assert.ok(h.revoked.includes('blob:photo-2'), 'a failed pending image URL is released');
  assert.ok(e['student-photo-status'].textContent);

  select(h, null);
  assert.equal(e['student-photo-preview'].src, stablePreview, 'cancelling the native picker changes nothing');

  select(h, file('race-a.png'));
  const stale = h.images[2];
  select(h, file('race-b.png'));
  const latest = h.images[3];
  assert.ok(h.revoked.includes('blob:photo-3'), 'a newer choice revokes the previous pending URL');
  stale.load();
  assert.equal(e['student-photo-preview'].src, stablePreview, 'stale loads cannot replace a current preview');
  latest.load();
  assert.equal(e['student-photo-preview'].src, 'blob:photo-4');

  const successfulUrl = e['student-photo-preview'].src;
  h.form.dispatch('reset');
  assertReset(h);
  assert.ok(h.revoked.includes(successfulUrl), 'form reset revokes the successful preview URL');

  select(h, file('pagehide.png'));
  h.images.at(-1).load();
  const pagehideUrl = e['student-photo-preview'].src;
  h.window.dispatch('pagehide');
  assertReset(h);
  assert.ok(h.revoked.includes(pagehideUrl), 'leaving the page releases the successful preview URL');
});
