import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../groups-ui.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../groups.css', import.meta.url), 'utf8');
const context = { window: {} };
vm.runInNewContext(source, context, { filename: 'groups-ui.js' });
const markup = context.window.StemmaGroups.view();
const dialog = markup.match(/<dialog\b[\s\S]*?<\/dialog>/)?.[0];
assert.ok(dialog, 'the generated groups view contains the create dialog');

const tags = (html, tagName) => [...html.matchAll(new RegExp(`<${tagName}\\b[^>]*>`, 'gi'))].map(match => match[0]);
const attr = (tag, name) => tag.match(new RegExp(`\\b${name}(?:\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+)))?`, 'i'));
const hasAttr = (tag, name) => Boolean(attr(tag, name));

test('group creation begins with a centered photo and complete group details', () => {
  const details = dialog.match(/<div\b[^>]*data-create-details[^>]*>[\s\S]*?<\/div>\s*<section\b[^>]*data-create-members/)?.[0];
  assert.ok(details, 'the first creation step contains the details before the member step');
  assert.match(details, /class="group-photo-field"[\s\S]*?class="group-photo-upload"[^>]*aria-label="Upload group image"/);
  assert.match(details, /data-group-photo-preview/);
  assert.match(details, /data-group-photo-caption>Add group photo<\/span>/);
  assert.match(css, /\.group-photo-field\s*\{[^}]*display:\s*grid;[^}]*justify-items:\s*center;/s,
    'the photo field centers the upload control and caption');

  assert.match(details, /<label>Description<textarea\b[^>]*name="description"/);
  assert.match(details, /A little introduction for your members\. Optional\./);
});

test('visibility, links, and required inputs have safe first-step defaults', () => {
  const radios = tags(dialog, 'input').filter(tag => /\btype\s*=\s*(["'])radio\1/i.test(tag) && /\bname\s*=\s*(["'])visibility\1/i.test(tag));
  assert.equal(radios.length, 2, 'there are exactly two visibility radio inputs');
  assert.deepEqual(radios.map(tag => attr(tag, 'value')?.[1] ?? attr(tag, 'value')?.[2]), ['public', 'private']);
  assert.ok(hasAttr(radios[0], 'checked'), 'public visibility is the default');
  assert.ok(!hasAttr(radios[1], 'checked'), 'private visibility is not the default');

  const publicLink = dialog.match(/<div\b[^>]*class="group-public-link"[^>]*>[\s\S]*?<\/div>\s*<div\b[^>]*class="group-private-link"/)?.[0];
  const privateLink = dialog.match(/<div\b[^>]*class="group-private-link"[^>]*>[\s\S]*?<\/div>/)?.[0];
  assert.ok(publicLink, 'a public username link editor is present');
  assert.match(publicLink, /https:\/\/Stemma\.wasmer\.app\//);
  const slug = tags(publicLink, 'input').find(tag => /\bname="slug"/.test(tag));
  assert.ok(slug, 'the public link editor has a slug input');
  assert.ok(hasAttr(slug, 'required'));
  assert.match(publicLink, /Choose a unique username for your group\./);
  assert.ok(privateLink, 'the private invite link preview is present');
  assert.match(privateLink, /data-private-link-preview/);
  assert.ok(hasAttr(privateLink.match(/^<div\b[^>]*>/)?.[0] ?? '', 'hidden'), 'private link starts hidden');
  assert.ok(!hasAttr(dialog.match(/<div\b[^>]*class="group-public-link"[^>]*>/)?.[0] ?? '', 'hidden'), 'public link starts visible');

  const name = tags(dialog, 'input').find(tag => /\bname="name"/.test(tag));
  assert.ok(name && hasAttr(name, 'required'), 'group name is required by default');
});

test('member step is searchable and the next/complete actions are accessible', () => {
  const members = dialog.match(/<section\b[^>]*data-create-members[^>]*>[\s\S]*?<\/section>/)?.[0];
  assert.ok(members);
  const search = tags(members, 'input').find(tag => /\bdata-member-search\b/.test(tag));
  assert.ok(search, 'member step has a search input');
  assert.match(search, /\btype="search"/);
  assert.match(search, /\baria-label="Search users"/);
  assert.match(search, /\bautocomplete="off"/);
  assert.match(members, /data-member-candidates[^>]*role="group"[^>]*aria-label="Available users"/);
  assert.match(members, /data-member-selection-chips/);
  assert.ok(hasAttr(members.match(/^<section\b[^>]*>/)?.[0] ?? '', 'hidden'), 'member step starts hidden');

  const submit = dialog.match(/<button\b[^>]*class="groups-primary group-create-next"[^>]*>/)?.[0];
  assert.ok(submit, 'initial primary action is the next-step button');
  assert.match(submit, /aria-label="Next: select members"/);
  assert.match(submit, /type="submit"/);
  assert.match(dialog, /data-create-back[^>]*aria-label="Back"/);
  assert.match(source, /submit\.setAttribute\('aria-label',\s*editing\s*\?\s*'Save changes'\s*:\s*step\s*===\s*1\s*\?\s*'Next: select members'\s*:\s*'Create group'\)/,
    'the step transition gives the final checkmark action an accessible Create group name');
  assert.match(source, /<svg[^>]*aria-hidden="true"><path d="m5 12 4 4L19 6"\/><\/svg>/,
    'the completion checkmark is decorative because its button has an accessible name');
});

test('generated view contains no inline event-handler attributes', () => {
  assert.doesNotMatch(markup, /\s+on[a-z]+\s*=/i);
});
