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
      <section class="group-detail" data-group-detail hidden aria-label="Group conversation"><button type="button" class="group-back" data-group-back aria-label="Back to groups">${glyph('arrow-right')}<span>Groups</span></button><header class="group-conversation-header" data-group-conversation-header hidden><button type="button" class="group-conversation-avatar-control" data-group-info aria-label="Open group info"><span class="group-conversation-avatar" data-conversation-avatar aria-hidden="true"></span></button><button type="button" class="group-conversation-title-control" data-group-info><span class="group-conversation-title" data-conversation-name></span></button><button type="button" class="group-info-button" data-group-info aria-label="Group info">Group info</button></header><div class="group-info-panel"><header class="group-detail-header"><span class="group-avatar" data-group-avatar aria-hidden="true"></span><h2 data-group-name tabindex="-1"></h2><p class="group-profile-description" data-group-description></p><div class="group-meta" aria-label="Group details"><span data-group-count></span><span data-group-visibility></span></div><div class="group-actions" data-group-actions></div></header><p class="group-status" data-group-status role="status" aria-live="polite"></p><section class="group-about-card" data-group-link-section hidden><h3>Group link</h3><p class="group-link-copy">Share this group with others.</p><div data-group-link-row class="group-link-row" hidden><a data-group-link target="_blank" rel="noreferrer"></a><button type="button" data-copy-link aria-label="Copy group link">Copy link</button></div></section><section class="group-members-section"><h3>Members <span data-member-count></span></h3><div class="group-members" data-group-members role="list" aria-label="Group members"></div></section><section class="group-settings-section" data-group-settings-section hidden><h3>Settings</h3><p>Manage this group.</p><button type="button" class="group-settings-button" data-group-settings>Group settings</button></section></div><section class="group-chat" data-group-chat hidden><div class="group-chat-heading"><h3>Messages</h3><button type="button" data-group-older hidden>Load older messages</button></div><div class="group-messages" data-group-messages role="log" aria-live="polite" aria-relevant="additions" tabindex="0"></div><form class="group-compose">${root.StemmaChatAttachments?.control() || ''}<label class="visually-hidden" for="group-message-input">Message</label><textarea id="group-message-input" maxlength="4000" rows="1" placeholder="Write a message…" required></textarea><button type="submit" aria-label="Send message">${glyph('arrow-up-right')}</button></form></section></section>
      <dialog class="group-dialog" data-group-dialog aria-labelledby="group-dialog-title"><form method="dialog" class="group-dialog-card" data-group-form>
        <header class="group-create-header"><button type="button" class="group-create-back" data-create-back aria-label="Back">${glyph('arrow-right')}</button><div><p class="groups-eyebrow" data-dialog-eyebrow>New group</p><h2 id="group-dialog-title" data-dialog-title>New Group</h2></div><button class="group-dialog-close" type="button" data-dialog-close aria-label="Close">×</button></header>
        <div data-create-details class="group-create-details">
          <div class="group-photo-field"><button type="button" class="group-photo-upload" data-group-photo-upload aria-label="Upload group image"><span data-group-photo-preview><svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="18" cy="16" r="7"/><path d="M5 38v-4c0-7 5-11 13-11s13 4 13 11v4M31 10a7 7 0 0 1 0 14M35 27c5 1 8 5 8 11"/></svg></span><span class="group-photo-camera"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M8 6l1.5-2h5L16 6h4a1 1 0 0 1 1 1v12H3V7a1 1 0 0 1 1-1z"/><circle cx="12" cy="12.5" r="4"/></svg></span></button><span data-group-photo-caption>Add group photo</span><input type="file" name="avatar" accept="image/png,image/jpeg,image/webp" data-group-photo-input class="visually-hidden" aria-label="Group image file"></div>
          <label class="group-name-field">Group name<input name="name" maxlength="80" required autocomplete="off" placeholder="Enter group name"></label>
          <label>Description<textarea name="description" maxlength="500" rows="2" placeholder="What is this group about?"></textarea><small>A little introduction for your members. Optional.</small></label>
          <fieldset class="group-visibility-options"><legend>Group type</legend><label><input type="radio" name="visibility" value="public" checked><span><strong>Public</strong><small>Anyone can find and join your group.</small></span></label><label><input type="radio" name="visibility" value="private"><span><strong>Private</strong><small>Only people with your invite link can join.</small></span></label></fieldset>
          <div class="group-public-link" data-public-link><label for="group-public-username">Public link</label><div class="group-link-editor"><span>https://Stemma.wasmer.app/</span><input id="group-public-username" name="slug" maxlength="40" required autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="username" aria-describedby="group-link-availability"></div><small id="group-link-availability" data-link-availability role="status" aria-live="polite">Choose a unique username for your group.</small></div>
          <div class="group-private-link" data-private-link hidden><span>Private invite link</span><p data-private-link-preview></p><small>This unique link becomes active when you create the group.</small></div>
        </div>
        <section data-create-members class="group-create-members" hidden aria-label="Select members"><p class="group-members-intro">Choose people to add to your group. You can also start with just you.</p><label class="groups-search-field">${glyph('pulse-search')}<input type="search" data-member-search placeholder="Search users" aria-label="Search users" autocomplete="off"></label><p data-member-selection-count class="group-selection-count" aria-live="polite">No members selected</p><div data-member-selection-chips class="group-selection-chips"></div><p data-candidates-status role="status" class="group-candidates-status"></p><div data-member-candidates class="group-member-candidates" role="group" aria-label="Available users"></div></section>
        <p class="group-dialog-status" data-dialog-status role="status" aria-live="polite"></p><footer class="group-dialog-actions"><button type="button" data-dialog-close>Cancel</button><button type="submit" class="groups-primary group-create-next" aria-label="Next: select members">${glyph('arrow-right')}</button></footer>
      </form></dialog>
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
    let creationStep = 1, avatarDataUrl = null, photoBusy = false, privateToken = '', slugTimer = null, slugRevision = 0, candidatesTimer = null, candidateRevision = 0, dialogRevision = 0, photoRevision = 0, submitting = false;
    const selectedMembers = new Map();
    const detailsStep = form.querySelector('[data-create-details]'), membersStep = form.querySelector('[data-create-members]');
    const availability = form.querySelector('[data-link-availability]'), candidateList = form.querySelector('[data-member-candidates]');
    const cameraMarkup = form.querySelector('[data-group-photo-preview]')?.innerHTML || '';
    function photo(target, item, fallback) {
      target.textContent = fallback;
      if (item?.avatarUrl || item?.photoUrl) { const image = node('img'); image.src = item.avatarUrl || item.photoUrl; image.alt = ''; image.loading = 'lazy'; image.addEventListener?.('error', () => { target.textContent = fallback; }, { once: true }); target.replaceChildren(image); }
    }
    const messageLoads = new Map(), messageSends = new Set();
    const node = text;
    root.StemmaChatAttachments?.mount(detail.querySelector('.group-compose'), {
      listen, signal,
      endpoint: () => current?.isMember && current.id ? `${api}/${encodeURIComponent(current.id)}/attachments` : null,
      status: detail.querySelector('[data-group-status]'),
      ready: () => Boolean(current?.isMember && detail.classList.contains('is-open') && !detail.hidden),
      onMessage: message => {
        if (!message || !current?.isMember || !message.id) return;
        if (!messages.some(item => String(item.id) === String(message.id))) {
          messages.push(message);
          messages.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
          paintMessages({ scroll: 'bottom' });
        }
      }
    });
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
        const avatar = node('span', 'group-list-avatar'); photo(avatar, group, initial(group)); avatar.setAttribute('aria-hidden', 'true');
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
        const avatar = node('span', 'group-member-avatar'); photo(avatar, member, String(name).slice(0, 1).toUpperCase()); row.append(avatar, node('span', 'group-member-name', name));
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
        row.append(who, root.StemmaChatAttachments?.render(message.attachment) || body, time); target.append(row);
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
      photo(detail.querySelector('[data-group-avatar]'), group, initial(group));
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
      photo(detail.querySelector('[data-conversation-avatar]'), group, initial(group));
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
      try { const data = await request(`${api}/invite/${encodeURIComponent(token)}`); if (!signal.aborted) showDetail({ ...data.group, inviteToken: token, inviteUrl: data.group?.inviteUrl || `${location.origin}/private_urls/${encodeURIComponent(token)}` }, data); }
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
    function makeToken() {
      const bytes = new Uint8Array(32); root.crypto.getRandomValues(bytes);
      return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    function visibilityChanged() {
      const isPublic = form.elements.visibility.value === 'public';
      if (!detailsStep) return;
      form.querySelector('[data-public-link]').hidden = !isPublic;
      form.querySelector('[data-private-link]').hidden = isPublic;
      form.elements.slug.required = isPublic;
      if (!isPublic) {
        if (!privateToken) privateToken = makeToken();
        form.querySelector('[data-private-link-preview]').textContent = editing ? (current?.inviteUrl ? new URL(current.inviteUrl, location.origin).href : 'Your private invite link will be available after saving.') : `https://Stemma.wasmer.app/private_urls/${privateToken}`;
      }
      slugRevision++; clearTimeout(slugTimer);
      if (isPublic && form.elements.slug.value) void checkSlug();
    }
    function setCreationStep(step) {
      creationStep = step;
      if (!detailsStep) return;
      detailsStep.hidden = step !== 1; membersStep.hidden = step !== 2; dialog.scrollTop = 0;
      form.querySelector('[data-dialog-title]').textContent = editing ? 'Group settings' : step === 1 ? 'New Group' : 'Add members';
      const submit = form.querySelector('.groups-primary');
      submit.innerHTML = editing ? 'Save changes' : step === 1 ? glyph('arrow-right') : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';
      submit.setAttribute('aria-label', editing ? 'Save changes' : step === 1 ? 'Next: select members' : 'Create group');
      submit.classList.toggle('group-create-next', !editing);
      if (step === 2) { form.querySelector('[data-member-search]').focus?.(); void loadCandidates(); }
    }
    async function checkSlug() {
      if (!availability || form.elements.visibility.value !== 'public') return true;
      const slug = form.elements.slug.value.trim().toLowerCase(), revision = ++slugRevision;
      if (!/^[a-z0-9_-]{3,40}$/.test(slug)) { availability.textContent = 'Use 3–40 letters, numbers, underscores or hyphens.'; availability.dataset.state = 'error'; return false; }
      if (editing && slug === current?.slug) { availability.textContent = 'Your current group link.'; availability.dataset.state = 'available'; return true; }
      availability.textContent = 'Checking username…'; availability.dataset.state = 'checking';
      try {
        const data = await request(`${api}/availability?slug=${encodeURIComponent(slug)}`);
        if (revision !== slugRevision || !dialog.open) return false;
        availability.textContent = data.available ? 'Username is available.' : 'This username is already taken or reserved.';
        availability.dataset.state = data.available ? 'available' : 'error'; return data.available === true;
      } catch (error) { if (revision === slugRevision && dialog.open) { availability.textContent = error.message; availability.dataset.state = 'error'; } return false; }
    }
    function paintSelection() {
      const count = form.querySelector('[data-member-selection-count]'); if (!count) return;
      count.textContent = selectedMembers.size ? `${selectedMembers.size} member${selectedMembers.size === 1 ? '' : 's'} selected` : 'No members selected';
      const chips = form.querySelector('[data-member-selection-chips]'); chips.replaceChildren();
      for (const [username, user] of selectedMembers) { const chip = node('button', 'group-member-chip', `${user.nickName || username} ×`); chip.type = 'button'; chip.dataset.removeMember = username; chip.setAttribute('aria-label', `Remove ${user.nickName || username}`); chips.append(chip); }
      for (const row of candidateList.querySelectorAll('[data-select-member]')) { const checked = selectedMembers.has(row.dataset.selectMember); row.setAttribute('aria-pressed', String(checked)); row.classList.toggle('is-selected', checked); }
    }
    async function loadCandidates() {
      if (!candidateList) return;
      const revision = ++candidateRevision, session = dialogRevision, target = form.querySelector('[data-candidates-status]');
      target.textContent = 'Loading users…';
      try {
        const data = await request(`${api}/candidates?q=${encodeURIComponent(form.querySelector('[data-member-search]').value.trim())}`);
        if (revision !== candidateRevision || session !== dialogRevision || !dialog.open) return;
        candidateList.replaceChildren();
        for (const user of data.users || []) {
          const row = node('button', 'group-candidate'); row.type = 'button'; row.dataset.selectMember = user.username;
          const avatar = node('span', 'group-member-avatar'); photo(avatar, user, String(user.nickName || user.username).slice(0, 1).toUpperCase());
          const copy = node('span', 'group-candidate-copy'); copy.append(node('strong', '', user.nickName || user.username), node('small', '', `@${user.username}`));
          row.append(avatar, copy, node('span', 'group-candidate-tick', '✓')); row.setAttribute('aria-label', `Select ${user.nickName || user.username}`); row._candidate = user; candidateList.append(row);
        }
        target.textContent = data.users?.length ? 'Select people to add.' : 'No users found.'; paintSelection();
      } catch (error) { if (revision === candidateRevision && session === dialogRevision && dialog.open) target.textContent = error.message; }
    }
    async function uploadPhoto(chosenFile) {
      const file = chosenFile?.name ? chosenFile : form.querySelector('[data-group-photo-input]')?.files?.[0]; if (!file) return;
      const revision = dialogRevision, uploadRevision = ++photoRevision; photoBusy = true; dialogStatus.textContent = 'Preparing photo…';
      try {
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) throw new Error('Choose a PNG, JPEG or WebP image under 10 MiB.');
        const objectUrl = URL.createObjectURL(file);
        let blob;
        try { const image = new Image(); image.src = objectUrl; await image.decode(); blob = await root.DeviceProfilePhotoStore.prepare(image); } finally { URL.revokeObjectURL(objectUrl); }
        const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('Could not read this photo.')); reader.readAsDataURL(blob); });
        if (revision !== dialogRevision || uploadRevision !== photoRevision || !dialog.open) return;
        avatarDataUrl = dataUrl; const image = node('img'); image.src = dataUrl; image.alt = 'Selected group photo'; form.querySelector('[data-group-photo-preview]').replaceChildren(image); form.querySelector('[data-group-photo-caption]').textContent = 'Change group photo'; dialogStatus.textContent = '';
      } catch (error) { if (revision === dialogRevision && uploadRevision === photoRevision && dialog.open) dialogStatus.textContent = error.message; }
      finally { if (revision === dialogRevision && uploadRevision === photoRevision) photoBusy = false; }
    }
    function openDialog(group = null) {
      editing = Boolean(group); dialogStatus.textContent = ''; dialogRevision++; submitting = false; photoBusy = false;
      avatarDataUrl = null; privateToken = ''; selectedMembers.clear();
      form.reset(); form.elements.name.value = group?.name || ''; form.elements.slug.value = group?.slug || '';
      form.elements.description.value = group?.description || ''; form.elements.visibility.value = group?.visibility || 'public';
      view.querySelector('[data-dialog-title]').textContent = editing ? 'Group settings' : 'New Group';
      view.querySelector('[data-dialog-eyebrow]').textContent = editing ? 'Manage group' : 'New group';
      form.querySelector('.groups-primary').disabled = false;
      if (detailsStep) {
        const preview = form.querySelector('[data-group-photo-preview]'); preview.innerHTML = cameraMarkup; if (group?.avatarUrl) photo(preview, group, '');
        form.querySelector('[data-group-photo-caption]').textContent = group?.avatarUrl ? 'Change group photo' : 'Add group photo';
        form.querySelector('[data-member-search]').value = ''; candidateList.replaceChildren(); paintSelection();
        availability.textContent = 'Choose a unique username for your group.'; availability.dataset.state = '';
      }
      if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
      setCreationStep(1); visibilityChanged();
      form.elements.name.focus({ preventScroll: true });
    }
    function rememberCreationOrigin() {
      creationReturnState = {
        activeView, focus: document.activeElement,
        visibility: [view, feed, searchView, savedView, listView, detail].filter(Boolean).map(element => [element, element.hidden]),
        scroll: [shell, ...shell.querySelectorAll('*')].map(element => [element, element.scrollTop, element.scrollLeft])
      };
    }
    function closeDialog(restore = true) {
      if (submitting) return;
      dialogRevision++; candidateRevision++; slugRevision++; clearTimeout(slugTimer); clearTimeout(candidatesTimer);
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
      const target = event.target.closest('[data-group-create],[data-group-open],[data-group-back],[data-group-join],[data-group-leave-action],[data-group-message-action],[data-group-info],[data-group-copy-action],[data-copy-link],[data-group-settings],[data-group-older],[data-dialog-close],[data-create-back],[data-group-photo-upload],[data-select-member],[data-remove-member]');
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
      else if (target.matches('[data-create-back]')) { if (creationStep === 2) { setCreationStep(1); dialogStatus.textContent = ''; } else closeDialog(); }
      else if (target.matches('[data-group-photo-upload]')) {
        const revision = dialogRevision;
        root.StemmaChatAttachments?.pickPhoto({ button: target, signal, accept: '.png,.jpg,.jpeg,.webp', ready: () => dialog.open && dialogRevision === revision && !submitting && !photoBusy, onSelect: uploadPhoto });
      }
      else if (target.matches('[data-select-member]')) { const username = target.dataset.selectMember; if (selectedMembers.has(username)) selectedMembers.delete(username); else if (selectedMembers.size < 100) selectedMembers.set(username, target._candidate); else dialogStatus.textContent = 'You can add up to 100 members at once.'; paintSelection(); }
      else if (target.matches('[data-remove-member]')) { selectedMembers.delete(target.dataset.removeMember); paintSelection(); }
    });
    if (detailsStep) {
      listen(form.elements.slug, 'input', () => { slugRevision++; clearTimeout(slugTimer); availability.textContent = 'Checking username…'; availability.dataset.state = 'checking'; slugTimer = setTimeout(checkSlug, 300); });
      for (const radio of form.querySelectorAll('[name="visibility"]')) listen(radio, 'change', visibilityChanged);
      listen(form.querySelector('[data-group-photo-input]'), 'change', uploadPhoto);
      listen(form.querySelector('[data-member-search]'), 'input', () => { candidateRevision++; clearTimeout(candidatesTimer); candidatesTimer = setTimeout(loadCandidates, 220); });
      listen(form.querySelector('[data-member-search]'), 'keydown', event => { if (event.key === 'Enter') { event.preventDefault(); clearTimeout(candidatesTimer); void loadCandidates(); } });
    }
    listen(form, 'submit', async event => {
      event.preventDefault(); if (submitting) return;
      if (photoBusy) { dialogStatus.textContent = 'Please wait for your photo to finish preparing.'; return; }
      const submit = form.querySelector('.groups-primary'), revision = dialogRevision;
      submit.disabled = true;
      if (creationStep === 1) {
        if (!form.elements.name.value.trim()) { dialogStatus.textContent = 'Enter a group name.'; submit.disabled = false; form.elements.name.focus(); return; }
        const valid = await checkSlug();
        if (revision !== dialogRevision || !dialog.open) return;
        if (valid === false) { dialogStatus.textContent = 'Choose an available public username to continue.'; submit.disabled = false; return; }
        if (!editing && detailsStep) { setCreationStep(2); dialogStatus.textContent = ''; submit.disabled = false; return; }
      }
      const payload = { name: form.elements.name.value.trim(), description: form.elements.description.value.trim(), visibility: form.elements.visibility.value };
      if (payload.visibility === 'public' || editing) payload.slug = form.elements.slug.value.trim();
      if (avatarDataUrl) payload.avatarDataUrl = avatarDataUrl;
      if (!editing) { payload.memberUsernames = [...selectedMembers.keys()]; if (payload.visibility === 'private') payload.inviteToken = privateToken; }
      submitting = true; dialogStatus.textContent = editing ? 'Saving…' : 'Creating…';
      try {
        const data = editing ? await request(`${api}/${encodeURIComponent(current.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }) : await request(api, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        submitting = false; closeDialog(false); await loadGroups();
        if (editing) showDetail(data.group, { members, preserveConversation: true }); else openById(data.group.id);
      } catch (error) { submitting = false; if (error.status === 409 && !editing) setCreationStep(1); dialogStatus.textContent = error.message; }
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
    listen(signal, 'abort', () => { clearTimeout(polling); clearTimeout(searchTimer); clearTimeout(slugTimer); clearTimeout(candidatesTimer); dialogRevision++; searchAbort?.abort(); loadAbort?.abort(); });
    void loadGroups();
    const path = decodeURIComponent(location.pathname || '/').replace(/^\/+|\/+$/g, '');
    if (path.startsWith('invite/') || path.startsWith('private_urls/')) { const token = path.slice(path.indexOf('/') + 1); if (token) openInvite(token); }
    else if (path) openPublic(path);
    return { open, openById, search: searchGroups, back };
  }
  root.StemmaGroups = Object.freeze({ view, mount, search: async query => { const response = await fetch(`${api}/search?q=${encodeURIComponent(query)}`, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } }); if (!response.ok) throw new Error('Could not search public groups.'); const data = await response.json(); return Array.isArray(data.groups) ? data.groups : []; } });
})(typeof window !== 'undefined' ? window : globalThis);
