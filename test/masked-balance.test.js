import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const [app, html, styles, paymentUi, server] = await Promise.all([
  readFile(new URL('app.js', root), 'utf8'),
  readFile(new URL('index.html', root), 'utf8'),
  readFile(new URL('styles.css', root), 'utf8'),
  readFile(new URL('payment-ui.js', root), 'utf8'),
  readFile(new URL('server.js', root), 'utf8')
]);
const releasedSource = `${app}\n${html}\n${styles}\n${paymentUi}\n${server}`;
const overviewHero = html.match(/<section class="hero-card"[\s\S]*?<\/section>/)?.[0];

test('Overview hero no longer contains mock balance or balance-visibility controls', () => {
  assert.ok(overviewHero, 'Overview hero markup exists');
  assert.doesNotMatch(overviewHero, /overview-mock-balance|overview-balance-value|balance-visibility-toggle|overview-eye-slash/i);
  assert.doesNotMatch(overviewHero, /5,000\.00|Private preview balance|Balance hidden/i);
});

test('Overview identity updates retain fallback skeletons and dashboard card skeletons', () => {
  assert.match(html, /class="hero-skeleton-name skeleton-shimmer"/);
  assert.match(html, /id="overview-photo-placeholder" class="portrait-skeleton skeleton-shimmer"/);
  assert.match(html, /id="overview-photo-reflection" class="overview-photo-reflection" alt="" aria-hidden="true" hidden/);
  assert.match(html, /id="overview-profile-photo" class="overview-profile-photo" alt="Your profile photo" hidden/);
  assert.match(app, /function renderSkeletonCards\(\)[\s\S]*?skeleton-shimmer/);
  assert.match(styles, /\.skeleton-shimmer\s*\{/);
});

test('approved bill navigation remains visual-only and makes no financial API or money requests', () => {
  assert.match(html, /<script src="payment-ui\.js\?v=\d+" defer><\/script>/);
  assert.match(app, /const payments = new PaymentExperience\(\)/);
  assert.match(app, /data-open-bill/);
  assert.match(paymentUi, /renderBill\(\)/);
  assert.doesNotMatch(releasedSource, /\/api\/(?:payments?|bills?|transactions?)\b/i);
  assert.doesNotMatch(releasedSource, /fetch\s*\([^)]*(?:payment|bill|balance|telebirr)/is);
  assert.doesNotMatch(releasedSource, /XMLHttpRequest|sendBeacon\s*\(/i);
});
