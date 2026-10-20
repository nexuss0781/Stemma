import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const pickerSource = read('chat-attachments-ui.js');

class Element {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.listeners = new Map();
    this.value = '';
    this.files = [];
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.isConnected = true;
    this.clicks = 0;
    this.parentNode = null;
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, fn) {
    const list = this.listeners.get(type) || [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  dispatch(type, event = {}) {
    for (const fn of this.listeners.get(type) || []) fn({ preventDefault() {}, stopPropagation() {}, ...event });
  }
  click() { this.clicks += 1; this.dispatch('click'); }
  focus() {}
  append(...items) {
    for (const item of items) { item.parentNode = this; this.children.push(item); }
  }
  replaceChildren(...items) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.append(...items);
  }
  remove() { this.isConnected = false; if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(item => item !== this); }
  close() { this.closed = true; }
  showModal() { this.open = true; }
  querySelector(selector) {
    const found = this.elements?.get(selector);
    if (found) return found;
    if (selector === 'span') return this.children.find(child => child.tagName === 'span') || null;
    if (selector === 'button') return this.children.find(child => child.tagName === 'button') || null;
    return null;
  }
  querySelectorAll(selector) {
    if (selector.includes('data-attachment-category')) return this.categories || [];
    if (selector.includes('data-attachment-back')) return this.dismissButtons || [];
    return [];
  }
}

class Dialog extends Element {
  constructor() {
    super('dialog');
    this.elements = new Map();
    const add = (selector, tag = 'div') => {
      const element = new Element(tag);
      element.parentNode = this;
      this.elements.set(selector, element);
      return element;
    };
    add('[data-modal-input]', 'input');
    add('.attachment-grid');
    add('.attachment-empty');
    add('.attachment-feedback', 'p');
    const cameraInput = add('[data-camera-input]', 'input');
    cameraInput.accept = 'image/*';
    cameraInput.capture = 'environment';
    const preview = add('.attachment-preview', 'section');
    preview.hidden = true;
    const previewClose = new Element('button');
    preview.elements = new Map([['button', previewClose]]);
    this.elements.set('[data-preview-close]', previewClose);
    add('.attachment-preview-media');
    add('.attachment-preview-name', 'p');
    add('[data-attachment-send]', 'button');
    const browse = add('[data-attachment-browse]', 'button');
    browse.elements = new Map([['span', new Element('span')]]);
    add('[data-attachment-count]', 'span');
    add('[data-attachment-add]', 'button');
    add('[data-attachment-camera]', 'button');
    const gallery = new Element('button');
    gallery.dataset.attachmentCategory = 'Gallery';
    const file = new Element('button');
    file.dataset.attachmentCategory = 'File';
    this.categories = [gallery, file];
    this.elements.set('[data-attachment-category="Gallery"]', gallery);
    this.elements.set('[data-attachment-category="File"]', file);
    this.dismissButtons = [add('[data-attachment-back]', 'button'), add('[data-attachment-cancel]', 'button')];
  }
}

function createPicker() {
  const dialogs = [];
  const body = new Element('body');
  body.append = dialog => { dialog.parentNode = body; body.children.push(dialog); dialogs.push(dialog); };
  const revoked = [];
  const root = {
    document: {
      body,
      createElement(tag) { return tag === 'dialog' ? new Dialog() : new Element(tag); }
    },
    URL: {
      createObjectURL(file) { return `blob:test-${file.name}`; },
      revokeObjectURL(url) { revoked.push(url); }
    },
    AbortController,
    StemmaParentNavigation: undefined
  };
  root.window = root;
  vm.runInNewContext(pickerSource, root, { filename: 'chat-attachments-ui.js' });
  const button = new Element('button');
  const signal = new AbortController().signal;
  const pickPhoto = options => root.StemmaChatAttachments.pickPhoto({ button, signal, ...options });
  return { root, button, dialogs, revoked, pickPhoto };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test('photo picker markup is limited to Gallery/File tabs and a separate native camera action', () => {
  assert.match(pickerSource, /function pickPhoto\(\{\s*button,\s*signal\s*=\s*new AbortController\(\)\.signal,\s*ready\s*=\s*\(\)\s*=>\s*true,\s*accept\s*=/s);
  assert.match(pickerSource, /role="tablist"[\s\S]*?\['Gallery'[\s\S]*?\['File'/);
  assert.match(pickerSource, /data-attachment-camera/);
  assert.match(pickerSource, /data-camera-input accept="image\/\*" capture="environment"/);
  assert.doesNotMatch(pickerSource, /<label[^>]*>Source<\/label>|<select[^>]*aria-label="Album or source"/);
  assert.doesNotMatch(pickerSource, /\['Location'|\['Article'|\['Poll'|\['Contact'/);
});

test('profile and group-photo upload callers use the shared photo picker and preserve photo callbacks', () => {
  const app = read('app.js');
  const groups = read('groups-ui.js');
  assert.match(app, /StemmaChatAttachments\?\.pickPhoto\(\{[^}]*button:[^}]*data-profile-photo/s);
  assert.match(app, /pickPhoto\(\{[^}]*onSelect:\s*file\s*=>\s*previewStudentPhoto\(file\)/s);
  assert.match(groups, /StemmaChatAttachments\?\.pickPhoto\(\{[^}]*accept:\s*'\.png,\.jpg,\.jpeg,\.webp'[^}]*onSelect:\s*uploadPhoto/s);
});

test('photo selection applies caller accept and size limits and returns the chosen file without an upload request', async () => {
  const h = createPicker();
  const selected = [];
  const file = { name: 'portrait.png', size: 12, lastModified: 1, type: 'image/png' };
  h.pickPhoto({ accept: '.png', maxBytes: 16, title: 'Profile photo', onSelect: value => selected.push(value) });
  const dialog = h.dialogs[0];
  assert.ok(dialog?.open);
  assert.match(dialog.innerHTML, /data-attachment-camera/);
  const localInput = dialog.querySelector('[data-modal-input]');
  const gallery = dialog.querySelector('[data-attachment-category="Gallery"]');
  gallery.click();
  assert.equal(localInput.accept, '.png');
  assert.equal(localInput.clicks, 1);
  localInput.files = [file, { name: 'too-large.png', size: 17, lastModified: 2, type: 'image/png' }];
  localInput.dispatch('change');
  assert.match(dialog.querySelector('.attachment-feedback').textContent, /too-large\.png: choose a nonempty file up to 1 KB/);
  assert.equal(dialog.querySelector('[data-attachment-send]').disabled, false);
  dialog.querySelector('[data-attachment-send]').click();
  await flush();
  assert.deepEqual(selected, [file]);
  assert.equal(dialog.closed, true);
  assert.equal(h.revoked.length, 1);
});

test('camera action opens the dedicated camera input and the File tab keeps the caller photo filter', () => {
  const h = createPicker();
  h.pickPhoto({ accept: '.webp', maxBytes: 1024, onSelect() {} });
  const dialog = h.dialogs[0];
  const cameraInput = dialog.querySelector('[data-camera-input]');
  dialog.querySelector('[data-attachment-camera]').click();
  assert.equal(cameraInput.clicks, 1);
  assert.equal(cameraInput.accept, 'image/*');
  assert.equal(cameraInput.capture, 'environment');
  dialog.querySelector('[data-attachment-category="File"]').click();
  assert.equal(dialog.querySelector('[data-modal-input]').accept, '.webp');
});
