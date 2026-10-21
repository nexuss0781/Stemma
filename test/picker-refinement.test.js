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
    this.classNames = new Set();
    this.classList = { add: name => this.classNames.add(name), contains: name => this.classNames.has(name) };
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, fn) {
    const list = this.listeners.get(type) || [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  dispatch(type, event = {}) {
    for (const fn of this.listeners.get(type) || []) fn({ type, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...event });
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
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value);
  }
  getAttribute(name) { return this.attributes[name] ?? null; }
  showModal() { this.open = true; }
  querySelector(selector) {
    const found = this.elements?.get(selector);
    if (found) return found;
    const matches = node => selector === node.tagName || selector.startsWith('.') && node.className === selector.slice(1) ||
      selector.startsWith('[aria-label="') && node.getAttribute('aria-label') === selector.slice(13, -2);
    const visit = node => {
      for (const child of node.children || []) {
        if (matches(child)) return child;
        const nested = visit(child);
        if (nested) return nested;
      }
      return null;
    };
    const child = visit(this);
    if (child) return child;
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
  const created = [];
  const root = {
    document: {
      body,
      createElement(tag) { return tag === 'dialog' ? new Dialog() : new Element(tag); }
    },
    URL: {
      createObjectURL(file) { created.push(file); return `blob:test-${file.name}`; },
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
  const pickMedia = options => root.StemmaChatAttachments.pickMedia({ button, signal, ...options });
  return { root, button, dialogs, revoked, created, pickPhoto, pickMedia };
}

function createChatPicker() {
  const h = createPicker();
  const input = new Element('input');
  const form = { querySelector: selector => selector === '.pulse-attach-button' ? h.button : selector === '.pulse-attach-input' ? input : null };
  const signal = new AbortController().signal;
  h.root.StemmaChatAttachments.mount(form, {
    listen: (target, type, listener) => target.addEventListener(type, listener),
    signal,
    endpoint: () => '/attachments'
  });
  h.button.click();
  return { ...h, input: h.dialogs[0].querySelector('[data-modal-input]') };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test('photo picker markup is limited to Gallery/File tabs and a separate native camera action', () => {
  assert.match(pickerSource, /function pickPhoto\(\{\s*button,\s*signal\s*=\s*new AbortController\(\)\.signal,\s*ready\s*=\s*\(\)\s*=>\s*true,\s*accept\s*=/s);
  assert.match(pickerSource, /const categories = \[\['Gallery'[\s\S]*if \(!galleryOnly\) categories\.push\(\['File'/);
  assert.match(pickerSource, /data-attachment-camera/);
  assert.match(pickerSource, /data-camera-input accept="image\/\*" capture="environment"/);
  assert.doesNotMatch(pickerSource, /<label[^>]*>Source<\/label>|<select[^>]*aria-label="Album or source"/);
  assert.doesNotMatch(pickerSource, /\['Location'|\['Article'|\['Poll'|\['Contact'/);
});

test('Gallery-only media picker hides File and Camera and enforces its supplied large size cap', () => {
  const h = createPicker();
  h.pickMedia({ galleryOnly: true, maxBytes: 256 * 1024 * 1024 });
  const dialog = h.dialogs[0];
  assert.doesNotMatch(dialog.innerHTML, /data-attachment-category="File"|data-attachment-camera|data-camera-input/);
  const input = dialog.querySelector('[data-modal-input]');
  input.files = [{ name: 'long.mp4', size: 240 * 1024 * 1024, lastModified: 1, type: 'video/mp4' }];
  input.dispatch('change');
  assert.equal(h.created.length, 1, 'a 240 MiB video is accepted under a 256 MiB cap');
  input.files = [{ name: 'oversize.mp4', size: 256 * 1024 * 1024 + 1, lastModified: 2, type: 'video/mp4' }];
  input.dispatch('change');
  assert.equal(h.created.length, 1, 'a file above the cap is rejected');
  assert.match(dialog.querySelector('.attachment-feedback').textContent, /up to 256(?:\.0)? MB/);
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
  assert.equal(localInput.accept, 'image/png');
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

test('Gallery opens the native chooser synchronously and chosen File objects persist across tabs, selection changes, and preview', () => {
  const h = createChatPicker();
  const dialog = h.dialogs[0];
  const localInput = h.input;
  const grid = dialog.querySelector('.attachment-grid');
  const photo = new File(['image bytes'], 'gallery-photo.png', { type: 'image/png', lastModified: 10 });
  const document = new File(['document bytes'], 'notes.pdf', { type: 'application/pdf', lastModified: 11 });
  const gallery = dialog.querySelector('[data-attachment-category="Gallery"]');
  const fileTab = dialog.querySelector('[data-attachment-category="File"]');

  gallery.click();
  assert.equal(localInput.clicks, 1, 'the native Gallery input is clicked before the tab click handler returns');
  localInput.files = [photo];
  localInput.dispatch('change');
  assert.deepEqual(h.created, [photo], 'the selected browser File object is passed intact to object-URL creation');
  assert.equal(grid.children.length, 1);
  assert.equal(grid.children[0].children[0].getAttribute('aria-label'), 'Preview gallery-photo.png');

  fileTab.click();
  assert.equal(localInput.clicks, 2, 'File tab also opens its native chooser synchronously');
  assert.equal(grid.children.length, 1, 'switching tabs does not discard the chosen Gallery file');
  localInput.files = [document];
  localInput.dispatch('change');
  assert.deepEqual(h.created, [photo, document], 'both original File object references populate picker entries');
  assert.equal(grid.children.length, 2, 'File shows both previously chosen and newly chosen files');

  const checkboxFor = name => {
    const card = grid.children.find(tile => tile.children[0].getAttribute('aria-label') === `Preview ${name}`);
    assert.ok(card, `${name} has a rendered tile`);
    return card.children[1].children[0];
  };
  const photoCheckbox = checkboxFor('gallery-photo.png');
  photoCheckbox.checked = false;
  photoCheckbox.dispatch('change');
  assert.equal(dialog.querySelector('[data-attachment-count]').textContent, '1', 'deselecting updates the count without removing the File');

  gallery.click();
  assert.equal(grid.children.length, 1, 'Gallery filtering hides the PDF but keeps the image entry');
  fileTab.click();
  assert.equal(grid.children.length, 2, 'returning to File restores both original files');
  assert.equal(checkboxFor('gallery-photo.png').checked, false, 'the deselected state survives a tab round trip');
  assert.equal(checkboxFor('notes.pdf').checked, true, 'the other file remains selected');

  checkboxFor('gallery-photo.png').checked = true;
  checkboxFor('gallery-photo.png').dispatch('change');
  assert.equal(dialog.querySelector('[data-attachment-count]').textContent, '2', 'reselection restores the selected count');
  gallery.click();
  fileTab.click();
  assert.equal(checkboxFor('gallery-photo.png').checked, true, 'the reselected File remains selected across tabs');

  grid.children.find(tile => tile.children[0].getAttribute('aria-label') === 'Preview gallery-photo.png').children[0].click();
  assert.equal(dialog.querySelector('.attachment-preview').hidden, false, 'preview opens as a separate layer');
  assert.equal(grid.hidden, true, 'the selection grid is hidden while preview is open');
  assert.equal(dialog.querySelector('.attachment-preview-media').children[0].src, 'blob:test-gallery-photo.png');
  dialog.querySelector('[data-preview-close]').click();
  assert.equal(dialog.querySelector('.attachment-preview').hidden, true, 'closing preview returns to selection');
  assert.equal(grid.hidden, false);
  assert.equal(grid.children.length, 2, 'closing preview leaves the original selected files intact');
  assert.equal(dialog.querySelector('[data-attachment-count]').textContent, '2');
  assert.deepEqual(h.created, [photo, document]);
});

test('chat picker accepts a 5 MiB File and rejects one byte over the chat attachment limit', () => {
  const h = createChatPicker();
  const dialog = h.dialogs[0];
  const localInput = h.input;
  const exactLimit = new File([new Uint8Array(5 * 1024 * 1024)], 'exact-limit.png', { type: 'image/png' });
  const overLimit = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'over-limit.png', { type: 'image/png' });

  dialog.querySelector('[data-attachment-category="Gallery"]').click();
  assert.equal(localInput.clicks, 1, 'Gallery launches the native chooser without deferral');
  localInput.files = [exactLimit, overLimit];
  localInput.dispatch('change');
  assert.deepEqual(h.created, [exactLimit], 'only the valid actual File object is retained');
  assert.equal(dialog.querySelector('.attachment-grid').children.length, 1);
  assert.match(dialog.querySelector('.attachment-feedback').textContent, /over-limit\.png: choose a nonempty file up to 5\.0 MB/);
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

test('Likee media mode reuses Gallery/File/Camera and returns one photo or video without publishing', async () => {
  const h = createPicker();
  const selected = [];
  const controller = new AbortController();
  h.root.StemmaChatAttachments.pickMedia({ button: h.button, signal: controller.signal, onSelect: file => selected.push(file) });
  const dialog = h.dialogs[0];
  const input = dialog.querySelector('[data-modal-input]');
  assert.match(input.accept, /video\/quicktime/);
  assert.match(input.accept, /image\/png/);
  dialog.querySelector('[data-attachment-category="Gallery"]').click();
  assert.equal(input.clicks, 1);
  const photo = new File(['png'], 'photo.png', { type: 'image/png' });
  const video = new File(['mov'], 'clip.mov', { type: 'video/quicktime' });
  input.files = [photo, video, new File(['pdf'], 'not-media.pdf', { type: 'application/pdf' })];
  input.dispatch('change');
  assert.match(dialog.querySelector('.attachment-feedback').textContent, /unsupported file type/);
  assert.equal(dialog.querySelector('[data-attachment-count]').textContent, '1');
  assert.equal(dialog.querySelector('[data-attachment-send]').textContent, 'Use media');
  assert.equal(selected.length, 0, 'choosing media does not upload or publish');
  dialog.querySelector('[data-attachment-category="File"]').click();
  assert.match(input.accept, /\.mov/);
  dialog.querySelector('[data-attachment-send]').click();
  await flush();
  assert.deepEqual(selected, [video]);
  assert.equal(dialog.closed, true);
  assert.equal(h.revoked.length, 2, 'all picker URLs are released');
});

test('shared uploader reports actual transport progress mapped to media bytes and waits for server success', async () => {
  const h = createPicker(); const changes = []; let request;
  h.root.XMLHttpRequest = class {
    constructor() { request = this; this.upload = {}; this.headers = {}; }
    open(method, endpoint) { this.method = method; this.endpoint = endpoint; }
    setRequestHeader(name, value) { this.headers[name] = value; }
    send(body) { this.body = JSON.parse(body); }
    abort() { this.onabort?.(); this.onloadend?.(); }
  };
  let settled = false;
  const pending = h.root.StemmaChatAttachments.upload({ endpoint: '/attachments', size: 2000000, body: { data: 'bytes' }, onProgress: state => changes.push(state) }).then(value => { settled = true; return value; });
  assert.equal(request.method, 'POST'); assert.equal(request.endpoint, '/attachments');
  assert.equal(request.headers['Content-Type'], 'application/json'); assert.equal(request.withCredentials, true);
  assert.equal(changes[0].percent, 0);
  request.upload.onprogress({ lengthComputable: false, loaded: 1, total: 0 });
  assert.equal(changes.length, 1, 'unknown totals do not fabricate percentages');
  request.upload.onprogress({ lengthComputable: true, loaded: 750000, total: 3000000 });
  assert.equal(changes.at(-1).percent, 25); assert.equal(changes.at(-1).loaded, 500000); assert.equal(changes.at(-1).total, 2000000);
  request.upload.onload(); await flush();
  assert.equal(changes.at(-1).percent, 100); assert.equal(changes.at(-1).complete, true);
  assert.equal(settled, false, '100% transferred is not yet a successful published post');
  request.status = 201; request.responseText = '{"ok":true}'; request.onload(); request.onloadend();
  assert.equal((await pending).ok, true);
});

test('shared uploader rejects cancelled and failed requests without automatic retries', async () => {
  const h = createPicker(); let request; let sends = 0;
  h.root.XMLHttpRequest = class {
    constructor() { request = this; this.upload = {}; }
    open() {} setRequestHeader() {} send() { sends++; }
    abort() { this.onabort?.(); this.onloadend?.(); }
  };
  const controller = new AbortController();
  const cancelled = h.root.StemmaChatAttachments.upload({ endpoint: '/attachments', size: 10, body: {}, signal: controller.signal });
  controller.abort(); await assert.rejects(cancelled, /cancelled/);
  const failed = h.root.StemmaChatAttachments.upload({ endpoint: '/attachments', size: 10, body: {} });
  request.status = 400; request.responseText = '{"error":"Video is longer than 4 minutes."}'; request.onload(); request.onloadend();
  await assert.rejects(failed, /longer than 4 minutes/);
  assert.equal(sends, 2, 'each explicit call sends once only');
});
