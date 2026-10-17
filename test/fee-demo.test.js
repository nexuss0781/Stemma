import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const renderSource = source.slice(source.indexOf('function renderForYou()'), source.indexOf('function updatePaymentProgress()'));
const html = vm.runInNewContext(`${renderSource}\nrenderForYou()`, {
  icon: () => '<svg aria-hidden="true"></svg>'
});

test('For You demo has a real future deadline and explicit sample disclosure', () => {
  assert.match(html, /datetime="2026-10-25"/);
  assert.match(html, /class="fee-calendar-day"[^>]*>25</);
  assert.match(html, /October 2026/);
  assert.match(html, /Demo only · No payment due/);
  assert.doesNotMatch(html, /skeleton-shimmer/);
});

test('history contains exactly five clearly marked static samples before demo today', () => {
  const history = html.match(/<ul class="fee-history-list"[\s\S]*?<\/ul>/)[0];
  assert.equal((history.match(/<li>/g) || []).length, 5);
  assert.equal((history.match(/<span>Sample<\/span>/g) || []).length, 5);
  const dates = [...history.matchAll(/datetime="(\d{4}-\d{2}-\d{2})"/g)].map(match => match[1]);
  assert.equal(dates.length, 5);
  dates.forEach(date => {
    assert.ok(date <= '2026-10-17');
    assert.equal(new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10), date);
  });
  assert.match(history, /not actual transactions/);
  assert.doesNotMatch(renderSource, /fetch\(|localStorage|sessionStorage|XMLHttpRequest/);
});

test('demo retains preview-only CTA and existing navigation targets', () => {
  assert.match(html, /data-fee-preview/);
  assert.match(html, /No payment has been started/);
  assert.match(html, /data-payment-slide="1"/);
  assert.match(html, /data-tab="2" aria-label="View all payment history"/);
});
