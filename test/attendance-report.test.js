import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const read = file => fs.readFile(new URL('../system-apps/attendance/' + file, import.meta.url), 'utf8');

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + 1);
  assert.notEqual(start, -1, `expected ${startMarker} to exist`);
  assert.ok(end > start, `expected ${endMarker} after ${startMarker}`);
  return source.slice(start, end);
}

test('Daily view has a date picker, student roster, visible Save and View actions', async () => {
  const html = await read('index.html');
  const daily = between(html, '<main', '</main>');
  assert.match(daily, /id="attendance-date"[^>]*type="date"/);
  assert.match(daily, /id="roster"/);
  const save = daily.match(/<button\b[^>]*id="save-attendance"[^>]*>([\s\S]*?)<\/button>/);
  assert.ok(save, 'daily view should contain the explicit save button');
  assert.match(save[1].replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/g, ''), /\bSave\b/, 'Save should have a visible text label');
  assert.match(html, /<button\b[^>]*id="view-report"[^>]*>[\s\S]*?<span>View<\/span>[\s\S]*?<\/button>/);
  assert.match(html, /id="save-toast"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /Only lines starting with a hyphen/);
  assert.match(html, /<title>Teacher Attendance<\/title>/);
  assert.match(html, /class="brand-name">Roll/);
});

test('Checkbox edits stay draft-only and Save confirms success only after server acknowledgement', async () => {
  const source = await read('app.ts');
  const render = between(source, 'function render()', 'function displayRequestError');
  assert.match(render, /markDirty\(\)/);
  assert.doesNotMatch(render, /saveAttendance\(\)/);
  const save = between(source, 'async function saveAttendance()', 'function openDialog()');
  assert.match(save, /await requestState[\s\S]*?dirty = false;[\s\S]*?showSavedToast\(\)[\s\S]*?catch/);
  assert.match(source, /window\.setTimeout\([\s\S]*?2800\)/);
  assert.match(source, /dirty = state\.presentIds\.length !== saved\.size/);
  assert.match(source, /saveButton\.addEventListener\(["']click["']/);
  assert.match(source, /Save your attendance changes before changing the date/);
  const dailyLoad = between(source, 'async function loadDate(', 'async function saveAttendance(');
  assert.doesNotMatch(dailyLoad, /\/month\?month=/, 'opening or changing a daily date should not load the report month');
});

test('Report uses roster text, saved snapshots and print bands; drafts cannot be exported', async () => {
  const source = await read('app.ts');
  const css = await read('app.css');
  assert.match(source, /name\.textContent\s*=\s*student\.name/);
  assert.match(source, /exportPDFButton\.disabled\s*=\s*dirty\s*\|\|\s*!loaded/);
  assert.match(source, /if\s*\(dirty\s*\|\|\s*!loaded[\s\S]*?window\.print\(\)/);
  assert.match(source, /cellStatus\([\s\S]*?const ids = saved\?\.presentIds/);
  assert.match(source, /start\s*\+=\s*11/);
  assert.doesNotMatch(source, /innerHTML/);
  assert.match(css, /@page[^;{]*\{[^}]*size\s*:\s*A4/s);
  assert.match(css, /@media\s+print/);
  assert.match(css, /\.month-print-table thead\s*\{[^}]*display\s*:\s*table-header-group/s);
  assert.match(css, /\.month-print-table tr\s*\{[^}]*break-inside\s*:\s*avoid/s);
  assert.match(css, /#report-grid-sections\s*\{[^}]*display\s*:\s*none/s);
});
