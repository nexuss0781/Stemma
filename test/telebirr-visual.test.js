import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const [paymentUi, server, baselineJson] = await Promise.all([
  readFile(new URL('payment-ui.js', root), 'utf8'),
  readFile(new URL('server.js', root), 'utf8'),
  readFile(new URL('./fixtures/approved-baseline.json', import.meta.url), 'utf8')
]);
const baseline = JSON.parse(baselineJson);

function renderPreview() {
  const iconCalls = [];
  const effects = { fetch: 0, xhr: 0, urlWrites: 0, historyWrites: 0 };
  const context = vm.createContext({
    icon(name) {
      iconCalls.push(name);
      return `<svg class="icon" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
    },
    fetch() { effects.fetch += 1; },
    XMLHttpRequest: function XMLHttpRequestStub() { effects.xhr += 1; },
    location: new Proxy({}, { set() { effects.urlWrites += 1; return true; } }),
    history: {
      pushState() { effects.historyWrites += 1; },
      replaceState() { effects.historyWrites += 1; }
    }
  });
  const markup = vm.runInContext(`${paymentUi}\nnew PaymentExperience().renderBill()`, context);
  return { markup, iconCalls, effects };
}

test('Telebirr bill screen renders sample data as an explicitly disconnected visual preview', () => {
  const { markup, iconCalls, effects } = renderPreview();
  assert.match(markup, /Customer Name:<\/span><strong>Customer 001<\/strong>/);
  assert.match(markup, /<th scope="col">Month<\/th><th scope="col">Amount<\/th><th scope="col">Due Date<\/th>/);
  assert.match(markup, /<td>12\/2024<\/td><td>676\.45<small>ETB<\/small><\/td><td class="bill-example-due">27\/01\/2025<\/td>/);
  assert.match(markup, /676\.45<small>ETB<\/small>/);
  assert.match(markup, /676\.45 ETB/);
  assert.match(markup, /Available Balance:701\.00ETB/);
  assert.match(markup, /<span>Total Bill Amount<\/span><strong>676\.45 ETB<\/strong>/);
  assert.match(markup, /<span>Other amount<\/span>/);
  assert.match(markup, /Visual preview only · Telebirr is not connected\. Pay opens a demo receipt; no payment is sent\./);
  assert.match(markup, /<button class="bill-secondary-action" type="button" data-bill-back>Back<\/button>\s*<button class="bill-primary-action" type="button" data-review-bill>Continue<\/button>/);
  const dialogTag = markup.match(/<dialog\b[^>]*>/)?.[0];
  assert.ok(dialogTag, 'payment dialog is present in the preview markup');
  assert.doesNotMatch(dialogTag, /\sopen(?:\s|>)/, 'payment dialog is initially closed');
  assert.match(markup, /<button class="bill-pay-button" type="button" data-bill-pay data-demo-pay aria-describedby="bill-sheet-note">Pay<\/button>/);
  assert.doesNotMatch(markup, /Subscribe/i);
  assert.equal((markup.match(/class="bill-pay-button"/g) || []).length, 1);
  assert.deepEqual(iconCalls, ['close'], 'the icon stub is used only for the close affordance');
  assert.deepEqual(effects, { fetch: 0, xhr: 0, urlWrites: 0, historyWrites: 0 });
});

test('visual renderer contains no provider, network, payment endpoint, or URL-write behavior', () => {
  const paymentUiWithoutValidatedFriendPhotoPath = paymentUi.replace('`/api/friend-bills/${billId}/photo`', '');
  assert.doesNotMatch(paymentUiWithoutValidatedFriendPhotoPath, /\b(?:fetch|XMLHttpRequest|sendBeacon|WebSocket)\b|\/api\/|location\.(?:assign|replace|href)|history\.pushState/i);
  assert.doesNotMatch(paymentUi, /(?:subscribe|createPayment|submitPayment|initiatePayment)\s*\(/i);
});

test('server matches the reviewed onboarding-profile and static payment-asset baseline', () => {
  const route = "  app.get('/payment-ui.js', (_req, res) => {\n    res.set('Cache-Control', 'public, max-age=300');\n    res.type('application/javascript').sendFile(path.join(ROOT, 'payment-ui.js'));\n  });\n";
  assert.equal((server.match(/app\.get\('\/payment-ui\.js'/g) || []).length, 1);
  assert.ok(server.includes(route), 'static asset route is present exactly as reviewed');
  assert.equal(createHash('sha256').update(server.replace(route, '')).digest('hex'), baseline.serverSha256, 'no other server code changed from the approved baseline');
  assert.doesNotMatch(server, /\/api\/(?:payments?|bills?|transactions?)\b/i);
});

test('data migrations are unchanged from the approved baseline', async () => {
  const currentNames = (await readdir(new URL('migrations/', root))).sort();
  const currentMigrations = await Promise.all(currentNames.map(async name => ({
    name,
    sha256: createHash('sha256').update(await readFile(new URL(`migrations/${name}`, root))).digest('hex')
  })));
  assert.deepEqual(currentMigrations, baseline.migrations, 'migration filenames and hashes match the approved baseline');
});
