import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const read = file => fs.readFile(new URL('../system-apps/attendance/' + file, import.meta.url), 'utf8');

test('Roll has adjacent report/import controls and an accessible explicit Save action', async () => {
  const html = await read('index.html');
  assert.match(html, /id="save-attendance"[^>]*aria-label="Save attendance"/);
  assert.match(html, /id="view-report"[\s\S]*?<\/button>\s*<button[^>]*id="open-import"/);
  assert.match(html, /id="save-toast"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /Only lines starting with a hyphen/);
  assert.match(html, /<title>Teacher Attendance<\/title>/);
  assert.match(html, /class="brand-name">Roll/);
});

test('Checkbox edits are drafts and Save confirms success only after server acknowledgement', async () => {
  const source = await read('app.ts');
  const render = source.slice(source.indexOf('function render()'), source.indexOf('function displayRequestError'));
  assert.match(render, /markDirty\(\)/);
  assert.doesNotMatch(render, /saveAttendance\(\)/);
  const save = source.slice(source.indexOf('async function saveAttendance()'), source.indexOf('function openDialog()'));
  assert.match(save, /await requestState[\s\S]*?dirty = false;[\s\S]*?showSavedToast\(\);[\s\S]*?catch/);
  assert.match(source, /window\.setTimeout\([\s\S]*?2800\)/);
  assert.match(source, /dirty = state\.presentIds\.length !== saved\.size/);
  assert.match(source, /saveButton\.addEventListener\("click"/);
  assert.match(source, /Save your attendance changes before changing the date/);
});

test('Report uses real roster text, blocks draft export and prints a paginated register', async () => {
  const source = await read('app.ts');
  const css = await read('app.css');
  assert.match(source, /name\.textContent = student\.name/);
  assert.match(source, /exportPDFButton\.disabled = dirty \|\| !loaded/);
  assert.match(source, /window\.print\(\)/);
  assert.doesNotMatch(source, /innerHTML/);
  assert.match(css, /@page \{ size: A4/);
  assert.match(css, /@media print/);
  assert.match(css, /thead \{ display: table-header-group/);
  assert.match(css, /tr \{ break-inside: avoid/);
});
