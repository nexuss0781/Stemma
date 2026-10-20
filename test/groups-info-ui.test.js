import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../groups-ui.js', import.meta.url), 'utf8');

const kebab = value => value.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
const camel = value => value.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.open = false;
    this.scrollHeight = 100;
    this.scrollTop = 0;
    this.clientHeight = 100;
    this._text = '';
    this._className = '';
    this.focusCount = 0;
    this.classList = {
      add: (...names) => { const values = new Set(this.className.split(/\s+/).filter(Boolean)); names.forEach(name => values.add(name)); this.className = [...values].join(' '); },
      remove: (...names) => { const remove = new Set(names); this.className = this.className.split(/\s+/).filter(name => name && !remove.has(name)).join(' '); },
      contains: name => this.className.split(/\s+/).includes(name),
      toggle: (name, force) => { const shouldAdd = force === undefined ? !this.classList.contains(name) : Boolean(force); if (shouldAdd) this.classList.add(name); else this.classList.remove(name); return shouldAdd; }
    };
    this.dataset = new Proxy({}, {
      get: (_target, key) => this.getAttribute(`data-${kebab(String(key))}`) ?? undefined,
      set: (_target, key, value) => { this.setAttribute(`data-${kebab(String(key))}`, value); return true; }
    });
  }
  get className() { return this._className; }
  set className(value) { this._className = String(value || ''); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { for (const child of this.children) child.parentNode = null; this.children = []; this._text = String(value ?? ''); }
  get isConnected() { let node = this; while (node.parentNode) node = node.parentNode; return node._isRoot === true; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null; }
  removeAttribute(name) { delete this.attributes[name]; }
  append(...children) { for (const child of children) { child.parentNode = this; this.children.push(child); } }
  replaceChildren(...children) { for (const child of this.children) child.parentNode = null; this.children = []; this._text = ''; this.append(...children); }
  removeChild(child) { this.children = this.children.filter(item => item !== child); child.parentNode = null; }
  focus() { this.focusCount++; if (this.ownerDocument) this.ownerDocument.activeElement = this; }
  reset() { for (const control of Object.values(this.elements || {})) control.value = ''; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  matches(selector) { return selector.split(',').some(part => matchesSimple(this, part.trim())); }
  closest(selector) { for (let node = this; node; node = node.parentNode) if (node.matches(selector)) return node; return null; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) { const found = []; const walk = node => { for (const child of node.children) { if (child.matches(selector)) found.push(child); walk(child); } }; walk(this); return found; }
}

function matchesSimple(element, selector) {
  if (selector === '*') return true;
  const tag = selector.match(/^[a-z][\w-]*/i)?.[0];
  if (tag && element.tagName !== tag.toUpperCase()) return false;
  for (const match of selector.matchAll(/\.([\w-]+)/g)) if (!element.classList.contains(match[1])) return false;
  for (const match of selector.matchAll(/#([\w-]+)/g)) if (element.getAttribute('id') !== match[1]) return false;
  for (const match of selector.matchAll(/\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]/g)) {
    const [, name, expected] = match;
    const actual = element.getAttribute(name);
    if (actual === null || (expected !== undefined && actual !== expected)) return false;
  }
  return Boolean(tag || selector.includes('.') || selector.includes('#') || selector.includes('['));
}

const el = (tag, cls = '', attrs = {}) => {
  const node = new Element(tag);
  if (cls) node.className = cls;
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  return node;
};
const append = (parent, ...children) => { for (const child of children) { if (parent.ownerDocument) assignDocument(child, parent.ownerDocument); } parent.append(...children); return parent; };
const assignDocument = (node, document) => { node.ownerDocument = document; for (const child of node.children) assignDocument(child, document); };

function createMounted(fetchImpl) {
  const listeners = [];
  const document = { hidden: false, activeElement: null, createElement: tag => { const node = new Element(tag); node.ownerDocument = document; return node; }, addEventListener(type, handler) { listeners.push({ element: document, type, handler }); } };
  const shell = el('div'); shell._isRoot = true; shell.ownerDocument = document;
  const view = el('section', 'groups-view');
  const feed = el('section', 'pulse-feed'), search = el('section', 'pulse-search'), saved = el('section', 'pulse-saved');
  append(shell, view, feed, search, saved);
  const listView = el('div', 'groups-list-view');
  const groupsStatus = el('p', 'groups-status', { 'data-groups-status': '' });
  const groupsList = el('div', 'groups-list', { 'data-groups-list': '' });
  const results = el('div', '', { 'data-groups-results': '' });
  const discoveryInput = el('input', '', { 'data-group-discovery': '' });
  append(listView, groupsStatus, groupsList, discoveryInput, results);

  const detail = el('section', 'group-detail', { 'data-group-detail': '' });
  const back = el('button', 'group-back', { 'data-group-back': '' });
  back.append(el('span'));
  const conversationHeader = el('header', 'group-conversation-header', { 'data-group-conversation-header': '' });
  const avatarControl = el('button', 'group-conversation-avatar-control', { 'data-group-info': '', 'aria-label': 'Open group info' });
  const conversationAvatar = el('span', 'group-conversation-avatar', { 'data-conversation-avatar': '' });
  avatarControl.append(conversationAvatar);
  const titleControl = el('button', 'group-conversation-title-control', { 'data-group-info': '' });
  const conversationName = el('span', 'group-conversation-title', { 'data-conversation-name': '' }); titleControl.append(conversationName);
  const infoButton = el('button', 'group-info-button', { 'data-group-info': '', 'aria-label': 'Group info' }); infoButton.textContent = 'Group info';
  append(conversationHeader, avatarControl, titleControl, infoButton);

  const infoPanel = el('div', 'group-info-panel');
  const detailHeader = el('header', 'group-detail-header');
  const groupAvatar = el('span', 'group-avatar', { 'data-group-avatar': '' });
  const groupName = el('h2', '', { 'data-group-name': '' });
  const description = el('p', '', { 'data-group-description': '' });
  const meta = el('div', 'group-meta');
  const groupCount = el('span', '', { 'data-group-count': '' });
  const visibility = el('span', '', { 'data-group-visibility': '' });
  meta.append(groupCount, visibility);
  const actions = el('div', '', { 'data-group-actions': '' });
  append(detailHeader, groupAvatar, groupName, description, meta, actions);
  const groupStatus = el('p', '', { 'data-group-status': '' });
  const linkSection = el('section', '', { 'data-group-link-section': '' });
  const linkRow = el('div', '', { 'data-group-link-row': '' });
  const groupLink = el('a', '', { 'data-group-link': '' });
  linkRow.append(groupLink, el('button', '', { 'data-copy-link': '' }));
  linkSection.append(linkRow);
  const membersSection = el('section', 'group-members-section');
  const memberCount = el('span', '', { 'data-member-count': '' });
  const memberRows = el('div', 'group-members', { 'data-group-members': '' });
  membersSection.append(memberCount, memberRows);
  const settingsSection = el('section', 'group-settings-section', { 'data-group-settings-section': '' });
  const settingsButton = el('button', 'group-settings-button', { 'data-group-settings': '' });
  settingsSection.append(settingsButton);
  append(infoPanel, detailHeader, groupStatus, linkSection, membersSection, settingsSection);

  const chat = el('section', 'group-chat', { 'data-group-chat': '' });
  const older = el('button', '', { 'data-group-older': '' });
  const messages = el('div', 'group-messages', { 'data-group-messages': '' });
  const compose = el('form', 'group-compose');
  const messageInput = el('textarea', '', { id: 'group-message-input' });
  const send = el('button', '', { type: 'submit' });
  compose.append(messageInput, send);
  append(chat, older, messages, compose);
  append(detail, back, conversationHeader, infoPanel, chat);
  const dialog = el('dialog', 'group-dialog', { 'data-group-dialog': '' });
  const groupForm = el('form', 'group-dialog-card', { 'data-group-form': '' });
  const dialogTitle = el('h2', '', { 'data-dialog-title': '' });
  const dialogEyebrow = el('p', '', { 'data-dialog-eyebrow': '' });
  const formName = el('input'), formSlug = el('input'), formDescription = el('textarea'), formVisibility = el('select');
  groupForm.elements = { name: formName, slug: formSlug, description: formDescription, visibility: formVisibility };
  const dialogStatus = el('p', '', { 'data-dialog-status': '' });
  const cancelButton = el('button', '', { type: 'button', 'data-dialog-close': '' });
  const primary = el('button', 'groups-primary');
  groupForm.append(dialogEyebrow, dialogTitle, formName, formSlug, formDescription, formVisibility, dialogStatus, cancelButton, primary);
  dialog.append(groupForm);
  append(view, listView, detail, dialog);

  const controller = new AbortController();
  const navigation = {
    entries: [], stack: [], backs: [],
    enter(key, close, options) {
      if (this.stack.some(entry => entry.key === key)) return key;
      const entry = { key, close, options };
      this.entries.push(entry); this.stack.push(entry); return key;
    },
    back(key) {
      this.backs.push(key);
      const entry = this.stack.at(-1);
      if (!entry || (key && entry.key !== key)) return false;
      this.stack.pop(); entry.close(); return true;
    }
  };
  const api = {
    fetch: fetchImpl, AbortController, setTimeout: () => ({}), clearTimeout() {},
    document, location: { origin: 'https://example.test', href: 'https://example.test/groups', pathname: '/groups' },
    navigator: { clipboard: { writeText: async () => {} } }, confirm: () => true,
    history: { state: {}, pushState() {}, replaceState() {}, back() {} }, addEventListener() {},
    StemmaParentNavigation: navigation
  };
  api.window = api;
  vm.runInNewContext(source, api);
  const mounted = api.StemmaGroups.mount(shell, {
    listen: (element, type, handler) => listeners.push({ element, type, handler }),
    signal: controller.signal
  });
  const handler = (element, type) => listeners.find(item => item.element === element && item.type === type)?.handler;
  const click = target => handler(shell, 'click')({ target, preventDefault() {} });
  return { api, mounted, shell, view, feed, search, saved, detail, listView, groupsList, groupsStatus, groupName, groupCount, description, memberCount, memberRows, messages, messageInput, conversationName, avatarControl, titleControl, infoButton, back, actions, settingsSection, settingsButton, chat, dialog, groupForm, cancelButton, navigation, handler, click, controller };
}

const response = data => ({ ok: true, status: 200, json: async () => data });
const flush = () => new Promise(resolve => setImmediate(resolve));
const texts = node => node.children.map(child => child.textContent);
const group = (overrides = {}) => ({ id: '42', name: 'Actual group name', slug: 'actual-group', description: 'The actual group description.', visibility: 'public', memberCount: 3, isMember: true, isOwner: false, publicUrl: '/actual-group', ...overrides });
const sampleMessages = [{ id: 'm-1', text: 'Earlier conversation history', createdAt: '2026-03-01T09:00:00Z', author: { nickName: 'Ari' } }];

function fixtureFetch({ groupData = group(), members = [{ username: 'ari', nickName: 'Ari' }, { username: 'bea', nickName: 'Bea', role: 'owner' }, { username: 'cy', nickName: 'Cy' }], messages = sampleMessages } = {}) {
  const requests = [];
  const fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url) === '/api/pulse/groups') return response({ groups: [groupData] });
    if (String(url) === `/api/pulse/groups/${groupData.id}/messages` && options.method !== 'POST') return response({ messages, hasMore: false });
    if (String(url) === `/api/pulse/groups/${groupData.id}`) return response({ group: groupData, members });
    if (String(url) === `/api/pulse/groups/${groupData.id}/join` && options.method === 'POST') {
      const joined = { ...groupData, isMember: true };
      return response({ group: joined, members });
    }
    if (String(url) === `/api/pulse/groups/${groupData.id}/messages` && options.method === 'POST') return response({ message: { id: 'm-2', text: JSON.parse(options.body).text, createdAt: '2026-03-01T10:00:00Z', mine: true } });
    throw new Error(`Unexpected fixture request: ${options.method || 'GET'} ${url}`);
  };
  fetch.requests = requests;
  return fetch;
}

async function openFixture(options) {
  const fetch = fixtureFetch(options);
  const mounted = createMounted(fetch);
  await mounted.mounted.openById('42');
  await flush();
  return { ...mounted, requests: fetch.requests };
}

test('exported view exposes clickable, accessibly named group avatar/title info controls', () => {
  const api = { window: null }; api.window = api;
  vm.runInNewContext(source, api);
  const markup = api.StemmaGroups.view();
  assert.match(markup, /<button[^>]*class="group-conversation-avatar-control"[^>]*data-group-info[^>]*aria-label="Open group info"/);
  assert.match(markup, /<button[^>]*class="group-conversation-title-control"[^>]*data-group-info/);
  assert.match(markup, /<span class="group-conversation-title" data-conversation-name><\/span>/);
  assert.match(markup, /<button[^>]*class="group-info-button"[^>]*data-group-info[^>]*aria-label="Group info"/);
});

test('mount renders API group identity, member count, description, and actual member rows', async () => {
  const mounted = await openFixture();
  assert.equal(mounted.groupName.textContent, 'Actual group name');
  assert.equal(mounted.conversationName.textContent, 'Actual group name');
  assert.equal(mounted.groupCount.textContent, '3 members');
  assert.equal(mounted.description.textContent, 'The actual group description.');
  assert.equal(mounted.memberCount.textContent, '3');
  assert.deepEqual(mounted.memberRows.children.map(row => row.children[1].textContent), ['Ari', 'Bea', 'Cy']);
  assert.equal(mounted.groupsList.children[0].children[1].children[0].textContent, 'Actual group name');
});

test('info Back and Message return to the same conversation without losing its draft or history', async () => {
  const mounted = await openFixture();
  mounted.messageInput.value = 'draft that must survive info';
  assert.deepEqual(mounted.messages.children.map(row => row.children[1].textContent), ['Earlier conversation history']);

  mounted.click(mounted.titleControl);
  assert.equal(mounted.detail.classList.contains('is-info'), true);
  assert.equal(mounted.navigation.entries.at(-1).key, 'pulse-group-info');
  assert.equal(mounted.groupName.focusCount > 0, true);
  mounted.click(mounted.back);
  assert.equal(mounted.detail.classList.contains('is-info'), false);
  assert.equal(mounted.detail.hidden, false, 'Back from info returns to conversation, not group list');
  assert.equal(mounted.messageInput.value, 'draft that must survive info');
  assert.deepEqual(mounted.messages.children.map(row => row.children[1].textContent), ['Earlier conversation history']);

  mounted.click(mounted.avatarControl);
  const messageAction = mounted.actions.querySelector('[data-group-message-action]');
  assert.ok(messageAction);
  mounted.click(messageAction);
  assert.equal(mounted.detail.classList.contains('is-info'), false);
  assert.equal(mounted.detail.hidden, false);
  assert.equal(mounted.messageInput.value, 'draft that must survive info');
  assert.equal(mounted.messageInput.focusCount > 0, true);
  assert.deepEqual(mounted.messages.children.map(row => row.children[1].textContent), ['Earlier conversation history']);
});

test('group child navigation registers its parent-close callback and delegates Back correctly', async () => {
  const mounted = await openFixture();
  assert.equal(mounted.navigation.entries.at(-1).key, 'pulse-group');
  mounted.click(mounted.back);
  assert.deepEqual(mounted.navigation.backs, ['pulse-group']);
  const child = mounted.navigation.entries.at(-1);
  child.close();
  assert.equal(mounted.detail.hidden, true, 'parent navigation close callback exits the group detail');
  assert.equal(mounted.view.hidden, true);
});

test('nonmembers can join but cannot access owner settings; owners retain settings access', async () => {
  const nonmember = await openFixture({ groupData: group({ isMember: false, isOwner: false }) });
  assert.ok(nonmember.actions.querySelector('[data-group-join]'));
  assert.equal(nonmember.settingsSection.hidden, true);
  assert.equal(nonmember.settingsButton.hidden, true);
  assert.equal(nonmember.chat.hidden, true);
  nonmember.click(nonmember.actions.querySelector('[data-group-join]'));
  await flush();
  assert.ok(nonmember.requests.some(request => request.url.endsWith('/42/join') && request.options.method === 'POST'));
  assert.equal(nonmember.chat.hidden, false, 'successful join enables the group conversation');
  assert.ok(nonmember.actions.querySelector('[data-group-message-action]'));

  const owner = await openFixture({ groupData: group({ isOwner: true }) });
  assert.equal(owner.settingsSection.hidden, false);
  assert.equal(owner.settingsButton.hidden, false);
  owner.click(owner.settingsButton);
  assert.equal(owner.dialog.open, true, 'owner can open group settings');
  assert.equal(owner.groupForm.elements.name.value, 'Actual group name');
});

function capturePulseState(mounted) {
  return {
    hidden: [mounted.view, mounted.feed, mounted.search, mounted.saved, mounted.listView, mounted.detail].map(element => element.hidden),
    detailClasses: ['is-open', 'is-info'].map(name => mounted.detail.classList.contains(name)),
    scroll: mounted.shell.querySelectorAll('*').map(element => element.scrollTop),
    focused: mounted.api.document.activeElement,
    status: mounted.groupsStatus.textContent,
    groupRows: texts(mounted.groupsList)
  };
}

test('canceling New Group restores the prior feed and search Pulse state without feedback or requests', async () => {
  for (const scenario of [
    { category: 'feed', cancel: 'button' },
    { category: 'search', cancel: 'escape' }
  ]) {
    const fetch = fixtureFetch();
    const mounted = createMounted(fetch);
    await flush();
    mounted.view.hidden = true;
    mounted.feed.hidden = scenario.category !== 'feed';
    mounted.search.hidden = scenario.category !== 'search';
    mounted.saved.hidden = true;
    mounted.listView.hidden = false;
    mounted.detail.hidden = true;
    mounted.detail.classList.remove('is-open', 'is-info');
    const trigger = el('button', '', { 'data-group-create': '' });
    append(scenario.category === 'feed' ? mounted.feed : mounted.search, trigger);
    mounted.shell.querySelectorAll('*').forEach((element, index) => { element.scrollTop = index + 7; });
    trigger.focus();
    const before = capturePulseState(mounted);
    const requestsBefore = fetch.requests.length;

    mounted.click(trigger);
    assert.equal(mounted.dialog.open, true);
    if (scenario.cancel === 'button') {
      mounted.click(mounted.cancelButton);
    } else {
      let prevented = false;
      mounted.handler(mounted.dialog, 'cancel')({ preventDefault() { prevented = true; } });
      assert.equal(prevented, true, 'Escape cancellation prevents the browser default before closing explicitly');
    }
    await flush();

    assert.equal(mounted.dialog.open, false, `${scenario.category} dialog is closed`);
    assert.deepEqual(capturePulseState(mounted), before, `${scenario.category} screen, stage, scroll, and focus are restored exactly`);
    assert.equal(fetch.requests.length, requestsBefore, 'cancel does not load or submit groups');
    assert.equal(mounted.groupsStatus.textContent, '', 'cancel does not show group status feedback');
    assert.equal(mounted.groupsList.querySelector('.groups-empty'), null, 'cancel does not inject empty/join feedback');
    assert.equal(mounted.dialog.querySelector('[data-dialog-status]').textContent, '', 'cancel does not show dialog feedback');
    mounted.controller.abort();
  }
});

test('native Escape from existing group info restores info stage, focus, and scroll without group feedback', async () => {
  const fetch = fixtureFetch();
  const mounted = createMounted(fetch);
  await mounted.mounted.openById('42');
  await flush();
  mounted.click(mounted.titleControl);
  const trigger = el('button', '', { 'data-group-create': '' });
  append(mounted.detail.querySelector('.group-info-panel'), trigger);
  mounted.shell.querySelectorAll('*').forEach((element, index) => { element.scrollTop = index + 31; });
  trigger.focus();
  const before = capturePulseState(mounted);
  const requestsBefore = fetch.requests.length;

  mounted.click(trigger);
  let prevented = false;
  mounted.handler(mounted.dialog, 'cancel')({ preventDefault() { prevented = true; } });
  await flush();

  assert.equal(prevented, true, 'native Escape is intercepted');
  assert.equal(mounted.dialog.open, false);
  assert.deepEqual(capturePulseState(mounted), before, 'conversation info stage and all scroll/focus state are preserved');
  assert.equal(fetch.requests.length, requestsBefore, 'cancel does not reload, join, or create a group');
  assert.equal(mounted.groupsStatus.textContent, '', 'cancel does not show no-groups feedback');
  assert.equal(mounted.dialog.querySelector('[data-dialog-status]').textContent, '', 'cancel does not show dialog feedback');
  mounted.controller.abort();
});
