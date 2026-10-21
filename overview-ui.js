/* Read-only, account-scoped highlights. No demo balances or invented urgency. */
(function (root) {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const svg = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const endpoints = { notifications: ['/api/notifications', 'notifications'], conversations: ['/api/pulse/conversations', 'conversations'], groups: ['/api/pulse/groups', 'groups'], channels: ['/api/pulse/channels', 'channels'], videos: ['/api/likee/videos', 'videos'] };
  const unread = item => !item.readAt && item.read !== true && (item.readAt === null || item.read === false);
  const clip = value => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  function summary(state, key, empty, populated) {
    const data = state[key];
    if (!data || data.status === 'loading') return { value: 'Checking…', detail: 'Fetching your latest highlights', status: 'loading' };
    if (data.status === 'error') return { value: 'Not connected', detail: 'Could not load. Tap to open or retry above.', status: 'error' };
    if (!data.items.length) return { value: empty, detail: 'A fresh start. Explore when you’re ready.', status: 'empty' };
    return { ...populated(data.items, data.hasMore), status: 'ready' };
  }
  function render(state = {}, options = {}) {
    const auth = options.authenticated === true;
    if (!auth) state = {};
    const profile = auth ? options.profile : null;
    const ready = profile && ['firstName', 'middleName', 'lastName', 'studentId', 'department'].every(k => String(profile[k] || '').trim());
    const n = summary(state, 'notifications', 'All quiet', items => {
      const count = items.filter(unread).length;
      const latest = items.find(unread) || items[0];
      return { value: count ? `${count} unread` : 'You’re caught up', detail: clip(latest.message || latest.title) || 'Open your notifications', count };
    });
    const chats = summary(state, 'conversations', 'Start a conversation', (items, more) => {
      const latest = items.find(item => item.lastMessage) || items[0];
      return { value: `${items.length}${more ? '+' : ''} conversation${items.length === 1 ? '' : 's'}`, detail: latest.lastMessage ? `${latest.nickName || latest.username}: ${clip(latest.lastMessage.text) || 'Shared an attachment'}` : 'Pick up where you left off in Pulse' };
    });
    const groups = summary(state, 'groups', 'Find your people', items => ({ value: `${items.length} group${items.length === 1 ? '' : 's'}`, detail: items.slice(0, 2).map(x => x.name).filter(Boolean).join(' · ') || 'Stay close to your communities' }));
    const channels = summary(state, 'channels', 'Explore channels', items => ({ value: `${items.length} channel${items.length === 1 ? '' : 's'}`, detail: clip(items.find(x => x.lastPost)?.lastPost?.text) || 'Updates from your channels, in one place' }));
    const videos = summary(state, 'videos', 'Make the first moment', items => ({ value: 'A little inspiration', detail: clip(items[0].caption || items[0].text) || 'Discover the latest moments in Likee' }));
    const next = !auth ? { label: 'Make it yours', title: 'Your space starts with you', detail: 'Sign in to bring your profile and highlights together.', action: 'Set up your profile', target: 'profile', icon: 'user' }
      : !ready ? { label: 'Your next step', title: 'Finish your student profile', detail: 'Keep your student details together, ready when you need them.', action: 'Complete profile', target: 'profile', icon: 'user' }
      : n.count ? { label: 'Worth your attention', title: `${n.count} notification${n.count === 1 ? '' : 's'} to catch up on`, detail: n.detail, action: 'See notifications', target: 'notifications', icon: 'bell' }
      : { label: 'Your next step', title: 'A clear view. A calmer day.', detail: 'Catch up, connect with your people, or pick up something new.', action: 'Explore Pulse', target: 'pulse', icon: 'pulse' };
    const cards = [
      { id: 'notifications', category: 'essentials', icon: 'bell', title: 'Notifications', ...n, action: n.count ? 'Catch up' : 'View updates', target: 'notifications' },
      { id: 'conversations', category: 'connect', icon: 'pulse', title: 'Conversations', ...chats, action: 'Open Pulse', target: 'pulse', tab: 1 },
      { id: 'payment', category: 'essentials', icon: 'card', title: 'Payment', value: 'Fees, made clearer', detail: 'Review fees, deposits and history. Payment screens are demo previews.', status: 'demo', action: 'Review payment', target: 'cards', tab: 0 },
      { id: 'groups', category: 'connect', icon: 'pulse-group', title: 'Your groups', ...groups, action: 'Go to groups', target: 'pulse', tab: 2 },
      { id: 'channels', category: 'connect', icon: 'pulse-channel', title: 'Channels', ...channels, action: 'Read updates', target: 'pulse', tab: 3 },
      { id: 'videos', category: 'connect', icon: 'likee', title: 'Likee', ...videos, action: 'Explore moments', target: 'likee' },
      { id: 'profile', category: 'essentials', icon: 'user', title: 'Your profile', value: ready ? 'Your details, together' : 'Make it yours', detail: ready ? [profile.department, profile.studentId && `ID ${profile.studentId}`].filter(Boolean).join(' · ') : 'Add your student details and a photo that feels like you.', action: ready ? 'View profile' : 'Complete profile', target: 'profile', status: ready ? 'ready' : 'empty' }
    ];
    const filter = options.filter || 0;
    const filtered = cards.filter(x => !filter || x.category === (filter === 1 ? 'connect' : 'essentials'));
    const attrs = x => `data-overview-target="${x.target}"${x.tab === undefined ? '' : ` data-overview-tab="${x.tab}"`}`;
    return `<article class="overview-next"><div class="overview-next-icon">${svg(next.icon)}</div><div class="overview-next-copy"><p class="overview-eyebrow">${escape(next.label)}</p><h2>${escape(next.title)}</h2><p>${escape(next.detail)}</p><button type="button" ${attrs(next)}>${escape(next.action)}${svg('arrow-right')}</button></div></article>
      <div class="overview-highlights-heading"><div><h2>${filter === 1 ? 'Stay connected' : filter === 2 ? 'Your essentials' : 'Picked for you'}</h2><p>Small steps. Everything within reach.</p></div><span>${filtered.length} shortcuts</span></div>
      <div class="overview-highlights">${filtered.map(x => `<button type="button" class="overview-quick-card overview-quick-${x.id}" ${attrs(x)} aria-label="${escape(x.action)}"><span class="overview-quick-top"><span class="overview-quick-icon">${svg(x.icon)}</span><span class="overview-quick-tag${x.status === 'error' ? ' is-error' : ''}">${x.status === 'demo' ? 'Demo' : x.status === 'error' ? 'Retry' : x.count ? `${x.count} new` : ''}</span>${svg('arrow-up-right')}</span><span class="overview-quick-title">${escape(x.title)}</span><strong>${escape(auth || ['payment', 'profile'].includes(x.id) ? x.value : 'Sign in to see more')}</strong><span class="overview-quick-description">${escape(auth || ['payment', 'profile'].includes(x.id) ? x.detail : 'Your personal highlights will appear here.')}</span><span class="overview-quick-action">${escape(x.action)}${svg('arrow-right')}</span></button>`).join('')}</div><p class="overview-footnote">Your highlights, not your to-do list. Go at your own pace.</p>`;
  }
  let container = null;
  let current = null;
  let state = {};
  let options = {};
  function paint() {
    if (!container?.isConnected) return;
    const focused = container.contains?.(root.document?.activeElement) ? root.document.activeElement : null;
    const key = focused?.getAttribute('aria-label');
    container.innerHTML = render(state, options);
    if (key) [...container.querySelectorAll('button[aria-label]')].find(x => x.getAttribute('aria-label') === key)?.focus({ preventScroll: true });
  }
  function unmount() { current?.abort(); current = null; container = null; state = {}; }
  function mount(element, nextOptions) {
    unmount(); container = element; options = nextOptions; paint();
    if (!options.authenticated) return;
    const controller = new AbortController(); current = controller;
    for (const [key, [url, property]] of Object.entries(endpoints)) {
      state[key] = { status: 'loading' };
      (async () => {
        const controllerForRequest = new AbortController();
        const timer = setTimeout(() => controllerForRequest.abort(), 12000);
        controller.signal.addEventListener('abort', () => controllerForRequest.abort(), { once: true });
        try {
          const response = await root.fetch(url, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' }, signal: controllerForRequest.signal });
          if (!response.ok) throw new Error('Unavailable');
          const body = await response.json();
          if (!Array.isArray(body[property]) || body.sourceAvailable === false) throw new Error('Unavailable');
          if (current !== controller) return;
          state[key] = { status: 'ready', items: body[property].filter(x => x && typeof x === 'object'), hasMore: body.hasMore === true };
        } catch {
          if (current !== controller) return;
          state[key] = { status: 'error', items: [] };
        } finally {
          clearTimeout(timer);
          if (current === controller) paint();
        }
      })();
    }
  }
  root.StemmaOverview = { render, mount, unmount };
})(typeof window === 'undefined' ? globalThis : window);
