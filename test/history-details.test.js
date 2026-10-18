import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const start = source.indexOf('function samplePaymentDeadline(');
const end = source.indexOf('function updatePaymentProgress()');
assert.ok(start >= 0 && end > start, 'payment-history functions are within the VM slice');
const renderSource = source.slice(start, end);
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"></use></svg>`;

function run(expression, values = {}) {
  return vm.runInNewContext(`${renderSource}\n${expression}`, {
    paymentDemoInterval: '15-days',
    icon,
    activeRoute: 'cards',
    activeTabs: { cards: 2 },
    ...values
  });
}

function entries() {
  return JSON.parse(run('JSON.stringify(paymentHistoryEntries())'));
}

function getAttributes(markup) {
  return Object.fromEntries([...markup.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, value]) => [key, value]));
}

function createDialog() {
  return {
    innerHTML: '',
    dataset: {},
    showModalCalls: 0,
    closeCalls: 0,
    showModal() { this.showModalCalls += 1; this.open = true; },
    close() { this.closeCalls += 1; this.open = false; }
  };
}

test('25 history entries have unique deterministic IDs and local receipt payloads', () => {
  const history = entries();
  assert.equal(history.length, 25);
  assert.equal(new Set(history.map(({ id }) => id)).size, 25);
  assert.equal(new Set(history.map(({ qrId }) => qrId)).size, 25);
  history.forEach((entry, index) => {
    const suffix = `${entry.date.replaceAll('-', '')}-${String(index + 1).padStart(3, '0')}`;
    assert.equal(entry.id, `STM-${suffix}`);
    assert.equal(entry.qrId, `STEMMA-RECEIPT-${suffix}`);
    assert.equal(entry.qrSrc, `/assets/history/receipt-${String(index + 1).padStart(3, '0')}.svg`);
    assert.match(entry.title, /.+/);
    assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(entry.label, /.+/);
    assert.match(entry.amount, /.+/);
    assert.doesNotMatch(entry.qrSrc, /^https?:/i);
    assert.doesNotMatch(entry.qrId, /account|wallet|iban|token/i);
  });
});

test('preview rows keep the original noninteractive list-item markup; full history makes every row a button', () => {
  const history = entries();
  const preview = run('renderHistoryRows(paymentHistoryEntries().slice(0, 5))');
  assert.equal((preview.match(/<li>/g) || []).length, 5);
  assert.equal((preview.match(/<button\b/g) || []).length, 0);
  assert.match(preview, /^<li><span class="fee-history-detail"><strong>Monthly fee<\/strong><time datetime="2026-10-15">/);
  assert.match(preview, /<span class="fee-history-total"><strong>1,250<\/strong><span>ETB<\/span><\/span><\/li><li>/);
  const forYou = run('renderForYou({})');
  const actualPreview = forYou.match(/<article class="fee-history-card"[\s\S]*?<\/article>/)?.[0];
  assert.ok(actualPreview, 'For You preview history exists');
  const actualRows = [...actualPreview.matchAll(/<li>([\s\S]*?)<\/li>/g)].map(([, row]) => row);
  assert.equal(actualRows.length, 5);
  assert.ok(actualRows.every(row => !/<button\b/.test(row)), 'preview rows are not interactive buttons');

  const full = run('renderPaymentHistory()');
  const buttons = [...full.matchAll(/<li>\s*<button\b([^>]*)>([\s\S]*?)<\/button>\s*<\/li>/g)];
  assert.equal(buttons.length, 25);
  buttons.forEach(([, attrs, body], index) => {
    assert.match(attrs, /class="history-transaction"/);
    assert.match(attrs, /type="button"/);
    assert.match(attrs, /data-history-entry="[^"]+"/);
    assert.match(attrs, /aria-haspopup="dialog"/);
    assert.match(attrs, /aria-controls="history-details-dialog"/);
    assert.equal(getAttributes(attrs)['data-history-entry'], history[index].id);
    assert.match(body, /class="fee-history-detail"/);
    assert.match(body, /class="fee-history-total"/);
  });
  assert.match(full, /<dialog\b[^>]*class="history-details-dialog"[^>]*id="history-details-dialog"[^>]*aria-labelledby="history-details-title"/);
});

test('each rendered receipt detail has its matching title, QR asset/payload, and transaction fields', () => {
  for (const entry of entries()) {
    const detail = run('renderHistoryDetails(entry)', { entry });
    assert.match(detail, /<button\b[^>]*data-close-history-details[^>]*aria-label="Close transaction details"[^>]*autofocus/);
    assert.match(detail, /<h2\b[^>]*id="history-details-title">Transaction details<\/h2>/);
    assert.match(detail, new RegExp(`<img\\b[^>]*src="${entry.qrSrc}"[^>]*alt="Transaction receipt QR code"[^>]*data-qr-payload="${entry.qrId}"`));
    assert.match(detail, new RegExp(`<dt>Transaction number<\\/dt>\\s*<dd>${entry.id}<\\/dd>`));
    assert.match(detail, new RegExp(`<dt>Reason<\\/dt>\\s*<dd>${entry.title}<\\/dd>`));
    assert.match(detail, new RegExp(`<dt>Amount<\\/dt>\\s*<dd[^>]*>${entry.amount}\\s*(?:<small>)?ETB(?:<\\/small>)?<\\/dd>`));
    assert.match(detail, new RegExp(`<dt>Date<\\/dt>\\s*<dd>${entry.label}<\\/dd>`));
  }
});

test('history detail opening is gated to cards history and known IDs; close uses native dialog close', () => {
  const history = entries();
  const dialog = createDialog();
  const document = { getElementById: id => id === 'history-details-dialog' ? dialog : null };
  let navigationSaves = 0;
  const open = (id, state = {}) => run('showHistoryDetails(id)', {
    id, document, activeRoute: 'cards', activeTabs: { cards: 2 },
    queueNavigationSave() { navigationSaves += 1; }, ...state
  });

  open(history[0].id);
  assert.equal(dialog.showModalCalls, 1);
  assert.equal(dialog.dataset.historyId, history[0].id, 'open history metadata records the selected transaction id');
  assert.equal(navigationSaves, 1, 'opening history details queues saved navigation metadata');
  assert.match(dialog.innerHTML, /Transaction details/);
  assert.match(dialog.innerHTML, new RegExp(history[0].id));
  for (const [id, state] of [
    ['not-a-history-id', {}],
    [history[1].id, { activeRoute: 'home' }],
    [history[2].id, { activeTabs: { cards: 1 } }]
  ]) {
    const before = { calls: dialog.showModalCalls, html: dialog.innerHTML };
    open(id, state);
    assert.equal(dialog.showModalCalls, before.calls);
    assert.equal(dialog.innerHTML, before.html);
  }
  dialog.open = true;
  const beforeAlreadyOpen = dialog.showModalCalls;
  open(history[3].id);
  assert.equal(dialog.showModalCalls, beforeAlreadyOpen);
  assert.equal(navigationSaves, 1, 'gated and already-open dialogs do not queue metadata saves');
  run('closeHistoryDetails()', { document });
  assert.equal(dialog.closeCalls, 1);
});

test('delegated clicks route history transaction buttons to open and close helpers', () => {
  const listenerStart = source.indexOf("document.addEventListener('click'");
  const listenerEnd = source.indexOf('\n});', listenerStart) + 4;
  assert.ok(listenerStart >= 0 && listenerEnd > listenerStart, 'document click listener exists');
  let clickListener;
  const calls = [];
  vm.runInNewContext(source.slice(listenerStart, listenerEnd), {
    document: {
      addEventListener: (_type, listener) => { clickListener = listener; },
      querySelectorAll: () => []
    },
    showHistoryDetails: id => calls.push(['open', id]),
    closeHistoryDetails: () => calls.push(['close'])
  });
  const transaction = {
    dataset: { historyEntry: 'STM-20261015-001' },
    closest: selector => selector === '[data-history-entry]' ? transaction : null
  };
  const close = {
    closest: selector => selector === '[data-close-history-details]' ? close : null
  };
  clickListener({ target: transaction });
  clickListener({ target: close });
  assert.deepEqual(calls, [['open', 'STM-20261015-001'], ['close']]);
});

test('history rendering and details remain local read-only presentation helpers', () => {
  assert.doesNotMatch(renderSource, /\bfetch\s*\(|XMLHttpRequest|\b(localStorage|sessionStorage|indexedDB)\b/);
  const full = run('renderPaymentHistory()');
  assert.doesNotMatch(full, /https?:\/\//i);
  assert.doesNotMatch(full, /account|wallet|iban|token/i);
});
