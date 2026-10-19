import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../notifications-ui.js', import.meta.url), 'utf8');

function loadRenderer() {
  const elements = new Map();
  const makeElement = id => ({
    id,
    hidden: false,
    open: false,
    scrollTop: 0,
    dataset: id === 'breadcrumb-current' ? { route: 'profile' } : {},
    classList: { contains: () => false, add() {}, toggle() {} },
    addEventListener() {},
    setAttribute() {},
    getAttribute() { return null; },
    replaceChildren() {},
    showModal() { this.open = true; },
    close() { this.open = false; },
    getBoundingClientRect() { return { left: 0, right: 10, top: 0, bottom: 10 }; }
  });
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement(id));
      return elements.get(id);
    }
  };
  const window = {
    addEventListener() {},
    clearTimeout() {},
    location: { hash: '#profile' },
    history: { state: null }
  };
  vm.runInNewContext(source, {
    window,
    document,
    fetch: async () => { throw new Error('Unexpected fetch'); },
    AbortController
  });
  return window.StemmaNotifications;
}

function textContent(html) {
  return html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function rowMap(html) {
  return new Map([...html.matchAll(/<button\b([^>]*data-notification-index="(\d+)"[^>]*)>([\s\S]*?)<\/button>/g)]
    .map(([, , index, body]) => [Number(index), body]));
}

function localDayOffset(days, hour = 12) {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + days);
  date.setHours(hour, 0, 0, 0);
  return date;
}

function headingTexts(html) {
  return [...html.matchAll(/<h[2-6]\b[^>]*>([\s\S]*?)<\/h[2-6]>/g)].map(([, value]) => textContent(value).trim());
}

test('feed groups only real records by unread status and local calendar day', () => {
  const { renderNotifications } = loadRenderer();
  const today = localDayOffset(0, 9);
  const records = [
    { id: 'older', title: 'Older read', message: 'An older item', createdAt: localDayOffset(-4).toISOString(), readAt: localDayOffset(-3).toISOString() },
    { id: 'today-read', title: 'Today read', message: 'A current-day item', createdAt: today.toISOString(), readAt: localDayOffset(0, 10).toISOString() },
    { id: 'unread-old', title: 'Unread old', message: 'Unread is grouped as new', createdAt: localDayOffset(-8).toISOString(), readAt: null },
    { id: 'today-newest', title: 'Today newest', message: 'Newest current-day item', createdAt: localDayOffset(0, 16).toISOString(), readAt: null },
    { id: 'yesterday', title: 'Yesterday read', message: 'Previous-day item', createdAt: localDayOffset(-1, 18).toISOString(), readAt: localDayOffset(-1, 19).toISOString() },
    { id: 'invalid', title: 'Invalid date', message: 'No fabricated date', createdAt: 'not-a-date', readAt: '2026-01-01T00:00:00Z' }
  ];
  const html = renderNotifications(records);
  const rows = rowMap(html);

  assert.equal(rows.size, records.length, 'each actual record is rendered exactly once');
  assert.deepEqual([...rows.keys()].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]);
  assert.equal(textContent(rows.get(0)).includes('Today newest'), true, 'index 0 is the newest record after sorting');
  assert.equal(textContent(rows.get(1)).includes('Today read'), true);
  assert.equal(textContent(rows.get(2)).includes('Yesterday read'), true);
  assert.equal(textContent(rows.get(3)).includes('Older read'), true);
  assert.equal(textContent(rows.get(4)).includes('Unread old'), true, 'a historic unread record keeps its original sorted index');
  assert.equal(textContent(rows.get(5)).includes('Invalid date'), true);
  assert.deepEqual(headingTexts(html), ['New', 'Today', 'Yesterday', localDayOffset(-4).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }), 'Earlier']);
  assert.doesNotMatch(html, /sample|demo notification|Alice|Bob/i, 'grouping does not add sample records');
  assert.match(html, /href="#i-bell"/, 'records without sender metadata use the existing notification icon');
  assert.doesNotMatch(html, /<img\b/i, 'no sender photo is invented when metadata is absent');
});

test('invalid timestamps use Earlier without a fabricated date, while date headings use localized local dates', () => {
  const { renderNotifications } = loadRenderer();
  const older = localDayOffset(-3, 14);
  const invalid = { id: 'invalid', title: 'Undated item', message: 'No fake timestamp', createdAt: 'not-a-date', readAt: '2026-01-01T00:00:00Z' };
  const valid = { id: 'old', title: 'Dated item', message: 'A real timestamp', createdAt: older.toISOString(), readAt: '2026-01-01T00:00:00Z' };
  const html = renderNotifications([invalid, valid]);
  const headings = headingTexts(html);
  assert.ok(headings.includes(older.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })), 'older records have their actual localized date heading');
  assert.ok(headings.includes('Earlier'), 'invalid dates have a distinct Earlier heading');
  const invalidRow = [...html.matchAll(/<button\b[^>]*data-notification-index="(\d+)"[^>]*>([\s\S]*?)<\/button>/g)]
    .find(([, , body]) => textContent(body).includes('Undated item'))?.[0];
  assert.ok(invalidRow);
  assert.doesNotMatch(invalidRow, /<time\b|datetime=|not-a-date|2026-01-01/, 'invalid date metadata does not leak into a fabricated display date');
});

test('an avatar appears only for a supported sender URL and rejects unsafe URL schemes', () => {
  const { renderNotifications } = loadRenderer();
  const safe = renderNotifications([{ id: 'photo', title: 'Has sender photo', createdAt: localDayOffset(0).toISOString(), readAt: null, senderAvatarUrl: 'https://example.com/avatar.jpg' }]);
  assert.match(safe, /<img\b[^>]*src="https:\/\/example\.com\/avatar\.jpg"/);
  const system = renderNotifications([{ id: 'system', type: 'system', title: 'System notice', createdAt: localDayOffset(0).toISOString(), readAt: null, senderAvatarUrl: 'https://example.com/avatar.jpg' }]);
  assert.doesNotMatch(system, /<img\b/i, 'system records do not use sender photos even if metadata is present');
  assert.match(system, /href="#i-bell"/);
  for (const senderAvatarUrl of ['javascript:alert(1)', 'data:image/svg+xml,<svg onload=alert(1)>']) {
    const unsafe = renderNotifications([{ id: 'unsafe', title: 'Unsafe sender photo', createdAt: localDayOffset(0).toISOString(), readAt: null, senderAvatarUrl }]);
    assert.doesNotMatch(unsafe, /<img\b/i, `${senderAvatarUrl.split(':')[0]} URLs must not become image sources`);
    assert.match(unsafe, /href="#i-bell"/, 'unsafe photo metadata falls back to the existing notification icon');
  }
});

test('list previews obey both length limits, escape content, and retain full text only in detail', () => {
  const { renderNotifications, renderNotificationDetail } = loadRenderer();
  const message = 'Alpha beta gamma delta epsilon zeta eta theta and a deliberately very long tail <script>never execute</script>';
  const item = { id: 'preview', title: '<b>Safe title</b>', message, createdAt: localDayOffset(0).toISOString(), readAt: null };
  const html = renderNotifications([item]);
  const previewMarkup = html.match(/<[^>]*class="notification-preview"[^>]*>([\s\S]*?)<\//)?.[1];
  assert.ok(previewMarkup, 'the list has a preview for a record with message text');
  const preview = textContent(previewMarkup);
  assert.ok(preview.endsWith('…'), 'truncated previews use an ellipsis');
  assert.ok(preview.length <= 48, `preview has at most 48 characters (got ${preview.length})`);
  assert.ok(preview.trim().split(/\s+/).length <= 6, 'preview has at most six words');
  const longWord = 'x'.repeat(70);
  const longPreviewHtml = renderNotifications([{ id: 'long', title: 'Long word', message: longWord, createdAt: localDayOffset(0).toISOString(), readAt: null }]);
  const longPreviewMarkup = longPreviewHtml.match(/<[^>]*class="notification-preview"[^>]*>([\s\S]*?)<\//)?.[1];
  const longPreview = textContent(longPreviewMarkup);
  assert.equal(longPreview.length, 48, 'the ellipsis is included in the 48-character maximum');
  assert.ok(longPreview.endsWith('…'));
  assert.match(html, /&lt;b&gt;Safe title&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<script>/i);
  const detail = renderNotificationDetail(item);
  assert.ok(textContent(detail).includes(message), 'the existing detail retains the complete message');
  assert.match(detail, /&lt;script&gt;never execute&lt;\/script&gt;/);
});
