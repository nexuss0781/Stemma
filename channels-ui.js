/* Channels are broadcasts: signed-in readers, owner-only publishing. */
(function attachChannels(root) {
  'use strict';
  const api = '/api/pulse/channels';
  const glyph = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
  const node = (tag, cls, value) => { const el = document.createElement(tag); el.className = cls; if (value != null) el.textContent = value; return el; };
  function view() {
    return `<section class="channel-view" aria-label="Channel" hidden>
      <header class="channel-header"><button type="button" class="group-back" data-channel-back aria-label="Back to Pulse">${glyph('arrow-right')}</button><span class="pulse-person-mark" aria-hidden="true">${glyph('pulse-channel')}</span><div><h2 data-channel-name tabindex="-1"></h2><p data-channel-role>Channel · Only the owner can post</p></div></header>
      <p class="channel-status" data-channel-status role="status" aria-live="polite"></p>
      <div class="channel-history" tabindex="0" role="region" aria-label="Channel posts"><button type="button" class="pulse-load-older" data-channel-older hidden>Load earlier posts</button><div data-channel-posts role="list" aria-label="Posts"></div></div>
      <p class="channel-read-only" data-channel-read-only hidden>Read only · Only the channel owner can publish posts.</p>
      <form class="channel-compose" hidden><label class="visually-hidden" for="channel-post-input">Channel post</label><textarea id="channel-post-input" rows="2" maxlength="4000" placeholder="Write a post…" required disabled></textarea><button type="submit" aria-label="Publish post" disabled>${glyph('arrow-up-right')}</button></form>
    </section>
    <dialog class="group-dialog channel-dialog" aria-labelledby="channel-create-title"><form class="group-dialog-card" data-channel-form><header class="group-create-header"><div><p class="groups-eyebrow">Pulse</p><h2 id="channel-create-title">New Channel</h2></div><button type="button" data-channel-cancel class="group-dialog-close" aria-label="Close new channel">×</button></header><p class="channel-create-copy">You publish posts. Other signed-in users can read them in Pulse.</p><label class="group-name-field">Channel name<input name="name" maxlength="80" required autocomplete="off" placeholder="Enter channel name"></label><p class="group-dialog-status" data-channel-create-status role="status" aria-live="polite"></p><footer class="group-dialog-actions"><button type="button" data-channel-cancel>Cancel</button><button type="submit" class="groups-primary">Create channel</button></footer></form></dialog>`;
  }
  function mount(shell, { listen, signal }) {
    const view = shell.querySelector('.channel-view'), feed = shell.querySelector('.pulse-feed');
    const dialog = shell.querySelector('.channel-dialog'), createForm = dialog.querySelector('form');
    const status = view.querySelector('[data-channel-status]'), postsTarget = view.querySelector('[data-channel-posts]');
    const history = view.querySelector('.channel-history'), compose = view.querySelector('.channel-compose');
    const input = compose.querySelector('textarea'), publish = compose.querySelector('button'), older = view.querySelector('[data-channel-older]');
    let channels = [], current = null, posts = [], cursor = null, hasMore = false, revision = 0, timer = null, listBusy = false, postsBusy = false, sending = false, creating = false, returnFocus = null;
    async function request(url, options = {}) {
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal, ...options, headers: { Accept: 'application/json', ...options.headers } });
      let data = {}; try { data = await response.json(); } catch {}
      if (!response.ok) throw new Error(data.error || 'Could not connect. Please try again.');
      return data;
    }
    function paintRows(message = '') {
      for (const list of shell.querySelectorAll('[data-channel-lists]')) {
        list.replaceChildren();
        for (const channel of channels) {
          const row = node('button', 'pulse-conversation pulse-direct-row pulse-channel-row'); row.type = 'button'; row.dataset.channelOpen = channel.id;
          row.dataset.pulseActivity = channel.lastPost?.createdAt || channel.updatedAt || channel.createdAt || '';
          const avatar = node('span', 'pulse-person-mark'); avatar.setAttribute('aria-hidden', 'true'); avatar.innerHTML = glyph('pulse-channel');
          const copy = node('span', 'pulse-copy'); copy.append(node('strong', '', channel.name), node('span', '', channel.lastPost?.text || (channel.isOwner ? 'Your channel · No posts yet' : 'Channel · No posts yet')));
          const meta = node('span', 'pulse-direct-meta');
          if (row.dataset.pulseActivity) { const time = node('time', '', new Date(row.dataset.pulseActivity).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })); time.dateTime = row.dataset.pulseActivity; meta.append(time); }
          row.append(avatar, copy, meta); list.append(row);
        }
        if (!channels.length) list.append(node('p', 'pulse-list-empty', message || 'No channels yet. Create a channel to publish posts.'));
      }
      shell.dispatchEvent(new Event('pulse:channels-updated'));
    }
    async function loadChannels() {
      if (listBusy || signal.aborted) return;
      listBusy = true;
      try { const data = await request(api); if (!signal.aborted) { channels = data.channels || []; paintRows(); } }
      catch (error) { if (!signal.aborted) paintRows(error.message); }
      finally { listBusy = false; }
    }
    function paintPosts(scrollBottom = false) {
      const beforeHeight = history.scrollHeight, beforeTop = history.scrollTop;
      postsTarget.replaceChildren();
      for (const post of posts) {
        const article = node('article', 'channel-post'); article.setAttribute('role', 'listitem'); article.dataset.channelPost = post.id;
        const time = node('time', '', new Date(post.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })); time.dateTime = post.createdAt;
        article.append(node('p', '', post.text), time); postsTarget.append(article);
      }
      if (!posts.length) postsTarget.append(node('p', 'channel-empty', current?.isOwner ? 'Publish the first post in your channel.' : 'No posts yet. Posts from the owner will appear here.'));
      older.hidden = !hasMore;
      history.scrollTop = scrollBottom ? history.scrollHeight : beforeTop + (history.scrollHeight - beforeHeight);
    }
    async function loadPosts(earlier = false) {
      if (!current || postsBusy || signal.aborted) return;
      postsBusy = true; older.disabled = true;
      const id = current.id, version = revision;
      const nearBottom = history.scrollHeight - history.scrollTop - history.clientHeight < 90;
      try {
        const data = await request(`${api}/${encodeURIComponent(id)}/posts${earlier && cursor ? `?before=${encodeURIComponent(cursor)}` : ''}`);
        if (signal.aborted || version !== revision) return;
        const incoming = data.posts || [];
        const unique = new Map([...posts, ...incoming].map(post => [String(post.id), post]));
        posts = [...unique.values()].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
        if (earlier || !cursor) { cursor = data.nextBefore || null; hasMore = Boolean(data.hasMore); }
        paintPosts(!earlier && nearBottom); status.textContent = '';
      } catch (error) { if (!signal.aborted && version === revision) status.textContent = error.message; }
      finally { if (version === revision) { postsBusy = false; older.disabled = false; } }
    }
    function back(restoring = false) {
      if (!restoring && root.StemmaParentNavigation?.back('pulse-channel')) return;
      revision++; current = null; postsBusy = false; posts = []; postsTarget.replaceChildren(); input.value = ''; compose.hidden = true; input.disabled = publish.disabled = true; view.hidden = true; feed.hidden = false; feed.inert = false;
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
      void loadChannels();
    }
    async function open(id, trigger) {
      const version = ++revision; current = null; postsBusy = false; posts = []; cursor = null; hasMore = false;
      returnFocus = trigger || shell.querySelector('[aria-selected="true"][data-pulse-tab]');
      root.StemmaParentNavigation?.enter('pulse-channel', () => back(true), { signal });
      feed.hidden = true; feed.inert = true; view.hidden = false; compose.hidden = true; input.value = ''; input.disabled = publish.disabled = true; postsTarget.replaceChildren(); older.hidden = true;
      view.querySelector('[data-channel-read-only]').hidden = true; view.querySelector('[data-channel-name]').textContent = ''; status.textContent = 'Opening channel…';
      try {
        const data = await request(`${api}/${encodeURIComponent(id)}`);
        if (signal.aborted || version !== revision) return;
        current = data.channel; view.querySelector('[data-channel-name]').textContent = current.name;
        view.querySelector('[data-channel-role]').textContent = current.isOwner ? 'Your channel · Only you can post' : 'Channel · Only the owner can post';
        compose.hidden = !current.isOwner; input.disabled = publish.disabled = !current.isOwner;
        view.querySelector('[data-channel-read-only]').hidden = current.isOwner;
        view.querySelector('[data-channel-name]').focus({ preventScroll: true }); await loadPosts();
      } catch (error) { if (!signal.aborted && version === revision) status.textContent = error.message; }
    }
    function openCreate() {
      if (creating) return;
      createForm.reset(); createForm.querySelector('[data-channel-create-status]').textContent = '';
      shell.classList.remove('is-create-open'); shell.querySelector('.pulse-create-affordance')?.setAttribute('aria-expanded', 'false');
      const menu = shell.querySelector('#pulse-create-previews'); menu.inert = true; menu.setAttribute('aria-hidden', 'true');
      root.StemmaParentNavigation?.enter('pulse-channel-create', () => { if (!creating) dialog.close(); }, { signal }); dialog.showModal(); createForm.elements.name.focus();
    }
    listen(shell, 'click', event => {
      const row = event.target.closest('[data-channel-open]'); if (row) void open(row.dataset.channelOpen, row);
      if (event.target.closest('[data-channel-create]')) openCreate();
      if (event.target.closest('[data-channel-back]')) back();
      if (event.target.closest('[data-channel-cancel]') && !creating) dialog.close();
    });
    listen(dialog, 'close', () => root.StemmaParentNavigation?.forget('pulse-channel-create'));
    listen(dialog, 'cancel', event => { if (creating) event.preventDefault(); });
    listen(createForm, 'submit', async event => {
      event.preventDefault(); if (creating) return;
      const name = createForm.elements.name.value.trim(); if (!name) { createForm.elements.name.focus(); return; }
      creating = true; const button = createForm.querySelector('[type="submit"]'); button.disabled = true;
      try { const data = await request(api, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }); if (!signal.aborted) { dialog.close(); await loadChannels(); await open(data.channel.id); } }
      catch (error) { if (!signal.aborted) createForm.querySelector('[data-channel-create-status]').textContent = error.message; }
      finally { creating = false; button.disabled = false; }
    });
    listen(older, 'click', () => loadPosts(true));
    listen(compose, 'submit', async event => {
      event.preventDefault(); if (!current?.isOwner || sending) return;
      const text = input.value.trim(); if (!text) return;
      const id = current.id, version = revision; sending = true; publish.disabled = true; input.readOnly = true;
      try {
        const data = await request(`${api}/${encodeURIComponent(id)}/posts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
        if (signal.aborted || version !== revision) return;
        if (!posts.some(post => post.id === data.post.id)) posts.push(data.post);
        input.value = ''; paintPosts(true); status.textContent = 'Post published.'; void loadChannels();
      } catch (error) { if (!signal.aborted && version === revision) status.textContent = error.message; }
      finally { sending = false; input.readOnly = false; publish.disabled = !current?.isOwner; }
    });
    async function tick() {
      if (signal.aborted) return;
      if (!document.hidden) { await loadChannels(); if (!view.hidden) await loadPosts(); }
      if (!signal.aborted) timer = setTimeout(tick, 8000);
    }
    listen(view, 'keydown', event => { if (event.key === 'Escape' && !event.target.closest('textarea')) { event.preventDefault(); back(); } });
    listen(signal, 'abort', () => { revision++; clearTimeout(timer); dialog.close(); posts = []; channels = []; input.value = ''; });
    void tick();
    return { open, loadChannels };
  }
  root.StemmaChannels = Object.freeze({ view, mount });
})(typeof window !== 'undefined' ? window : globalThis);
