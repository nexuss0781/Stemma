import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const rendererSource = await readFile(new URL('../profile-ui.js', import.meta.url), 'utf8');

function createRenderer() {
  const sandbox = {
    fetch() {
      throw new Error('The profile renderer must not make network requests.');
    }
  };
  vm.runInNewContext(rendererSource, sandbox, { filename: 'profile-ui.js' });
  assert.equal(typeof sandbox.renderStudentProfile, 'function');
  return sandbox.renderStudentProfile;
}

function getSections(html) {
  return [...html.matchAll(/<section class='student-profile-section'>([\s\S]*?)<\/section>/g)]
    .map(match => match[1]);
}

test('renders all eight profile fields in the three requested semantic groups', () => {
  const render = createRenderer();
  const html = render({
    firstName: 'Ada', middleName: 'Byron', lastName: 'Lovelace',
    studentId: 'ST-123', department: 'Mathematics', nickName: 'Ada B.',
    username: 'ada_lovelace', bio: 'Mathematician\nand writer.'
  });

  assert.match(html, /^<article class='student-profile-page'>/);
  assert.match(html, /<header class='student-profile-header'>/);
  assert.match(html, /<button type='button' class='student-profile-avatar' data-profile-photo aria-label='Choose profile photo'>/);
  assert.match(html, /<h1 id='student-profile-display-name' class='student-profile-name'>Ada B\.<\/h1>/);
  assert.match(html, /<p class='student-profile-full-name'>Ada Byron Lovelace<\/p>/);
  assert.match(html, /<p class='student-profile-handle'>@ada_lovelace<\/p>/);
  const groups = getSections(html);
  assert.equal(groups.length, 3);
  assert.match(groups[0], /^<h2>Identity<\/h2>/);
  assert.match(groups[1], /^<h2>Student details<\/h2>/);
  assert.match(groups[2], /^<h2>Account &amp; about<\/h2>/);
  assert.equal((html.match(/<dt>/g) || []).length, 8);
  assert.equal((html.match(/<dd>/g) || []).length, 8);
  for (const label of ['First name', 'Middle name', 'Last name', 'Student ID', 'Department', 'Nick Name', 'Username', 'Bio']) {
    assert.ok(html.includes(`<dt>${label}</dt>`), `Missing labeled field: ${label}`);
  }
  assert.match(html, /class='student-profile-detail profile-bio'/);
  assert.match(html, /Mathematician\nand writer\./);
});

test('escapes every stored field and the photo notice as HTML text', () => {
  const render = createRenderer();
  const hostile = `\"><img src=x onerror='alert(1)'>&`;
  const profile = Object.fromEntries([
    'firstName', 'middleName', 'lastName', 'studentId', 'department', 'nickName', 'username', 'bio'
  ].map(field => [field, `${field}:${hostile}`]));
  const html = render(profile, { photoNotice: `Notice ${hostile}` });
  const escaped = '&quot;&gt;&lt;img src=x onerror=&#39;alert(1)&#39;&gt;&amp;';
  for (const field of Object.keys(profile)) {
    assert.ok(html.includes(`${field}:${escaped}`), `${field} was not escaped`);
  }
  assert.ok(html.includes(`Notice ${escaped}`));
  assert.match(html, /<p class='student-profile-notice' role='status'>/);
  assert.doesNotMatch(html, /<img src=x onerror=/);
  assert.doesNotMatch(html, /onerror='alert\(1\)'/);
});

test('uses only blob photo URLs and otherwise shows a non-person icon placeholder', () => {
  const render = createRenderer();
  const profile = { firstName: 'Ada' };
  const allowed = render(profile, { photoURL: 'blob:https://example.test/photo-1' });
  assert.match(allowed, /<button type='button' class='student-profile-avatar' data-profile-photo aria-label='Replace profile photo'>/);
  assert.match(allowed, /<img id='profile-photo-image' src='blob:https:\/\/example\.test\/photo-1' alt=''>/);
  assert.doesNotMatch(allowed, /student-profile-avatar-fallback/);

  for (const photoURL of [
    'https://example.test/photo.png',
    'javascript:alert(1)',
    'data:image/svg+xml,<svg onload=alert(1)>',
    '/relative/photo.png',
    ''
  ]) {
    const html = render(profile, { photoURL });
    assert.match(html, /<button type='button' class='student-profile-avatar' data-profile-photo aria-label='Choose profile photo'>/);
    assert.doesNotMatch(html, /id='profile-photo-image'/);
    assert.match(html, /class='student-profile-avatar-fallback'/);
    assert.doesNotMatch(html, /<svg[^>]*onload=/);
  }

  const escapedBlob = render(profile, { photoURL: `blob:https://example.test/\" onerror='alert(1)'` });
  const escapedImage = escapedBlob.match(/<img\b[^>]*>/)?.[0];
  assert.equal(escapedImage, "<img id='profile-photo-image' src='blob:https://example.test/&quot; onerror=&#39;alert(1)&#39;' alt=''>");
  assert.match(escapedBlob, /aria-label='Replace profile photo'/);
});

test('renders loading, guest, and error states with the exact messages and delegated buttons', () => {
  const render = createRenderer();
  const loading = render(null, { state: 'loading' });
  assert.match(loading, /aria-busy='true'/);
  assert.match(loading, /Loading your profile…/);
  assert.doesNotMatch(loading, /<button/);
  assert.doesNotMatch(loading, /data-profile-photo/);
  assert.doesNotMatch(loading, /student-profile-section/);

  for (const guest of [render(null), render(null, { state: 'guest' }), render(undefined)]) {
    assert.match(guest, /Your profile is not set up yet\./);
    assert.match(guest, /<button type='button' data-setup-profile>Set up profile<\/button>/);
    assert.doesNotMatch(guest, /data-profile-photo/);
    assert.doesNotMatch(guest, /student-profile-section/);
  }

  const error = render({ firstName: 'Must not appear' }, { state: 'error' });
  assert.match(error, /Your saved profile could not be loaded\./);
  assert.match(error, /<button type='button' data-retry-profile>Try again<\/button>/);
  assert.doesNotMatch(error, /data-profile-photo/);
  assert.doesNotMatch(error, /Must not appear|Not provided|student-profile-section/);
  assert.doesNotMatch(error, /data-setup-profile/);
});

test('does not invent names, profile links, social details, location, or financial fields', () => {
  const render = createRenderer();
  const html = render({ firstName: '', middleName: ' ', lastName: '', bio: '  ' });
  assert.doesNotMatch(html, /id='student-profile-display-name'/);
  assert.doesNotMatch(html, /student-profile-full-name|student-profile-handle/);
  assert.equal((html.match(/>Not provided<\/dd>/g) || []).length, 8);
  assert.doesNotMatch(html, /href=|https?:\/\/|Twitter|LinkedIn|Location|Balance|Payment|Workplace|Occupation/i);
});
