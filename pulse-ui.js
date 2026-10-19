/* Pulse shows only real Saved Messages; public handles and self notes connect separately. */
(function attachPulse(root) {
  'use strict';
  const categories = Object.freeze([
    { label: 'All', icon: 'pulse' }, { label: 'User', icon: 'user' },
    { label: 'Group', icon: 'pulse-group' }, { label: 'Channel', icon: 'pulse-channel' },
    { label: 'App', icon: 'grid' }
  ]);
  const glyph = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
  const bone = (classes = '') => `<span class="pulse-bone skeleton-shimmer ${classes}"></span>`;
  // Match the supplied stacked-bookmark silhouette using the existing avatar palette.
  const bookmarkStack = `<svg class="pulse-bookmark-stack" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path d="M5 2h5v9a1 1 0 0 0 1.6.8L14 10l2.4 1.8A1 1 0 0 0 18 11V2h2a4 4 0 0 1 4 4v18a4 4 0 0 1-4 4H5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z" fill="currentColor"/><path d="M12 2h4v7l-2-1.5L12 9Z" fill="currentColor"/><path d="M27 13v14a4 4 0 0 1-4 4H13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
  function rows(kind) {
    if (kind !== 'all') return '';
    return `<div class="pulse-conversations"><button type="button" class="pulse-conversation pulse-saved-row" data-pulse-saved><span class="pulse-person-mark" aria-hidden="true">${bookmarkStack}</span><span class="pulse-copy"><strong>Saved Messages</strong><span class="pulse-saved-preview" hidden></span></span></button></div>`;
  }
  function stages(kind) {
    // Keep gesture/stage state intact without showing unfinished stories or grids.
    return ['minimal', 'stories', 'previews', 'grid'].map((name, i) => `<section class="pulse-stage pulse-stage-${name}${i === 0 ? ' is-current' : ''}" ${i === 0 ? '' : 'inert aria-hidden="true"'} aria-label="${kind === 'all' ? 'Saved Messages list' : 'Empty conversations'}">${rows(kind)}</section>`).join('');
  }
  function searchView() {
    return `<section class="pulse-search" id="pulse-search" role="region" aria-label="Pulse Search" hidden>
      <div class="pulse-search-header">
        <label class="pulse-search-field">${glyph('pulse-search')}<input id="pulse-search-input" type="search" placeholder="Username or nickname" aria-label="Search Pulse" aria-describedby="pulse-search-hint" autocomplete="off" spellcheck="false"></label>
        <button type="button" class="pulse-search-close" aria-label="Close Pulse search">${glyph('close')}</button>
      </div>
      <span id="pulse-search-hint" class="pulse-announcement">Search app users by username or nickname only.</span>
      <nav class="pulse-search-tabs pulse-tabs" role="tablist" aria-label="Search categories">${categories.map((item, i) => `<button type="button" class="pulse-search-tab pulse-tab" role="tab" aria-label="Search ${item.label}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}" data-pulse-search-tab="${i}" aria-controls="pulse-search-results">${glyph(item.icon)}</button>`).join('')}</nav>
      <div class="pulse-search-body" id="pulse-search-results" role="region" aria-label="Pulse search results">
        <p class="pulse-data-status pulse-user-status" role="status" aria-live="polite" hidden></p><div class="pulse-user-results" role="list" aria-label="Users" hidden></div><button type="button" class="pulse-users-more" hidden>Load more users</button>
        <div class="pulse-search-suggestions" tabindex="0" role="region" aria-label="Suggested previews, scroll horizontally"><div aria-hidden="true">${Array.from({ length: 8 }, () => `<div class="pulse-search-suggestion">${bone('pulse-search-circle')}${bone('pulse-search-caption')}</div>`).join('')}</div></div>
        <div class="pulse-search-recent-heading"><h2>Recent</h2><button type="button" class="pulse-search-clear" disabled title="Recent history is coming later">Clear All</button></div>
        <div class="pulse-search-recents" role="list" aria-label="Recent search placeholders">${Array.from({ length: 6 }, (_, i) => `<div class="pulse-search-recent-row" role="listitem" aria-label="Recent search placeholder ${i + 1}"><div class="pulse-search-row-skeleton" aria-hidden="true">${bone('pulse-avatar')}<div class="pulse-copy">${bone(`pulse-name pulse-length-${i % 3}`)}${bone('pulse-preview')}</div></div><button type="button" class="pulse-search-remove" aria-label="Remove recent search placeholder ${i + 1}" disabled title="Recent history is coming later">${glyph('close')}</button></div>`).join('')}</div>
      </div>
    </section>`;
  }
  function render(selected = 0) {
    selected = Math.max(0, Math.min(categories.length - 1, selected));
    return `<section class="pulse-shell" aria-label="Pulse visual preview">
      <div class="pulse-feed">
        <span class="pulse-announcement" role="status" aria-live="polite" aria-atomic="true"></span>
        <nav class="pulse-tabs" role="tablist" aria-label="Pulse categories">${categories.map((item, i) => `<button type="button" class="pulse-tab" role="tab" id="pulse-tab-${i}" aria-label="${item.label}" aria-controls="pulse-panel-${i}" aria-selected="${i === selected}" tabindex="${i === selected ? 0 : -1}" data-pulse-tab="${i}">${glyph(item.icon)}</button>`).join('')}</nav>
        <div class="pulse-viewport"><div class="pulse-track" style="transform:translate3d(-${selected * 100}%,0,0)">${categories.map((item, i) => `<section class="pulse-panel" id="pulse-panel-${i}" role="tabpanel" aria-labelledby="pulse-tab-${i}" aria-description="Pull down to reveal stories; swipe up to return. Use Arrow Down or Arrow Up when focused." data-stage="0" tabindex="0" ${i === selected ? '' : 'inert aria-hidden="true"'}>${stages(['all', 'user', 'group', 'channel', 'app'][i])}</section>`).join('')}</div></div>
        <div class="pulse-create-previews" id="pulse-create-previews" aria-hidden="true" inert>
          ${[1, 2, 3].map(order => `<span class="pulse-create-preview" style="--preview-order:${order}">${bone('pulse-create-preview-icon')}${bone('pulse-create-preview-line')}</span>`).join('')}
        </div>
        <button type="button" class="pulse-create-affordance" aria-label="Toggle create previews" aria-expanded="false" aria-controls="pulse-create-previews">
          <svg viewBox="0 0 32 32" focusable="false" aria-hidden="true">
            <path d="M29 10.5V25a4 4 0 0 1-4 4H10.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
            <rect x="3" y="3" width="22" height="22" rx="3.3" fill="currentColor" />
            <path class="pulse-create-plus" d="M14 9v10M9 14h10" fill="none" stroke-width="2" stroke-linecap="round" />
          </svg>
        </button>
      </div>
      ${searchView()}
      ${root.StemmaPulseData ? root.StemmaPulseData.savedView() : ''}
    </section>`;
  }
  let cleanup = () => {};
  function mount(container, selected = 0, onChange = () => {}) {
    cleanup();
    const shell = container.querySelector('.pulse-shell');
    if (!shell) return;
    const track = shell.querySelector('.pulse-track');
    const viewport = shell.querySelector('.pulse-viewport');
    const tabs = [...shell.querySelectorAll('[data-pulse-tab]')];
    const panels = [...shell.querySelectorAll('.pulse-panel')];
    let drag = null;
    const abort = new AbortController();
    const listen = (target, type, fn, options = {}) => target.addEventListener(type, fn, { ...options, signal: abort.signal });
    const announcement = shell.querySelector('.pulse-announcement');
    const createToggle = shell.querySelector('.pulse-create-affordance');
    function setCreateOpen(open) {
      shell.classList.toggle('is-create-open', open);
      createToggle.setAttribute('aria-expanded', String(open));
    }
    listen(createToggle, 'click', () => setCreateOpen(createToggle.getAttribute('aria-expanded') !== 'true'));
    listen(document, 'pointerdown', event => {
      if (!createToggle.contains(event.target)) setCreateOpen(false);
    });
    listen(document, 'keydown', event => {
      if (event.key === 'Escape' && createToggle.getAttribute('aria-expanded') === 'true') {
        event.preventDefault();
        setCreateOpen(false);
        createToggle.focus({ preventScroll: true });
      }
    });
    listen(shell, 'focusout', event => {
      if (!shell.contains(event.relatedTarget)) setCreateOpen(false);
    });
    const feed = shell.querySelector('.pulse-feed');
    const search = shell.querySelector('.pulse-search');
    const searchInput = shell.querySelector('#pulse-search-input');
    const searchTrigger = document.querySelector('.pulse-topbar-search');
    const searchTabs = [...shell.querySelectorAll('.pulse-search-tab')];
    function setSearchOpen(open) {
      setCreateOpen(false);
      drag = null;
      track.classList.remove('is-dragging');
      track.style.transform = `translate3d(-${selected * 100}%,0,0)`;
      states.forEach(state => { stop(state); resetVisual(state); state.progress = Number(state.panel.dataset.stage); state.panel.dataset.progress = String(state.progress); });
      const saved = shell.querySelector('.pulse-saved');
      if (saved) saved.hidden = true;
      search.hidden = !open;
      feed.hidden = open;
      feed.inert = open;
      searchTrigger?.setAttribute('aria-expanded', String(open));
      if (open) searchInput.focus({ preventScroll: true });
      else searchTrigger?.focus({ preventScroll: true });
    }
    if (searchTrigger) listen(searchTrigger, 'click', () => setSearchOpen(search.hidden));
    listen(shell.querySelector('.pulse-search-close'), 'click', () => setSearchOpen(false));
    listen(search, 'keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setSearchOpen(false); }
    });
    function selectSearch(index, focus = false) {
      index = (index + searchTabs.length) % searchTabs.length;
      searchTabs.forEach((tab, i) => { tab.setAttribute('aria-selected', String(i === index)); tab.tabIndex = i === index ? 0 : -1; });
      if (focus) searchTabs[index].focus();
    }
    listen(search, 'click', event => {
      const tab = event.target.closest('[data-pulse-search-tab]');
      if (tab) selectSearch(Number(tab.dataset.pulseSearchTab));
    });
    listen(search, 'keydown', event => {
      const tab = event.target.closest('[data-pulse-search-tab]');
      if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = Number(tab.dataset.pulseSearchTab);
      selectSearch(event.key === 'Home' ? 0 : event.key === 'End' ? searchTabs.length - 1 : index + (event.key === 'ArrowRight' ? 1 : -1), true);
    });
    const stageNames = ['Chat preview', 'Circular story previews', 'Story tile previews', 'Two-column preview grid'];
    let wheelTimer;
    let wheelLocked = false;
    let wheelDistance = 0;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const states = panels.map(panel => ({ panel, progress: Number(panel.dataset.stage), frame: 0, pair: null }));
    const clamp = (value, min = 0, max = 3) => Math.max(min, Math.min(max, value));
    const mix = (a, b, t) => a + (b - a) * t;
    function resetVisual(state) {
      state.pair = null;
      state.panel.classList.remove('is-interacting');
      [...state.panel.children].forEach(stage => {
        stage.removeAttribute('style');
        [...stage.children].forEach(child => child.removeAttribute('style'));
        stage.querySelectorAll('.pulse-conversation, .pulse-story-ring').forEach(row => row.removeAttribute('style'));
      });
    }
    // Measure shared layout once per adjacent pair, never on every pointer move.
    // The chat rows and story rail keep their identity instead of double-image crossfades.
    function paint(state, progress) {
      state.progress = clamp(progress);
      state.panel.dataset.progress = state.progress.toFixed(4);
      const low = Math.min(2, Math.floor(state.progress));
      const t = state.progress - low;
      if (!state.pair || state.pair.low !== low) {
        resetVisual(state);
        const from = state.panel.children[low];
        const to = state.panel.children[low + 1];
        const shared = ['.pulse-conversations', '.pulse-stories'].map(selector => {
          const a = from.querySelector(selector), b = to.querySelector(selector);
          if (a && b && selector === '.pulse-stories') {
            const scroll = state.progress - low > .5 ? b.scrollLeft : a.scrollLeft;
            a.scrollLeft = scroll; b.scrollLeft = scroll;
          }
          return a && b ? { a, b, y: [a.offsetTop, b.offsetTop], h: [a.offsetHeight, b.offsetHeight] } : null;
        }).filter(Boolean);
        state.pair = { low, from, to, shared };
      }
      state.panel.classList.add('is-interacting');
      const { from, to, shared } = state.pair;
      [...state.panel.children].forEach(stage => {
        stage.style.visibility = stage === from || stage === to ? 'visible' : 'hidden';
        stage.style.opacity = stage === from || stage === to ? '1' : '0';
        stage.style.transform = 'none';
      });
      // Shared layouts morph; unrelated grid content uses a restrained depth handoff.
      for (const [stage, weight, direction] of [[from, 1 - t, -1], [to, t, 1]]) {
        [...stage.children].forEach(child => {
          child.style.opacity = String(weight);
          if (child.matches('.pulse-stories, .pulse-previews')) child.style.clipPath = `inset(0 0 ${(1 - weight) * 100}% 0)`;
          child.style.transform = `translate3d(0,${direction * (1 - weight) * 24}px,0) scale(${mix(.97, 1, weight)})`;
          if (child.classList.contains('pulse-stories')) {
            child.style.transform = 'none';
            child.querySelectorAll('.pulse-story-ring').forEach(ring => { ring.style.transformOrigin = 'center top'; ring.style.transform = `scale(${weight})`; });
          }
        });
      }
      shared.forEach(({ a, b, y, h }) => {
        a.style.opacity = '1';
        a.style.clipPath = 'none';
        a.querySelectorAll('.pulse-story-ring').forEach(ring => ring.style.transform = 'none');
        a.style.transform = `translate3d(0,${mix(y[0], y[1], t) - y[0]}px,0)`;
        a.style.height = `${mix(h[0], h[1], t)}px`;
        a.style.alignSelf = 'start';
        b.style.opacity = '0';
        if (low === 1 && a.classList.contains('pulse-conversations')) {
          [...a.children].slice(3).forEach(row => { row.style.flex = `${1 - t} 1 0%`; row.style.opacity = String(1 - t); row.style.overflow = 'hidden'; });
        }
      });
    }
    function stop(state) { cancelAnimationFrame(state.frame); state.frame = 0; }
    function settle(state, target, velocity = 0) {
      stop(state);
      if (motion.matches) { state.progress = target; resetVisual(state); state.panel.dataset.progress = String(target); return; }
      const lower = Math.min(Math.floor(state.progress), target);
      const upper = Math.max(Math.ceil(state.progress), target);
      paint(state, state.progress);
      let last = performance.now();
      let speed = velocity;
      const tick = now => {
        const dt = Math.min((now - last) / 1000, .032);
        last = now;
        // Damped spring: release velocity is carried forward, no restart or CSS delay.
        speed += ((target - state.progress) * 420 - speed * 40) * dt;
        const next = clamp(state.progress + speed * dt, lower, upper);
        if (Math.abs(target - next) < .001 && Math.abs(speed) < .015) {
          state.progress = target; state.panel.dataset.progress = String(target);
          resetVisual(state); state.frame = 0; return;
        }
        paint(state, next);
        state.frame = requestAnimationFrame(tick);
      };
      state.frame = requestAnimationFrame(tick);
    }
    function reveal(panel, index, velocity = 0) {
      const next = clamp(index);
      const current = Number(panel.dataset.stage);
      if (current !== next) {
        if (panel.contains(document.activeElement) && document.activeElement !== panel) panel.focus({ preventScroll: true });
        panel.dataset.stage = String(next);
        announcement.textContent = `${categories[selected].label}: ${stageNames[next]}, stage ${next + 1} of 4.`;
        panel.setAttribute('aria-description', `${stageNames[next]}, stage ${next + 1} of 4. Pull down or Arrow Down for next; swipe up or Arrow Up for previous.`);
      }
      [...panel.children].forEach((stage, i) => {
        stage.classList.toggle('is-current', i === next);
        stage.classList.toggle('is-past', i < next);
        stage.inert = i !== next;
        if (i === next) stage.removeAttribute('aria-hidden'); else stage.setAttribute('aria-hidden', 'true');
      });
      settle(states[panels.indexOf(panel)], next, velocity);
    }
    function select(index, focus = false) {
      selected = Math.max(0, Math.min(categories.length - 1, index));
      states.forEach(state => { stop(state); state.progress = Number(state.panel.dataset.stage); state.panel.dataset.progress = String(state.progress); resetVisual(state); });
      setCreateOpen(false);
      drag = null;
      track.classList.remove('is-dragging');
      track.style.transform = `translate3d(-${selected * 100}%,0,0)`;
      tabs.forEach((tab, i) => { tab.setAttribute('aria-selected', String(i === selected)); tab.tabIndex = i === selected ? 0 : -1; });
      panels.forEach((panel, i) => { panel.inert = i !== selected; if (i === selected) panel.removeAttribute('aria-hidden'); else panel.setAttribute('aria-hidden', 'true'); });
      if (focus) tabs[selected].focus();
      onChange(selected);
    }
    listen(shell, 'click', event => {
      const tab = event.target.closest('[data-pulse-tab]');
      if (tab) select(Number(tab.dataset.pulseTab));
    });
    listen(shell, 'keydown', event => {
      if (event.target.closest('.pulse-search')) return;
      if (!event.target.closest('.pulse-tab') || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? categories.length - 1 : selected + (event.key === 'ArrowRight' ? 1 : -1);
      select(index, true);
    });
    listen(viewport, 'keydown', event => {
      if (event.target.closest('.pulse-stories') || !['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const panel = panels[selected];
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? 3 : Number(panel.dataset.stage) + (['ArrowDown', 'PageDown'].includes(event.key) ? 1 : -1);
      reveal(panel, next);
    });
    // A wheel/trackpad burst is one pull, not three skipped layouts.
    listen(viewport, 'wheel', event => {
      if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      event.preventDefault();
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(() => { wheelLocked = false; wheelDistance = 0; }, 220);
      if (wheelLocked) return;
      wheelDistance += event.deltaY;
      if (Math.abs(wheelDistance) < 36) return;
      const panel = panels[selected];
      reveal(panel, Number(panel.dataset.stage) + (wheelDistance < 0 ? 1 : -1));
      wheelLocked = true;
    }, { passive: false });
    listen(viewport, 'pointerdown', event => {
      if (!event.isPrimary) { drag = null; select(selected); return; }
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      drag = { x: event.clientX, y: event.clientY, dx: 0, dy: 0, axis: null, rail: Boolean(event.target.closest('.pulse-stories')), id: event.pointerId, start: states[selected].progress, base: Number(panels[selected].dataset.stage), time: performance.now(), velocity: 0, lastY: event.clientY };
    });
    listen(viewport, 'pointermove', event => {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.axis && Math.max(Math.abs(dx), Math.abs(dy)) > 10) {
        if (Math.abs(dx) > Math.abs(dy) * 1.2) {
          if (drag.rail) { drag = null; return; } // Native story scrolling never selects a category.
          drag.axis = 'x';
          track.classList.add('is-dragging');
        } else if (Math.abs(dy) > Math.abs(dx) * 1.2) { drag.axis = 'y'; drag.start = states[selected].progress; stop(states[selected]); }
        else return;
        viewport.setPointerCapture(event.pointerId);
      }
      if (!drag.axis) return;
      const now = performance.now();
      drag.velocity = (event.clientY - drag.lastY) / Math.max(8, now - drag.time);
      drag.lastY = event.clientY; drag.time = now;
      drag.dy = dy;
      drag.dx = (selected === 0 && dx > 0) || (selected === categories.length - 1 && dx < 0) ? dx * .22 : dx;
      if (drag.axis === 'y' && !motion.matches) paint(states[selected], clamp(drag.start + dy / 180, Math.max(0, drag.base - 1), Math.min(3, drag.base + 1)));
      if (drag.axis === 'x') track.style.transform = `translate3d(calc(-${selected * 100}% + ${drag.dx}px),0,0)`;
    });
    const finish = event => {
      if (!drag || event.pointerId !== drag.id) return;
      const gesture = drag;
      drag = null;
      if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
      if (gesture.axis === 'y') {
        const panel = panels[selected];
        const velocity = performance.now() - gesture.time > 80 ? 0 : gesture.velocity;
        const commit = event.type !== 'pointercancel' && (Math.abs(gesture.dy) >= 48 || (Math.abs(gesture.dy) >= 18 && Math.abs(velocity) > .55 && Math.sign(velocity) === Math.sign(gesture.dy)));
        const target = commit ? gesture.base + (gesture.dy > 0 ? 1 : -1) : gesture.base;
        reveal(panel, target, event.type === 'pointercancel' ? 0 : velocity * 1000 / 180);
      }
      const next = event.type !== 'pointercancel' && gesture.axis === 'x' && Math.abs(gesture.dx) > Math.min(64, viewport.clientWidth * .18) ? selected + (gesture.dx < 0 ? 1 : -1) : selected;
      if (gesture.axis === 'x') select(next);
    };
    listen(viewport, 'pointerup', finish);
    listen(viewport, 'pointercancel', finish);
    listen(viewport, 'lostpointercapture', event => {
      if (event.target === viewport && drag && event.pointerId === drag.id && !viewport.hasPointerCapture(event.pointerId)) { const panel = panels[selected]; drag = null; reveal(panel, Number(panel.dataset.stage)); }
    });
    listen(motion, 'change', () => { states.forEach(state => reveal(state.panel, Number(state.panel.dataset.stage))); });
    listen(window, 'resize', () => { states.forEach(state => { stop(state); resetVisual(state); state.progress = Number(state.panel.dataset.stage); state.panel.dataset.progress = String(state.progress); }); drag = null; });
    root.StemmaPulseData?.mount(shell, { listen, signal: abort.signal, closeSearch: () => setSearchOpen(false) });
    cleanup = () => { searchTrigger?.setAttribute('aria-expanded', 'false'); abort.abort(); clearTimeout(wheelTimer); states.forEach(stop); };
  }
  root.StemmaPulse = Object.freeze({ render, mount, categories, unmount: () => { cleanup(); cleanup = () => {}; } });
})(typeof window !== 'undefined' ? window : globalThis);
