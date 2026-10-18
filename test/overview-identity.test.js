import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const [app, html, styles] = await Promise.all([
  readFile(new URL('app.js', root), 'utf8'),
  readFile(new URL('index.html', root), 'utf8'),
  readFile(new URL('styles.css', root), 'utf8')
]);

const rendererStart = app.indexOf('function renderOverviewIdentity() {');
const rendererEnd = app.indexOf('\nfunction renderSidebarIdentity()', rendererStart);
assert.ok(rendererStart >= 0 && rendererEnd > rendererStart,
  'app.js defines renderOverviewIdentity before renderSidebarIdentity');
const rendererSource = app.slice(rendererStart, rendererEnd);

function createHarness({ authenticated = true, profile = null, photoURL = '' } = {}) {
  const attributes = new Map();
  const name = { textContent: '', title: '', hidden: true };
  const namePlaceholder = { hidden: false };
  let photoSource = '';
  const photo = {
    hidden: true,
    onerror: null,
    get src() { return photoSource; },
    set src(value) { photoSource = String(value); attributes.set('src', photoSource); },
    getAttribute(key) { return key === 'src' ? (attributes.get('src') ?? null) : null; },
    setAttribute(key, value) { attributes.set(key, String(value)); if (key === 'src') photoSource = String(value); },
    removeAttribute(key) { attributes.delete(key); if (key === 'src') photoSource = ''; }
  };
  const photoPlaceholder = { hidden: false };
  const frame = {
    attributes: new Map([['aria-hidden', 'true']]),
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
  };
  const elements = new Map([
    ['overview-student-name', name],
    ['overview-name-placeholder', namePlaceholder],
    ['overview-profile-photo', photo],
    ['overview-photo-placeholder', photoPlaceholder],
    ['overview-photo-frame', frame]
  ]);
  const context = vm.createContext({
    document: { getElementById: id => elements.get(id) ?? null },
    googleAuthenticated: authenticated,
    savedStudentProfile: profile,
    studentPhotoURL: photoURL
  });
  vm.runInContext(rendererSource, context, { filename: 'app.js renderOverviewIdentity' });
  return { context, name, namePlaceholder, photo, photoPlaceholder, frame };
}

function render(harness) {
  vm.runInContext('renderOverviewIdentity();', harness.context);
}

test('authenticated saved profile shows only trimmed first and middle names and photo', () => {
  const h = createHarness({
    authenticated: true,
    profile: {
      firstName: '  Ada  ', middleName: ' Byron ', lastName: 'Lovelace',
      nickName: 'Countess', username: 'ada', email: 'private@example.test',
      googleName: 'Google Display Name'
    },
    photoURL: 'blob:student-photo'
  });

  render(h);
  assert.equal(h.name.textContent, 'Ada Byron');
  assert.equal(h.name.title, 'Ada Byron');
  assert.equal(h.name.hidden, false);
  assert.equal(h.namePlaceholder.hidden, true);
  assert.equal(h.photo.src, 'blob:student-photo');
  assert.equal(h.photo.hidden, false);
  assert.equal(h.photoPlaceholder.hidden, true);
  assert.equal(h.frame.attributes.get('aria-hidden'), 'false');
});

test('guest mode ignores lingering saved profile and photo and leaves the original placeholders', () => {
  const h = createHarness({
    authenticated: false,
    profile: { firstName: 'Saved', middleName: 'Student', lastName: 'Ignored' },
    photoURL: 'blob:stale-account-photo'
  });

  render(h);
  assert.equal(h.name.textContent, '');
  assert.equal(h.name.hidden, true);
  assert.equal(h.namePlaceholder.hidden, false);
  assert.equal(h.photo.hidden, true);
  assert.equal(h.photo.getAttribute('src'), null);
  assert.equal(h.photoPlaceholder.hidden, false);
  assert.equal(h.frame.attributes.get('aria-hidden'), 'true');
});

test('missing middle name displays only first name; missing photo preserves portrait skeleton', () => {
  const h = createHarness({ authenticated: true, profile: { firstName: '  Hana  ', lastName: 'Ignored' } });

  render(h);
  assert.equal(h.name.textContent, 'Hana');
  assert.equal(h.name.hidden, false);
  assert.equal(h.namePlaceholder.hidden, true);
  assert.equal(h.photo.hidden, true);
  assert.equal(h.photo.getAttribute('src'), null);
  assert.equal(h.photoPlaceholder.hidden, false);
  assert.equal(h.frame.attributes.get('aria-hidden'), 'true');
});

test('account reset clears previously rendered identity even if stale profile and photo remain in memory', () => {
  const h = createHarness({
    authenticated: true,
    profile: { firstName: 'Mina', middleName: 'Example' },
    photoURL: 'blob:old-account-photo'
  });
  render(h);
  assert.equal(h.name.textContent, 'Mina Example');
  assert.equal(h.photo.hidden, false);

  h.context.googleAuthenticated = false;
  render(h);
  assert.equal(h.name.textContent, '');
  assert.equal(h.name.title, '');
  assert.equal(h.name.hidden, true);
  assert.equal(h.namePlaceholder.hidden, false);
  assert.equal(h.photo.getAttribute('src'), null);
  assert.equal(h.photo.hidden, true);
  assert.equal(h.photoPlaceholder.hidden, false);
  assert.equal(h.frame.attributes.get('aria-hidden'), 'true');
});

test('photo load failure hides the image and restores the portrait skeleton', () => {
  const h = createHarness({
    authenticated: true,
    profile: { firstName: 'Sam' },
    photoURL: 'blob:unreadable-photo'
  });
  render(h);
  assert.equal(typeof h.photo.onerror, 'function');
  h.photo.onerror();

  assert.equal(h.photo.hidden, true);
  assert.equal(h.photoPlaceholder.hidden, false);
  assert.equal(h.frame.attributes.get('aria-hidden'), 'true');
});

test('profile text is assigned as textContent rather than interpreted as markup', () => {
  const payload = '<img src=x onerror="alert(1)">';
  const h = createHarness({
    authenticated: true,
    profile: { firstName: payload, middleName: '<script>bad()</script>' }
  });

  render(h);
  assert.equal(h.name.textContent, `${payload} <script>bad()</script>`);
  assert.equal(h.name.title, `${payload} <script>bad()</script>`);
  assert.equal(h.name.innerHTML, undefined, 'renderer does not populate the name through innerHTML');
  assert.match(rendererSource, /name\.textContent\s*=\s*displayName/);
  assert.doesNotMatch(rendererSource, /name\.innerHTML\s*=/);
});

test('hero markup keeps both fallback skeletons, the same balance card, and photo uses contain fit', () => {
  const hero = html.match(/<section class="hero-card"[\s\S]*?<\/section>/)?.[0];
  assert.ok(hero, 'existing Overview hero card exists');
  for (const id of [
    'overview-student-name', 'overview-name-placeholder', 'overview-profile-photo',
    'overview-photo-placeholder', 'overview-photo-frame'
  ]) assert.match(hero, new RegExp(`id="${id}"`), `${id} remains inside the hero card`);
  assert.match(hero, /id="overview-name-placeholder"[^>]*class="hero-skeleton-name skeleton-shimmer"/);
  assert.match(hero, /id="overview-photo-placeholder"[^>]*class="portrait-skeleton skeleton-shimmer"/);
  assert.match(hero, /id="overview-student-name"[^>]*hidden/);
  assert.match(hero, /id="overview-profile-photo"[^>]*hidden/);
  assert.match(hero, /class="overview-mock-balance" data-preview-only="true"/);
  assert.match(styles, /\.hero-card \.overview-profile-photo\s*\{[^}]*object-fit:\s*contain\s*;/s);
  assert.match(styles, /\.hero-card\s*\{[^}]*border-radius\s*:/s, 'existing hero rectangle retains its rounded-card styling');
});
