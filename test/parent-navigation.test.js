import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../parent-navigation.js', import.meta.url), 'utf8');
function harness() {
  const events = {}, keys = {}, entries = [{ state: null, url: 'https://example.test/#pulse' }];
  let index = 0;
  const root = {
    location: { href: entries[0].url },
    document: { designMode: 'off', addEventListener: (type, fn) => { keys[type] = fn; } },
    addEventListener: (type, fn) => { events[type] = fn; },
    history: {
      get state() { return entries[index].state; },
      pushState(state, _title, url) { entries.splice(index + 1); entries.push({ state, url }); index++; root.location.href = url; },
      replaceState(state, _title, url) { entries[index] = { state, url }; root.location.href = url; },
      back() { if (index > 0) { index--; root.location.href = entries[index].url; events.popstate({ state: entries[index].state }); } }
    }
  };
  vm.runInNewContext(source, { window: root, Date, Math });
  const key = (target = {}, extras = {}) => {
    let prevented = false;
    keys.keydown({ key: 'Backspace', target, preventDefault: () => { prevented = true; }, ...extras });
    return prevented;
  };
  return { root, nav: root.StemmaParentNavigation, key, entries };
}
test('browser back and visible back close one child at a time', () => {
  const { nav, root } = harness(), closed = [];
  nav.enter('search', () => closed.push('search'));
  nav.enter('chat', () => closed.push('chat'));
  root.history.back();
  assert.deepEqual(closed, ['chat']); assert.equal(nav.current(), 'search');
  assert.equal(nav.back('search'), true); assert.deepEqual(closed, ['chat', 'search']);
  assert.equal(nav.back(), false);
});
test('Backspace returns to parent outside editable controls, not at root', () => {
  const { nav, key } = harness(); let closed = 0;
  assert.equal(key(), false);
  nav.enter('chat', () => closed++);
  assert.equal(key({ tagName: 'BUTTON' }), true); assert.equal(closed, 1);
  assert.equal(key(), false);
});
test('normal input, textarea, select, contenteditable, shadow editor and composition are untouched', () => {
  const { nav, key, root } = harness(); let closed = 0;
  nav.enter('chat', () => closed++);
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) assert.equal(key({ tagName }), false);
  assert.equal(key({ isContentEditable: true }), false);
  assert.equal(key({ closest: () => ({}) }), false);
  assert.equal(key({}, { composedPath: () => [{ tagName: 'SPAN' }, { isContentEditable: true }] }), false);
  for (const flag of ['isComposing', 'altKey', 'ctrlKey', 'metaKey', 'shiftKey', 'repeat', 'defaultPrevented']) assert.equal(key({}, { [flag]: true }), false);
  root.document.designMode = 'on'; assert.equal(key(), false);
  assert.equal(closed, 0); assert.equal(nav.current(), 'chat');
});
test('abort forgets a detached screen without executing its callback', () => {
  const { nav, root } = harness(); let closed = 0;
  const controller = new AbortController();
  nav.enter('search', () => closed++, { signal: controller.signal });
  controller.abort(); assert.equal(nav.current(), null);
  root.history.back(); assert.equal(closed, 0);
});
test('history contains identifiers only; page state is kept in live callbacks', () => {
  const { nav, entries } = harness();
  nav.enter('notification-detail', () => {}, { url: '#notifications' });
  assert.deepEqual(Object.keys(entries.at(-1).state), ['stemmaChild']);
  nav.reset(); assert.equal(nav.current(), null);
  assert.equal(entries.at(-1).state.stemmaChild, undefined);
});
