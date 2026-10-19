/* In-memory child-screen history. No account, message, or form data enters history. */
(function attachParentNavigation(root) {
  'use strict';
  const FIELD = 'stemmaChild';
  const session = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  let serial = 0, pending = false;
  const stack = [];
  const state = () => root.history.state && typeof root.history.state === 'object' ? root.history.state : {};
  function forget(key) {
    const index = stack.findIndex(entry => entry.key === key);
    if (index < 0) return false;
    const [entry] = stack.splice(index, 1);
    if (state()[FIELD] === entry.id) {
      root.history.replaceState(entry.parentState, '', root.location.href);
    }
    return true;
  }
  function enter(key, close, { signal, url } = {}) {
    if (signal?.aborted || typeof close !== 'function') return false;
    if (stack.some(entry => entry.key === key)) return key;
    const entry = { key, close, id: `${session}:${++serial}`, parentState: { ...state() } };
    root.history.pushState({ ...state(), [FIELD]: entry.id }, '', url || root.location.href);
    stack.push(entry);
    signal?.addEventListener('abort', () => forget(key), { once: true });
    return key;
  }
  function back(key) {
    const entry = stack.at(-1);
    if (!entry || (key && entry.key !== key)) return false;
    if (pending) return true;
    if (state()[FIELD] === entry.id) {
      pending = true;
      root.history.back();
    } else {
      stack.pop();
      entry.close();
    }
    return true;
  }
  function reset() {
    stack.length = 0;
    pending = false;
    const clean = { ...state() }; delete clean[FIELD];
    root.history.replaceState(clean, '', root.location.href);
  }
  function editable(event) {
    if (root.document.designMode === 'on') return true;
    const path = event.composedPath?.() || [event.target];
    return path.some(node => node && (node.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName || '') || node.closest?.('[contenteditable]:not([contenteditable="false"]), [role="textbox"]')));
  }
  root.addEventListener('popstate', event => {
    pending = false;
    const destination = event.state?.[FIELD];
    // A browser Back can traverse more than one child entry (history.go(-n)).
    while (stack.length && stack.at(-1).id !== destination) {
      const entry = stack.pop();
      entry.close();
    }
  });
  root.document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.key !== 'Backspace' || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.repeat || editable(event)) return;
    if (back()) event.preventDefault();
  });
  root.StemmaParentNavigation = Object.freeze({ enter, back, forget, reset, current: () => stack.at(-1)?.key || null });
})(typeof window !== 'undefined' ? window : globalThis);
