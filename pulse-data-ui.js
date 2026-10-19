/* Only public handles and self-owned notes are connected; no peer messaging. */
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
    let searchTimer, searchRequest, sequence = 0, offset = 0, busy = false, notes = [], loading = false;
    let previewRevision = 0;
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
      if (!response.ok) throw new Error('Could not connect. Please try again.');
      return response.json();
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
          const row = node('div', 'pulse-user-result'); row.setAttribute('role', 'listitem');
          const avatar = node('span', 'pulse-person-mark'); avatar.setAttribute('aria-hidden', 'true'); avatar.textContent = (user.nickName || user.username || '?').slice(0, 1).toUpperCase();
          const copy = node('div', 'pulse-copy');
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
    listen(signal, 'abort', () => { resetSearch(); notes = []; items.replaceChildren(); text.value = ''; paintPreview(); });
    // Fetch afresh on every mount; never cache private note content in browser storage.
    const initialPreviewRevision = previewRevision;
    request('/api/pulse/saved').then(data => {
      if (!signal.aborted && previewRevision === initialPreviewRevision) paintPreview(data.messages[0]?.text);
    }).catch(() => { /* Signed-out/offline lists stay blank, never show a fake preview. */ });
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
  }
  root.StemmaPulseData = Object.freeze({ savedView, mount });
})(typeof window !== 'undefined' ? window : globalThis);
