import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const read = file => fs.readFile(new URL('../system-apps/attendance/' + file, import.meta.url), 'utf8');

function sourceFunction(source, name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(`function ${nextName}(`, start + 1);
  assert.notEqual(start, -1, `expected ${name} to exist`);
  assert.notEqual(end, -1, `expected ${nextName} to follow ${name}`);
  return source.slice(start, end);
}

test('Student present labels appear only for checked students and update on rerender', async () => {
  const source = await read('app.js');
  const render = sourceFunction(source, 'render', 'displayRequestError');

  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName;
      this.children = [];
      this.dataset = {};
      this.hidden = false;
      this.style = { setProperty() {} };
      this.classList = { contains: name => this.className?.split(/\s+/).includes(name) ?? false };
    }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    addEventListener() {}
    setAttribute() {}
  }
  class FakeInput extends FakeElement {}

  const roster = new FakeElement('div');
  const context = vm.createContext({
    document: {
      activeElement: null,
      createElement: tagName => tagName === 'input' ? new FakeInput(tagName) : new FakeElement(tagName),
    },
    HTMLInputElement: FakeInput,
    state: {
      students: [{ id: 'present', name: 'Present Student' }, { id: 'absent', name: 'Absent Student' }],
      presentIds: ['present'],
    },
    roster,
    presentCount: new FakeElement('span'),
    studentCount: new FakeElement('span'),
    progressRing: new FakeElement('div'),
    emptyState: new FakeElement('div'),
    busy: false,
    loaded: true,
  });
  vm.runInContext(render, context);

  const studentLabels = () => roster.children.slice(1).map(row => row.children[2].textContent);
  vm.runInContext('render()', context);
  assert.deepEqual(studentLabels(), ['Present', '']);

  context.state.presentIds = ['absent'];
  vm.runInContext('render()', context);
  assert.deepEqual(studentLabels(), ['', 'Present']);
});

test('Monthly grid is part of the report view, with one right-aligned month chooser and no step buttons', async () => {
  const html = await read('index.html');
  const reportStart = html.indexOf('id="report-view"');
  const reportEnd = html.indexOf('</section>', reportStart);
  assert.notEqual(reportStart, -1, 'report view should exist');
  assert.ok(reportEnd > reportStart, 'report view should have a closing boundary');
  const reportMarkup = html.slice(reportStart, reportEnd);
  assert.match(reportMarkup, /id="attendance-month"/);
  assert.match(reportMarkup, /id="monthly-grid-wrap"/);
  assert.match(reportMarkup, /id="monthly-grid"/);
  assert.ok(reportMarkup.indexOf('attendance-month') < reportMarkup.indexOf('monthly-grid-wrap'), 'month chooser should precede the grid');
  assert.doesNotMatch(html, /id="(?:previous-month|next-month)"/);
  assert.match(reportMarkup, /id="report-grid-sections"/);

  const css = await read('app.css');
  assert.match(css, /\.month-control\s*\{[^}]*margin-left\s*:\s*auto/s, 'month chooser should sit at the right edge');
});

test('Monthly view uses saved records only, and print bands remain hidden on screen', async () => {
  const source = await read('app.ts');
  const css = await read('app.css');
  assert.match(source, /\/month\?month=/);
  const dailyLoad = sourceFunction(source, 'loadDate', 'saveAttendance');
  assert.doesNotMatch(dailyLoad, /\/month\?month=/, 'daily loading must not fetch a month report');
  assert.match(source, /(?:async\s+)?function\s+loadMonth\s*\(/, 'month data should be loaded by a separate lazy loader');
  assert.match(source, /monthState\.days\.find\(day\s*=>\s*day\.date\s*===\s*date\)/);
  assert.match(source, /saved\?\.presentIds\.length\s*\?\s*["']unmarked["']\s*:\s*saved\s*\?\s*["']neutral["']\s*:\s*["']unknown["']/);
  assert.doesNotMatch(source, /["']absent["']|["']no-class["']|["']is-red["']/);
  assert.match(source, /for\s*\([^)]*index\s*=\s*1[^)]*index\s*<=\s*12/);
  assert.match(source, /function\s+scrollToCurrentWeek\s*\([\s\S]*?getDay\(\)[\s\S]*?scrollLeft/);
  assert.match(source, /viewReportButton\.addEventListener[\s\S]*?loadMonth\(/);
  const monthGrid = sourceFunction(source, 'renderMonthGrid', 'scrollToCurrentWeek');
  assert.doesNotMatch(monthGrid, /createElement\(["'](?:input|button)["']\)/, 'monthly screen grid should be read-only');

  const reportStart = source.indexOf('function renderReport(');
  const reportEnd = source.indexOf('saveButton.addEventListener', reportStart);
  assert.ok(reportEnd > reportStart, 'report renderer should precede report controls');
  const report = source.slice(reportStart, reportEnd);
  assert.match(report, /start\s*\+=\s*11/, 'report should retain 11-day print bands');
  assert.doesNotMatch(report, /createElement\(["']input["']\)|type\s*=\s*["']checkbox["']/, 'report grid should be read-only');
  assert.match(css, /#report-grid-sections\s*\{[^}]*display\s*:\s*none/s, 'print bands should not be shown as multiple tables on screen');
  assert.match(css, /@media\s+print[\s\S]*?#report-grid-sections\s*\{[^}]*display\s*:\s*block/s, 'print rules should restore the bands');
  assert.match(css, /position\s*:\s*sticky\s*;\s*left\s*:\s*0/);
});
