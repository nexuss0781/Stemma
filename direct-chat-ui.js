/* Separately mounted private one-to-one chat view for Pulse. */
(function attachDirectChat(root) {
  'use strict';
  function view() {
    return `<section class="pulse-direct-chat" aria-label="Direct chat" hidden>
      <header class="pulse-direct-header"><button type="button" class="pulse-search-close pulse-direct-back" aria-label="Back to Pulse conversations"><svg class="icon" aria-hidden="true"><use href="#i-arrow-right"></use></svg></button><span class="pulse-person-mark pulse-direct-peer" aria-hidden="true"></span><div class="pulse-direct-identity"><h2 class="pulse-direct-title">Chat</h2><p class="pulse-direct-handle"></p></div><span class="pulse-direct-private">1:1</span></header>
      <div class="pulse-direct-history" tabindex="0" role="region" aria-label="Conversation messages"><button type="button" class="pulse-direct-older" hidden>Load earlier messages</button><div class="pulse-direct-messages" role="list" aria-label="Messages"></div></div>
      <p class="pulse-data-status pulse-direct-status" role="status" aria-live="polite"></p>
      <form class="pulse-saved-compose pulse-direct-compose"><label class="pulse-announcement" for="pulse-direct-text">Message</label><textarea id="pulse-direct-text" rows="1" maxlength="4000" placeholder="Message…" required disabled></textarea><button type="submit" aria-label="Send message" disabled><svg class="icon" aria-hidden="true"><use href="#i-arrow-up-right"></use></svg></button></form>
    </section>`;
  }
  function mount(shell, { listen, signal, onClose }) {
    const panel = shell.querySelector('.pulse-direct-chat');
    if (!panel) return null;
    const back = panel.querySelector('.pulse-direct-back');
    const title = panel.querySelector('.pulse-direct-title');
    const handle = panel.querySelector('.pulse-direct-handle');
    const history = panel.querySelector('.pulse-direct-history');
    const list = panel.querySelector('.pulse-direct-messages');
    const older = panel.querySelector('.pulse-direct-older');
    const status = panel.querySelector('.pulse-direct-status');
    const form = panel.querySelector('form');
    const input = panel.querySelector('textarea');
    const send = form.querySelector('button');
    let conversation = null, messages = [], loading = false, sending = false, hasMore = false, generation = 0;
    function isCurrent(id, revision) {
      return !signal.aborted && generation === revision && conversation && String(conversation.id) === id;
    }
    function node(tag, className, text) {
      const el = root.document.createElement(tag); el.className = className;
      if (text !== undefined) el.textContent = text;
      return el;
    }
    async function request(url, options = {}) {
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal, ...options, headers: { Accept: 'application/json', ...options.headers } });
      let data = {};
      try { data = await response.json(); } catch { /* Use a generic message if the response is not JSON. */ }
      if (response.status === 401) throw new Error('Sign in again to use direct messages.');
      if (!response.ok) { const error = new Error(typeof data.error === 'string' ? data.error : 'Could not connect. Please try again.'); error.status = response.status; throw error; }
      return data;
    }
    function timestamp(value) {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? '' : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    }
    function chronologically(a, b) {
      const dateOrder = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      if (Number.isFinite(dateOrder) && dateOrder) return dateOrder;
      return String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
    }
    function paint() {
      list.replaceChildren();
      for (const message of messages) {
        const item = node('article', `pulse-direct-message${message.mine ? ' is-mine' : ''}`);
        item.setAttribute('role', 'listitem');
        item.append(node('p', '', message.text));
        const date = new Date(message.createdAt);
        const time = node('time', '', Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
        time.setAttribute('title', timestamp(message.createdAt));
        time.setAttribute('aria-label', timestamp(message.createdAt));
        if (message.createdAt) time.dateTime = message.createdAt;
        item.append(time);
        if (!message.mine) {
          // Peer photos remain account-private; use only the public nickname/handle.
          const peer = conversation.peer || conversation;
          const avatar = node('span', 'pulse-person-mark pulse-direct-message-avatar', (peer.nickName || peer.username || '?').trim().slice(0, 1).toUpperCase());
          avatar.setAttribute('aria-hidden', 'true');
          item.append(avatar);
        }
        list.append(item);
      }
    }
    function merge(incoming, { olderPage = false } = {}) {
      const known = new Map(messages.map(message => [String(message.id), message]));
      for (const message of incoming) if (message && message.id != null && typeof message.text === 'string') known.set(String(message.id), message);
      messages = [...known.values()].sort(chronologically);
      if (olderPage) paint();
    }
    async function load({ before = null, initial = false } = {}) {
      if (loading || !conversation || signal.aborted) return;
      const id = String(conversation.id), revision = generation;
      loading = true; older.disabled = true;
      const wasAtBottom = history.scrollHeight - history.scrollTop - history.clientHeight < 48;
      const previousHeight = history.scrollHeight;
      if (initial) { status.textContent = 'Loading messages…'; input.disabled = send.disabled = true; }
      try {
        const suffix = before ? `?before=${encodeURIComponent(before)}` : '';
        const data = await request(`/api/pulse/conversations/${encodeURIComponent(id)}/messages${suffix}`);
        if (!isCurrent(id, revision)) return;
        merge(Array.isArray(data.messages) ? data.messages : []);
        hasMore = Boolean(data.hasMore); older.hidden = !hasMore;
        paint();
        if (initial || wasAtBottom) history.scrollTop = history.scrollHeight;
        else if (before) history.scrollTop = history.scrollHeight - previousHeight;
        input.disabled = false; send.disabled = !input.value.trim();
        status.textContent = messages.length ? '' : 'No messages yet. Say hello.';
      } catch (error) { if (isCurrent(id, revision)) status.textContent = error.message; }
      finally {
        if (isCurrent(id, revision)) { loading = false; older.disabled = false; }
      }
    }
    async function refresh() {
      if (!conversation || panel.hidden || signal.aborted || loading) return;
      const id = String(conversation.id), revision = generation;
      const wasAtBottom = history.scrollHeight - history.scrollTop - history.clientHeight < 48;
      const previousHeight = history.scrollHeight;
      try {
        const data = await request(`/api/pulse/conversations/${encodeURIComponent(id)}/messages`);
        if (!isCurrent(id, revision)) return;
        const oldCount = messages.length;
        merge(Array.isArray(data.messages) ? data.messages : []);
        paint();
        if (wasAtBottom && messages.length > oldCount) history.scrollTop = history.scrollHeight;
        else if (!wasAtBottom) history.scrollTop = history.scrollHeight - previousHeight + history.scrollTop;
        status.textContent = messages.length ? '' : 'No messages yet. Say hello.';
      } catch (error) { if (isCurrent(id, revision)) status.textContent = error.message; }
    }
    function open(next) {
      generation++; loading = false; sending = false;
      conversation = next; messages = []; hasMore = false;
      const peer = next.peer || next;
      title.textContent = peer.nickName || `@${peer.username || ''}`;
      handle.textContent = peer.username ? `@${peer.username}` : '';
      const avatar = panel.querySelector('.pulse-direct-peer');
      if (avatar) avatar.textContent = (peer.nickName || peer.username || '?').trim().slice(0, 1).toUpperCase();
      panel.hidden = false; list.replaceChildren(); older.hidden = true;
      input.value = ''; input.disabled = send.disabled = true; status.textContent = '';
      input.style.height = 'auto';
      back.focus({ preventScroll: true }); void load({ initial: true });
    }
    function closeView() {
      generation++; loading = false; sending = false; conversation = null; messages = []; hasMore = false;
      panel.hidden = true; list.replaceChildren(); older.hidden = true; older.disabled = false;
      input.value = ''; input.disabled = send.disabled = true; status.textContent = '';
      const avatar = panel.querySelector('.pulse-direct-peer');
      if (avatar) avatar.textContent = '';
      title.textContent = 'Chat'; handle.textContent = ''; input.style.height = 'auto';
    }
    listen(back, 'click', () => { closeView(); onClose(); });
    listen(panel, 'keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); closeView(); onClose(); }
    });
    listen(older, 'click', () => {
      if (messages.length && hasMore) void load({ before: messages[0].id });
    });
    listen(input, 'input', () => {
      input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
      send.disabled = sending || !input.value.trim() || input.disabled;
    });
    listen(input, 'keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); }
    });
    listen(form, 'submit', async event => {
      event.preventDefault();
      const value = input.value.trim();
      if (!value || sending || input.disabled || !conversation) return;
      const id = String(conversation.id), revision = generation;
      sending = true; send.disabled = true; status.textContent = 'Sending…';
      try {
        const data = await request(`/api/pulse/conversations/${encodeURIComponent(id)}/messages`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: value })
        });
        if (!isCurrent(id, revision)) return;
        if (data.message) merge([data.message]);
        paint(); if (input.value.trim() === value) input.value = '';
        input.style.height = 'auto'; history.scrollTop = history.scrollHeight; status.textContent = '';
      } catch (error) { if (isCurrent(id, revision)) status.textContent = error.message; }
      finally {
        if (isCurrent(id, revision)) { sending = false; send.disabled = input.disabled || !input.value.trim(); }
      }
    });
    listen(signal, 'abort', closeView);
    return Object.freeze({ open, closeView, refresh, isOpen: () => !panel.hidden });
  }
  root.StemmaDirectChat = Object.freeze({ view, mount });
})(typeof window !== 'undefined' ? window : globalThis);
