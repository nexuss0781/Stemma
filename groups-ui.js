/* Groups: public discovery, private invite previews, membership, and member chat. */
(function attachGroups(root) {
  'use strict';
  const api = '/api/pulse/groups';
  const text = (tag, cls, value) => { const el = document.createElement(tag); if (cls) el.className = cls; if (value != null) el.textContent = value; return el; };
  const glyph = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
  function view() {
    return `<section class="groups-view" aria-label="Groups" hidden>
      <div class="groups-list-view"><header class="groups-list-heading"><div><p class="groups-eyebrow">Pulse</p><h2>Groups</h2><p>Find your people and keep the conversation going.</p></div><button type="button" class="groups-new-button" data-group-create>＋ <span>New group</span></button></header>
      <p class="groups-status" data-groups-status role="status" aria-live="polite"></p><div class="groups-list" data-groups-list role="list" aria-label="Your groups"></div>
      <section class="groups-discover"><h3>Public groups</h3><p>Search names to find communities to join.</p><form class="groups-discover-form"><label class="groups-search-field">${glyph('pulse-search')}<input data-group-discovery type="search" placeholder="Search public groups" aria-label="Search public groups" autocomplete="off"></label></form><div class="groups-discovery-results" data-groups-results role="list" aria-label="Public group results"></div></section></div>
      <section class="group-detail" data-group-detail hidden aria-label="Group conversation"><button type="button" class="group-back" data-group-back aria-label="Back to groups">${glyph('arrow-right')}<span>Groups</span></button><header class="group-conversation-header" data-group-conversation-header hidden><button type="button" class="group-conversation-avatar-control" data-group-info aria-label="Open group info"><span class="group-conversation-avatar" data-conversation-avatar aria-hidden="true"></span></button><button type="button" class="group-conversation-title-control" data-group-info><span class="group-conversation-title" data-conversation-name></span></button><button type="button" class="group-info-button" data-group-info aria-label="Group info">Group info</button></header><div class="group-info-panel"><header class="group-detail-header"><span class="group-avatar" data-group-avatar aria-hidden="true"></span><h2 data-group-name tabindex="-1"></h2><p class="group-profile-description" data-group-description></p><div class="group-meta" aria-label="Group details"><span data-group-count></span><span data-group-visibility></span></div><div class="group-actions" data-group-actions></div></header><p class="group-status" data-group-status role="status" aria-live="polite"></p><section class="group-about-card" data-group-link-section hidden><h3>Group link</h3><p class="group-link-copy">Share this group with others.</p><div data-group-link-row class="group-link-row" hidden><a data-group-link target="_blank" rel="noreferrer"></a><button type="button" data-copy-link aria-label="Copy group link">Copy link</button></div></section><section class="group-members-section"><h3>Members <span data-member-count></span></h3><div class="group-members" data-group-members role="list" aria-label="Group members"></div></section><section class="group-settings-section" data-group-settings-section hidden><h3>Settings</h3><p>Manage this group.</p><button type="button" class="group-settings-button" data-group-settings>Group settings</button></section></div><section class="group-chat" data-group-chat hidden><div class="group-chat-heading"><h3>Messages</h3><button type="button" data-group-older hidden>Load older messages</button></div><div class="group-messages" data-group-messages role="log" aria-live="polite" aria-relevant="additions" tabindex="0"></div><form class="group-compose"><label class="visually-hidden" for="group-message-input">Message</label><textarea id="group-message-input" maxlength="4000" rows="1" placeholder="Write a message…" required></textarea><button type="submit" aria-label="Send message">${glyph('arrow-up-right')}</button></form></section></section>
      <dialog class="group-dialog" data-group-dialog><form method="dialog" class="group-dialog-card" data-group-form><button class="group-dialog-close" type="button" data-dialog-close aria-label="Close">×</button><p class="groups-eyebrow" data-dialog-eyebrow>New group</p><h2 data-dialog-title>Start a group</h2><label>Group name<input name="name" maxlength="80" required autocomplete="off" placeholder="e.g. Weekend runners"></label><label>Short link<input name="slug" maxlength="48" required autocomplete="off" placeholder="weekend-runners"><small>Used in your group’s public address.</small></label><label>Description<textarea name="description" maxlength="500" rows="3" placeholder="What is this group about?"></textarea></label><label>Visibility<select name="visibility"><option value="public">Public — searchable by anyone</option><option value="private">Private — invite link only</option></select></label><p class="group-dialog-status" data-dialog-status role="status"></p><div class="group-dialog-actions"><button type="button" data-dialog-close>Cancel</button><button type="submit" class="groups-primary">Create group</button></div></form></dialog>
    </section>`;
  }
  function mount(shell, { listen, signal }) {
    const view = shell.querySelector('.groups-view'); if (!view) return { open: () => {} };
    const feed = shell.querySelector('.pulse-feed'), searchView = shell.querySelector('.pulse-search'), savedView = shell.querySelector('.pulse-saved');
    const listView = view.querySelector('.groups-list-view'), detail = view.querySelector('[data-group-detail]');
    const status = view.querySelector('[data-groups-status]'), list = view.querySelector('[data-groups-list]');
    const discovery = view.querySelector('[data-groups-results]'), searchInput = view.querySelector('[data-group-discovery]');
    const dialog = view.querySelector('[data-group-dialog]'), form = view.querySelector('[data-group-form]');
    const dialogStatus = view.querySelector('[data-dialog-status]');
    let groups = [], current = null, members = [], messages = [], pageBefore = null, more = false, polling = null, searchTimer = null, searchAbort = null, loadAbort = null, seq = 0, editing = false, activeView = false, infoReturnFocus = null;
    let creationReturnState = null;
    const messageLoads = new Map(), messageSends = new Set();
    const node = text;
    async function request(url, options = {}, controllerSignal = signal) {
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: controllerSignal, ...options, headers: { Accept: 'application/json', ...options.headers } });
      let data = {}; try { data = await response.json(); } catch {}
      if (!response.ok) { const error = new Error(typeof data.error === 'string' ? data.error : 'Could not connect. Please try again.'); error.status = response.status; throw error; }
      return data;
    }
    const initial = item => String(item?.name || '?').trim().slice(0, 1).toUpperCase() || '?';
    function renderRows(target, items, emptyText, { publicOnly = false } = {}) {
      target.replaceChildren();
      const filtered = publicOnly ? items.filter(group => group.visibility === 'public') : items;
      for (const group of filtered) {
        const row = node('button', 'group-list-row'); row.type = 'button'; row.dataset.groupOpen = group.id; row.dataset.groupSlug = group.slug || '';
        const avatar = node('span', 'group-list-avatar', initial(group)); avatar.setAttribute('aria-hidden', 'true');
        const copy = node('span', 'group-list-copy'); copy.append(node('strong', '', group.name || 'Group'), node('span', '', `${Number(group.memberCount) || 0} members${group.visibility === 'private' ? ' · Private' : ''}`));
        row.append(avatar, copy, node('span', 'group-list-arrow', '›')); target.append(row);
      }
      if (!filtered.length && emptyText) { const empty = node('p', 'groups-empty', emptyText); target.append(empty); }
    }
    async function loadGroups() {
      status.textContent = 'Loading groups…';
      try { const data = await request(api); if (!signal.aborted) { groups = Array.isArray(data.groups) ? data.groups : []; renderRows(list, groups, 'You have not joined any groups yet. Search public groups or start one.'); for (const target of shell.querySelectorAll('[data-group-lists]')) renderRows(target, groups, 'No groups yet — search or start one.'); status.textContent = ''; } }
      catch (error) { if (!signal.aborted) status.textContent = error.message; }
    }
    async function searchGroups(query, externalSignal = signal) {
      const data = await request(`${api}/search?q=${encodeURIComponent(query)}`, {}, externalSignal);
      return Array.isArray(data.groups) ? data.groups : [];
    }
    async function discover() {
      clearTimeout(searchTimer); searchAbort?.abort(); const query = searchInput.value.trim();
      discovery.replaceChildren(); if (!query) return;
      searchAbort = new AbortController(); const controller = searchAbort, revision = ++seq;
      discovery.append(node('p', 'groups-empty', 'Searching…'));
      try { const found = await searchGroups(query, controller.signal); if (signal.aborted || revision !== seq) return; renderRows(discovery, found, 'No public groups found.', { publicOnly: true }); }
      catch (error) { if (!signal.aborted && error.name !== 'AbortError' && revision === seq) { discovery.replaceChildren(node('p', 'groups-empty', error.message)); } }
    }
    function paintMembers() {
      const target = detail.querySelector('[data-group-members]'); target.replaceChildren();
      for (const member of members) {
        const row = node('div', 'group-member-row'); row.setAttribute('role', 'listitem');
        const name = member.nickName || member.nickname || member.username || 'Member';
        row.append(node('span', 'group-member-avatar', String(name).slice(0, 1).toUpperCase()), node('span', 'group-member-name', name));
        if (member.isOwner || member.role === 'owner') row.append(node('span', 'group-owner-tag', 'Owner'));
        target.append(row);
      }
      detail.querySelector('[data-member-count]').textContent = String(members.length || current?.memberCount || 0);
    }
    function paintMessages({ scroll = 'bottom' } = {}) {
      const target = detail.querySelector('[data-group-messages]');
      const oldHeight = target.scrollHeight, oldTop = target.scrollTop;
      const atBottom = oldHeight - oldTop - target.clientHeight < 48;
      target.replaceChildren();
      for (const message of messages) {
        const row = node('article', `group-message${message.mine ? ' is-mine' : ''}`); row.dataset.messageId = String(message.id);
        const who = node('strong', 'group-message-author', message.mine ? 'You' : (message.author?.nickName || message.author?.username || 'Member'));
        const body = node('p', 'group-message-text', message.text || '');
        const time = node('time', 'group-message-time');
        const date = new Date(message.createdAt); if (!Number.isNaN(date.getTime())) { time.dateTime = date.toISOString(); time.textContent = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
        row.append(who, body, time); target.append(row);
      }
      if (scroll === 'bottom' || (scroll === 'preserve' && atBottom)) target.scrollTop = target.scrollHeight;
      else if (scroll === 'anchor') target.scrollTop = oldTop + target.scrollHeight - oldHeight;
      else if (scroll === 'preserve') target.scrollTop = oldTop;
      detail.querySelector('[data-group-older]').hidden = !more;
    }
    async function loadMessages(older = false) {
      const groupId = String(current?.id || '');
      if (!groupId || !current?.isMember) return;
      if (messageLoads.has(groupId)) return;
      const token = {}; messageLoads.set(groupId, token);
      const before = older ? pageBefore : null;
      const priorMore = more;
      try {
        const data = await request(`${api}/${encodeURIComponent(groupId)}/messages${before ? `?before=${encodeURIComponent(before)}` : ''}`);
        if (signal.aborted || !detail.classList.contains('is-open') || String(current?.id) !== groupId) return;
        const received = Array.isArray(data.messages) ? data.messages : [];
        const combined = older ? [...received, ...messages] : [...messages, ...received];
        messages = [...new Map(combined.map(message => [String(message.id), message])).values()].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
        if (older) more = Boolean(data.hasMore);
        else if (!before) more = priorMore || Boolean(data.hasMore);
        pageBefore = messages[0]?.id || pageBefore;
        paintMessages({ scroll: older ? 'anchor' : (before ? 'preserve' : 'bottom') });
      } catch (error) { if (!signal.aborted && String(current?.id) === groupId) detail.querySelector('[data-group-status]').textContent = error.message; }
      finally { if (messageLoads.get(groupId) === token) messageLoads.delete(groupId); }
    }
    function schedulePoll() {
      clearTimeout(polling); polling = null;
      if (signal.aborted || document.hidden || !current?.isMember || detail.hidden || detail.classList.contains('is-info')) return;
      polling = setTimeout(async () => { await loadMessages(false); schedulePoll(); }, 5000);
    }
    function setLink(group) {
      const row = detail.querySelector('[data-group-link-row]'), link = detail.querySelector('[data-group-link]');
      const href = group.visibility === 'private' ? group.inviteUrl : group.publicUrl;
      row.hidden = !href; detail.querySelector('[data-group-link-section]').hidden = !href;
      if (href) { link.href = href; link.textContent = href; }
    }
    function activate() {
      activeView = true; view.hidden = false; feed.hidden = true; if (searchView) searchView.hidden = true; if (savedView) savedView.hidden = true;
    }
    function showDetail(group, payload = {}) {
      activate();
      const preserve = payload.preserveConversation && String(current?.id) === String(group.id);
      const restoreInfo = preserve && detail.classList.contains('is-info'), returnFocus = infoReturnFocus;
      current = group; members = Array.isArray(payload.members) ? payload.members : [];
      root.StemmaParentNavigation?.enter('pulse-group', () => back(true), { signal });
      listView.hidden = true; detail.hidden = false; detail.classList.add('is-open');
      detail.querySelector('[data-group-avatar]').textContent = initial(group);
      detail.querySelector('[data-group-name]').textContent = group.name || 'Group';
      detail.querySelector('[data-group-count]').textContent = `${Number(group.memberCount) || members.length || 0} members`;
      const visibility = group.visibility === 'private' ? 'Private' : group.visibility === 'public' ? 'Public' : '';
      detail.querySelector('[data-group-visibility]').textContent = visibility;
      detail.querySelector('[data-group-visibility]').hidden = !visibility;
      detail.querySelector('[data-group-description]').textContent = group.description || 'No description added yet.';
      detail.querySelector('[data-group-status]').textContent = '';
      detail.classList.toggle('is-member', Boolean(group.isMember)); detail.classList.remove('is-info'); infoReturnFocus = null;
      const backButton = detail.querySelector('[data-group-back]'); backButton.querySelector('span').textContent = 'Groups'; backButton.setAttribute('aria-label', 'Back to groups');
      detail.querySelector('[data-group-conversation-header]').hidden = !group.isMember;
      detail.querySelector('[data-conversation-avatar]').textContent = initial(group);
      detail.querySelector('[data-conversation-name]').textContent = group.name || 'Group';
      setLink(group); paintMembers();
      const actions = detail.querySelector('[data-group-actions]'); actions.replaceChildren();
      const action = (label, key, primary = false) => { const button = node('button', `group-action${primary ? ' group-action-primary' : ''}`, label); button.type = 'button'; button.setAttribute(`data-${key}`, ''); actions.append(button); return button; };
      if (!group.isMember) action('Join group', 'group-join', true); else { action('Message', 'group-message-action', true); action('Copy link', 'group-copy-action'); action('Leave', 'group-leave-action'); }
      detail.querySelector('[data-group-settings]').hidden = !group.isOwner;
      detail.querySelector('[data-group-settings-section]').hidden = !group.isOwner;
      detail.querySelector('[data-group-chat]').hidden = !group.isMember;
      if (!preserve) { messages = []; more = false; pageBefore = null; paintMessages(); }
      if (restoreInfo) { openInfo(returnFocus); return; }
      if (group.isMember) { void loadMessages(); schedulePoll(); }
      else { clearTimeout(polling); }
      (group.isMember ? detail.querySelector('[data-group-info]') : detail.querySelector('[data-group-name]')).focus?.({ preventScroll: true });
    }
    async function openById(id, invite = '') {
      activate(); detail.hidden = false; listView.hidden = true;
      clearTimeout(polling); detail.querySelector('[data-group-status]').textContent = 'Opening group…';
      loadAbort?.abort(); loadAbort = new AbortController();
      try {
        const url = `${api}/${encodeURIComponent(id)}${invite ? `?invite=${encodeURIComponent(invite)}` : ''}`;
        const data = await request(url, {}, loadAbort.signal); if (!signal.aborted) showDetail(data.group, data);
      } catch (error) { if (!signal.aborted && error.name !== 'AbortError') { detail.hidden = false; listView.hidden = true; detail.querySelector('[data-group-status]').textContent = error.message; } }
    }
    async function openPublic(slug) {
      activate();
      clearTimeout(polling);
      try { const data = await request(`${api}/resolve/${encodeURIComponent(slug)}`); if (!signal.aborted) showDetail(data.group, data); }
      catch (error) { if (!signal.aborted) { detail.hidden = false; listView.hidden = true; detail.querySelector('[data-group-status]').textContent = error.message; } }
    }
    async function openInvite(token) {
      activate();
      clearTimeout(polling);
      try { const data = await request(`${api}/invite/${encodeURIComponent(token)}`); if (!signal.aborted) showDetail({ ...data.group, inviteToken: token, inviteUrl: data.group?.inviteUrl || `${location.origin}/invite/${encodeURIComponent(token)}` }, data); }
      catch (error) { if (!signal.aborted) { detail.hidden = false; listView.hidden = true; detail.querySelector('[data-group-status]').textContent = error.message; } }
    }
    function open(group) { if (group?.id) openById(group.id); else if (group?.slug) openPublic(group.slug); }
    function openInfo(trigger) { if (!current?.isMember) return; infoReturnFocus = trigger || detail.querySelector('[data-group-info]'); root.StemmaParentNavigation?.enter('pulse-group-info', () => closeInfo(true), { signal }); clearTimeout(polling); detail.classList.add('is-info'); view.scrollTop = 0; detail.scrollTop = 0; detail.querySelector('[data-group-back] span').textContent = 'Conversation'; detail.querySelector('[data-group-back]').setAttribute('aria-label', 'Back to conversation'); detail.querySelector('[data-group-name]').focus({ preventScroll: true }); }
    function closeInfo(restoring = false) { if (!restoring && root.StemmaParentNavigation?.back('pulse-group-info')) return; detail.classList.remove('is-info'); detail.querySelector('[data-group-back] span').textContent = 'Groups'; detail.querySelector('[data-group-back]').setAttribute('aria-label', 'Back to groups'); const trigger = infoReturnFocus; infoReturnFocus = null; if (trigger?.isConnected) trigger.focus({ preventScroll: true }); schedulePoll(); }
    function back(restoring = false) { if (!restoring && detail.classList.contains('is-info') && current?.isMember) { closeInfo(); return; } if (!restoring && root.StemmaParentNavigation?.back('pulse-group')) return; infoReturnFocus = null; clearTimeout(polling); detail.hidden = true; detail.classList.remove('is-open'); listView.hidden = false; view.hidden = true; activeView = false; feed.hidden = false; current = null; void loadGroups(); }
    async function join() {
      if (!current) return;
      const button = detail.querySelector('[data-group-join]'); if (button) button.disabled = true;
      try { const data = await request(`${api}/${encodeURIComponent(current.id)}/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(current.inviteToken ? { invite: current.inviteToken } : {}) }); showDetail(data.group, { ...data, members: data.members || members }); void loadGroups(); }
      catch (error) { detail.querySelector('[data-group-status]').textContent = error.message; if (button) button.disabled = false; }
    }
    async function leave() {
      if (!current || !root.confirm('Leave this group? You can rejoin later if it is public or you have an invite link.')) return;
      try { await request(`${api}/${encodeURIComponent(current.id)}/leave`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); root.StemmaParentNavigation?.forget('pulse-group-info'); root.StemmaParentNavigation?.forget('pulse-group'); back(true); }
      catch (error) { detail.querySelector('[data-group-status]').textContent = error.message; }
    }
    async function copyLink() {
      const href = current?.visibility === 'private' ? current.inviteUrl : current?.publicUrl;
      if (!href) { detail.querySelector('[data-group-status]').textContent = 'No link is available for this group.'; return; }
      try { await navigator.clipboard.writeText(new URL(href, location.href).href); detail.querySelector('[data-group-status]').textContent = 'Link copied.'; }
      catch { detail.querySelector('[data-group-status]').textContent = new URL(href, location.href).href; }
    }
    function openDialog(group = null) {
      editing = Boolean(group); dialogStatus.textContent = '';
      form.reset(); form.elements.name.value = group?.name || ''; form.elements.slug.value = group?.slug || '';
      form.elements.description.value = group?.description || ''; form.elements.visibility.value = group?.visibility || 'public';
      view.querySelector('[data-dialog-title]').textContent = editing ? 'Group settings' : 'Start a group';
      view.querySelector('[data-dialog-eyebrow]').textContent = editing ? 'Manage group' : 'New group';
      form.querySelector('.groups-primary').textContent = editing ? 'Save changes' : 'Create group';
      if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
      form.elements.name.focus();
    }
    function rememberCreationOrigin() {
      creationReturnState = {
        activeView, focus: document.activeElement,
        visibility: [view, feed, searchView, savedView, listView, detail].filter(Boolean).map(element => [element, element.hidden]),
        scroll: [shell, ...shell.querySelectorAll('*')].map(element => [element, element.scrollTop, element.scrollLeft])
      };
    }
    function closeDialog(restore = true) {
      if (dialog.open && dialog.close) dialog.close(); else dialog.removeAttribute('open');
      const previous = creationReturnState; creationReturnState = null;
      if (!restore || !previous) return;
      activeView = previous.activeView;
      for (const [element, hidden] of previous.visibility) element.hidden = hidden;
      previous.focus?.focus?.({ preventScroll: true });
      for (const [element, top, left] of previous.scroll) { element.scrollTop = top; element.scrollLeft = left; }
    }
    listen(dialog, 'cancel', event => { event.preventDefault(); closeDialog(); });
    listen(dialog, 'keydown', event => { if (event.key === 'Escape') event.stopPropagation(); });
    listen(searchInput, 'input', () => { clearTimeout(searchTimer); searchAbort?.abort(); seq++; searchTimer = setTimeout(discover, 220); });
    listen(shell, 'click', event => {
      const target = event.target.closest('[data-group-create],[data-group-open],[data-group-back],[data-group-join],[data-group-leave-action],[data-group-message-action],[data-group-info],[data-group-copy-action],[data-copy-link],[data-group-settings],[data-group-older],[data-dialog-close]');
      if (!target) return;
      if (target.matches('[data-group-create]')) { rememberCreationOrigin(); activate(); openDialog(); }
      else if (target.matches('[data-group-open]')) { const id = target.dataset.groupOpen; if (/^[1-9]\d{0,18}$/.test(id || '')) void openById(id); }
      else if (target.matches('[data-group-back]')) back();
      else if (target.matches('[data-group-join]')) void join();
      else if (target.matches('[data-group-leave-action]')) void leave();
      else if (target.matches('[data-group-message-action]')) { closeInfo(); detail.querySelector('#group-message-input').focus({ preventScroll: true }); }
      else if (target.matches('[data-group-info]')) openInfo(target);
      else if (target.matches('[data-group-copy-action],[data-copy-link]')) void copyLink();
      else if (target.matches('[data-group-settings]')) openDialog(current);
      else if (target.matches('[data-group-older]')) void loadMessages(true);
      else if (target.matches('[data-dialog-close]')) closeDialog();
    });
    listen(form, 'submit', async event => {
      event.preventDefault(); const payload = { name: form.elements.name.value.trim(), slug: form.elements.slug.value.trim(), description: form.elements.description.value.trim(), visibility: form.elements.visibility.value };
      const submit = form.querySelector('.groups-primary'); submit.disabled = true; dialogStatus.textContent = editing ? 'Saving…' : 'Creating…';
      try {
        const data = editing ? await request(`${api}/${encodeURIComponent(current.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }) : await request(api, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        closeDialog(false); await loadGroups();
        if (editing) showDetail(data.group, { members, preserveConversation: true }); else openById(data.group.id);
      } catch (error) { dialogStatus.textContent = error.message; }
      finally { submit.disabled = false; }
    });
    listen(detail.querySelector('.group-compose'), 'submit', async event => {
      event.preventDefault(); const input = detail.querySelector('#group-message-input'), value = input.value.trim(), groupId = String(current?.id || '');
      if (!value || !groupId || !current?.isMember || messageSends.has(groupId)) return;
      messageSends.add(groupId); const send = event.currentTarget.querySelector('button'); send.disabled = true;
      try {
        const data = await request(`${api}/${encodeURIComponent(groupId)}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: value }) });
        if (signal.aborted || String(current?.id) !== groupId) return;
        if (input.value.trim() === value) input.value = '';
        if (data.message && !messages.some(message => String(message.id) === String(data.message.id))) { messages.push(data.message); messages.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()); paintMessages({ scroll: 'bottom' }); }
      } catch (error) { if (String(current?.id) === groupId) detail.querySelector('[data-group-status]').textContent = error.message; }
      finally { messageSends.delete(groupId); if (send.isConnected) send.disabled = false; }
    });
    listen(document, 'visibilitychange', () => { if (document.hidden) clearTimeout(polling); else schedulePoll(); });
    listen(signal, 'abort', () => { clearTimeout(polling); clearTimeout(searchTimer); searchAbort?.abort(); loadAbort?.abort(); });
    void loadGroups();
    const path = decodeURIComponent(location.pathname || '/').replace(/^\/+|\/+$/g, '');
    if (path.startsWith('invite/')) { const token = path.slice('invite/'.length); if (token) openInvite(token); }
    else if (path) openPublic(path);
    return { open, openById, search: searchGroups, back };
  }
  root.StemmaGroups = Object.freeze({ view, mount, search: async query => { const response = await fetch(`${api}/search?q=${encodeURIComponent(query)}`, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } }); if (!response.ok) throw new Error('Could not search public groups.'); const data = await response.json(); return Array.isArray(data.groups) ? data.groups : []; } });
})(typeof window !== 'undefined' ? window : globalThis);
