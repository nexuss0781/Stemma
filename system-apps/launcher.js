/* Only bundled, trusted System Apps are launchable. Commands are deployment metadata, never browser-executed. */
(function attachSystemApps(root) {
  'use strict';
  const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const view = () => '<section class="system-apps-launcher" aria-label="Apps"><h2>Apps</h2><div class="system-apps-grid" data-system-apps-grid role="list"><p role="status">Loading…</p></div></section>';
  async function mount(container, { signal } = {}) {
    const grid = container.querySelector('[data-system-apps-grid]');
    if (!grid) return;
    try {
      const response = await fetch('/system-apps/apps.json', { credentials: 'same-origin', cache: 'no-store', signal });
      if (!response.ok) throw new Error('Apps unavailable.');
      const data = await response.json();
      if (signal?.aborted || !grid.isConnected) return;
      const safePath = path => typeof path === 'string' && /^\/system-apps\/[a-z0-9/_.-]+$/.test(path) && !path.includes('..');
      const apps = Array.isArray(data.apps) ? data.apps.filter(app => app.kind === 'system' && app.trusted === true && safePath(app.launch?.url) && safePath(app.icon)) : [];
      grid.innerHTML = apps.map(app => `<div role="listitem"><a class="system-app-tile" href="${escape(app.launch.url)}" aria-label="Open ${escape(app.name)}"><span class="system-app-icon"><img src="${escape(app.icon)}" width="88" height="88" alt="" /></span><span class="system-app-name">${escape(app.name)}</span></a></div>`).join('');
      if (!apps.length) grid.textContent = 'No apps yet.';
    } catch (error) {
      if (error.name === 'AbortError' || signal?.aborted || !grid.isConnected) return;
      grid.innerHTML = '<button class="system-apps-retry" type="button">Retry apps</button>';
      grid.querySelector('button').addEventListener('click', () => void mount(container, { signal }), { once: true, signal });
    }
  }
  root.StemmaSystemApps = Object.freeze({ view, mount });
})(typeof window !== 'undefined' ? window : globalThis);
