import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
const source = await readFile(new URL('../notifications-ui.js', import.meta.url), 'utf8');

function lastRule(styles, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rules = [...styles.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g'))];
  assert.ok(rules.length, `expected a CSS rule for ${selector}`);
  return rules.at(-1)[1];
}

function createUi(records) {
  const elements = new Map();
  const windowListeners = new Map();
  const window = {
    location: { hash: '#profile' },
    history: {
      state: null,
      pushState(state, _title, url) {
        this.state = state;
        window.location.hash = new URL(url, 'https://stemma.test').hash;
      },
      replaceState(state, _title, url) {
        this.state = state;
        window.location.hash = new URL(url, 'https://stemma.test').hash;
      },
      back() { window.location.hash = '#profile'; }
    },
    addEventListener(name, callback) {
      const listeners = windowListeners.get(name) || [];
      listeners.push(callback);
      windowListeners.set(name, listeners);
    }
  };
  class Element {
    constructor(id) {
      this.id = id;
      this.hidden = false;
      this.open = false;
      this.dataset = id === 'breadcrumb-current' ? { route: 'profile' } : {};
      this.attributes = new Map();
      this.listeners = new Map();
      this.classes = new Set();
      this.classList = {
        contains: name => this.classes.has(name),
        add: name => this.classes.add(name),
        toggle: (name, force) => {
          const enabled = force === undefined ? !this.classes.has(name) : Boolean(force);
          if (enabled) this.classes.add(name); else this.classes.delete(name);
          return enabled;
        }
      };
      this.textContent = '';
      this.innerHTML = '';
      this.scrollTop = 0;
    }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    replaceChildren() { this.innerHTML = ''; this.textContent = ''; }
    focus() {}
    showModal() { this.open = true; }
    close() { this.open = false; }
    click(target = this) { this.listeners.get('click')?.({ target }); }
  }
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new Element(id));
      return elements.get(id);
    }
  };
  const fetch = async () => ({ ok: true, json: async () => ({ notifications: records }) });
  vm.runInNewContext(source, { window, document, fetch, AbortController });
  return { document, window };
}

test('Notifications title is centered in the toolbar, with Back left and checkbox immediately before far-right sort', () => {
  const toolbarStart = html.indexOf('<div class="notifications-top-row">');
  const selectionToolsStart = html.indexOf('<div id="notifications-selection-tools"', toolbarStart);
  assert.ok(toolbarStart >= 0 && selectionToolsStart > toolbarStart, 'toolbar exists before selection tools');
  const toolbar = html.slice(toolbarStart, selectionToolsStart);
  const leading = toolbar.match(/<div class="notifications-leading-actions">([\s\S]*?)<\/div>/)?.[1];
  const title = toolbar.match(/<h1 id="notifications-title">Notifications<\/h1>/)?.[0];
  const trailing = toolbar.match(/<div class="notifications-trailing-actions">([\s\S]*)$/)?.[1];
  assert.ok(leading && title && trailing, 'toolbar has leading actions, one title and trailing actions');
  assert.match(leading, /id="notifications-back"[^>]*aria-label="Back to previous page"/);
  assert.doesNotMatch(leading, /notifications-select|notifications-sort/);
  assert.match(leading, /id="notifications-mark-read"[^>]*hidden[^>]*disabled/);
  assert.match(toolbar, /id="notifications-back"[^>]*aria-label="Back to previous page"[^>]*><svg/);
  assert.match(trailing, /id="notifications-select"[^>]*aria-label="Select notifications"[^>]*><svg[\s\S]*?<\/button>\s*<div class="notifications-sort-control">/,
    'the selection checkbox directly precedes the sort control');
  assert.ok(trailing.indexOf('notifications-select') < trailing.indexOf('notifications-sort'));
  assert.equal((toolbar.match(/id="notifications-title"/g) || []).length, 1);

  const row = lastRule(css, '.notifications-top-row');
  const titleRule = lastRule(css, '.notifications-page-heading h1');
  const trailingRule = lastRule(css, '.notifications-trailing-actions');
  assert.match(row, /grid-template-columns:\s*minmax\(0,1fr\)\s+auto\s+minmax\(0,1fr\)/,
    'equal side columns center the title independently of action widths');
  assert.match(titleRule, /text-align:\s*center/);
  assert.match(titleRule, /color:\s*var\(--brand-burgundy\)/);
  assert.match(titleRule, /font-size:\s*clamp\(20px,\s*5\.8vw,\s*28px\)/,
    'toolbar title is sized up to 28px');
  assert.match(trailingRule, /justify-self:\s*end/);
});

test('toolbar and feed spacing keep Today and notification content shifted upward', () => {
  const toolbarStart = html.indexOf('<div class="notifications-top-row">');
  const selectionToolsStart = html.indexOf('<div id="notifications-selection-tools"', toolbarStart);
  const toolbar = html.slice(toolbarStart, selectionToolsStart);
  assert.match(toolbar, /<h1 id="notifications-title">Notifications<\/h1>/);
  assert.doesNotMatch(html, /class="notifications-title-row"/, 'title is no longer on a separate row');

  const page = lastRule(css, '.notifications-page');
  const heading = lastRule(css, '.notifications-page-heading');
  const group = lastRule(css, '.notification-group');
  assert.match(page, /grid-template-rows:\s*auto\s+auto\s+minmax\(0,1fr\)/);
  assert.match(page, /gap:\s*0/);
  assert.match(heading, /gap:\s*0/);
  assert.match(group, /padding:\s*4px 0 0/,
    'group headings such as Today use compact top spacing');
});

test('Read is hidden until at least one notification is selected', async () => {
  const { document } = createUi([
    { id: 'unread', title: 'Unread', message: 'New message', createdAt: '2026-10-19T10:00:00Z', readAt: null }
  ]);
  const read = document.getElementById('notifications-mark-read');
  document.getElementById('profile-notifications-button').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(read.hidden, true, 'no selection means no Read action');

  const content = document.getElementById('notifications-content');
  document.getElementById('notifications-select').click();
  assert.equal(read.hidden, true, 'entering selection mode with zero selected still hides Read');
  const row = { dataset: { notificationIndex: '0' } };
  content.click({ closest: selector => selector === '[data-notification-index]' ? row : null });
  assert.equal(document.getElementById('notifications-selection-count').textContent, '1 selected');
  assert.equal(read.hidden, false, 'Read appears after selecting one notification');
  content.click({ closest: selector => selector === '[data-notification-index]' ? row : null });
  assert.equal(read.hidden, true, 'Read hides again when selection returns to zero');
});

test('unread dots are limited to unread records outside selection mode', () => {
  const elements = new Map();
  const minimalDocument = {
    getElementById(id) {
      if (!elements.has(id)) {
        elements.set(id, {
          hidden: false, open: false, dataset: {}, classList: { contains: () => false, add() {}, toggle() {} },
          addEventListener() {}, setAttribute() {}, getAttribute() { return null; }, replaceChildren() {},
          showModal() {}, close() {}, focus() {}
        });
      }
      return elements.get(id);
    }
  };
  const window = { location: { hash: '#profile' }, history: { state: null }, addEventListener() {} };
  vm.runInNewContext(source, { window, document: minimalDocument, fetch: async () => { throw new Error('Unexpected fetch'); }, AbortController });
  const { renderNotifications } = window.StemmaNotifications;
  const unread = { id: 'new', title: 'Unread', createdAt: '2026-10-19T10:00:00Z', readAt: null };
  const read = { id: 'old', title: 'Read', createdAt: '2026-10-18T10:00:00Z', readAt: '2026-10-18T11:00:00Z' };

  const normal = renderNotifications([unread, read], null);
  assert.equal((normal.match(/notification-unread-dot/g) || []).length, 1);
  assert.match(normal, /notification-unread-dot[^>]*aria-label="Unread"/);
  const selecting = renderNotifications([unread, read], new Set());
  assert.doesNotMatch(selecting, /notification-unread-dot/,
    'selection mode replaces unread dots with selection affordances');
  assert.match(selecting, /notification-checkbox/);
});
