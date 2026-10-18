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
  const legacyName = { textContent: '', title: '', hidden: true };
  const legacyNamePlaceholder = { hidden: false };
  const nickname = { textContent: '', hidden: true };
  function createImage() {
    let photoSource = '';
    return {
      hidden: true,
      onerror: null,
      get src() { return photoSource; },
      set src(value) { photoSource = String(value); attributes.set(`${this.id}:src`, photoSource); },
      getAttribute(key) { return key === 'src' ? (attributes.get(`${this.id}:src`) ?? null) : null; },
      setAttribute(key, value) { attributes.set(`${this.id}:${key}`, String(value)); if (key === 'src') photoSource = String(value); },
      removeAttribute(key) { attributes.delete(`${this.id}:${key}`); if (key === 'src') photoSource = ''; }
    };
  }
  const photo = Object.assign(createImage(), { id: 'overview-profile-photo' });
  const reflection = Object.assign(createImage(), { id: 'overview-photo-reflection' });
  const photoPlaceholder = { hidden: false };
  const frame = {
    attributes: new Map([['aria-hidden', 'true']]),
    classes: new Set(),
    classList: {
      add(name) { frame.classes.add(name); },
      remove(name) { frame.classes.delete(name); },
      contains(name) { return frame.classes.has(name); },
      toggle(name, force) {
        const enabled = force === undefined ? !frame.classes.has(name) : Boolean(force);
        if (enabled) frame.classes.add(name); else frame.classes.delete(name);
        return enabled;
      }
    },
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
  };
  const elements = new Map([
    ['overview-student-name', legacyName],
    ['overview-name-placeholder', legacyNamePlaceholder],
    ['overview-student-nickname', nickname],
    ['overview-profile-photo', photo],
    ['overview-photo-reflection', reflection],
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
  return { context, nickname, photo, reflection, photoPlaceholder, frame };
}

function render(harness) {
  vm.runInContext('renderOverviewIdentity();', harness.context);
}

test('authenticated saved profile shows only its trimmed persisted nickname and mirrors the photo', () => {
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
  assert.equal(h.nickname.textContent, 'Countess');
  assert.equal(h.nickname.hidden, false);
  assert.equal(h.photo.src, 'blob:student-photo');
  assert.equal(h.photo.hidden, false);
  assert.equal(h.reflection.src, 'blob:student-photo');
  assert.equal(h.reflection.hidden, false);
  assert.equal(h.photoPlaceholder.hidden, true);
  assert.equal(h.frame.attributes.get('aria-hidden'), 'false');
  assert.equal(h.frame.classList.contains('has-profile-photo'), true);
});

test('guest mode ignores lingering saved profile and photo and leaves the original placeholders', () => {
  const h = createHarness({
    authenticated: false,
    profile: { firstName: 'Saved', middleName: 'Student', lastName: 'Ignored', nickName: 'Stale nickname' },
    photoURL: 'blob:stale-account-photo'
  });

  render(h);
  assert.equal(h.nickname.textContent, '');
  assert.equal(h.nickname.hidden, true);
  assert.equal(h.photo.hidden, true);
  assert.equal(h.photo.getAttribute('src'), null);
  assert.equal(h.reflection.hidden, true);
  assert.equal(h.reflection.getAttribute('src'), null);
  assert.equal(h.photoPlaceholder.hidden, false);
  assert.equal(h.frame.attributes.get('aria-hidden'), 'true');
  assert.equal(h.frame.classList.contains('has-profile-photo'), false);
});

test('missing profile or photo leaves the nickname empty and preserves portrait skeleton', () => {
  const h = createHarness({ authenticated: true, profile: null, photoURL: 'blob:unowned-photo' });

  render(h);
  assert.equal(h.nickname.textContent, '');
  assert.equal(h.nickname.hidden, true);
  assert.equal(h.photo.hidden, true);
  assert.equal(h.photo.getAttribute('src'), null);
  assert.equal(h.reflection.hidden, true);
  assert.equal(h.reflection.getAttribute('src'), null);
  assert.equal(h.photoPlaceholder.hidden, false);
  assert.equal(h.frame.attributes.get('aria-hidden'), 'true');
});

test('account reset clears previously rendered identity even if stale profile and photo remain in memory', () => {
  const h = createHarness({
    authenticated: true,
    profile: { firstName: 'Mina', middleName: 'Example', nickName: 'Mina' },
    photoURL: 'blob:old-account-photo'
  });
  render(h);
  assert.equal(h.nickname.textContent, 'Mina');
  assert.equal(h.photo.hidden, false);

  h.context.googleAuthenticated = false;
  render(h);
  assert.equal(h.nickname.textContent, '');
  assert.equal(h.nickname.hidden, true);
  assert.equal(h.photo.getAttribute('src'), null);
  assert.equal(h.photo.hidden, true);
  assert.equal(h.reflection.getAttribute('src'), null);
  assert.equal(h.reflection.hidden, true);
  assert.equal(h.photoPlaceholder.hidden, false);
  assert.equal(h.frame.attributes.get('aria-hidden'), 'true');
  assert.equal(h.frame.classList.contains('has-profile-photo'), false);
});

test('photo load failure hides both images and restores the portrait skeleton', () => {
  const h = createHarness({
    authenticated: true,
    profile: { firstName: 'Sam' },
    photoURL: 'blob:unreadable-photo'
  });
  render(h);
  assert.equal(typeof h.photo.onerror, 'function');
  h.photo.onerror();

  assert.equal(h.photo.hidden, true);
  assert.equal(h.reflection.hidden, true);
  assert.equal(h.photoPlaceholder.hidden, false);
  assert.equal(h.frame.attributes.get('aria-hidden'), 'true');
  assert.equal(h.frame.classList.contains('has-profile-photo'), false);
});

test('nickname is assigned as textContent rather than interpreted as markup', () => {
  const payload = '<img src=x onerror="alert(1)">';
  const h = createHarness({
    authenticated: true,
    profile: { firstName: 'Ignored', nickName: `  ${payload}  ` }
  });

  render(h);
  assert.equal(h.nickname.textContent, payload);
  assert.equal(h.nickname.innerHTML, undefined, 'renderer does not populate nickname through innerHTML');
  assert.match(rendererSource, /nickname\.textContent\s*=/);
  assert.doesNotMatch(rendererSource, /nickname\.innerHTML\s*=/);
});

test('empty nickname is hidden and an unusually long nickname is preserved after trimming', () => {
  const empty = createHarness({ authenticated: true, profile: { nickName: '   \t  ' } });
  render(empty);
  assert.equal(empty.nickname.textContent, '');
  assert.equal(empty.nickname.hidden, true);

  const longNickname = 'N'.repeat(500);
  const long = createHarness({ authenticated: true, profile: { nickName: ` ${longNickname} ` } });
  render(long);
  assert.equal(long.nickname.textContent, longNickname);
  assert.equal(long.nickname.hidden, false);
});

test('hero markup contains nickname and rear reflection before front photo, with fallback and contain fit', () => {
  const hero = html.match(/<section class="hero-card"[\s\S]*?<\/section>/)?.[0];
  assert.ok(hero, 'existing Overview hero card exists');
  for (const id of [
    'overview-student-nickname', 'overview-photo-reflection', 'overview-profile-photo',
    'overview-photo-placeholder', 'overview-photo-frame'
  ]) assert.match(hero, new RegExp(`id="${id}"`), `${id} remains inside the hero card`);
  assert.match(hero, /id="overview-photo-placeholder"[^>]*class="portrait-skeleton skeleton-shimmer"/);
  assert.match(hero, /<p id="overview-student-nickname" class="overview-student-nickname" hidden><\/p>/);
  assert.match(hero, /id="overview-photo-reflection" class="overview-photo-reflection" alt="" aria-hidden="true" hidden/);
  assert.match(hero, /id="overview-profile-photo"[^>]*hidden/);
  assert.ok(hero.indexOf('overview-photo-reflection') < hero.indexOf('overview-photo-placeholder'));
  assert.ok(hero.indexOf('overview-photo-reflection') < hero.indexOf('overview-profile-photo'));
  assert.doesNotMatch(hero, /overview-mock-balance|overview-balance-value|balance-visibility-toggle/);
  assert.match(styles, /\.hero-card \.overview-profile-photo\s*\{[^}]*object-fit:\s*contain\s*;/s);
  const reflectionStyle = styles.match(/\.overview-photo-reflection\s*\{([^}]*)\}/s)?.[1] ?? '';
  assert.match(reflectionStyle, /filter:\s*[^;]*grayscale\(1\)[^;]*blur\(12px\)/);
  assert.match(reflectionStyle, /object-fit:\s*cover/);
  const photoFrameStyle = styles.match(/\.avatar-glass\.has-profile-photo\s*\{([^}]*)\}/s)?.[1] ?? '';
  assert.ok(photoFrameStyle, 'photo frame has a dedicated profile-photo state');
  assert.match(photoFrameStyle, /background:\s*rgba\(236,205,151,\.23\)/);
  assert.doesNotMatch(photoFrameStyle, /(?:^|;)\s*filter\s*:/, 'glass frame must not grayscale the front layer');
  assert.match(photoFrameStyle, /backdrop-filter:\s*none/);
  const frontGlassStyle = styles.match(/\.avatar-glass\.has-profile-photo::after\s*\{([^}]*)\}/s)?.[1] ?? '';
  assert.match(frontGlassStyle, /background:\s*linear-gradient\(145deg, rgba\(239,210,161,\.46\), rgba\(215,164,124,\.4\)\)/,
    'front glass retains the original warm portrait palette');
  assert.doesNotMatch(frontGlassStyle, /filter\s*:/);
  const fullColorPhotoStyle = styles.match(/\.avatar-glass\.has-profile-photo \.overview-profile-photo\s*\{([^}]*)\}/s)?.[1] ?? '';
  assert.match(fullColorPhotoStyle, /z-index:\s*1/, 'actual photo is above the warm glass, not tinted by it');
  for (const rule of styles.matchAll(/[^{}]*\.overview-profile-photo\s*\{([^}]*)\}/g)) {
    assert.doesNotMatch(rule[1], /(?:^|;)\s*(?:filter|opacity|mix-blend-mode)\s*:/,
      'actual photo must retain its original full-color appearance');
  }
  assert.match(styles, /\.hero-card\s*\{[^}]*border-radius\s*:/s, 'existing hero rectangle retains its rounded-card styling');
});
