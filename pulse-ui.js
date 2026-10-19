/* Visual-only Pulse shell. No accounts, messaging, uploads, or network calls. */
(function attachPulse(root) {
  'use strict';
  const categories = Object.freeze([
    { label: 'All', icon: 'pulse' }, { label: 'User', icon: 'user' },
    { label: 'Group', icon: 'pulse-group' }, { label: 'Channel', icon: 'pulse-channel' },
    { label: 'App', icon: 'grid' }
  ]);
  const glyph = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
  const bone = (classes = '') => `<span class="pulse-bone skeleton-shimmer ${classes}"></span>`;
  function rows(kind) {
    return `<div class="pulse-conversations" aria-hidden="true">${Array.from({ length: 6 }, (_, i) => `
      <div class="pulse-conversation pulse-kind-${kind}">
        <div class="pulse-avatar-wrap">${bone('pulse-avatar')}${kind === 'group' ? bone('pulse-avatar-secondary') : ''}</div>
        <div class="pulse-copy">${bone(`pulse-name pulse-length-${i % 3}`)}${bone('pulse-preview')}${kind === 'channel' ? bone('pulse-preview-short') : ''}</div>
        <div class="pulse-meta">${bone('pulse-time')}${i % 3 === 0 ? bone('pulse-dot') : ''}</div>
      </div>`).join('')}</div>`;
  }
  function tiles() {
    return `<div class="pulse-app-grid" aria-hidden="true">${Array.from({ length: 9 }, () => `
      <div class="pulse-app-tile">${bone('pulse-app-icon')}
        <div class="pulse-tile-copy">${bone('pulse-tile-line')}${bone('pulse-tile-line short')}</div>
      </div>`).join('')}</div>`;
  }
  function stories() {
    return `<div class="pulse-stories" tabindex="0" role="region" aria-label="Story previews, scroll horizontally">${Array.from({ length: 12 }, (_, i) => `<div class="pulse-story-ring${i === 0 ? ' pulse-story-own' : ''}" aria-hidden="true">${bone('pulse-story-avatar')}</div>`).join('')}</div>`;
  }
  function stages(kind, app) {
    return `<section class="pulse-stage pulse-stage-minimal is-current" aria-label="Chat preview">${app ? tiles() : rows(kind)}</section>
      <section class="pulse-stage pulse-stage-stories" inert aria-hidden="true" aria-label="Circular story previews">${stories()}${rows(kind)}</section>
      <section class="pulse-stage pulse-stage-previews" inert aria-hidden="true" aria-label="Story tile previews">${stories()}<div class="pulse-previews" aria-hidden="true">${Array.from({ length: 3 }, () => `<div class="pulse-preview-tile">${bone('pulse-tile-avatar')}<div class="pulse-tile-copy">${bone('pulse-tile-line')}${bone('pulse-tile-line short')}</div></div>`).join('')}</div>${rows(kind)}</section>
      <section class="pulse-stage pulse-stage-grid" inert aria-hidden="true" aria-label="Two-column preview grid"><div class="pulse-discovery-grid" aria-hidden="true">${Array.from({ length: 4 }, () => `<div class="pulse-discovery-tile">${bone('pulse-discovery-image')}<div class="pulse-discovery-copy">${bone('pulse-avatar')}${bone('pulse-name')}</div></div>`).join('')}</div></section>`;
  }
  function render(selected = 0) {
    selected = Math.max(0, Math.min(categories.length - 1, selected));
    return `<section class="pulse-shell" aria-label="Pulse visual preview">
      <div class="pulse-feed">
        <span class="pulse-announcement" role="status" aria-live="polite" aria-atomic="true"></span>
        <nav class="pulse-tabs" role="tablist" aria-label="Pulse categories">${categories.map((item, i) => `<button type="button" class="pulse-tab" role="tab" id="pulse-tab-${i}" aria-label="${item.label}" aria-controls="pulse-panel-${i}" aria-selected="${i === selected}" tabindex="${i === selected ? 0 : -1}" data-pulse-tab="${i}">${glyph(item.icon)}</button>`).join('')}</nav>
        <div class="pulse-viewport"><div class="pulse-track" style="transform:translate3d(-${selected * 100}%,0,0)">${categories.map((item, i) => `<section class="pulse-panel" id="pulse-panel-${i}" role="tabpanel" aria-labelledby="pulse-tab-${i}" aria-description="Pull down to reveal stories; swipe up to return. Use Arrow Down or Arrow Up when focused." data-stage="0" tabindex="0" ${i === selected ? '' : 'inert aria-hidden="true"'}>${stages(['all', 'user', 'group', 'channel', 'all'][i], i === 4)}</section>`).join('')}</div></div>
        <div class="pulse-create-affordance" aria-hidden="true">
          <svg viewBox="0 0 32 32" focusable="false" aria-hidden="true">
            <path d="M29 10.5V25a4 4 0 0 1-4 4H10.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
            <rect x="3" y="3" width="22" height="22" rx="3.3" fill="currentColor" />
            <path class="pulse-create-plus" d="M14 9v10M9 14h10" fill="none" stroke-width="2" stroke-linecap="round" />
          </svg>
        </div>
      </div>
    </section>`;
  }
  let cleanup = () => {};
  function mount(container, selected = 0, onChange = () => {}) {
    cleanup();
    const shell = container.querySelector('.pulse-shell');
    if (!shell) return;
    const track = shell.querySelector('.pulse-track');
    const viewport = shell.querySelector('.pulse-viewport');
    const tabs = [...shell.querySelectorAll('.pulse-tab')];
    const panels = [...shell.querySelectorAll('.pulse-panel')];
    let drag = null;
    const abort = new AbortController();
    const listen = (target, type, fn, options = {}) => target.addEventListener(type, fn, { ...options, signal: abort.signal });
    const announcement = shell.querySelector('.pulse-announcement');
    const stageNames = ['Chat preview', 'Circular story previews', 'Story tile previews', 'Two-column preview grid'];
    let wheelTimer;
    let wheelLocked = false;
    let wheelDistance = 0;
    function reveal(panel, index) {
      const next = Math.max(0, Math.min(3, index));
      const current = Number(panel.dataset.stage);
      if (current === next) return;
      if (panel.contains(document.activeElement) && document.activeElement !== panel) panel.focus({ preventScroll: true });
      panel.dataset.stage = String(next);
      announcement.textContent = `${categories[selected].label}: ${stageNames[next]}, stage ${next + 1} of 4.`;
      panel.setAttribute('aria-description', `${stageNames[next]}, stage ${next + 1} of 4. Pull down or Arrow Down for next; swipe up or Arrow Up for previous.`);
      [...panel.children].forEach((stage, i) => {
        stage.classList.toggle('is-current', i === next);
        stage.classList.toggle('is-past', i < next);
        stage.inert = i !== next;
        if (i === next) stage.removeAttribute('aria-hidden'); else stage.setAttribute('aria-hidden', 'true');
      });
    }
    function select(index, focus = false) {
      selected = Math.max(0, Math.min(categories.length - 1, index));
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
      drag = { x: event.clientX, y: event.clientY, dx: 0, dy: 0, axis: null, rail: Boolean(event.target.closest('.pulse-stories')), id: event.pointerId };
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
        } else if (Math.abs(dy) > Math.abs(dx) * 1.2) drag.axis = 'y';
        else return;
        viewport.setPointerCapture(event.pointerId);
      }
      if (!drag.axis) return;
      drag.dy = dy;
      drag.dx = (selected === 0 && dx > 0) || (selected === categories.length - 1 && dx < 0) ? dx * .22 : dx;
      if (drag.axis === 'x') track.style.transform = `translate3d(calc(-${selected * 100}% + ${drag.dx}px),0,0)`;
    });
    const finish = event => {
      if (!drag || event.pointerId !== drag.id) return;
      const gesture = drag;
      drag = null;
      if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
      if (event.type !== 'pointercancel' && gesture.axis === 'y' && Math.abs(gesture.dy) >= 48) {
        const panel = panels[selected];
        reveal(panel, Number(panel.dataset.stage) + (gesture.dy > 0 ? 1 : -1));
      }
      const next = event.type !== 'pointercancel' && gesture.axis === 'x' && Math.abs(gesture.dx) > Math.min(64, viewport.clientWidth * .18) ? selected + (gesture.dx < 0 ? 1 : -1) : selected;
      if (gesture.axis === 'x') select(next);
    };
    listen(viewport, 'pointerup', finish);
    listen(viewport, 'pointercancel', finish);
    listen(viewport, 'lostpointercapture', event => {
      if (event.target === viewport && drag && event.pointerId === drag.id && !viewport.hasPointerCapture(event.pointerId)) { drag = null; select(selected); }
    });
    cleanup = () => { abort.abort(); clearTimeout(wheelTimer); };
  }
  root.StemmaPulse = Object.freeze({ render, mount, categories });
})(typeof window !== 'undefined' ? window : globalThis);
