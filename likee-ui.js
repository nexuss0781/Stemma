/* Likee: authenticated short videos, without demo users or invented engagement. */
(function attachLikee(root) {
  'use strict';
  const D = root.document;
  const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const linkPattern = new RegExp(`^Likee video\\n#likee/video/(${UUID})$`, 'i');
  const paths = {
    back: '<path d="m15 18-6-6 6-6"/>', close: '<path d="m6 6 12 12M6 18 18 6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>', check: '<path d="m5 12 4 4L19 6"/>',
    like: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>',
    comments: '<path d="M21 11.5a9 9 0 0 1-9 9 10 10 0 0 1-4-.8L3 21l1.3-4.7a9 9 0 1 1 16.7-4.8Z"/>',
    repost: '<path d="m16 3 4 4-4 4M4 11V9a2 2 0 0 1 2-2h14M8 21l-4-4 4-4m12 0v2a2 2 0 0 1-2 2H4"/>',
    bookmark: '<path d="M6 3h12v19l-6-4-6 4Z"/>',
    share: '<path d="m13 3 9 8-9 8v-5C7 14 4 16 2 20c0-9 4-13 11-13Z"/>',
    sound: '<path d="m11 4-6 5H2v6h3l6 5ZM16 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
    mute: '<path d="m11 4-6 5H2v6h3l6 5ZM17 9l5 6m0-6-5 6"/>',
    play: '<path d="m9 4 13 8-13 8Z"/>'
  };
  function svg(name) { return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.play}</svg>`; }
  function node(tag, cls, text) { const el = D.createElement(tag); if (cls) el.className = cls; if (text !== undefined) el.textContent = text; return el; }
  function button(label, icon, cls = '') { const b = node('button', cls); b.type = 'button'; b.setAttribute('aria-label', label); b.innerHTML = svg(icon); return b; }
  async function api(path, body) {
    const response = await root.fetch(`/api/likee${path}`, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    let data = {}; try { data = await response.json(); } catch { /* No HTML server details in the UI. */ }
    if (!response.ok) throw new Error(response.status === 401 ? 'Sign in to discover Likee.' : data.error || 'Could not connect. Please try again.');
    return data;
  }
  let screen, feed, status, sheet, observer, originFocus, videos = [], muted = true, generation = 0, activeId = null;
  function announce(text) { if (status) status.textContent = text; }
  function pauseAll() { screen?.querySelectorAll('video').forEach(v => v.pause()); }
  function closeSheet() {
    if (!sheet) return;
    const old = sheet; sheet = null; old.classList.remove('is-open');
    if (feed) feed.inert = false;
    const focus = old.returnFocus;
    root.setTimeout(() => old.remove(), root.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 220);
    focus?.focus({ preventScroll: true });
    if (!D.hidden && screen) { const active = [...feed.children].find(el => el.dataset.videoId === activeId); active?.querySelector('video')?.play().catch(() => {}); }
  }
  function close(silent = false) {
    generation++; closeSheet(); pauseAll(); observer?.disconnect(); screen?.remove(); screen = null;
    if (!silent) {
      root.dispatchEvent(new root.CustomEvent('stemma:likee-back'));
      originFocus?.focus?.({ preventScroll: true });
    }
  }
  function sheetView(title) {
    closeSheet(); pauseAll();
    const overlay = node('div', 'likee-sheet-overlay'); overlay.returnFocus = D.activeElement;
    const modal = node('section', 'likee-sheet'); modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-label', title); modal.tabIndex = -1;
    const grab = node('span', 'likee-sheet-grab'); grab.setAttribute('aria-hidden', 'true');
    const header = node('header', 'likee-sheet-header'); const heading = node('h2', '', title); const exit = button(`Close ${title.toLowerCase()}`, 'close'); exit.onclick = closeSheet; header.append(heading, exit);
    const content = node('div', 'likee-sheet-content'); overlay.append(modal); modal.append(grab, header, content); overlay.addEventListener('click', e => { if (e.target === overlay) closeSheet(); });
    screen.append(overlay); sheet = overlay; feed.inert = true;
    root.requestAnimationFrame(() => { overlay.classList.add('is-open'); modal.focus(); });
    return { content, modal, overlay };
  }
  function avatar(name, url, cls = '') {
    const el = node('span', `likee-avatar ${cls}`, (name || '?').trim().slice(0, 1).toUpperCase());
    if (typeof url === 'string' && /^\/api\/(?:likee\/videos\/[^/]+\/avatar|likee\/conversations\/\d+\/avatar|pulse\/conversations\/\d+\/peer-photo)$/.test(url)) {
      const image = node('img'); image.alt = ''; image.src = url; image.referrerPolicy = 'no-referrer'; image.onerror = () => image.remove(); el.append(image);
    }
    return el;
  }
  async function share(video) {
    const { content, modal, overlay } = sheetView('Send to');
    const hint = node('p', 'likee-sheet-hint', 'Choose one or more students'); const list = node('div', 'likee-recipients'); const message = node('p', 'likee-sheet-message', 'Loading conversations…'); message.setAttribute('role', 'status');
    const send = node('button', 'likee-send', 'Send'); send.type = 'button'; send.disabled = true; const selected = new Set(); const requestId = root.crypto.randomUUID();
    content.append(hint, list, message); modal.append(send);
    try {
      const data = await api('/recipients'); if (sheet !== overlay) return;
      const recipients = Array.isArray(data.recipients) ? data.recipients : [];
      message.textContent = recipients.length ? '' : 'No conversations yet. Start a private chat in Pulse, then share here.';
      for (const peer of recipients) {
        const row = node('button', 'likee-recipient'); row.type = 'button'; row.setAttribute('aria-pressed', 'false');
        const name = peer.nickName || peer.username; row.setAttribute('aria-label', `Select ${name}`);
        const selection = node('span', 'likee-selection'); selection.innerHTML = svg('check');
        row.append(avatar(name, peer.avatarUrl || `/api/pulse/conversations/${peer.id}/peer-photo`), node('span', 'likee-recipient-name', name), selection);
        row.onclick = () => { if (!selected.has(peer.id) && selected.size >= 25) { message.textContent = 'Select up to 25 chats at once.'; return; } message.textContent = ''; if (selected.has(peer.id)) selected.delete(peer.id); else selected.add(peer.id); row.setAttribute('aria-pressed', String(selected.has(peer.id))); send.disabled = !selected.size; send.textContent = selected.size ? `Send · ${selected.size}` : 'Send'; };
        list.append(row);
      }
      send.onclick = async () => {
        if (!selected.size || send.disabled) return;
        send.disabled = true; list.inert = true; message.textContent = 'Sending…';
        try { await api(`/videos/${video.id}/share`, { conversationIds: [...selected], requestId }); if (sheet === overlay) { closeSheet(); announce('Video sent to your selected chats.'); } }
        catch (error) { message.textContent = error.message; list.inert = false; send.disabled = false; }
      };
    } catch (error) { if (sheet === overlay) message.textContent = error.message; }
  }
  async function comments(video, count) {
    const { content, modal, overlay } = sheetView('Comments');
    const list = node('div', 'likee-comments'); const message = node('p', 'likee-sheet-message', 'Loading comments…'); message.setAttribute('role', 'status');
    const form = node('form', 'likee-comment-form'); const input = node('input'); input.placeholder = 'Add a comment…'; input.setAttribute('aria-label', 'Add a comment'); input.maxLength = 1000; input.required = true;
    const send = node('button', '', 'Post'); send.type = 'submit'; form.append(input, send); content.append(list, message); modal.append(form);
    function append(comment) { const row = node('article', 'likee-comment'); row.append(node('strong', '', comment.nickName || comment.username || (comment.mine ? 'You' : 'Student')), node('p', '', comment.text)); list.append(row); }
    try { const data = await api(`/videos/${video.id}/comments`); if (sheet !== overlay) return; (data.comments || []).forEach(append); message.textContent = list.children.length ? '' : 'Be the first to comment.'; }
    catch (error) { if (sheet === overlay) message.textContent = error.message; }
    form.onsubmit = async e => {
      e.preventDefault(); if (!input.value.trim() || send.disabled) return; const text = input.value.trim(); send.disabled = true;
      try { const data = await api(`/videos/${video.id}/comments`, { text }); if (sheet !== overlay) return; append(data.comment); input.value = ''; message.textContent = ''; video.comments = Number(video.comments || 0) + 1; count.textContent = String(video.comments); }
      catch (error) { message.textContent = error.message; } finally { send.disabled = false; }
    };
  }
  function card(video) {
    const article = node('article', 'likee-video'); article.dataset.videoId = video.id; article.setAttribute('aria-label', `Video by ${video.nickName || 'student'}`);
    const media = node('video', 'likee-media'); media.dataset.src = `/api/likee/videos/${video.id}/media`; media.loop = true; media.muted = muted; media.playsInline = true; media.preload = 'none'; media.setAttribute('playsinline', '');
    media.onclick = () => { if (media.paused) media.play().catch(() => announce('Tap the video to play.')); else media.pause(); };
    media.onerror = () => { const err = node('p', 'likee-media-error', 'This video is unavailable. Swipe to keep exploring.'); if (!article.querySelector('.likee-media-error')) article.append(err); };
    article.append(media, node('div', 'likee-shade'));
    const rail = node('aside', 'likee-actions'); rail.setAttribute('aria-label', 'Video actions');
    const profile = node('div', 'likee-profile'); profile.append(avatar(video.nickName, video.avatarUrl, 'likee-creator'));
    if (!video.mine) {
      const follow = button(video.following ? 'Unfollow creator' : 'Follow creator', video.following ? 'check' : 'plus', 'likee-follow'); follow.setAttribute('aria-pressed', String(Boolean(video.following)));
      follow.onclick = async () => { follow.disabled = true; try { const active = !video.following; await api(`/videos/${video.id}/follow`, { active }); videos.filter(v => v.username === video.username).forEach(v => { v.following = active; }); video.following = active; screen.querySelectorAll(`[data-creator="${CSS.escape(video.username || video.id)}"]`).forEach(b => { b.innerHTML = svg(active ? 'check' : 'plus'); b.setAttribute('aria-label', active ? 'Unfollow creator' : 'Follow creator'); b.setAttribute('aria-pressed', String(active)); }); } catch (error) { announce(error.message); } finally { follow.disabled = false; } };
      follow.dataset.creator = video.username || video.id; profile.append(follow);
    }
    rail.append(profile);
    for (const [action, label, prop, countProp] of [['like', 'Like', 'liked', 'likes'], ['comments', 'Comments', null, 'comments'], ['repost', 'Repost', 'reposted', 'reposts'], ['bookmark', 'Bookmark', 'bookmarked', 'bookmarks'], ['share', 'Share', null, null]]) {
      const control = button(label, action, `likee-action likee-action-${action}`); const counter = node('span', 'likee-count', countProp ? String(Number(video[countProp] || 0)) : 'Share'); control.append(counter);
      if (prop) control.setAttribute('aria-pressed', String(Boolean(video[prop])));
      control.onclick = async () => {
        if (action === 'share') return share(video);
        if (action === 'comments') return comments(video, counter);
        control.disabled = true;
        try { const active = !video[prop]; const data = await api(`/videos/${video.id}/${action}`, { active }); video[prop] = active; const updated = data.video || data; video[countProp] = Number.isFinite(Number(updated[countProp])) ? Number(updated[countProp]) : Math.max(0, Number(video[countProp] || 0) + (active ? 1 : -1)); control.setAttribute('aria-pressed', String(active)); counter.textContent = String(video[countProp]); }
        catch (error) { announce(error.message); } finally { control.disabled = false; }
      };
      rail.append(control);
    }
    const details = node('div', 'likee-details'); details.append(node('strong', 'likee-nickname', video.nickName || video.username || 'Student'));
    if (video.caption) {
      const caption = node('p', 'likee-caption'); const text = node('span', '', video.caption.length > 100 ? `${video.caption.slice(0, 100).trimEnd()}… ` : video.caption); caption.append(text);
      if (video.caption.length > 100) { const more = node('button', 'likee-more', '…more'); more.type = 'button'; more.setAttribute('aria-expanded', 'false'); more.onclick = () => { const expanded = more.getAttribute('aria-expanded') === 'true'; text.textContent = expanded ? `${video.caption.slice(0, 100).trimEnd()}… ` : `${video.caption} `; more.textContent = expanded ? '…more' : 'less'; more.setAttribute('aria-expanded', String(!expanded)); }; caption.append(more); }
      details.append(caption);
    }
    article.append(rail, details); return article;
  }
  async function upload() {
    const { content, modal, overlay } = sheetView('Post a video');
    const form = node('form', 'likee-upload'); const file = node('input'); file.type = 'file'; file.accept = 'video/mp4,video/webm,video/quicktime'; file.required = true; file.setAttribute('aria-label', 'Choose a video, up to 5 MiB');
    const caption = node('textarea'); caption.placeholder = 'A short caption…'; caption.maxLength = 1000; caption.setAttribute('aria-label', 'Video caption'); const hint = node('p', 'likee-sheet-hint', 'MP4, WebM or MOV · up to 5 MiB');
    const send = node('button', 'likee-send', 'Post video'); send.type = 'submit'; const message = node('p', 'likee-sheet-message'); message.setAttribute('role', 'status'); form.append(file, hint, caption, message, send); content.append(form);
    form.onsubmit = async e => {
      e.preventDefault(); const blob = file.files[0]; if (!blob || send.disabled) return;
      if (blob.size > 5 * 1024 * 1024) { message.textContent = 'Choose a video smaller than 5 MiB.'; return; }
      send.disabled = true; message.textContent = 'Posting…';
      try {
        const dataUrl = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(blob); });
        const data = await api('/videos', { caption: caption.value.trim(), mimeType: blob.type, data: dataUrl.split(',')[1] });
        if (sheet !== overlay) return; closeSheet(); await load(data.video?.id); announce('Your video is live.');
      } catch (error) { message.textContent = error.message || 'Could not upload this video.'; send.disabled = false; }
    };
  }
  async function load(id) {
    const revision = ++generation; announce('Loading Likee…');
    try {
      const data = await api('/videos'); if (!screen || revision !== generation) return;
      videos = Array.isArray(data.videos) ? data.videos : [];
      if (id && !videos.some(v => v.id === id)) { const detail = await api(`/videos/${id}`); if (!screen || revision !== generation) return; if (detail.video) videos.unshift(detail.video); }
      observer?.disconnect(); feed.replaceChildren();
      if (!videos.length) {
        const empty = node('div', 'likee-empty'); const mark = node('img', 'likee-empty-mark'); mark.src = '/assets/likee-icon.svg'; mark.alt = '';
        const post = node('button', 'likee-empty-post', 'Post the first video'); post.type = 'button'; post.onclick = upload;
        empty.append(mark, node('h2', '', 'A little spark.\nA new perspective.'), node('p', '', 'Your student videos belong here.\nBe the first to share a moment.'), post); feed.append(empty); announce(''); return;
      }
      observer = new IntersectionObserver(entries => { for (const entry of entries) { const media = entry.target.querySelector('video'); if (entry.isIntersecting && !media.getAttribute('src')) { media.src = media.dataset.src; media.preload = 'metadata'; } if (entry.isIntersecting && entry.intersectionRatio > .6 && !sheet && !D.hidden) { activeId = entry.target.dataset.videoId; media.play().catch(() => {}); } else media.pause(); } }, { root: feed, threshold: [.2, .65] });
      for (const video of videos) { const article = card(video); feed.append(article); observer.observe(article); }
      announce(''); const target = id && [...feed.children].find(el => el.dataset.videoId === id); target?.scrollIntoView({ block: 'start' });
    } catch (error) { if (!screen || revision !== generation) return; announce(error.message); const retry = node('button', 'likee-retry', 'Try again'); retry.type = 'button'; retry.onclick = () => { retry.remove(); void load(id); }; feed.replaceChildren(retry); }
  }
  function open(id, container) {
    if (!container) { root.dispatchEvent(new root.CustomEvent('stemma:likee-open', { detail: { id } })); return; }
    if (screen) { if (id) void load(id); return; }
    generation++; originFocus = D.activeElement;
    screen = node('section', 'likee-screen is-route'); screen.setAttribute('role', 'region'); screen.setAttribute('aria-label', 'Likee video feed');
    const top = node('header', 'likee-header'); const back = button('Back from Likee', 'back'); back.onclick = () => close();
    const brand = node('div', 'likee-brand'); const mark = node('img'); mark.src = '/assets/likee-icon.svg'; mark.alt = ''; const brandCopy = node('div', 'likee-brand-copy'); brandCopy.append(node('h1', '', 'Likee'), node('span', 'likee-brand-caption', 'by Stemma')); brand.append(mark, brandCopy);
    const actions = node('div', 'likee-header-actions'); const sound = button('Unmute videos', 'mute'); sound.onclick = () => { muted = !muted; sound.innerHTML = svg(muted ? 'mute' : 'sound'); sound.setAttribute('aria-label', muted ? 'Unmute videos' : 'Mute videos'); screen.querySelectorAll('video').forEach(v => { v.muted = muted; }); };
    const post = button('Post a video', 'plus'); post.onclick = upload; actions.append(sound, post); top.append(back, brand, actions);
    feed = node('div', 'likee-feed'); feed.tabIndex = 0; feed.setAttribute('aria-label', 'Vertical video feed');
    status = node('p', 'likee-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    screen.append(feed, top, status); container.append(screen);
    screen.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (sheet) closeSheet(); else close(); }
      if (e.key === 'Tab' && sheet) { const owner = sheet; const focusables = [...owner.querySelectorAll('button:not([disabled]), input, textarea, [tabindex="0"]')].filter(el => !el.closest('[inert]') && el.getClientRects().length); const first = focusables[0], last = focusables.at(-1); if (e.shiftKey && D.activeElement === first) { e.preventDefault(); last?.focus(); } else if (!e.shiftKey && D.activeElement === last) { e.preventDefault(); first?.focus(); } }
      if (!sheet && e.target === feed && ['ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); feed.scrollBy({ top: feed.clientHeight * (e.key === 'ArrowDown' ? 1 : -1), behavior: root.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }); }
    });
    back.focus(); void load(id);
  }
  const cache = new Map();
  function renderChatCard(text) {
    const match = typeof text === 'string' && text.match(linkPattern); if (!match) return null;
    const id = match[1]; const link = node('a', 'likee-chat-card'); link.href = `#likee/video/${id}`; link.setAttribute('aria-label', 'Open shared Likee video');
    const thumb = node('span', 'likee-chat-thumb'); thumb.innerHTML = svg('play'); const copy = node('span', 'likee-chat-copy'); copy.append(node('strong', '', 'Likee'), node('span', '', 'Watch video')); link.append(thumb, copy);
    link.onclick = e => { e.preventDefault(); open(id); };
    if (!cache.has(id)) cache.set(id, api(`/videos/${id}`).catch(() => null));
    cache.get(id).then(data => { if (!data?.video) { copy.lastChild.textContent = 'Video unavailable'; return; } const v = node('video'); v.src = `/api/likee/videos/${id}/media#t=0.1`; v.muted = true; v.playsInline = true; v.preload = 'metadata'; v.setAttribute('aria-hidden', 'true'); thumb.prepend(v); copy.lastChild.textContent = data.video.nickName || 'Watch video'; });
    return link;
  }
  D?.addEventListener('visibilitychange', () => { if (D.hidden) pauseAll(); else if (screen && !sheet) { const active = [...feed.children].find(el => el.dataset.videoId === activeId); active?.querySelector('video')?.play().catch(() => {}); } });
  function deepLink() { const match = root.location.hash.match(new RegExp(`^#likee(?:/video/(${UUID}))?$`, 'i')); if (match && screen && match[1]) void load(match[1]); else if (!match && screen) close(true); }
  root.addEventListener?.('hashchange', deepLink);
  root.StemmaLikee = Object.freeze({ open, close, renderChatCard, mount: (container, id) => open(id, container), unmount: () => close(true), showVideo: id => { if (screen) void load(id); } });
  if (D?.readyState === 'loading') D.addEventListener('DOMContentLoaded', deepLink, { once: true }); else deepLink();
})(typeof window !== 'undefined' ? window : globalThis);
