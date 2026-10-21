import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const read = path => fs.readFile(new URL('../' + path, import.meta.url), 'utf8');

test('Teacher Attendance has a complete trusted TypeScript System App configuration', async () => {
  const config = JSON.parse(await read('system-apps/apps.json'));
  assert.equal(config.version, 1);
  assert.equal(config.apps.length, 1);
  const app = config.apps[0];
  assert.equal(app.name, 'Teacher Attendance');
  assert.equal(app.kind, 'system'); assert.equal(app.trusted, true);
  assert.equal(app.language, 'TypeScript'); assert.ok(app.description.length > 20);
  assert.equal(app.launch.url, '/system-apps/attendance/');
  assert.equal(app.launch.fullscreen, true);
  assert.equal(app.persistence.driver, 'postgresql'); assert.equal(app.persistence.scope, 'account');
  assert.equal(app.runtime.install, 'npm ci'); assert.equal(app.runtime.start, 'npm start');
  for (const path of [app.icon, app.splashImage, app.launch.url + 'index.html', app.launch.url + 'app.ts', app.launch.url + 'app.js']) {
    assert.ok((await read(path.slice(1))).length > 20);
  }
});

test('Apps launcher has exactly three responsive columns and large icons', async () => {
  const css = await read('system-apps/launcher.css');
  assert.match(css, /grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(css, /clamp\(72px,16vw,100px\)/);
  const pulse = await read('pulse-ui.js');
  assert.match(pulse, /kind === 'app'.*StemmaSystemApps/);
  assert.match(pulse, /StemmaSystemApps\?\.mount/);
  assert.match(await read('index.html'), /system-apps\/launcher.js/);
  assert.match(await read('app.js'), /appsLink \? 'pulse'/);
});

test('Launcher rejects external, traversal and untrusted apps, escapes names, and never runs commands', async () => {
  const source = await read('system-apps/launcher.js');
  const grid = { innerHTML: '', isConnected: true };
  const container = { querySelector: () => grid };
  const valid = { kind: 'system', trusted: true, name: '<Teacher>', icon: '/system-apps/attendance/icon.svg', launch: { url: '/system-apps/attendance/' }, runtime: { start: 'malicious command' } };
  const root = {};
  const context = { window: root, fetch: async () => ({ ok: true, json: async () => ({ apps: [valid, { ...valid, trusted: false }, { ...valid, launch: { url: 'https://evil.invalid/' } }, { ...valid, icon: '/system-apps/../secret' }] }) }) };
  vm.runInNewContext(source, context);
  await root.StemmaSystemApps.mount(container);
  assert.equal((grid.innerHTML.match(/class="system-app-tile"/g) || []).length, 1);
  assert.match(grid.innerHTML, /&lt;Teacher&gt;/); assert.doesNotMatch(grid.innerHTML, /malicious command|evil.invalid|\.\./);
});
