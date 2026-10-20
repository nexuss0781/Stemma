/* Channels are broadcasts: signed-in readers, owner-only publishing. */
(function attachChannels(root) {
  'use strict';
  const api = '/api/pulse/channels';
  const glyph = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
  const node = (tag, cls, value) => { const el = document.createElement(tag); el.className = cls; if (value != null) el.textContent = value; return el; };
  function view() {
    return `<section class="channel-view" aria-label="Channel" hidden>
      <header class="channel-header"><button type="button" class="group-back" data-channel-back aria-label="Back to Pulse">${glyph('arrow-right')}</button><span class="pulse-person-mark channel-avatar" data-channel-avatar aria-hidden="true"></span><div><h2 data-channel-name tabindex="-1"></h2><p data-channel-role>Channel · Only the owner can post</p></div><button type="button" data-channel-leave hidden>Leave</button></header>
      <button type="button" class="channel-pinned" data-channel-pinned hidden></button>
      <p class="channel-status" data-channel-status role="status" aria-live="polite"></p>
      <div class="channel-history" tabindex="0" role="region" aria-label="Channel posts"><button type="button" class="pulse-load-older" data-channel-older hidden>Load earlier posts</button><div data-channel-posts role="list" aria-label="Posts"></div></div>
      <p class="channel-read-only" data-channel-read-only hidden>Read only · Only the channel owner can publish posts.</p>
      <footer class="channel-reader-controls" hidden><button type="button" data-channel-subscribe>Subscribe</button><button type="button" data-channel-mute hidden>Mute</button></footer>
      <form class="channel-compose" hidden><label class="visually-hidden" for="channel-post-input">Channel post</label>${root.StemmaChatAttachments?.control() || ''}<textarea id="channel-post-input" rows="2" maxlength="4000" placeholder="Broadcast…" required disabled></textarea><button type="submit" aria-label="Publish post" disabled>${glyph('arrow-up-right')}</button></form>
    </section>
    <dialog class="group-dialog channel-dialog" aria-labelledby="channel-create-title"><form class="group-dialog-card" data-channel-form><header class="group-create-header"><div><p class="groups-eyebrow">Pulse</p><h2 id="channel-create-title">New Channel</h2></div><button type="button" data-channel-cancel class="group-dialog-close" aria-label="Close new channel">×</button></header><p class="channel-create-copy">You publish posts. Other signed-in users can read them in Pulse.</p><label class="group-name-field">Channel name<input name="name" maxlength="80" required autocomplete="off" placeholder="Enter channel name"></label><p class="group-dialog-status" data-channel-create-status role="status" aria-live="polite"></p><footer class="group-dialog-actions"><button type="button" data-channel-cancel>Cancel</button><button type="submit" class="groups-primary">Create channel</button></footer></form></dialog>`;
  }
  function mount(shell, { listen, signal }) {
    const view = shell.querySelector('.channel-view'), feed = shell.querySelector('.pulse-feed');
    const dialog = shell.querySelector('.channel-dialog'), createForm = dialog.querySelector('form');
    const status = view.querySelector('[data-channel-status]'), postsTarget = view.querySelector('[data-channel-posts]');
    const history = view.querySelector('.channel-history'), compose = view.querySelector('.channel-compose');
    const input = compose.querySelector('textarea'), publish = compose.querySelector('[type="submit"]'), older = view.querySelector('[data-channel-older]');
    let channels = [], current = null, posts = [], cursor = null, hasMore = false, revision = 0, timer = null, listBusy = false, postsBusy = false, sending = false, creating = false, returnFocus = null;
    let portal = null, appInert = false, unreadAfter = null, initialPaint = true, readTimer = null, readPending = false, savedScroll = [], controlBusy = false;
    const pinned = view.querySelector('[data-channel-pinned]'), mute = view.querySelector('[data-channel-mute]'), subscribe = view.querySelector('[data-channel-subscribe]'), leave = view.querySelector('[data-channel-leave]');
    function resizeViewport() { if (portal) { view.style.setProperty('--channel-height', `${root.visualViewport?.height || root.innerHeight}px`); view.style.setProperty('--channel-top', `${root.visualViewport?.offsetTop || 0}px`); } }
    function focusMode(open) {
      const app = document.getElementById('app-shell');
      if (open && !portal) {
        savedScroll = [...shell.querySelectorAll('.pulse-panel, .pulse-feed, .pulse-viewport, .pulse-unified-list')].map(el => [el, el.scrollTop, el.scrollLeft]);
        portal = document.createComment('Channel parent'); view.before(portal); document.body.append(view);
        if (app) { appInert = app.inert; app.inert = true; } document.body.classList.add('stemma-channel-focus'); resizeViewport();
      } else if (!open && portal) {
        portal.replaceWith(view); portal = null; if (app) app.inert = appInert; document.body.classList.remove('stemma-channel-focus');
        for (const [el, top, left] of savedScroll) { el.scrollTop = top; el.scrollLeft = left; }
      }
    }
    if (root.visualViewport) { listen(root.visualViewport, 'resize', resizeViewport); listen(root.visualViewport, 'scroll', resizeViewport); }
    listen(root, 'resize', resizeViewport);
    function paintHeader() {
      if (!current) return;
      view.querySelector('[data-channel-name]').textContent = current.name;
      view.querySelector('[data-channel-role]').textContent = `${Number(current.subscriberCount || 0).toLocaleString()} ${Number(current.subscriberCount || 0) === 1 ? 'subscriber' : 'subscribers'}`;
      const avatar = view.querySelector('[data-channel-avatar]'); avatar.replaceChildren();
      if (current.avatarUrl && /^\/api\//.test(current.avatarUrl)) { const image = node('img', ''); image.src = current.avatarUrl; image.alt = ''; avatar.append(image); }
      else avatar.textContent = [...current.name.trim()].slice(0, 2).join('').toUpperCase();
      const ownerLabel = current.isOwner ? 'Your channel · Only you can post' : 'Read only · Only the channel owner can publish posts.';
      view.querySelector('[data-channel-read-only]').textContent = ownerLabel;
      view.querySelector('.channel-reader-controls').hidden = current.isOwner;
      subscribe.hidden = current.isSubscribed; mute.hidden = !current.isSubscribed; leave.hidden = current.isOwner || !current.isSubscribed;
      mute.textContent = current.muted ? 'Unmute' : 'Mute'; mute.setAttribute('aria-pressed', String(Boolean(current.muted)));
      pinned.hidden = !current.pinnedPost; pinned.replaceChildren();
      if (current.pinnedPost) { pinned.append(node('strong', '', 'Pinned post'), node('span', '', current.pinnedPost.text)); pinned.dataset.postId = current.pinnedPost.id; }
    }
    async function markVisibleRead() {
      if (!current?.isSubscribed || current.isOwner || document.hidden || readPending) return;
      const box = history.getBoundingClientRect(); let last = null;
      for (const article of postsTarget.querySelectorAll('[data-channel-post]')) { const rect = article.getBoundingClientRect(); if (rect.top < box.bottom && rect.bottom > box.top) last = article.dataset.channelPost; }
      if (!last || (current.lastReadPostId && BigInt(last) <= BigInt(current.lastReadPostId))) return;
      const id = current.id, version = revision; readPending = true;
      try { await request(`${api}/${encodeURIComponent(id)}/read`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ postId: last }) }); if (version === revision) current.lastReadPostId = last; } catch {} finally { readPending = false; }
    }
    function scheduleRead() { clearTimeout(readTimer); readTimer = setTimeout(markVisibleRead, 650); }
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
    function paintPosts(scrollBottom = false, earlier = false) {
      const beforeHeight = history.scrollHeight, beforeTop = history.scrollTop;
      postsTarget.replaceChildren(); let dividerAdded = false;
      for (const post of posts) {
        if (!dividerAdded && unreadAfter !== null && BigInt(post.id) > BigInt(unreadAfter)) {
          const divider = node('div', 'channel-unread', 'Unread posts'); divider.setAttribute('role', 'separator'); postsTarget.append(divider); dividerAdded = true;
        }
        const article = node('article', 'channel-post'); article.setAttribute('role', 'listitem'); article.dataset.channelPost = post.id;
        article.append(node('strong', 'channel-post-author', current?.ownerName || current?.name || 'Channel owner'));
        if (post.attachment) {
          const a = post.attachment;
          if (/^video\/(mp4|webm)$/.test(a.mimeType) && /^\/api\/pulse\/attachments\/[a-f0-9-]{36}$/i.test(a.url)) {
            const video = node('video', 'channel-video'); video.src = a.url; video.controls = true; video.preload = 'metadata'; video.playsInline = true; video.setAttribute('aria-label', a.name); article.append(video);
          } else { const media = root.StemmaChatAttachments?.render(a); if (media) article.append(media); }
        }
        const time = node('time', '', new Date(post.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })); time.dateTime = post.createdAt;
        article.append(node('p', 'channel-caption', post.text), time);
        if (current?.isOwner) { const pin = node('button', 'channel-pin-control', current.pinnedPost?.id === post.id ? 'Unpin' : 'Pin post'); pin.type = 'button'; pin.dataset.channelPin = post.id; pin.setAttribute('aria-label', `${pin.textContent} ${post.id}`); article.append(pin); }
        postsTarget.append(article);
      }
      if (!posts.length) postsTarget.append(node('p', 'channel-empty', current?.isOwner ? 'Publish the first post in your channel.' : 'No posts yet. Posts from the owner will appear here.'));
      older.hidden = !hasMore;
      if (initialPaint) { const divider = postsTarget.querySelector('.channel-unread'); if (divider) history.scrollTop = Math.max(0, divider.offsetTop - 12); else history.scrollTop = history.scrollHeight; initialPaint = false; }
      else history.scrollTop = scrollBottom ? history.scrollHeight : earlier ? beforeTop + history.scrollHeight - beforeHeight : beforeTop;
      scheduleRead();
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
        const changed = initialPaint || incoming.some(post => !posts.some(item => item.id === post.id));
        const unique = new Map([...posts, ...incoming].map(post => [String(post.id), post]));
        posts = [...unique.values()].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
        if (earlier || !cursor) { cursor = data.nextBefore || null; hasMore = Boolean(data.hasMore); }
        if (changed) paintPosts(!earlier && nearBottom, earlier); status.textContent = '';
      } catch (error) { if (!signal.aborted && version === revision) status.textContent = error.message; }
      finally { if (version === revision) { postsBusy = false; older.disabled = false; } }
    }
    function back(restoring = false) {
      if (!restoring && root.StemmaParentNavigation?.back('pulse-channel')) return;
      clearTimeout(readTimer); focusMode(false); revision++; current = null; postsBusy = false; posts = []; postsTarget.replaceChildren(); input.value = ''; compose.hidden = true; input.disabled = publish.disabled = true; view.hidden = true; feed.hidden = false; feed.inert = false;
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
      void loadChannels();
    }
    async function open(id, trigger) {
      const version = ++revision; current = null; unreadAfter = null; initialPaint = true; clearTimeout(readTimer); postsBusy = false; posts = []; cursor = null; hasMore = false;
      returnFocus = trigger || shell.querySelector('[aria-selected="true"][data-pulse-tab]');
      root.StemmaParentNavigation?.enter('pulse-channel', () => back(true), { signal });
      focusMode(true); feed.hidden = true; feed.inert = true; view.hidden = false; compose.hidden = true; input.value = ''; input.disabled = publish.disabled = true; postsTarget.replaceChildren(); older.hidden = true;
      view.querySelector('[data-channel-read-only]').hidden = true; pinned.hidden = true; view.querySelector('.channel-reader-controls').hidden = true; leave.hidden = true; view.querySelector('[data-channel-name]').textContent = ''; status.textContent = 'Opening channel…';
      try {
        const data = await request(`${api}/${encodeURIComponent(id)}`);
        if (signal.aborted || version !== revision) return;
        current = data.channel; unreadAfter = current.isSubscribed && !current.isOwner ? (current.lastReadPostId || '0') : null; paintHeader();
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
      if (event.target.closest('[data-channel-cancel]') && !creating) dialog.close();
    });
    listen(view, 'click', async event => {
      if (event.target.closest('[data-channel-back]')) { back(); return; }
      if (!current || controlBusy) return;
      const pin = event.target.closest('[data-channel-pin]');
      let action = null, body = null;
      if (pin && current.isOwner) { action = 'pin'; body = { postId: current.pinnedPost?.id === pin.dataset.channelPin ? null : pin.dataset.channelPin }; }
      if (event.target.closest('[data-channel-mute]') && current.isSubscribed) { action = 'preferences'; body = { muted: !current.muted }; }
      if (event.target.closest('[data-channel-subscribe]')) { action = 'subscription'; body = { subscribed: true }; }
      if (event.target.closest('[data-channel-leave]')) { action = 'subscription'; body = { subscribed: false }; }
      if (event.target.closest('[data-channel-pinned]')) {
        let article = [...postsTarget.querySelectorAll('[data-channel-post]')].find(el => el.dataset.channelPost === current.pinnedPost?.id);
        let pages = 0; while (!article && hasMore && !postsBusy && current && pages++ < 40) { const previous = cursor; await loadPosts(true); if (cursor === previous) break; article = [...postsTarget.querySelectorAll('[data-channel-post]')].find(el => el.dataset.channelPost === current?.pinnedPost?.id); }
        article?.scrollIntoView({ block: 'start', behavior: 'smooth' }); return;
      }
      if (!action) return;
      const id = current.id, version = revision; controlBusy = true;
      try { await request(`${api}/${encodeURIComponent(id)}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const data = await request(`${api}/${encodeURIComponent(id)}`); if (version !== revision) return; current = data.channel; paintHeader(); if (action === 'pin') paintPosts(); if (action === 'subscription' && !body.subscribed) back();
      } catch (error) { if (version === revision) status.textContent = error.message; } finally { controlBusy = false; }
    });
    listen(history, 'scroll', scheduleRead);
    root.StemmaChatAttachments?.mount(compose, { listen, signal, endpoint: () => current?.isOwner ? `${api}/${encodeURIComponent(current.id)}/attachments` : null, ready: () => Boolean(current?.isOwner && !sending), extraBody: () => input.value.trim() ? { caption: input.value.trim() } : {}, onMessage: post => { if (!current?.isOwner) return; if (!posts.some(item => item.id === post.id)) posts.push(post); input.value = ''; paintPosts(true); void loadChannels(); } });
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
      if (!document.hidden) { await loadChannels(); if (!view.hidden) { await loadPosts(); const id = current?.id, version = revision; if (id) { try { const data = await request(`${api}/${encodeURIComponent(id)}`); if (version === revision) { current = data.channel; paintHeader(); } } catch {} } } }
      if (!signal.aborted) timer = setTimeout(tick, 8000);
    }
    listen(view, 'keydown', event => { if (event.key === 'Escape' && !event.target.closest('textarea')) { event.preventDefault(); back(); } });
    listen(signal, 'abort', () => { focusMode(false); revision++; clearTimeout(timer); clearTimeout(readTimer); dialog.close(); posts = []; channels = []; input.value = ''; });
    void tick();
    return { open, loadChannels };
  }
  root.StemmaChannels = Object.freeze({ view, mount });
})(typeof window !== 'undefined' ? window : globalThis);
