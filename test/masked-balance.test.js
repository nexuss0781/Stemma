import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const [app, html, styles, paymentUi, server, baselineJson] = await Promise.all([
  readFile(new URL('app.js', root), 'utf8'),
  readFile(new URL('index.html', root), 'utf8'),
  readFile(new URL('styles.css', root), 'utf8'),
  readFile(new URL('payment-ui.js', root), 'utf8'),
  readFile(new URL('server.js', root), 'utf8'),
  readFile(new URL('./fixtures/approved-baseline.json', import.meta.url), 'utf8')
]);
const baseline = JSON.parse(baselineJson);
const releasedSource = `${app}\n${html}\n${styles}\n${paymentUi}\n${server}`;
const balanceMarkup = html.match(/<div class="overview-mock-balance"[\s\S]*?<\/div>/)?.[0];
const overviewHero = html.match(/<section class="hero-card"[\s\S]*?<\/section>/)?.[0];
const helperStart = app.indexOf('function setPreviewBalanceVisible(');
const helperEnd = app.indexOf('\nfunction renderTabs()', helperStart);
const helperSource = app.slice(helperStart, helperEnd);

test('overview balance is masked by default and contains no CBE or unmasked amount', () => {
  assert.ok(balanceMarkup, 'mock balance markup exists');
  assert.match(balanceMarkup, /aria-label="Private preview balance, not real funds"/);
  assert.match(balanceMarkup, /id="overview-balance-value"[^>]*aria-label="Balance hidden"[^>]*>••••••<\/span>/);
  assert.match(balanceMarkup, /id="balance-visibility-toggle"[^>]*aria-label="Show balance"[^>]*aria-pressed="false"/);
  assert.doesNotMatch(balanceMarkup, /5,000\.00|CBE|Commercial Bank of Ethiopia/i);
});

test('local reveal and remask update the value and matching accessible toggle state', () => {
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'balance visibility helper exists');
  const value = {
    textContent: '••••••',
    attributes: { 'aria-label': 'Balance hidden' },
    setAttribute(name, next) { this.attributes[name] = next; }
  };
  const button = {
    attributes: { 'aria-pressed': 'false', 'aria-label': 'Show balance' },
    setAttribute(name, next) { this.attributes[name] = next; }
  };
  const surrounding = {
    hero: '<section class="hero-card"><span class="hero-skeleton-name skeleton-shimmer"></span></section>',
    avatar: '<div class="avatar-glass"><span class="portrait-skeleton skeleton-shimmer"></span></div>',
    cards: '<article class="skeleton-card"><span class="skeleton-shimmer"></span></article>'
  };
  const before = structuredClone(surrounding);
  const document = {
    getElementById(id) {
      if (id === 'overview-balance-value') return value;
      if (id === 'balance-visibility-toggle') return button;
      throw new Error(`Unexpected DOM access from balance helper: ${id}`);
    }
  };
  assert.match(helperSource, /value\.textContent = visible \? '5,000\.00' : '••••••'/);
  const context = vm.createContext({ document });
  vm.runInContext(`${helperSource}\nsetPreviewBalanceVisible(true);`, context);
  assert.equal(value.textContent, '5,000.00');
  assert.equal(value.attributes['aria-label'], 'Balance 5,000.00 ETB');
  assert.equal(button.attributes['aria-pressed'], 'true');
  assert.equal(button.attributes['aria-label'], 'Hide balance');
  assert.deepEqual(surrounding, before);

  vm.runInContext('setPreviewBalanceVisible(false);', context);
  assert.equal(value.textContent, '••••••');
  assert.equal(value.attributes['aria-label'], 'Balance hidden');
  assert.equal(button.attributes['aria-pressed'], 'false');
  assert.equal(button.attributes['aria-label'], 'Show balance');
  assert.deepEqual(surrounding, before);
});

test('approved hero background, balance, and cards remain unchanged around identity slots', () => {
  assert.match(html, /class="hero-skeleton-name skeleton-shimmer"/);
  assert.match(html, /class="avatar-glass"[^>]*aria-hidden="true"><span id="overview-photo-placeholder" class="portrait-skeleton skeleton-shimmer"><\/span>/);
  assert.match(app, /function renderSkeletonCards\(\)[\s\S]*?skeleton-shimmer/);
  assert.match(styles, /\.skeleton-shimmer\s*\{/);
  assert.match(html, /class="overview-mock-balance"/);
  assert.ok(overviewHero, 'Overview hero markup exists');
  const originalHero = overviewHero
    .replace(/<div id="overview-name-placeholder" class="hero-skeleton-name skeleton-shimmer" aria-hidden="true"><\/div>\s*<p id="overview-student-name" class="overview-student-name" hidden><\/p>/, '<div class="hero-skeleton-name skeleton-shimmer" aria-hidden="true"></div>')
    .replace(/<div id="overview-photo-frame" class="avatar-glass" aria-hidden="true"><span id="overview-photo-placeholder" class="portrait-skeleton skeleton-shimmer"><\/span><img id="overview-profile-photo" class="overview-profile-photo" alt="Your profile photo" hidden><\/div>/, '<div class="avatar-glass" aria-hidden="true"><span class="portrait-skeleton skeleton-shimmer"></span></div>');
  assert.equal(createHash('sha256').update(originalHero).digest('hex'), baseline.overviewHeroSha256, 'Only the requested name/photo slots differ from the approved Overview hero');
});

test('approved bill navigation is visual-only and makes no financial API or money requests', () => {
  assert.match(html, /<script src="payment-ui\.js\?v=\d+" defer><\/script>/);
  assert.match(app, /const payments = new PaymentExperience\(\)/);
  assert.match(app, /data-open-bill/);
  assert.match(paymentUi, /renderBill\(\)/);
  assert.doesNotMatch(releasedSource, /\/api\/(?:payments?|bills?|transactions?)\b/i);
  assert.doesNotMatch(releasedSource, /fetch\s*\([^)]*(?:payment|bill|balance|telebirr)/is);
  assert.doesNotMatch(releasedSource, /XMLHttpRequest|sendBeacon\s*\(/i);
});
