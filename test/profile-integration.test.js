import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';
import { once } from 'node:events';
import { buildConfig, createApp } from '../server.js';

const root = new URL('../', import.meta.url);
const app = await readFile(new URL('app.js', root), 'utf8');
const html = await readFile(new URL('index.html', root), 'utf8');
const profilePhotoSource = await readFile(new URL('profile-photo.js', root), 'utf8');
const profileUiSource = await readFile(new URL('profile-ui.js', root), 'utf8');

function appBlock(startMarker, endMarker) {
  const start = app.indexOf(startMarker);
  const end = app.indexOf(endMarker, start);
  assert.notEqual(start, -1, `app.js must contain ${startMarker}`);
  assert.ok(end > start, `${endMarker} must follow ${startMarker}`);
  return app.slice(start, end);
}

function makeGrid() {
  const attributes = new Map();
  const classes = new Set();
  return {
    innerHTML: '', tabIndex: -1,
    classList: {
      toggle(name, force) { if (force) classes.add(name); else classes.delete(name); },
      contains(name) { return classes.has(name); }
    },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    removeAttribute(name) { attributes.delete(name); },
    attributes,
    classes
  };
}

function createRenderHarness({ profile, state, photoURL, photoNotice }) {
  const grid = makeGrid();
  const context = vm.createContext({
    document: { getElementById: id => id === 'dashboard-grid' ? grid : null },
    activeRoute: 'profile', activeTabs: { profile: 0, cards: 0 },
    payments: { isBillOpen: false, isReceiptOpen: false },
    paymentSlides: ['For You', 'For friend'],
    savedStudentProfile: profile, profileReadState: state,
    studentPhotoURL: photoURL, profilePhotoNotice: photoNotice,
    renderForYou: () => '', renderSkeletonCards: () => '',
    renderDepositForm: () => '', renderPaymentHistory: () => ''
  });
  vm.runInContext(profileUiSource, context, { filename: 'profile-ui.js' });
  const start = app.indexOf('function renderCards() {');
  const end = app.indexOf('function render() {', start);
  assert.ok(start >= 0 && end > start, 'app.js must define renderCards before render');
  vm.runInContext(app.slice(start, end), context, { filename: 'app.js renderCards integration' });
  return { context, grid };
}

test('Profile remains the fifth and far-right existing route, without creating a new bottom-nav item', () => {
  const routesStart = app.indexOf('const sections = [');
  const routesEnd = app.indexOf('];', routesStart);
  assert.ok(routesStart >= 0 && routesEnd > routesStart);
  const routeBlock = app.slice(routesStart, routesEnd + 2);
  const routeIds = [...routeBlock.matchAll(/\bid:\s*'([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(routeIds, ['cards', 'activity', 'overview', 'goals', 'profile']);
  assert.match(routeBlock, /\{ id: 'profile', icon: 'user', label: 'Profile' \}\s*\];?$/,
    'Profile occupies the existing fifth/far-right route position');
  assert.equal((app.match(/id:\s*'profile'/g) || []).length, 1, 'there is one Profile route, not an extra navigation tab');
  assert.match(app, /bottomNav\.innerHTML\s*=\s*`[\s\S]*?\$\{sections\.map\(item =>/,
    'bottom navigation is rendered from the same existing sections array');
});

test('renderCards explicitly renders saved profile data with current read and photo state', () => {
  const profile = { firstName: 'Ada', middleName: 'Byron', lastName: 'Lovelace', studentId: 'ST-123', department: 'Math', nickName: 'Ada', username: 'ada_l', bio: 'Math' };
  const h = createRenderHarness({ profile, state: 'ready', photoURL: 'blob:profile-preview', photoNotice: 'Stored on this device.' });
  h.context.renderCards();
  assert.equal(h.grid.attributes.get('aria-label'), 'Your profile');
  assert.equal(h.grid.tabIndex, 0);
  assert.match(h.grid.innerHTML, /id='student-profile-display-name'[^>]*>Ada<\/h1>/);
  assert.match(h.grid.innerHTML, /src='blob:profile-preview'/);
  assert.match(h.grid.innerHTML, /Stored on this device\./);
  assert.match(h.grid.innerHTML, /Identity|Student details|Account &amp; about/);

  const loading = createRenderHarness({ profile, state: 'loading', photoURL: '', photoNotice: '' });
  loading.context.renderCards();
  assert.match(loading.grid.innerHTML, /Loading your profile/);
  assert.doesNotMatch(loading.grid.innerHTML, /Ada|student-profile-section/);
});

test('device photo account key is derived only from verified Google session email', () => {
  const start = app.indexOf('googleAuthenticated = Boolean(status.authenticated');
  const endMarker = 'const nextPhotoKey = email ? `google:${email}` : \'\';';
  const end = app.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, 'the session must derive a photo key after verifying Google authentication');
  const accountKeyCode = app.slice(start, end + endMarker.length);
  assert.match(accountKeyCode, /status\.authProvider === 'google'/);
  assert.match(accountKeyCode, /status\.googleProfile\.email/);
  assert.match(accountKeyCode, /trim\(\)\.toLowerCase\(\)/);
  assert.match(accountKeyCode, /`google:\$\{email\}`/);
  assert.doesNotMatch(accountKeyCode, /studentId|username|nickName|localStorage|sessionStorage|window\./,
    'form data and ambient browser globals are not account-key fallbacks');

  const context = vm.createContext({ status: { authenticated: true, authProvider: 'google', googleProfile: { email: ' ADA@Example.COM ' } } });
  assert.equal(vm.runInContext(`${accountKeyCode}\nnextPhotoKey;`, context, { filename: 'app.js verified photo account key' }), 'google:ada@example.com');
  for (const status of [
    { authenticated: false, authProvider: 'google', googleProfile: { email: 'ada@example.com' } },
    { authenticated: true, authProvider: 'fayda', googleProfile: { email: 'ada@example.com' } },
    { authenticated: true, authProvider: 'google', googleProfile: {} }
  ]) {
    const guest = vm.createContext({ status });
    assert.equal(vm.runInContext(`${accountKeyCode}\nnextPhotoKey;`, guest, { filename: 'app.js unverified photo account key' }), '',
      'unauthenticated, non-Google, or email-less users receive no photo key');
  }
  assert.match(app, /profilePhotoAccountKey = nextPhotoKey;/);
});

test('photo controller stores and restores with the account key and ignores a stale restore after account/selection changes', async () => {
  const calls = [];
  const storedBlob = new Blob(['photo'], { type: 'image/webp' });
  const replacementBlob = new Blob(['other'], { type: 'image/webp' });
  let resolveGet;
  const store = {
    put: async (key, blob) => { calls.push(['put', key, blob]); },
    get: key => { calls.push(['get', key]); return new Promise(resolve => { resolveGet = resolve; }); }
  };
  const preview = { src: '', hidden: true };
  const placeholder = { hidden: false };
  const classCalls = [];
  const profilePhotoInput = { files: [], addEventListener() {} };
  const context = vm.createContext({
    document: { getElementById: () => profilePhotoInput },
    DeviceProfilePhotoStore: class { constructor() { calls.push(['store-created']); return store; } },
    URL: {
      createObjectURL: blob => { calls.push(['create-url', blob]); return 'blob:restored-photo'; },
      revokeObjectURL: url => calls.push(['revoke-url', url])
    },
    activeRoute: 'profile', dashboardEntered: true,
    profilePhotoAccountKey: 'google:ada@example.com',
    profilePhotoNotice: '', deviceProfilePhotoStore: null,
    preparedProfilePhoto: storedBlob, selectedProfilePhotoChanged: true,
    profilePhotoPreparationError: false, profilePhotoPreparation: Promise.resolve(), profilePhotoRevision: 4,
    studentPhotoURL: 'blob:previous', studentPhotoPreview: preview, studentPhotoPlaceholder: placeholder,
    studentPhotoButton: { classList: { add: name => classCalls.push(name) }, setAttribute() {} },
    studentPhotoLabel: { textContent: '' },
    renderCards() { calls.push(['render']); },
    console
  });
  vm.runInContext(appBlock('// Profile photo integration:', '// End Profile photo integration.'), context,
    { filename: 'app.js profile photo integration' });

  await context.persistSelectedProfilePhoto();
  assert.equal(calls.find(call => call[0] === 'put')[1], 'google:ada@example.com');
  assert.equal(calls.find(call => call[0] === 'put')[2], storedBlob);
  assert.equal(context.selectedProfilePhotoChanged, false);
  assert.equal(context.profilePhotoNotice, '');

  context.profilePhotoAccountKey = 'google:ada@example.com';
  context.selectedProfilePhotoChanged = false;
  context.studentPhotoURL = 'blob:previous';
  const restoringSavedPhoto = context.restoreDeviceProfilePhoto();
  assert.deepEqual(calls.find(call => call[0] === 'get'), ['get', 'google:ada@example.com']);
  resolveGet(storedBlob);
  await restoringSavedPhoto;
  assert.equal(context.studentPhotoURL, 'blob:restored-photo', 'a saved photo is restored as the current preview URL');
  assert.equal(preview.src, 'blob:restored-photo');
  assert.equal(preview.hidden, false);
  assert.equal(placeholder.hidden, true);
  assert.deepEqual(calls.find(call => call[0] === 'revoke-url'), ['revoke-url', 'blob:previous'],
    'a successful restore revokes the replaced preview URL');

  context.studentPhotoURL = 'blob:selection-current';
  preview.src = 'blob:selection-current';
  context.selectedProfilePhotoChanged = false;
  const restoring = context.restoreDeviceProfilePhoto();
  context.profilePhotoAccountKey = 'google:other@example.com';
  context.selectedProfilePhotoChanged = true;
  context.preparedProfilePhoto = replacementBlob;
  resolveGet(replacementBlob);
  await restoring;
  assert.equal(context.studentPhotoURL, 'blob:selection-current', 'a late restore cannot replace a newly selected photo URL');
  assert.equal(preview.src, 'blob:selection-current');
  assert.equal(preview.hidden, false);
  assert.equal(placeholder.hidden, true);
  assert.equal(calls.filter(call => call[0] === 'revoke-url').length, 1, 'a stale restore does not revoke the active preview');
});

test('failed photo storage reports session-only status instead of claiming persistence', async () => {
  const profilePhotoInput = { files: [], addEventListener() {} };
  const context = vm.createContext({
    document: { getElementById: () => profilePhotoInput },
    DeviceProfilePhotoStore: class { constructor() { return { put: async () => { throw new Error('quota exceeded'); } }; } },
    URL: { revokeObjectURL() {} }, activeRoute: 'profile', dashboardEntered: true,
    profilePhotoAccountKey: 'google:ada@example.com', profilePhotoNotice: '', deviceProfilePhotoStore: null,
    preparedProfilePhoto: new Blob(['photo'], { type: 'image/webp' }), selectedProfilePhotoChanged: true,
    profilePhotoPreparationError: false, profilePhotoPreparation: Promise.resolve(), profilePhotoRevision: 2,
    studentPhotoURL: 'blob:selected', renderCards() {}, console
  });
  vm.runInContext(appBlock('// Profile photo integration:', '// End Profile photo integration.'), context,
    { filename: 'app.js failed profile photo storage' });
  await context.saveProfilePhotoFromPage();
  assert.match(context.profilePhotoNotice, /available for this session only/i);
  assert.match(context.profilePhotoNotice, /could not be saved on this device/i);
  assert.equal(context.selectedProfilePhotoChanged, true, 'failed storage must not clear the unsaved-selection state');
  assert.doesNotMatch(context.profilePhotoNotice, /photo was saved on this device/i);
});

test('profile-photo.js and profile-ui.js are served as unauthenticated valid JavaScript assets', async t => {
  const server = createApp({ config: buildConfig({ NODE_ENV: 'test', SESSION_SECRET: 'profile-integration-static-assets-regression-secret' }) }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.close(); await once(server, 'close'); });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const asset of ['profile-photo.js', 'profile-ui.js']) {
    const response = await fetch(`${base}/${asset}`);
    assert.equal(response.status, 200, `${asset} is available without a signed-in session`);
    assert.match(response.headers.get('content-type'), /javascript/);
    assert.match(response.headers.get('cache-control'), /max-age=/);
    const source = await response.text();
    assert.ok(source.length > 0);
    assert.doesNotThrow(() => new vm.Script(source, { filename: asset }), `${asset} response parses as JavaScript`);
    assert.equal(source, asset === 'profile-photo.js' ? profilePhotoSource : profileUiSource,
      `${asset} serves the checked-in module rather than an unrelated response`);
  }
});
