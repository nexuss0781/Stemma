import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';
import { once } from 'node:events';
import { buildConfig, createApp } from '../server.js';

const root = new URL('../', import.meta.url);
const html = await readFile(new URL('index.html', root), 'utf8');
const app = await readFile(new URL('app.js', root), 'utf8');

function personalizationBlock() {
  const start = app.indexOf('// Fourth onboarding profile');
  const end = app.indexOf('// End fourth onboarding profile', start);
  assert.notEqual(start, -1, 'app.js must mark the fourth onboarding profile block');
  assert.notEqual(end, -1, 'app.js must mark the end of the fourth onboarding profile block');
  assert.ok(end > start, 'fourth onboarding profile markers must be in order');
  return app.slice(start, end + '// End fourth onboarding profile'.length);
}

class Element {
  constructor(id = '') {
    this.id = id;
    this.value = '';
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.validity = { valid: true };
    this.listeners = new Map();
    this.attributes = new Map();
    this.classNames = new Set();
    this.classList = {
      add: name => this.classNames.add(name),
      remove: name => this.classNames.delete(name),
      toggle: (name, force) => {
        const add = force === undefined ? !this.classNames.has(name) : Boolean(force);
        if (add) this.classNames.add(name);
        else this.classNames.delete(name);
        return add;
      },
      contains: name => this.classNames.has(name)
    };
  }
  addEventListener(type, callback) {
    const callbacks = this.listeners.get(type) ?? [];
    callbacks.push(callback);
    this.listeners.set(type, callbacks);
  }
  async dispatch(type, props = {}) {
    const event = { type, target: this, currentTarget: this, preventDefault() {}, ...props };
    for (const callback of this.listeners.get(type) ?? []) await callback.call(this, event);
    return event;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
}

const baseProfile = {
  firstName: 'Ada', middleName: 'Byron', lastName: 'Lovelace', studentId: 'ST-123', department: 'Mathematics'
};

function createHarness({ savedStudentProfile = { ...baseProfile }, googleAuthenticated = true, fetchImpl, persistPhoto = async () => {}, initialProfileReadState = 'loading', refreshProfile = () => {} } = {}) {
  const fields = Object.fromEntries(['nickName', 'username', 'bio'].map(name => [name, new Element(name)]));
  fields.nickName.value = 'Ada';
  fields.username.value = 'ada_l';
  fields.bio.value = 'Mathematician';
  const accept = new Element('personalization-accept');
  const feedback = new Element('personalization-feedback');
  const back = new Element('personalization-back');
  const form = new Element('personalization-form');
  form.elements = { namedItem: name => fields[name] ?? null };
  form.querySelector = selector => selector === '[type="submit"]' ? accept : null;
  form.reportValidity = () => Object.values(fields).every(field => field.validity.valid);
  form.setAttribute = Element.prototype.setAttribute;
  form.removeAttribute = Element.prototype.removeAttribute;
  const ids = {
    'personalization-form': form,
    'personalization-accept': accept,
    'personalization-feedback': feedback,
    'personalization-back': back,
    ...Object.fromEntries(Object.values(fields).map(field => [field.id, field]))
  };
  const slideCalls = [];
  const dashboardCalls = [];
  const requests = [];
  const context = vm.createContext({
    document: { getElementById: id => ids[id] ?? null },
    personalizationForm: form,
    personalizationFeedback: feedback,
    personalizationAccept: accept,
    personalizationBack: back,
    personalizationSaving: false,
    studentPhotoPendingURL: '',
    studentPhotoButton: new Element('student-photo-button'),
    persistSelectedProfilePhoto: persistPhoto,
    profileReadState: initialProfileReadState,
    refreshProfileIfVisible: refreshProfile,
    savedStudentProfile,
    googleAuthenticated,
    profileLoadFailed: false,
    studentFieldNames: ['firstName', 'middleName', 'lastName', 'studentId', 'department'],
    isStudentProfileComplete: profile => ['firstName', 'middleName', 'lastName', 'studentId', 'department']
      .every(name => typeof profile?.[name] === 'string' && profile[name].trim()),
    goToOnboardingSlide: index => slideCalls.push(index),
    enterDashboard: () => dashboardCalls.push('dashboard'),
    fetch: async (...args) => {
      requests.push(args);
      return fetchImpl ? fetchImpl(...args) : { ok: true, json: async () => ({ profile: null }) };
    },
    FormData: class {
      constructor(target) { this.target = target; }
      *[Symbol.iterator]() { yield* Object.entries(fields).map(([key, field]) => [key, field.value]); }
    },
    console
  });
  vm.runInContext(personalizationBlock(), context, { filename: 'app.js fourth onboarding profile' });
  return { context, fields, accept, feedback, back, form, slideCalls, dashboardCalls, requests };
}

test('fourth onboarding step exposes required personalization fields and moves the optional photo preview', () => {
  const sectionId = html.indexOf('id="personalization-slide"');
  const sectionEnd = html.indexOf('</section>', sectionId);
  assert.ok(sectionId >= 0 && sectionEnd > sectionId, 'personalization section exists');
  const section = html.slice(html.lastIndexOf('<section', sectionId), sectionEnd);
  assert.match(section, /<section[^>]*id="personalization-slide"[^>]*>/);
  assert.match(section, /class="[^"]*onboarding-slide/);
  assert.match(html, /id="progress-dot-four"/, 'fourth onboarding progress indicator exists');
  assert.match(section, /<form\b[^>]*id="personalization-form"/);
  assert.match(section, /<input\b(?=[^>]*name="nickName")(?=[^>]*maxlength="60")(?=[^>]*required)[^>]*>/i);
  assert.match(section, /<input\b(?=[^>]*name="username")(?=[^>]*maxlength="30")(?=[^>]*pattern="\[A-Za-z0-9_\.\]\{3,30\}")(?=[^>]*required)[^>]*>/i);
  assert.match(section, /<textarea\b(?=[^>]*name="bio")(?=[^>]*maxlength="280")[^>]*>/i);
  assert.match(section, /<button\b(?=[^>]*id="personalization-accept")(?=[^>]*disabled)[^>]*type="submit"/i);
  assert.match(section, /<button\b(?=[^>]*id="personalization-back")(?=[^>]*type="button")[^>]*>/i);
  assert.match(app, /personalizationBack\.addEventListener\('click',[\s\S]{0,100}goToOnboardingSlide\(2\)/,
    'the fourth-step Back control returns to the student-details step');

  const photoStart = html.indexOf('id="student-photo-button"');
  assert.ok(photoStart >= sectionId && photoStart < sectionEnd, 'optional photo preview controls are on step four');
  assert.doesNotMatch(html.slice(0, sectionId), /id="student-photo-button"/,
    'the first three onboarding steps do not retain the old photo box');
});

test('personalization completion is distinct from base-profile completion and submit gating uses all prerequisites', async () => {
  const h = createHarness();
  assert.equal(typeof h.context.isPersonalizationComplete, 'function');
  assert.equal(h.context.isPersonalizationComplete(baseProfile), false);
  const complete = { ...baseProfile, nickName: 'Ada', username: 'ada_l', bio: 'Math' };
  assert.equal(h.context.isPersonalizationComplete(complete), true);
  assert.equal(h.context.isPersonalizationComplete({ ...complete, username: '' }), false);
  await h.back.dispatch('click');
  assert.deepEqual(h.slideCalls, [2], 'Back returns to slide index two');

  h.context.updatePersonalizationSubmit();
  assert.equal(h.accept.disabled, false, 'valid fields and an authenticated saved base profile enable acceptance');
  h.fields.username.validity.valid = false;
  h.context.updatePersonalizationSubmit();
  assert.equal(h.accept.disabled, true, 'native field validity is required');
  h.fields.username.validity.valid = true;
  h.context.personalizationSaving = true;
  h.context.updatePersonalizationSubmit();
  assert.equal(h.accept.disabled, true, 'saving disables acceptance');
  h.context.personalizationSaving = false;
  h.context.profileLoadFailed = true;
  h.context.updatePersonalizationSubmit();
  assert.equal(h.accept.disabled, true, 'profile-load failure disables acceptance');
  h.context.profileLoadFailed = false;
  h.context.googleAuthenticated = false;
  h.context.updatePersonalizationSubmit();
  assert.equal(h.accept.disabled, true, 'Google authentication is required');
  h.context.googleAuthenticated = true;
  h.context.savedStudentProfile = null;
  h.context.updatePersonalizationSubmit();
  assert.equal(h.accept.disabled, true, 'a saved base profile is required');
});

test('personalization save preserves base profile data, retains edits on errors, and enters the dashboard only when confirmed complete', async () => {
  const saveProfile = { ...baseProfile, nickName: 'Ada', username: 'ada_l', bio: 'Mathematician' };
  const h = createHarness({ fetchImpl: async () => {
    return { ok: true, json: async () => ({ profile: { ...saveProfile, isPersonalizationComplete: true } }) };
  } });
  await h.form.dispatch('submit');
  assert.equal(h.dashboardCalls.length, 1, 'only a confirmed complete personalization enters the dashboard');
  assert.equal(h.requests.length, 1);
  const [url, options] = h.requests[0];
  assert.equal(url, '/api/student-profile');
  assert.equal(options.method, 'PUT');
  assert.deepEqual(JSON.parse(options.body), saveProfile, 'the update carries all five saved base-profile fields and the personalization fields');

  const failed = createHarness({ fetchImpl: async () => ({ ok: true, json: async () => ({ profile: { ...baseProfile, ...saveProfile, username: '' } }) }) });
  await failed.form.dispatch('submit');
  assert.equal(failed.dashboardCalls.length, 0, 'an incomplete server-confirmed profile must not leave step four');
  assert.deepEqual(Object.fromEntries(Object.entries(failed.fields).map(([name, field]) => [name, field.value])), {
    nickName: 'Ada', username: 'ada_l', bio: 'Mathematician'
  }, 'server refusal does not clear user-entered values');
  assert.ok(failed.feedback.textContent, 'failure feedback explains why completion did not proceed');

  const rejected = createHarness({ fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) });
  await rejected.form.dispatch('submit');
  assert.equal(rejected.dashboardCalls.length, 0);
  assert.deepEqual(Object.values(rejected.fields).map(field => field.value), ['Ada', 'ada_l', 'Mathematician']);
});

test('photo persistence failure keeps step four and truthfully reports that only profile text was saved', async () => {
  const saveProfile = { ...baseProfile, nickName: 'Ada', username: 'ada_l', bio: 'Mathematician' };
  const refreshCalls = [];
  const h = createHarness({
    persistPhoto: async () => { throw new Error('IndexedDB write failed'); },
    refreshProfile: () => refreshCalls.push('refreshed'),
    fetchImpl: async () => ({ ok: true, json: async () => ({ profile: { ...saveProfile, isPersonalizationComplete: true } }) })
  });
  await h.form.dispatch('submit');

  assert.equal(h.requests.length, 1, 'profile text is saved before local photo persistence is attempted');
  const [, options] = h.requests[0];
  assert.equal(options.method, 'PUT');
  const sentProfile = JSON.parse(options.body);
  assert.deepEqual(Object.keys(sentProfile).sort(), [
    'bio', 'department', 'firstName', 'lastName', 'middleName', 'nickName', 'studentId', 'username'
  ], 'the API payload contains exactly the eight text fields and never includes the image');
  assert.equal(Object.hasOwn(sentProfile, 'photo'), false);
  assert.equal(Object.hasOwn(sentProfile, 'photoURL'), false);
  assert.deepEqual(sentProfile, saveProfile);
  assert.equal(h.dashboardCalls.length, 0, 'photo persistence failure must not advance to the dashboard');
  assert.equal(h.context.profileReadState, 'loading', 'the page must not claim profile/photo readiness on failed persistence');
  assert.deepEqual(refreshCalls, [], 'the ready profile view is refreshed only after local persistence succeeds');
  assert.match(h.feedback.textContent, /profile text was saved, but your photo could not be saved on this device/i);
  assert.deepEqual(Object.values(h.fields).map(field => field.value), ['Ada', 'ada_l', 'Mathematician'],
    'the user remains on step four with their edits intact');
  assert.equal(h.accept.disabled, false, 'the text form remains retryable after photo storage failure');
});


test('HTTP image policy allows local photo previews without loosening script permissions', async t => {
  const server = createApp({ config: buildConfig({ NODE_ENV: 'test', SESSION_SECRET: 'fourth-onboarding-image-policy-regression-secret' }) }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.close(); await once(server, 'close'); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
  assert.equal(response.status, 200);
  const policy = response.headers.get('content-security-policy');
  assert.match(policy, /img-src[^;]*\bblob:/);
  assert.match(policy, /script-src 'self'(?:;|$)/);
  assert.doesNotMatch(policy, /script-src[^;]*(?:blob:|unsafe-inline)/);
});
