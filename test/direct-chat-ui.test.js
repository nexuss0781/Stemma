import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../direct-chat-ui.js', import.meta.url), 'utf8');

class Element {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.attributes = {};
    this.style = {};
    this.textContent = '';
    this.value = '';
    this.hidden = false;
    this.disabled = false;
    this.scrollHeight = 100;
    this.scrollTop = 0;
    this.clientHeight = 100;
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  append(child) { this.children.push(child); }
  replaceChildren(...children) { this.children = children; }
  focus() {}
}

function createMountedChat(fetchImpl) {
  const panel = new Element('section');
  const elements = {
    '.pulse-direct-back': new Element('button'),
    '.pulse-direct-title': new Element('h2'),
    '.pulse-direct-handle': new Element('p'),
    '.pulse-direct-history': new Element('div'),
    '.pulse-direct-messages': new Element('div'),
    '.pulse-direct-older': new Element('button'),
    '.pulse-direct-status': new Element('p'),
    form: new Element('form'),
    textarea: new Element('textarea')
  };
  const submit = new Element('button');
  elements.form.querySelector = selector => selector === 'button' ? submit : null;
  panel.querySelector = selector => elements[selector] || null;
  const shell = { querySelector: selector => selector === '.pulse-direct-chat' ? panel : null };
  const listeners = [];
  const controller = new AbortController();
  const api = { fetch: fetchImpl, document: { createElement: tag => new Element(tag) } };
  api.window = api;
  vm.runInNewContext(source, api);
  const chat = api.StemmaDirectChat.mount(shell, {
    listen: (element, type, handler) => listeners.push({ element, type, handler }),
    signal: controller.signal,
    onClose() {}
  });
  const handler = (element, type) => listeners.find(item => item.element === element && item.type === type)?.handler;
  return { chat, panel, elements, submit, handler, controller };
}

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const response = data => ({ ok: true, status: 200, json: async () => data });
const flush = () => new Promise(resolve => setImmediate(resolve));
const texts = list => list.children.map(item => item.children[0]?.textContent);

test('direct chat view renders accessible, initially-disabled message controls and an empty labeled history', () => {
  const api = { window: null };
  api.window = api;
  vm.runInNewContext(source, api);
  const markup = api.StemmaDirectChat.view();
  assert.match(markup, /<section class="pulse-direct-chat" aria-label="Direct chat" hidden>/);
  assert.match(markup, /aria-label="Back to Pulse conversations"/);
  assert.match(markup, /<div class="pulse-direct-history" tabindex="0" role="region" aria-label="Conversation messages">/);
  assert.match(markup, /<div class="pulse-direct-messages" role="list" aria-label="Messages"><\/div>/);
  assert.match(markup, /class="pulse-data-status pulse-direct-status" role="status" aria-live="polite"/);
  assert.match(markup, /<textarea id="pulse-direct-text"[^>]*maxlength="4000"[^>]*required disabled>/);
  assert.match(markup, /<button type="submit" aria-label="Send message" disabled>/);
  assert.match(markup, /class="pulse-direct-older" hidden>Load earlier messages/);
});

test('late load, refresh, and send responses never paint into a different conversation', async () => {
  const requests = [];
  const mounted = createMountedChat(() => {
    const pending = deferred();
    requests.push(pending);
    return pending.promise;
  });
  const { chat, elements, submit } = mounted;

  chat.open({ id: 'alpha', peer: { username: 'alpha' } });
  chat.open({ id: 'beta', peer: { username: 'beta' } });
  assert.equal(requests.length, 2);
  requests[0].resolve(response({ messages: [{ id: 'a1', text: 'alpha secret', createdAt: '2026-01-01T00:00:00Z' }], hasMore: false }));
  await flush();
  assert.deepEqual(texts(elements['.pulse-direct-messages']), [], 'stale initial load does not paint');
  assert.equal(elements.textarea.disabled, true, 'stale load cannot enable the new conversation composer');
  requests[1].resolve(response({ messages: [{ id: 'b1', text: 'beta message', createdAt: '2026-01-02T00:00:00Z' }], hasMore: false }));
  await flush();
  assert.deepEqual(texts(elements['.pulse-direct-messages']), ['beta message']);

  elements.textarea.value = 'alpha-bound send';
  const pendingSend = mounted.handler(elements.form, 'submit')({ preventDefault() {} });
  assert.equal(requests.length, 3);
  chat.open({ id: 'gamma', peer: { username: 'gamma' } });
  requests[3].resolve(response({ messages: [{ id: 'g1', text: 'gamma message', createdAt: '2026-01-03T00:00:00Z' }], hasMore: false }));
  await flush();
  elements.textarea.value = 'gamma draft';
  requests[2].resolve(response({ message: { id: 'b2', text: 'late beta send', createdAt: '2026-01-04T00:00:00Z', mine: true } }));
  await flush();
  assert.deepEqual(texts(elements['.pulse-direct-messages']), ['gamma message'], 'stale send cannot merge into another thread');
  assert.equal(elements.textarea.value, 'gamma draft', 'stale send cannot clear the new thread draft');
  await pendingSend;

  chat.refresh();
  assert.equal(requests.length, 5);
  chat.open({ id: 'delta', peer: { username: 'delta' } });
  requests[5].resolve(response({ messages: [{ id: 'd1', text: 'delta message', createdAt: '2026-01-05T00:00:00Z' }], hasMore: false }));
  await flush();
  requests[4].resolve(response({ messages: [{ id: 'g2', text: 'late gamma refresh', createdAt: '2026-01-06T00:00:00Z' }], hasMore: false }));
  await flush();
  assert.deepEqual(texts(elements['.pulse-direct-messages']), ['delta message'], 'stale refresh cannot merge into another thread');

  const staleClose = deferred();
  // A final pending refresh is invalidated by close; closed panels must remain closed and empty.
  const closeMounted = createMountedChat(() => staleClose.promise);
  closeMounted.chat.open({ id: 'epsilon', peer: { username: 'epsilon' } });
  closeMounted.chat.closeView();
  staleClose.resolve(response({ messages: [{ id: 'e1', text: 'closed stale message', createdAt: '2026-01-07T00:00:00Z' }], hasMore: false }));
  await flush();
  assert.equal(closeMounted.chat.isOpen(), false);
  assert.deepEqual(texts(closeMounted.elements['.pulse-direct-messages']), []);
  assert.equal(closeMounted.elements.textarea.disabled, true);
});

test('incoming avatars use only public identity and clear when leaving the conversation', async () => {
  const mounted = createMountedChat(async () => response({ messages: [
    { id: '1', text: 'Hello', createdAt: '2026-01-01T00:00:00Z' },
    { id: '2', text: 'Hi', createdAt: '2026-01-01T00:00:01Z', mine: true }
  ] }));
  const headerAvatar = new Element('span');
  mounted.elements['.pulse-direct-peer'] = headerAvatar;
  mounted.chat.open({ id: 'avatar-peer', peer: { nickName: 'Robin', username: 'robin', firstName: 'Secret', photoUrl: '/private-photo' } });
  await flush();
  assert.equal(headerAvatar.textContent, 'R');
  const [incoming, outgoing] = mounted.elements['.pulse-direct-messages'].children;
  assert.equal(incoming.children.length, 3);
  assert.equal(incoming.children[2].textContent, 'R');
  assert.equal(incoming.children[2].attributes['aria-hidden'], 'true');
  assert.equal(incoming.children[2].className, 'pulse-person-mark pulse-direct-message-avatar');
  assert.equal(outgoing.children.length, 2, 'outgoing messages have no duplicated participant avatar');
  assert.equal(incoming.children.some(child => child.tagName === 'img'), false, 'private profile photos are not requested');
  mounted.chat.closeView();
  assert.equal(headerAvatar.textContent, '');
  assert.equal(mounted.elements['.pulse-direct-title'].textContent, 'Chat');
  assert.equal(mounted.elements['.pulse-direct-handle'].textContent, '');
  mounted.chat.open({ id: 'handle-peer', peer: { username: 'sparrow', firstName: 'Secret' } });
  await flush();
  assert.equal(headerAvatar.textContent, 'S');
  assert.equal(mounted.elements['.pulse-direct-title'].textContent, '@sparrow');
  assert.equal(mounted.elements['.pulse-direct-messages'].children[0].children[2].textContent, 'S');
});
