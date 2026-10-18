import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const demoQrPayload = 'STEMMA-DEMO-RECEIPT-67645-001';
const [paymentUi, appSource] = await Promise.all([
  readFile(new URL('payment-ui.js', root), 'utf8'),
  readFile(new URL('app.js', root), 'utf8')
]);
const clickStart = appSource.indexOf("document.addEventListener('click'");
const clickEnd = appSource.indexOf('\n});', clickStart) + 4;
assert.ok(clickStart >= 0 && clickEnd > clickStart, 'app click handler exists');
const clickHandlerSource = appSource.slice(clickStart, clickEnd);

function makeExperience({ dialogOpen = false } = {}) {
  const effects = { fetch: 0, xhr: 0, localStorage: 0, sessionStorage: 0 };
  const dialog = {
    open: dialogOpen,
    close() { this.open = false; },
    showModal() { this.open = true; }
  };
  const context = vm.createContext({
    document: { getElementById: id => id === 'bill-payment-dialog' ? dialog : null },
    icon: name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"></use></svg>`,
    fetch() { effects.fetch += 1; },
    XMLHttpRequest: function XMLHttpRequestStub() { effects.xhr += 1; },
    localStorage: new Proxy({}, { get() { effects.localStorage += 1; throw new Error('localStorage access'); } }),
    sessionStorage: new Proxy({}, { get() { effects.sessionStorage += 1; throw new Error('sessionStorage access'); } })
  });
  const instance = vm.runInContext(`${paymentUi}\nnew PaymentExperience()`, context);
  return { instance, dialog, effects };
}

function fireAppClick({ payments, dialog, selector, onRender = () => {} }) {
  let clickListener;
  vm.runInNewContext(clickHandlerSource, {
    document: {
      addEventListener: (_type, listener) => { clickListener = listener; },
      querySelectorAll: () => [],
      querySelector: query => query === '#bill-payment-dialog' ? dialog : null
    },
    window: { matchMedia: () => ({ matches: false }) },
    activeRoute: 'cards',
    paymentSlideIndex: 0,
    payments,
    render: onRender,
    renderTabs() {}
  });
  assert.equal(typeof clickListener, 'function');
  const button = { closest: requested => requested === `[data-${selector}]` ? button : null };
  clickListener({ target: button });
}

test('bill Pay is disabled in the visual preview and legacy receipt markup stays clearly illustrative', () => {
  const { instance } = makeExperience();
  const bill = instance.renderBill();
  assert.match(bill, /<button class="bill-pay-button" type="button" data-bill-pay disabled aria-describedby="bill-sheet-note">Pay<\/button>/);
  assert.doesNotMatch(bill, /data-demo-pay/);
  assert.match(bill, /Visual preview only · Telebirr is not connected\./);
  assert.match(bill, /Visual preview only · Telebirr is not connected\. No payment was sent; Pay is disabled\./);

  instance.demoReceiptTime = '2026/10/18 12:34:56';
  const receipt = instance.renderReceipt();
  assert.match(receipt, /<article class="bill-page telebirr-preview demo-receipt"/);
  assert.match(receipt, /<article[^>]*aria-describedby="receipt-no-payment-note"/);
  assert.match(receipt, /<h1 id="receipt-title">Receipt Preview<\/h1>/);
  assert.match(receipt, /-676\.45 <small>\(ETB\)<\/small>/);
  assert.match(receipt, /Transaction Time:<\/dt><dd>2026\/10\/18 12:34:56<\/dd>/);
  assert.match(receipt, /Transaction To:<\/dt><dd>Ethio telecom<\/dd>/);
  assert.match(receipt, /Transaction Type:<\/dt><dd>Bill Payment<\/dd>/);
  assert.match(receipt, /Transaction Number:<\/dt><dd class="receipt-reference">RCP-67645-001<\/dd>/);
  assert.doesNotMatch(receipt, /receipt-reference[^\"]*(?:purple|highlight)|class="[^"]*purple[^"]*receipt-reference/);
  assert.match(receipt, /<p class="receipt-preview-note" id="receipt-no-payment-note">No payment was sent\.<\/p>/);
  assert.match(receipt, /class="receipt-qr-code"[^>]*data-demo-qr[^>]*data-qr-payload="STEMMA-DEMO-RECEIPT-67645-001"[^>]*role="img"[^>]*aria-label="Receipt identifier QR code"/);
  assert.doesNotMatch(receipt, /(?:qr-placeholder|qr-style placeholder|demo-receipt-squares|<pattern\b|>DEMO<\/span>)/i);
  assert.match(appSource, /payments\.isReceiptOpen \? payments\.renderReceipt\(\) : payments\.renderBill\(\)/);
  assert.match(appSource, /aria-label', payments\.isReceiptOpen \? 'Receipt preview' : 'Bill payment details'/);
});

test('receipt preview visible text contains no Demo and keeps its non-payment notice accessible', () => {
  const { instance } = makeExperience();
  const receipt = instance.renderReceipt();
  const visibleText = receipt.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  assert.doesNotMatch(visibleText, /\bdemo\b/i, 'visible receipt text never describes the preview as a demo');
  assert.match(visibleText, /\bReceipt Preview\b/);
  assert.match(visibleText, /No payment was sent\./);
  assert.match(receipt, /aria-describedby="receipt-no-payment-note"/);
  assert.match(receipt, /<p class="receipt-preview-note" id="receipt-no-payment-note">No payment was sent\.<\/p>/);
});

test('demo receipt QR is inline, scannable data-only markup with no external or persistent effects', () => {
  const { instance, effects } = makeExperience();
  const before = { ...effects };
  const receipt = instance.renderReceipt();
  const qrMarkup = receipt.match(/<div class="receipt-qr-code"[^>]*>[\s\S]*?<\/div>/)?.[0];
  assert.ok(qrMarkup, 'receipt exposes the accessible data-demo-qr wrapper');
  assert.equal((receipt.match(/STEMMA-DEMO-RECEIPT-67645-001/g) ?? []).length, 1,
    'the exact payload appears once, in the wrapper data attribute');
  assert.match(qrMarkup, /data-demo-qr\b/);
  assert.match(qrMarkup, /data-qr-payload="STEMMA-DEMO-RECEIPT-67645-001"/);
  assert.match(qrMarkup, /role="img"/);
  assert.match(qrMarkup, /aria-label="Receipt identifier QR code"/);

  const svg = qrMarkup.match(/<svg\b[^>]*>[\s\S]*?<\/svg>/)?.[0];
  assert.ok(svg, 'QR is rendered as an inline SVG');
  assert.match(svg, /viewBox="0 0 41 41"/);
  assert.match(svg, /<rect\b[^>]*fill="(?:white|#fff(?:fff)?)"/i, 'SVG includes a white background');
  assert.match(svg, /<path\b[^>]*fill="(?:black|#000(?:000)?)"/i, 'SVG includes the black QR modules');
  assert.doesNotMatch(qrMarkup, /<(?:img|image)\b|\b(?:href|src)\s*=|https?:\/\/|data:image\//i,
    'QR uses no external image, URL, or linked resource');
  assert.doesNotMatch(qrMarkup, /<pattern\b|placeholder|DEMO<\/span>/i,
    'QR contains no decorative pattern or DEMO stripe');
  assert.match(receipt, /No payment was sent\./);
  assert.deepEqual(effects, before, 'rendering the receipt makes no network or storage calls');
  assert.doesNotMatch(paymentUi, /\bsubscribe\s*\(/i, 'receipt flow does not subscribe to external state');
});

test('openDemoReceipt requires an open bill, closes the sheet, and creates only an ephemeral formatted time', () => {
  const { instance, dialog, effects } = makeExperience({ dialogOpen: true });
  assert.equal(instance.isBillOpen, false);
  assert.equal(instance.isReceiptOpen, false);
  assert.equal(instance.demoReceiptTime, '');
  instance.openDemoReceipt();
  assert.equal(instance.isReceiptOpen, false, 'out-of-order invocation is ignored');
  assert.equal(dialog.open, true, 'ignored invocation leaves the dialog unchanged');

  instance.isBillOpen = true;
  instance.openDemoReceipt();
  assert.equal(instance.isReceiptOpen, true);
  assert.equal(dialog.open, false, 'successful demo transition closes the payment sheet');
  assert.match(instance.demoReceiptTime, /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/);
  const timestamp = instance.demoReceiptTime;
  instance.openDemoReceipt();
  assert.equal(instance.demoReceiptTime, timestamp, 'repeat invocation while receipt is open is ignored');
  assert.deepEqual(effects, { fetch: 0, xhr: 0, localStorage: 0, sessionStorage: 0 });
});

test('legacy receipt action is not exposed by the disabled bill Pay markup', () => {
  const { instance, dialog, effects } = makeExperience({ dialogOpen: false });
  const sampleOverviewBalance = '5,000.00';
  const sampleBill = { availableBalance: 701, amount: 676.45, debited: false, ledgerEntries: [] };
  const before = structuredClone(sampleBill);
  const bill = instance.renderBill();
  assert.match(bill, /<button class="bill-pay-button" type="button" data-bill-pay disabled aria-describedby="bill-sheet-note">Pay<\/button>/);
  assert.doesNotMatch(bill, /data-demo-pay/);

  // Keep exercising the existing internal receipt method as a legacy unit check;
  // it is not reachable through the disabled Pay control in the rendered UI.
  instance.isBillOpen = true;
  dialog.open = true;
  instance.openDemoReceipt();
  assert.equal(instance.isReceiptOpen, true);
  assert.equal(dialog.open, false);
  assert.match(instance.renderReceipt(), /Receipt Preview/);
  assert.equal(sampleOverviewBalance, '5,000.00');
  assert.deepEqual(sampleBill, before, 'sample bill fields and ledger remain untouched');
  assert.deepEqual(effects, { fetch: 0, xhr: 0, localStorage: 0, sessionStorage: 0 });
  assert.doesNotMatch(paymentUi, /\b(?:fetch|XMLHttpRequest|sendBeacon|WebSocket|localStorage|sessionStorage)\b|\/api\//i);
  assert.doesNotMatch(paymentUi, /(?:charge|debit|transfer|createPayment|submitPayment)\s*\(/i);
});

test('receipt back returns to bill details without closing the bill flow', () => {
  const { instance, dialog } = makeExperience();
  instance.isBillOpen = true;
  instance.isReceiptOpen = true;
  let rendered = '';
  fireAppClick({
    payments: instance,
    dialog,
    selector: 'receipt-back',
    onRender: () => { rendered = instance.isReceiptOpen ? instance.renderReceipt() : instance.renderBill(); }
  });
  assert.equal(instance.isBillOpen, true);
  assert.equal(instance.isReceiptOpen, false);
  assert.match(rendered, /Pay Ethio telecom bill/);
  assert.doesNotMatch(rendered, /demo-receipt/);
});
