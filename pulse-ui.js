/* Visual-only Pulse shell. No accounts, messaging, uploads, or network calls. */
(function attachPulse(root) {
  'use strict';
  const categories = Object.freeze([
    { label: 'All', icon: 'pulse' }, { label: 'User', icon: 'user' },
    { label: 'Group', icon: 'pulse-group' }, { label: 'Channel', icon: 'pulse-channel' },
    { label: 'App', icon: 'grid' }, { label: 'Story', icon: 'pulse-story' }
  ]);
  const glyph = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
  const bone = (classes = '') => `<span class="pulse-bone skeleton-shimmer ${classes}"></span>`;
  function rows(kind) {
    return `<div class="pulse-conversations" aria-hidden="true">${Array.from({ length: 8 }, (_, i) => `
      <div class="pulse-conversation pulse-kind-${kind}">
        <div class="pulse-avatar-wrap">${bone('pulse-avatar')}${kind === 'group' ? bone('pulse-avatar-secondary') : ''}</div>
        <div class="pulse-copy">${bone(`pulse-name pulse-length-${i % 3}`)}${bone('pulse-preview')}${kind === 'channel' ? bone('pulse-preview-short') : ''}</div>
        <div class="pulse-meta">${bone('pulse-time')}${i % 3 === 0 ? bone('pulse-dot') : ''}</div>
      </div>`).join('')}</div>`;
  }
  function tiles(kind) {
    return `<div class="pulse-${kind}-grid" aria-hidden="true">${Array.from({ length: kind === 'story' ? 6 : 9 }, () => `
      <div class="pulse-${kind}-tile">${bone(kind === 'story' ? 'pulse-tile-avatar' : 'pulse-app-icon')}
        <div class="pulse-tile-copy">${bone('pulse-tile-line')}${bone('pulse-tile-line short')}</div>
      </div>`).join('')}</div>`;
  }
  function render(selected = 0) {
    selected = Math.max(0, Math.min(5, selected));
    return `<section class="pulse-shell" aria-label="Pulse visual preview">
      <div class="pulse-stories" aria-hidden="true">${Array.from({ length: 7 }, (_, i) => `<div class="pulse-story-ring${i === 0 ? ' pulse-story-own' : ''}">${bone('pulse-story-avatar')}</div>`).join('')}</div>
      <div class="pulse-previews" aria-hidden="true">${Array.from({ length: 3 }, () => `<div class="pulse-preview-tile">${bone('pulse-tile-avatar')}<div class="pulse-tile-copy">${bone('pulse-tile-line')}${bone('pulse-tile-line short')}</div></div>`).join('')}</div>
      <div class="pulse-feed">
        <nav class="pulse-tabs" role="tablist" aria-label="Pulse categories">${categories.map((item, i) => `<button type="button" class="pulse-tab" role="tab" id="pulse-tab-${i}" aria-label="${item.label}" aria-controls="pulse-panel-${i}" aria-selected="${i === selected}" tabindex="${i === selected ? 0 : -1}" data-pulse-tab="${i}">${glyph(item.icon)}</button>`).join('')}</nav>
        <div class="pulse-viewport"><div class="pulse-track" style="transform:translate3d(-${selected * 100}%,0,0)">${categories.map((item, i) => `<section class="pulse-panel" id="pulse-panel-${i}" role="tabpanel" aria-labelledby="pulse-tab-${i}" tabindex="0" ${i === selected ? '' : 'inert aria-hidden="true"'}>${i === 4 ? tiles('app') : i === 5 ? tiles('story') : rows(['all', 'user', 'group', 'channel'][i])}</section>`).join('')}</div></div>
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
    const listen = (target, type, fn) => target.addEventListener(type, fn, { signal: abort.signal });
    function select(index, focus = false) {
      selected = Math.max(0, Math.min(categories.length - 1, index));
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
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? 5 : selected + (event.key === 'ArrowRight' ? 1 : -1);
      select(index, true);
    });
    listen(viewport, 'pointerdown', event => {
      if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
      drag = { x: event.clientX, y: event.clientY, dx: 0, horizontal: false, id: event.pointerId };
    });
    listen(viewport, 'pointermove', event => {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.horizontal && Math.abs(dy) > Math.max(8, Math.abs(dx))) { drag = null; return; }
      if (!drag.horizontal && Math.abs(dx) > Math.max(8, Math.abs(dy))) {
        drag.horizontal = true;
        viewport.setPointerCapture(event.pointerId);
        track.classList.add('is-dragging');
      }
      if (!drag.horizontal) return;
      drag.dx = (selected === 0 && dx > 0) || (selected === 5 && dx < 0) ? dx * .22 : dx;
      track.style.transform = `translate3d(calc(-${selected * 100}% + ${drag.dx}px),0,0)`;
    });
    const finish = event => {
      if (!drag || event.pointerId !== drag.id) return;
      const next = event.type !== 'pointercancel' && drag.horizontal && Math.abs(drag.dx) > Math.min(64, viewport.clientWidth * .18) ? selected + (drag.dx < 0 ? 1 : -1) : selected;
      if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
      drag = null;
      select(next);
    };
    listen(viewport, 'pointerup', finish);
    listen(viewport, 'pointercancel', finish);
    cleanup = () => abort.abort();
  }
  root.StemmaPulse = Object.freeze({ render, mount, categories });
})(typeof window !== 'undefined' ? window : globalThis);
