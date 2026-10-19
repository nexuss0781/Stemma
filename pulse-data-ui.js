/* Private, account-scoped Pulse data; message content is never persisted locally. */
(function attachPulseData(root) {
  'use strict';
  function savedView() {
    return `<section class="pulse-saved" aria-label="Saved Messages" hidden>
      <header class="pulse-saved-header"><button type="button" class="pulse-search-close pulse-saved-back" aria-label="Back to Pulse"><svg class="icon" aria-hidden="true"><use href="#i-arrow-right"></use></svg></button><div><h2>Saved Messages</h2><p>Only you can see these notes</p></div></header>
      <div class="pulse-saved-history" tabindex="0" role="region" aria-label="Saved notes"><button type="button" class="pulse-load-older" hidden>Load earlier notes</button><div class="pulse-saved-items" role="list" aria-label="Your saved messages"></div></div>
      <p class="pulse-data-status" role="status" aria-live="polite"></p>
      <form class="pulse-saved-compose"><label class="pulse-announcement" for="pulse-saved-text">Message to save</label><textarea id="pulse-saved-text" rows="2" maxlength="4000" placeholder="Save a note…" required disabled></textarea><button type="submit" aria-label="Save message" disabled><svg class="icon" aria-hidden="true"><use href="#i-arrow-up-right"></use></svg></button></form>
    </section>`;
  }
  function mount(shell, { listen, signal, closeSearch }) {
    const feed = shell.querySelector('.pulse-feed');
    const saved = shell.querySelector('.pulse-saved');
    const search = shell.querySelector('.pulse-search');
    const field = shell.querySelector('#pulse-search-input');
    const results = shell.querySelector('.pulse-user-results');
    const recent = [...shell.querySelectorAll('.pulse-search-suggestions, .pulse-search-recent-heading, .pulse-search-recents')];
    const searchStatus = shell.querySelector('.pulse-user-status');
    const history = saved.querySelector('.pulse-saved-history');
    const items = saved.querySelector('.pulse-saved-items');
    const status = saved.querySelector('.pulse-data-status');
    const form = saved.querySelector('form');
    const text = saved.querySelector('textarea');
    const send = form.querySelector('button');
    const older = saved.querySelector('.pulse-load-older');
    const more = shell.querySelector('.pulse-users-more');
    const announcement = shell.querySelector('.pulse-announcement');
    const conversationLists = [...shell.querySelectorAll('[data-pulse-conversations]')];
    const directView = root.StemmaDirectChat?.mount(shell, { listen, signal, onClose: () => returnToFeed() });
    let searchTimer, searchRequest, sequence = 0, offset = 0, busy = false, notes = [], loading = false;
    let previewRevision = 0, conversations = [], conversationsLoading = false, conversationsState = 'loading';
    let pollTimer = null, pollBusy = false, isDirectOpen = false;
    const previews = [...shell.querySelectorAll('.pulse-saved-preview')];
    function paintPreview(value = '') {
      previewRevision++;
      for (const preview of previews) {
        preview.textContent = value.replace(/\s+/g, ' ').trim();
        preview.hidden = !preview.textContent;
      }
    }
    function node(tag, className, value) { const el = document.createElement(tag); el.className = className; if (value !== undefined) el.textContent = value; return el; }
    async function request(url, options = {}) {
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal, ...options, headers: { Accept: 'application/json', ...options.headers } });
      if (response.status === 401) throw new Error('Sign in to search users and save your messages.');
      let data = {};
      try { data = await response.json(); } catch { /* A non-JSON failure still gets a safe generic message. */ }
      if (!response.ok) { const error = new Error(typeof data.error === 'string' ? data.error : 'Could not connect. Please try again.'); error.status = response.status; throw error; }
      return data;
    }
    function resetSearch() {
      clearTimeout(searchTimer); searchRequest?.abort(); sequence++;
      results.replaceChildren(); searchStatus.textContent = ''; more.hidden = true; offset = 0;
    }
    async function lookup(append = false) {
      clearTimeout(searchTimer); searchRequest?.abort(); searchRequest = new AbortController();
      const controller = searchRequest, revision = ++sequence;
      const query = field.value.trim().replace(/^@/, '');
      const tab = search.querySelector('[aria-selected="true"][data-pulse-search-tab]');
      const supported = !tab || Number(tab.dataset.pulseSearchTab) < 2;
      recent.forEach(el => { el.hidden = Boolean(query); });
      results.hidden = !query; searchStatus.hidden = !query;
      more.hidden = true;
      if (!append) { results.replaceChildren(); offset = 0; }
      if (!query) { searchStatus.textContent = ''; return; }
      if (!supported) { searchStatus.textContent = 'User lookup is available in All and User.'; return; }
      searchStatus.textContent = 'Searching…'; more.disabled = true;
      try {
        const data = await request(`/api/pulse/users?q=${encodeURIComponent(query)}&offset=${offset}`, { signal: controller.signal });
        if (signal.aborted || revision !== sequence || search.hidden) return;
        for (const user of data.users) {
          const row = node('button', 'pulse-user-result'); row.type = 'button'; row.setAttribute('role', 'listitem');
          row.dataset.pulseChatUsername = user.username;
          const avatar = node('span', 'pulse-person-mark'); avatar.setAttribute('aria-hidden', 'true'); avatar.textContent = (user.nickName || user.username || '?').slice(0, 1).toUpperCase();
          const copy = node('span', 'pulse-copy');
          copy.append(node('strong', '', user.nickName || `@${user.username}`));
          if (user.username) copy.append(node('span', '', `@${user.username}`));
          row.append(avatar, copy); results.append(row);
        }
        offset += data.users.length;
        searchStatus.textContent = offset ? '' : 'No users found by username or nickname.';
        more.hidden = !data.hasMore;
      } catch (error) { if (!signal.aborted && revision === sequence && error.name !== 'AbortError') searchStatus.textContent = error.message; }
      finally { if (revision === sequence) more.disabled = false; }
    }
    function initials(conversation) {
      const peer = conversation.peer || conversation;
      const name = peer.nickName || peer.username || '?';
      return String(name).trim().slice(0, 1).toUpperCase() || '?';
    }
    function renderConversations() {
      for (const list of conversationLists) {
        list.replaceChildren();
        for (const conversation of conversations) {
          const row = node('button', 'pulse-conversation pulse-direct-row'); row.type = 'button';
          row.dataset.pulseConversation = conversation.id;
          const avatar = node('span', 'pulse-person-mark pulse-direct-avatar', initials(conversation)); avatar.setAttribute('aria-hidden', 'true');
          const copy = node('span', 'pulse-copy');
          const peer = conversation.peer || conversation;
          copy.append(node('strong', '', peer.nickName || `@${peer.username || ''}`));
          const message = conversation.lastMessage;
          const preview = message ? `${message.mine ? 'You: ' : ''}${String(message.text || '').replace(/\s+/g, ' ').trim()}` : 'No messages yet';
          copy.append(node('span', 'pulse-direct-preview', preview));
          const meta = node('span', 'pulse-direct-meta');
          if (message?.createdAt) {
            const time = node('time', '', shortTime(message.createdAt)); time.dateTime = message.createdAt; meta.append(time);
          }
          row.append(avatar, copy, meta); list.append(row);
        }
        const message = conversations.length ? '' : conversationsState === 'loading' ? 'Loading conversations…' : conversationsState === 'error' ? 'Conversations could not be loaded. Check your connection and try again.' : 'No conversations yet.';
        const empty = node('p', 'pulse-list-empty', message); empty.setAttribute('role', 'status');
        empty.hidden = Boolean(conversations.length); list.append(empty);
      }
    }
    function shortTime(value) {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }
    async function loadConversations() {
      if (conversationsLoading || signal.aborted) return;
      conversationsLoading = true;
      try {
        const data = await request('/api/pulse/conversations');
        if (!signal.aborted && Array.isArray(data.conversations)) { conversations = data.conversations; conversationsState = 'ready'; renderConversations(); }
      } catch (error) {
        if (!signal.aborted) { conversationsState = 'error'; renderConversations(); if (announcement) announcement.textContent = error.message; }
      }
      finally { conversationsLoading = false; }
    }
    function returnToFeed() {
      isDirectOpen = false; if (directView) directView.closeView();
      if (saved) saved.hidden = true;
      if (search) search.hidden = true;
      feed.hidden = false; feed.inert = false;
      schedulePoll();
      shell.querySelector('.pulse-stage.is-current [data-pulse-conversation]')?.focus({ preventScroll: true });
    }
    async function startConversation(username) {
      const normalized = String(username || '').trim().replace(/^@+/, '');
      if (!normalized || signal.aborted || !directView) return;
      if (searchStatus) searchStatus.textContent = `Opening chat with @${normalized}…`;
      try {
        const data = await request('/api/pulse/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: normalized }) });
        if (signal.aborted || !data.conversation) return;
        await loadConversations();
        closeSearch();
        openConversation(data.conversation);
      } catch (error) {
        if (signal.aborted) return;
        // A server-side self-chat rejection is shown as a calm, non-technical explanation.
        if (searchStatus) searchStatus.textContent = error.status === 400 || error.status === 404 ? 'A conversation can’t be started with that account.' : error.message;
      }
    }
    function openConversation(conversation) {
      if (!conversation?.id || !directView) return;
      isDirectOpen = true; clearTimeout(pollTimer);
      closeSearch(); feed.hidden = true; feed.inert = true; if (saved) saved.hidden = true;
      directView.open(conversation);
      schedulePoll();
    }
    listen(results, 'click', event => {
      const result = event.target.closest('[data-pulse-chat-username]');
      if (result) startConversation(result.dataset.pulseChatUsername);
    });
    listen(shell, 'click', event => {
      const row = event.target.closest('[data-pulse-conversation]');
      if (row) {
        const conversation = conversations.find(item => String(item.id) === row.dataset.pulseConversation);
        if (conversation) openConversation(conversation);
      }
    });
    listen(signal, 'abort', () => { resetSearch(); notes = []; items.replaceChildren(); text.value = ''; paintPreview(); clearTimeout(pollTimer); });
    // Fetch afresh on every mount; never cache private note or chat content in browser storage.
    const initialPreviewRevision = previewRevision;
    request('/api/pulse/saved').then(data => {
      if (!signal.aborted && previewRevision === initialPreviewRevision) paintPreview(data.messages[0]?.text);
    }).catch(() => { /* Signed-out/offline lists stay blank, never show a fake preview. */ });
    void loadConversations();
    listen(field, 'input', () => { resetSearch(); searchTimer = setTimeout(() => lookup(), 220); });
    listen(field, 'keydown', event => { if (event.key === 'Enter') { event.preventDefault(); lookup(); } });
    listen(search, 'click', event => { if (event.target.closest('[data-pulse-search-tab]')) lookup(); });
    listen(search, 'keydown', event => {
      if (event.target.closest('[data-pulse-search-tab]') && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) lookup();
    });
    listen(more, 'click', () => lookup(true));
    function paintNotes() {
      items.replaceChildren();
      for (const message of [...notes].reverse()) {
        const item = node('article', 'pulse-saved-message'); item.setAttribute('role', 'listitem');
        item.append(node('p', '', message.text));
        const time = node('time', '', new Date(message.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })); time.dateTime = message.createdAt;
        item.append(time); items.append(item);
      }
    }
    async function loadNotes(append = false) {
      if (loading) return;
      loading = true; older.disabled = true;
      if (!append) { notes = []; paintNotes(); text.disabled = send.disabled = true; status.textContent = 'Loading your notes…'; older.hidden = true; }
      const height = history.scrollHeight, top = history.scrollTop;
      try {
        const before = append && notes.length ? `?before=${encodeURIComponent(notes.at(-1).id)}` : '';
        const data = await request('/api/pulse/saved' + before);
        if (signal.aborted) return;
        notes = append ? [...notes, ...data.messages] : data.messages;
        paintNotes(); paintPreview(notes[0]?.text); older.hidden = !data.hasMore;
        text.disabled = false; send.disabled = !text.value.trim();
        status.textContent = notes.length ? '' : 'Notes, links, reminders—keep them here for yourself.';
        history.scrollTop = append ? top + history.scrollHeight - height : history.scrollHeight;
      } catch (error) { if (!signal.aborted) status.textContent = error.message; }
      finally { loading = false; older.disabled = false; }
    }
    function closeSaved() { saved.hidden = true; feed.hidden = feed.inert = false; shell.querySelector('.pulse-stage.is-current [data-pulse-saved]')?.focus({ preventScroll: true }); }
    listen(shell, 'click', event => {
      if (!event.target.closest('[data-pulse-saved]')) return;
      closeSearch(); feed.hidden = feed.inert = true; saved.hidden = false;
      saved.querySelector('.pulse-saved-back').focus({ preventScroll: true }); loadNotes();
    });
    listen(saved.querySelector('.pulse-saved-back'), 'click', closeSaved);
    listen(saved, 'keydown', event => { if (event.key === 'Escape') { event.preventDefault(); closeSaved(); } });
    listen(older, 'click', () => loadNotes(true));
    listen(text, 'input', () => { send.disabled = busy || !text.value.trim(); });
    listen(form, 'submit', async event => {
      event.preventDefault(); const value = text.value.trim(); if (!value || busy || text.disabled) return;
      busy = true; send.disabled = true; status.textContent = 'Saving…';
      try {
        const data = await request('/api/pulse/saved', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: value }) });
        if (signal.aborted) return;
        notes.unshift(data.message); paintNotes(); paintPreview(data.message.text); if (text.value.trim() === value) text.value = '';
        status.textContent = 'Saved'; history.scrollTop = history.scrollHeight;
      } catch (error) { if (!signal.aborted) status.textContent = error.message; }
      finally { busy = false; send.disabled = !text.value.trim(); }
    });
    function schedulePoll() {
      if (typeof clearTimeout === 'function') clearTimeout(pollTimer); pollTimer = null;
      if (signal.aborted || root.document?.hidden || !root.setTimeout) return;
      pollTimer = root.setTimeout(async () => {
        if (pollBusy || signal.aborted) return;
        pollBusy = true;
        try { if (isDirectOpen) await directView?.refresh(); else await loadConversations(); }
        finally { pollBusy = false; schedulePoll(); }
      }, 5000);
    }
    if (root.document) listen(root.document, 'visibilitychange', () => { if (root.document.hidden) { if (typeof clearTimeout === 'function') clearTimeout(pollTimer); } else schedulePoll(); });
    schedulePoll();
  }
  root.StemmaPulseData = Object.freeze({ savedView, mount });
})(typeof window !== 'undefined' ? window : globalThis);
