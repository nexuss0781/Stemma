/* Real, server-backed Pulse stories. No fabricated identities or offline story fallback. */
(function attachStories(root) {
  'use strict';
  const MAX_BYTES = 5 * 1024 * 1024;
  const MAX_SECONDS = 50;
  const POLL_MS = 30000;
  const RASTER = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
  const VIDEO = new Set(['video/mp4', 'video/quicktime']);
  const esc = value => String(value || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  function stageView(category, stage) {
    if (category !== 'all' && category !== 'user') return '';
    if (stage === 1) return '<div class="pulse-stories pulse-story-rail pulse-story-circles" data-story-stage="1" role="region" aria-label="Active stories"></div>';
    if (stage === 2) return '<div class="pulse-stories pulse-story-rail pulse-story-previews" data-story-stage="2" role="region" aria-label="Story previews"></div>';
    if (stage === 3) return '<div class="pulse-story-grid" data-story-stage="3" role="region" aria-label="Active story grid"></div>';
    return '';
  }
  function mount(shell, { listen, signal } = {}) {
    if (!shell || !listen) return () => {};
    const abort = new AbortController();
    signal?.addEventListener('abort', () => abort.abort(), { once: true });
    const on = (target, type, fn, options = {}) => target.addEventListener(type, fn, { ...options, signal: abort.signal });
    const stages = [...shell.querySelectorAll('[data-story-stage]')];
    const menu = shell.querySelector('#pulse-create-previews');
    if (!stages.length) return () => abort.abort();
    const toBody = document.createElement('div');
    toBody.innerHTML = `<dialog class="stemma-story-dialog stemma-story-viewer" aria-label="Story viewer"><div class="story-viewer-frame"><div class="story-progress" aria-hidden="true"></div><header class="story-viewer-header"><span class="story-viewer-avatar-wrap"><img class="story-owner-avatar" alt=""><span class="story-viewer-avatar-fallback" hidden></span></span><div class="story-owner-copy"><strong class="story-owner-name"></strong><span class="story-owner-time"></span></div><button type="button" class="story-close" aria-label="Close story">×</button></header><div class="story-media"></div><p class="story-description" hidden></p><div class="story-owner-actions" hidden><button type="button" class="story-delete">Delete story</button></div></div></dialog><dialog class="stemma-story-dialog stemma-story-composer" aria-labelledby="story-compose-title"><form class="story-compose-form"><header class="story-compose-header"><button type="button" class="story-compose-close" aria-label="Close story composer">×</button><p class="story-eyebrow">PULSE · NEW STORY</p><h2 id="story-compose-title">Share a story</h2><p class="story-compose-step">Preview your media, then send when you’re ready.</p></header><label class="story-upload-label"><span class="story-upload-icon" aria-hidden="true">＋</span><strong>Choose a photo or video</strong><span>JPEG, PNG, WebP, GIF, MP4 or MOV · up to 5 MiB</span><input type="file" name="media" accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,.jpg,.jpeg,.png,.webp,.gif,.mp4,.mov" required></label><div class="story-compose-preview" hidden></div><div class="story-trim-tools" hidden><div class="story-trim-heading"><strong>Make your story up to 50 seconds</strong><span>Choose a range and preview it above</span></div><label class="story-trim-control">Start <output data-trim-start-label>0:00</output><input type="range" data-trim-start aria-label="Clip start time" min="0" max="1" step="0.1" value="0"></label><label class="story-trim-control">End <output data-trim-end-label>0:49</output><input type="range" data-trim-end aria-label="Clip end time" min="0.1" max="49.5" step="0.1" value="49.5"></label><p class="story-trim-hint">Only the selected section will be sent. Your original video stays on your device.</p></div><label class="story-description-label">Description <span>optional</span><textarea name="description" maxlength="1000" rows="2" placeholder="Add a description"></textarea></label><p class="story-compose-error" role="alert" aria-live="assertive" hidden></p><button class="story-submit" type="submit" disabled>Send story</button><p class="story-expiry-note">Stories are removed after 48 hours.</p></form></dialog>`;
    const viewer = toBody.querySelector('.stemma-story-viewer');
    const composer = toBody.querySelector('.stemma-story-composer');
    document.body.append(toBody);
    const v = { progress: viewer.querySelector('.story-progress'), avatar: viewer.querySelector('.story-owner-avatar'), name: viewer.querySelector('.story-owner-name'), time: viewer.querySelector('.story-owner-time'), close: viewer.querySelector('.story-close'), media: viewer.querySelector('.story-media'), description: viewer.querySelector('.story-description'), actions: viewer.querySelector('.story-owner-actions'), del: viewer.querySelector('.story-delete') };
    const c = { form: composer.querySelector('form'), file: composer.querySelector('[type=file]'), preview: composer.querySelector('.story-compose-preview'), desc: composer.querySelector('textarea'), error: composer.querySelector('.story-compose-error'), submit: composer.querySelector('.story-submit'), trim: composer.querySelector('.story-trim-tools'), start: composer.querySelector('[data-trim-start]'), end: composer.querySelector('[data-trim-end]'), startLabel: composer.querySelector('[data-trim-start-label]'), endLabel: composer.querySelector('[data-trim-end-label]') };
    let stories = [], serverOffset = 0, fetchController = null, pollTimer = 0, expiryTimer = 0, tickTimer = 0, current = null, currentIndex = 0, viewerNav = false, composerNav = false, previewUrl = null, destroyed = false, refreshBusy = false, sourceFile = null, sourceType = '', sourceDuration = 0, trimStart = 0, trimEnd = 0, recorderJob = null;
    const now = () => Date.now() + serverOffset;
    const mediaUrl = story => `/api/pulse/stories/${encodeURIComponent(story.id)}/media`;
    const ownerKey = story => story.mine ? 'mine' : (story.owner?.username ? `user:${story.owner.username}` : `story:${story.id}`);
    const nameOf = story => story.owner?.nickName || story.owner?.username || 'Stemma user';
    const initials = story => nameOf(story).trim().split(/\s+/).slice(0, 2).map(part => part[0] || '').join('').toUpperCase() || '?';
    const visibleStories = () => stories.filter(story => Date.parse(story.expiresAt) > now());
    function safeAvatar(img, story) {
      const url = story.owner?.avatarUrl || `/api/pulse/stories/${encodeURIComponent(story.id)}/avatar`;
      img.src = url; img.hidden = false; const fallback = img.nextElementSibling; if (fallback?.classList.contains('story-avatar-fallback') || fallback?.classList.contains('story-viewer-avatar-fallback')) { fallback.textContent = initials(story); fallback.hidden = true; }
      img.onerror = () => { img.onerror = null; img.hidden = true; if (fallback && (fallback.classList.contains('story-avatar-fallback') || fallback.classList.contains('story-viewer-avatar-fallback'))) fallback.hidden = false; };
    }
    function makeAvatar(story, className = '') {
      const wrap = document.createElement('span'); wrap.className = `story-avatar-wrap ${className}`.trim();
      const img = document.createElement('img'); img.className = 'story-avatar'; img.alt = ''; img.loading = 'lazy'; img.hidden = true;
      const fallback = document.createElement('span'); fallback.className = 'story-avatar-fallback'; fallback.textContent = initials(story); fallback.hidden = true;
      wrap.append(img, fallback); safeAvatar(img, story); return wrap;
    }
    function mediaKind(story) { return String(story.mimeType || '').startsWith('video/') ? 'video' : 'image'; }
    function render() {
      const active = visibleStories();
      const groups = new Map();
      for (const story of active) { const key = ownerKey(story); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(story); }
      for (const group of groups.values()) group.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      for (const stage of stages) {
        stage.replaceChildren();
        const layout = Number(stage.dataset.storyStage);
        if (layout === 1) {
          for (const group of groups.values()) {
            const latest = group[group.length - 1];
            const button = document.createElement('button'); button.type = 'button'; button.className = `pulse-story-ring${latest.mine ? ' pulse-story-own' : ''}`; button.setAttribute('aria-label', `${nameOf(latest)}${group.length > 1 ? `, ${group.length} stories` : ''}`); button.dataset.storyOpen = latest.id;
            const avatar = makeAvatar(latest, 'pulse-story-avatar'); button.append(avatar, Object.assign(document.createElement('span'), { className: 'story-ring-name', textContent: latest.mine ? 'Your story' : nameOf(latest) })); stage.append(button);
          }
        } else if (layout === 2) {
          for (const story of active) stage.append(tile(story, false));
        } else if (layout === 3) {
          for (const story of active) stage.append(tile(story, true));
        }
      }
      requestAnimationFrame(() => { updateGridScrolling(); updateVisibleVideos(); });
    }
    function updateGridScrolling() {
      for (const grid of stages.filter(stage => stage.dataset.storyStage === '3')) {
        grid.classList.toggle('is-scrollable', grid.scrollHeight > grid.clientHeight + 1);
      }
    }
    function tile(story, grid) {
      const button = document.createElement('button'); button.type = 'button'; button.className = grid ? 'story-grid-card' : 'story-preview-card'; button.dataset.storyOpen = story.id; button.setAttribute('aria-label', `Open story by ${nameOf(story)}`);
      const media = mediaKind(story) === 'video' ? document.createElement('video') : document.createElement('img');
      media.className = 'story-card-media'; if (media.tagName === 'VIDEO') { media.muted = true; media.playsInline = true; media.preload = 'none'; } else { media.alt = ''; media.loading = 'lazy'; media.decoding = 'async'; } media.src = mediaUrl(story);
      const meta = document.createElement('span'); meta.className = 'story-card-meta'; meta.append(makeAvatar(story, 'story-card-avatar'), Object.assign(document.createElement('span'), { className: 'story-card-name', textContent: story.mine ? 'You' : nameOf(story) }));
      button.append(media, meta); return button;
    }
    function updateVisibleVideos() {
      for (const video of shell.querySelectorAll('.pulse-panel:not([inert]) .pulse-stage.is-current .story-card-media')) {
        if (video.tagName !== 'VIDEO' || video.preload !== 'none') continue;
        const rect = video.getBoundingClientRect();
        if (rect.bottom > 0 && rect.top < innerHeight) video.preload = 'metadata';
      }
    }
    async function refresh() {
      if (destroyed || refreshBusy || document.visibilityState === 'hidden') return;
      refreshBusy = true; fetchController?.abort(); fetchController = new AbortController();
      try {
        const response = await fetch('/api/pulse/stories', { credentials: 'same-origin', signal: fetchController.signal, headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error(response.status === 401 ? 'Sign in to load or share stories.' : `Could not load stories (${response.status}).`);
        const payload = await response.json();
        if (!Array.isArray(payload.stories)) throw new Error('The stories response was incomplete.');
        if (payload.serverNow) { const server = Date.parse(payload.serverNow); if (Number.isFinite(server)) serverOffset = server - Date.now(); }
        const next = payload.stories.filter(item => item && item.id && Date.parse(item.expiresAt) > now());
        const changed = JSON.stringify(next) !== JSON.stringify(stories); stories = next;
        if (changed) render(); scheduleExpiry();
        if (current && !stories.some(item => item.id === current.id)) closeViewer(false);
      } catch (error) {
        if (error.name !== 'AbortError') { const status = shell.querySelector('.pulse-announcement'); if (status) status.textContent = error.message || 'Stories are unavailable right now.'; }
      } finally { refreshBusy = false; }
    }
    function scheduleExpiry() {
      clearTimeout(expiryTimer); const next = Math.min(...stories.map(item => Date.parse(item.expiresAt)).filter(Number.isFinite));
      if (Number.isFinite(next)) expiryTimer = setTimeout(() => { stories = visibleStories(); render(); if (current && !stories.some(item => item.id === current.id)) closeViewer(false); scheduleExpiry(); }, Math.max(0, next - now()));
    }
    function schedulePoll() { clearTimeout(pollTimer); pollTimer = setTimeout(() => { refresh(); schedulePoll(); }, POLL_MS); }
    function since(story) { const ms = Math.max(0, now() - Date.parse(story.createdAt)); if (!Number.isFinite(ms)) return 'Recently'; const minutes = Math.floor(ms / 60000); return minutes < 1 ? 'now' : minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago`; }
    function byId(id) { return visibleStories().find(item => String(item.id) === String(id)); }
    function ownerGroup(story) { return stories.filter(item => ownerKey(item) === ownerKey(story)).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)); }
    function openViewer(story) {
      if (!story || !viewer.isConnected) return;
      current = story; const collection = ownerGroup(story); currentIndex = Math.max(0, collection.findIndex(item => item.id === story.id)); showViewerStory();
      if (!viewer.open) viewer.showModal(); viewer.querySelector('.story-close').focus({ preventScroll: true });
      if (!viewerNav) { root.StemmaParentNavigation?.enter('pulse-story-viewer', () => closeViewer(false), { signal: abort.signal }); viewerNav = Boolean(root.StemmaParentNavigation); }
    }
    function showViewerStory() {
      if (!current) return;
      const collection = ownerGroup(current); if (!collection.length) return closeViewer(false);
      current = collection[Math.min(currentIndex, collection.length - 1)];
      v.name.textContent = nameOf(current); v.time.textContent = since(current); safeAvatar(v.avatar, current);
      v.description.textContent = current.description || ''; v.description.hidden = !current.description;
      v.actions.hidden = !current.mine;
      clearInterval(tickTimer);
      v.progress.replaceChildren();
      collection.forEach((item, i) => { const segment = document.createElement('span'); segment.className = `story-progress-segment${i < currentIndex ? ' is-done' : i === currentIndex ? ' is-active' : ''}`; const fill = document.createElement('i'); segment.append(fill); v.progress.append(segment); });
      v.media.replaceChildren();
      const media = mediaKind(current) === 'video' ? document.createElement('video') : document.createElement('img'); media.className = 'story-view-media'; media.src = mediaUrl(current);
      if (media.tagName === 'VIDEO') { media.controls = true; media.playsInline = true; media.preload = 'metadata'; media.addEventListener('timeupdate', () => { const fill = v.progress.children[currentIndex]?.firstElementChild; if (fill && media.duration > 0) fill.style.width = `${Math.min(100, media.currentTime / media.duration * 100)}%`; }, { signal: abort.signal }); media.addEventListener('ended', nextStory, { once: true, signal: abort.signal }); }
      else {
        media.alt = ''; const fill = v.progress.children[currentIndex]?.firstElementChild; const started = Date.now();
        tickTimer = setInterval(() => { const elapsed = Date.now() - started; if (fill) fill.style.width = `${Math.min(100, elapsed / 5000 * 100)}%`; if (elapsed >= 5000) nextStory(); }, 80);
      }
      v.media.append(media);
    }
    function stepStory(direction) { if (!current) return; const all = ownerGroup(current); currentIndex += direction; if (currentIndex < 0 || currentIndex >= all.length) { closeViewer(true); return; } current = all[currentIndex]; showViewerStory(); }
    function nextStory() { stepStory(1); }
    function closeViewer(back = false) {
      if (viewer.open) { viewer.querySelector('video')?.pause(); viewer.close(); }
      current = null; v.media.replaceChildren(); clearInterval(tickTimer);
      if (viewerNav) { if (back) root.StemmaParentNavigation?.back('pulse-story-viewer'); else root.StemmaParentNavigation?.forget('pulse-story-viewer'); }
      viewerNav = false;
    }
    const MAX_CLIP_SECONDS = 49.5;
    function openComposer() {
      if (!composer.open) composer.showModal(); c.error.hidden = true; c.file.focus({ preventScroll: true });
      if (!composerNav) { root.StemmaParentNavigation?.enter('pulse-story-composer', () => closeComposer(false), { signal: abort.signal }); composerNav = Boolean(root.StemmaParentNavigation); }
    }
    function clearPreview() {
      const player = c.preview.querySelector('video'); player?.pause(); if (player) root.StemmaStoryVideoCapture?.release(player);
      if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = null; sourceFile = null; sourceType = ''; sourceDuration = 0; c.preview.replaceChildren(); c.preview.hidden = true; c.trim.hidden = true; c.submit.disabled = true;
    }
    function closeComposer(back = false) {
      if (composer.open) composer.close(); recorderJob?.cancel?.(); clearPreview(); c.form.reset(); c.file.value = ''; c.error.hidden = true;
      if (composerNav) { if (back) root.StemmaParentNavigation?.back('pulse-story-composer'); else root.StemmaParentNavigation?.forget('pulse-story-composer'); } composerNav = false;
    }
    function error(message) { c.error.textContent = message; c.error.hidden = false; }
    function typeFor(file) { if (file.type) return file.type.toLowerCase().split(';')[0].trim(); const ext = file.name.toLowerCase().split('.').pop(); return ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', mov: 'video/quicktime' })[ext] || ''; }
    function timeLabel(seconds) { const n = Math.max(0, Math.floor(Number(seconds) || 0)); return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`; }
    function fileChoice(file) {
      clearPreview(); c.error.hidden = true; if (!file) return;
      const type = typeFor(file);
      if (!RASTER.has(type) && !VIDEO.has(type)) { c.file.value = ''; return error('Choose a JPEG, PNG, WebP, GIF, MP4, or MOV file.'); }
      if (file.size > MAX_BYTES) { c.file.value = ''; return error('Choose a file no larger than 5 MiB.'); }
      sourceFile = file; sourceType = type; previewUrl = URL.createObjectURL(file);
      const media = type.startsWith('video/') ? document.createElement('video') : document.createElement('img'); media.className = 'story-compose-media'; media.src = previewUrl;
      if (type.startsWith('video/')) {
        media.controls = true; media.playsInline = true; media.preload = 'metadata'; media.setAttribute('aria-label', 'Story video preview');
        media.addEventListener('loadedmetadata', () => {
          if (!sourceFile) return;
          if (!Number.isFinite(media.duration) || media.duration <= 0) { error('This video has no readable duration. Choose another video.'); return; }
          sourceDuration = media.duration; trimStart = 0; trimEnd = Math.min(media.duration, MAX_CLIP_SECONDS);
          if (sourceDuration > MAX_SECONDS) {
            c.trim.hidden = false; c.start.value = '0'; c.start.max = String(Math.max(0, sourceDuration - 0.1)); c.end.value = String(trimEnd); c.end.min = '0.1'; c.end.max = String(trimEnd); c.startLabel.value = timeLabel(0); c.endLabel.value = timeLabel(trimEnd);
            c.end.max = String(sourceDuration);
            media.addEventListener('timeupdate', () => { if (recorderJob) return; if (media.currentTime >= trimEnd) { media.pause(); media.currentTime = trimStart; } else if (media.currentTime < trimStart) media.currentTime = trimStart; }, { signal: abort.signal });
          }
          c.submit.disabled = false;
        }, { once: true });
        media.addEventListener('error', () => { if (sourceFile) error('This video could not be read.'); }, { once: true });
      } else { media.alt = 'Story image preview'; media.addEventListener('load', () => { if (sourceFile) c.submit.disabled = false; }, { once: true }); media.addEventListener('error', () => { if (sourceFile) error('This image could not be read.'); }, { once: true }); }
      c.preview.append(media); c.preview.hidden = false;
    }
    function updateTrim(changed) {
      if (!sourceDuration) return;
      let a = Number(c.start.value), b = Number(c.end.value);
      if (changed === 'start' && (b <= a || b - a > MAX_CLIP_SECONDS)) b = Math.min(sourceDuration, a + MAX_CLIP_SECONDS);
      if (changed === 'end' && (b <= a || b - a > MAX_CLIP_SECONDS)) a = Math.max(0, b - MAX_CLIP_SECONDS);
      a = Math.max(0, Math.min(a, sourceDuration - 0.1)); b = Math.max(a + 0.1, Math.min(b, sourceDuration));
      c.start.value = String(a); c.end.value = String(b); trimStart = a; trimEnd = b;
      c.start.max = String(Math.max(0, sourceDuration - 0.1)); c.end.min = '0.1'; c.end.max = String(sourceDuration);
      c.startLabel.value = timeLabel(a); c.endLabel.value = timeLabel(b);
      const player = c.preview.querySelector('video'); if (player && (player.currentTime < a || player.currentTime >= b)) { player.pause(); player.currentTime = a; }
    }
    async function makeTrimmedClip() {
      const player = c.preview.querySelector('video');
      if (!player || !sourceFile || !VIDEO.has(sourceType)) throw new Error('Choose a supported video to trim.');
      const capture = root.StemmaStoryVideoCapture;
      if (!capture || !window.MediaRecorder) throw new Error('This browser cannot trim video locally. Try a browser with MP4 recording support, or choose a clip 50 seconds or shorter.');
      const options = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4'];
      const mimeType = options.find(type => MediaRecorder.isTypeSupported?.(type));
      if (!mimeType) throw new Error('This browser cannot create a playable MP4 trim. Try a browser with MP4 recording support, or choose a clip 50 seconds or shorter.');
      if (trimEnd - trimStart > MAX_SECONDS || trimEnd <= trimStart) throw new Error('Select a clip no longer than 50 seconds.');
      player.pause(); player.muted = false;
      await new Promise((resolve, reject) => {
        if (Math.abs(player.currentTime - trimStart) < 0.02) resolve();
        else { const done = () => { clean(); resolve(); }, fail = () => { clean(); reject(new Error('Could not seek to the selected clip start.')); }, clean = () => { player.removeEventListener('seeked', done); player.removeEventListener('error', fail); }; player.addEventListener('seeked', done, { once: true }); player.addEventListener('error', fail, { once: true }); player.currentTime = trimStart; }
      });
      const captureJob = await capture.capture(player);
      const stream = captureJob.stream;
      if (!stream.getVideoTracks().length || (player.audioTracks?.length && !stream.getAudioTracks().length)) { captureJob.cleanup(); throw new Error('This browser could not capture the video and its audio for trimming. Choose another browser or a shorter clip.'); }
      let recorder;
      const videoBitsPerSecond = Math.max(128000, Math.min(1500000, Math.floor((MAX_BYTES * 8 / (trimEnd - trimStart) - 96000) * .84)));
      try { recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond, audioBitsPerSecond: 64000 }); } catch { captureJob.cleanup(); throw new Error('This browser cannot encode the MP4 trim. Choose a shorter video or use a browser with MP4 recording support.'); }
      const chunks = [];
      let cancelRequested = false;
      const blob = await new Promise((resolve, reject) => {
        let settled = false, boundaryTimer = 0; const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(guard); clearInterval(boundaryTimer); player.pause(); captureJob.cleanup(); recorderJob = null; fn(value); };
        const stop = () => { if (recorder.state !== 'inactive') recorder.stop(); };
        const guard = setTimeout(() => { stop(); finish(reject, new Error('Video trimming took too long. Please try again.')); }, 60000);
        player.addEventListener('timeupdate', () => { if (player.currentTime >= trimEnd - 0.015) stop(); }, { signal: abort.signal }); player.addEventListener('ended', stop, { once: true, signal: abort.signal });
        recorder.addEventListener('dataavailable', event => { if (event.data?.size) chunks.push(event.data); }); recorder.addEventListener('error', () => finish(reject, new Error('The browser could not encode this MP4 trim.')));
        recorder.addEventListener('stop', () => { const output = new Blob(chunks, { type: recorder.mimeType || 'video/mp4' }); if (cancelRequested) finish(reject, new Error('Video trimming was cancelled.')); else if (!output.size) finish(reject, new Error('The trimmed video was empty. Try another browser or a shorter clip.')); else if (output.size > MAX_BYTES) finish(reject, new Error('This trimmed clip is larger than 5 MiB. Choose a shorter or smaller clip.')); else finish(resolve, output); }, { once: true });
        recorderJob = { cancel: () => { cancelRequested = true; stop(); } };
        boundaryTimer = setInterval(() => { if (player.currentTime >= trimEnd - .04) stop(); }, 20);
        recorder.start(250); player.play().catch(() => { stop(); finish(reject, new Error('Video playback was blocked, so the selected clip could not be trimmed. Try again after pressing play.')); });
      });
      recorderJob = null;
      const outUrl = URL.createObjectURL(blob);
      try { await new Promise((resolve, reject) => { const probe = document.createElement('video'); probe.preload = 'metadata'; probe.onloadedmetadata = () => { const duration = probe.duration; probe.removeAttribute('src'); probe.load(); if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_SECONDS) reject(new Error('The recorded trim was not within the 50-second limit. Adjust the selection and try again.')); else resolve(); }; probe.onerror = () => reject(new Error('The browser produced an MP4 that could not be read. Choose a shorter video or another browser.')); probe.src = outUrl; }); } finally { URL.revokeObjectURL(outUrl); }
      return new File([blob], 'stemma-story-clip.mp4', { type: 'video/mp4' });
    }
    on(shell, 'click', event => {
      const button = event.target.closest('[data-story-open]'); if (button && shell.contains(button)) { openViewer(byId(button.dataset.storyOpen)); return; }
      if (event.target.closest('[data-story-create]')) { openComposer(); const toggle = shell.querySelector('.pulse-create-affordance'); toggle?.setAttribute('aria-expanded', 'false'); menu?.setAttribute('aria-hidden', 'true'); if (menu) menu.inert = true; shell.classList.remove('is-create-open'); }
    });
    on(shell, 'pointerdown', event => { const item = event.target.closest('[data-story-open]'); if (item) item.dataset.storyDownX = String(event.clientX); });
    on(shell, 'pointerup', event => { const item = event.target.closest('[data-story-open]'); if (item && item.dataset.storyDownX && Math.abs(event.clientX - Number(item.dataset.storyDownX)) > 8) { item.dataset.storyDragged = '1'; setTimeout(() => delete item.dataset.storyDragged, 0); } });
    on(shell, 'click', event => { const item = event.target.closest('[data-story-open]'); if (item?.dataset.storyDragged) { event.preventDefault(); event.stopImmediatePropagation(); delete item.dataset.storyDragged; } }, true);
    on(viewer, 'click', event => { if (event.target === v.close) closeViewer(true); });
    on(viewer, 'cancel', event => { event.preventDefault(); closeViewer(true); });
    on(viewer, 'close', () => { viewer.querySelector('video')?.pause(); if (current) { current = null; v.media.replaceChildren(); } });
    on(viewer, 'keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); closeViewer(true); }
      else if (event.key === 'ArrowRight') { event.preventDefault(); stepStory(1); }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); stepStory(-1); }
      else if (event.key === 'Tab') { const focusables = [...viewer.querySelectorAll('button:not([hidden]),video[controls]')].filter(el => !el.disabled); if (!focusables.length) return; const first = focusables[0], last = focusables.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } }
    });
    on(v.del, 'click', async () => {
      if (!current?.mine || !window.confirm('Delete this story? This cannot be undone.')) return;
      try { const response = await fetch(`/api/pulse/stories/${encodeURIComponent(current.id)}`, { method: 'DELETE', credentials: 'same-origin', headers: { Accept: 'application/json' } }); if (!response.ok) throw new Error(response.status === 401 ? 'Sign in again to delete this story.' : 'Could not delete this story.'); stories = stories.filter(item => item.id !== current.id); render(); closeViewer(true); } catch (e) { v.time.textContent = e.message; }
    });
    on(composer.querySelector('.story-compose-close'), 'click', () => closeComposer(true));
    on(composer, 'cancel', event => { event.preventDefault(); closeComposer(true); });
    on(composer, 'close', () => { recorderJob?.cancel?.(); });
    on(c.file, 'change', () => fileChoice(c.file.files?.[0]));
    on(c.start, 'input', () => updateTrim('start')); on(c.end, 'input', () => updateTrim('end'));
    on(c.form, 'submit', async event => {
      event.preventDefault(); c.error.hidden = true;
      const file = sourceFile; if (!file) return error('Choose a photo or video to share.');
      if (file.size > MAX_BYTES) return error('Choose a file no larger than 5 MiB.');
      if (c.desc.value.length > 1000) return error('Descriptions can be up to 1,000 characters.');
      c.submit.disabled = true; c.submit.textContent = sourceDuration > MAX_SECONDS ? 'Trimming video…' : 'Sending…';
      [c.file, c.desc, c.start, c.end].forEach(control => { control.disabled = true; });
      try {
        const readyFile = sourceDuration > MAX_SECONDS ? await makeTrimmedClip() : file;
        if (!composer.open || sourceFile !== file) throw new Error('Story sending was cancelled.');
        const mimeType = typeFor(readyFile); if ((!RASTER.has(mimeType) && !VIDEO.has(mimeType)) || readyFile.size > MAX_BYTES) throw new Error(readyFile.size > MAX_BYTES ? 'This story is larger than 5 MiB. Choose a smaller file.' : 'This file type is not supported.');
        c.submit.textContent = 'Sending…';
        const bytes = new Uint8Array(await readyFile.arrayBuffer()); let binary = ''; for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        const response = await fetch('/api/pulse/stories', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ name: readyFile.name, mimeType, data: btoa(binary), description: c.desc.value }) });
        const payload = await response.json().catch(() => ({})); if (!response.ok) throw new Error(response.status === 401 ? 'Sign in to send a story.' : payload.error || `Could not send story (${response.status}).`);
        if (!payload.story) throw new Error('The server did not confirm the story. Try refreshing Pulse.');
        closeComposer(false); await refresh();
      } catch (e) { error(e.message || 'Could not send story. Check your connection and try again.'); }
      finally { [c.file, c.desc, c.start, c.end].forEach(control => { control.disabled = false; }); c.submit.disabled = !sourceFile; c.submit.textContent = 'Send story'; }
    });
    on(document, 'visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
    on(window, 'resize', () => requestAnimationFrame(updateGridScrolling));
    on(shell, 'scroll', updateVisibleVideos, { capture: true, passive: true });
    const stageObserver = new MutationObserver(updateVisibleVideos); stageObserver.observe(shell, { subtree: true, attributes: true, attributeFilter: ['data-stage', 'aria-hidden'] });
    const observer = new MutationObserver(() => { if (!document.body.contains(toBody)) abort.abort(); }); observer.observe(document.body, { childList: true });
    refresh(); schedulePoll();
    const cleanup = () => { destroyed = true; abort.abort(); observer.disconnect(); stageObserver.disconnect(); clearTimeout(pollTimer); clearTimeout(expiryTimer); clearInterval(tickTimer); fetchController?.abort(); viewer.querySelector('video')?.pause(); recorderJob?.cancel?.(); clearPreview(); if (viewer.open) viewer.close(); if (composer.open) composer.close(); toBody.remove(); };
    abort.signal.addEventListener('abort', cleanup, { once: true });
    return cleanup;
  }
  root.StemmaStories = Object.freeze({ stageView, mount });
})(typeof window !== 'undefined' ? window : globalThis);
