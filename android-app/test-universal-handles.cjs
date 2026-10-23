'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const {
  CHANNEL_USERNAME_PATTERN,
  GROUP_SLUG_PATTERN,
  transformSource
} = require('./universal-handles-transform.cjs');

const root = path.resolve(__dirname, '..');
const www = path.join(__dirname, 'www');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');

assert.equal(CHANNEL_USERNAME_PATTERN.test('A_User.23'), true, 'accept 5–30 permitted channel username characters regardless of case');
assert.equal(CHANNEL_USERNAME_PATTERN.test('AbcD'), false, 'reject four-character channel usernames');
assert.equal(CHANNEL_USERNAME_PATTERN.test('a'.repeat(31)), false, 'reject too-long channel usernames');
assert.equal(CHANNEL_USERNAME_PATTERN.test('bad-name'), false, 'reject unsupported channel username punctuation');
assert.equal(GROUP_SLUG_PATTERN.test('Club_One-2'), true, 'accept group slug letters, numbers, underscores and hyphens regardless of case');
assert.equal(GROUP_SLUG_PATTERN.test('AbcD'), false, 'reject four-character group slugs');
assert.equal(GROUP_SLUG_PATTERN.test('a'.repeat(41)), false, 'reject too-long group slugs');
assert.equal(GROUP_SLUG_PATTERN.test('bad.slug'), false, 'reject periods in group slugs');

const channels = transformSource('/channels-ui.js', source('channels-ui.js'));
assert.match(channels, /name="username" minlength="5" maxlength="30" pattern="\[A-Za-z0-9_\.\]\{5,30\}" required/);
assert.match(channels, /const username = createForm\.elements\.username\.value\.trim\(\)\.toLowerCase\(\)/, 'channel username payload is normalized to lowercase');
assert.match(channels, /if \(!\/\^\[A-Za-z0-9_\.\]\{5,30\}\$\/\.test\(username\)\)/, 'invalid channel usernames are rejected before POST');
assert.match(channels, /Use 5–30 letters, numbers, underscores or periods/);
assert.match(channels, /JSON\.stringify\(\{ name, username \}\)/, 'valid channel create request sends name and username');
assert.match(channels, /aria-describedby="channel-username-help"/);
assert.match(channels, /channelHandle\.textContent = channelUsername \? `@\$\{channelUsername\}` : ''/);
assert.doesNotMatch(channels, /channelHandle\.innerHTML/, 'user-provided channel handles are never interpolated as HTML');

const groups = transformSource('/groups-ui.js', source('groups-ui.js'));
assert.match(groups, /name="slug" minlength="5" maxlength="40" pattern="\[A-Za-z0-9_-\]\{5,40\}"/);
assert.match(groups, /\/\^\[A-Za-z0-9_-\]\{5,40\}\$\/\.test\(slug\)/, 'availability checks enforce a five-character case-insensitive public username');
assert.match(groups, /Use 5–40 letters, numbers, underscores or hyphens/);
assert.match(groups, /payload\.slug = form\.elements\.slug\.value\.trim\(\)\.toLowerCase\(\)/, 'group username payload is normalized to lowercase');
assert.match(groups, /slug === String\(current\?\.slug \|\| ''\)\.toLowerCase\(\)/, 'existing group username comparison ignores case');
assert.match(groups, /\/\^\[A-Za-z0-9_-\]\{5,40\}\$\/\.test\(slug\)/);
assert.match(groups, /group\.visibility === 'public' && typeof group\.slug === 'string'/, 'only public group slugs are displayed');
assert.match(groups, /detailHandle\.textContent = groupHandle \? `@\$\{groupHandle\}` : ''/);
assert.match(groups, /conversationHandle\.textContent = groupHandle \? `@\$\{groupHandle\}` : ''/);
assert.doesNotMatch(groups, /detailHandle\.innerHTML|conversationHandle\.innerHTML/);

const profile = transformSource('/profile-ui.js', source('profile-ui.js'));
assert.match(profile, /Your username is your universal handle across accounts, groups, channels, and apps\./);
assert.match(profile, /@\$\{escapeHtml\(values\.username\)\}/, 'profile handle preserves its existing escaped username display');
assert.doesNotMatch(profile, /uuid|identityId/i, 'UUID identity values are not shown as usernames');

const account = transformSource('/app.js', source('app.js'));
assert.match(account, /\^\[A-Za-z0-9_\.\]\{5,30\}\$\/\.test\(profile\.username\)/, 'account profile validation enforces five characters');
assert.match(account, /\^\[A-Za-z0-9_\.\]\{5,30\}\$\/\.test\(username\.value\.trim\(\)\)/, 'account editor submit availability enforces five characters');
assert.match(account, /if \(name === 'username'\) profile\[name\] = profile\[name\]\.toLowerCase\(\)/, 'account username save payload is lowercase');

for (const [file, code] of [['channels-ui.js', channels], ['groups-ui.js', groups], ['profile-ui.js', profile], ['app.js', account]]) {
  assert.doesNotThrow(() => esbuild.transformSync(code, { target: 'chrome100' }), `${file} transformed source parses`);
}
assert.throws(() => transformSource('/channels-ui.js', 'missing source'), /anchor missing or ambiguous/, 'anchor drift fails closed');

const index = fs.readFileSync(path.join(www, 'index.html'), 'utf8');
assert.match(index, /id="profile-username"[^>]*minlength="5" maxlength="30" pattern="\[A-Za-z0-9_\.\]\{5,30\}"[^>]*aria-describedby="profile-username-help"/, 'generated Android account editor has native five-character constraints and accessible help');
assert.match(index, /id="profile-username-help"[^>]*>Choose a unique 5–30 character username[\s\S]*case-insensitive\./, 'generated Android account editor exposes case-insensitive guidance');
const jsName = index.match(/src="\/(app\.[a-f0-9]+\.js)"/);
assert.ok(jsName, 'Android index references a hashed native app bundle');
const bundle = fs.readFileSync(path.join(www, jsName[1]), 'utf8');
for (const text of ['Channel username', 'underscores or periods for the channel username', 'data-channel-handle', 'data-group-handle', 'universal handle across accounts, groups, channels, and apps']) {
  assert.ok(bundle.includes(text), `hashed Android bundle contains ${text}`);
}
assert.match(bundle, /JSON\.stringify\(\{name:[\w$]+,username:[\w$]+\}\)/, 'hashed Android bundle sends the validated username with the channel name');
assert.match(bundle, /textContent=.{1,4}\?`@\$\{[A-Za-z_$][\w$]*\}`/, 'hashed Android bundle renders returned channel handles as text');

console.log('Android universal-handle transforms and bundle checks passed.');
