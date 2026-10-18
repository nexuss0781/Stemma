import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
const renderSource = source.slice(source.indexOf('function samplePaymentDeadline('), source.indexOf('function updatePaymentProgress()'));
const frozenToday = new Date('2026-10-17T12:00:00');
const intervals = ['1-month', '2-months', '3-months', '15-days'];

function runDemo(expression, values = {}) {
  return vm.runInNewContext(`${renderSource}\n${expression}`, {
    paymentDemoInterval: '15-days',
    icon: (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"></use></svg>`,
    ...values
  });
}

function renderForYou({ deadline, today = frozenToday, interval } = {}) {
  return runDemo('renderForYou({ deadline, today, interval })', { deadline, today, interval });
}

function sampleDeadline(interval, today = frozenToday) {
  return runDemo('samplePaymentDeadline(interval, today)', { interval, today });
}

function headingFor(deadline, today = frozenToday) {
  return runDemo('paymentDeadlineHeading(deadline, today)', { deadline, today });
}

function localDateString(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addCalendarDays(date, amount) {
  const result = new Date(date);
  result.setDate(result.getDate() + amount);
  return localDateString(result);
}

function deadlineBlock(rendered) {
  return rendered.match(/<div class="fee-deadline">[\s\S]*?<\/div>/)?.[0];
}

function cssRulesMatching(selectorFragment) {
  return [...styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(([, selector, declarations]) => ({ selector: selector.replace(/\/\*[\s\S]*?\*\//g, '').trim(), declarations }))
    .filter(({ selector }) => selector.includes(selectorFragment));
}

function historyEntries() {
  return JSON.parse(runDemo('JSON.stringify(paymentHistoryEntries())'));
}

function fullHistory() {
  return runDemo('renderPaymentHistory()');
}

function visibleText(markup) {
  return markup.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function paymentHistoryTab() {
  const classes = new Set();
  const attributes = {};
  const grid = {
    classList: {
      toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); },
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); }
    },
    setAttribute(name, value) { attributes[name] = value; },
    removeAttribute(name) { delete attributes[name]; },
    innerHTML: ''
  };
  const cardsSource = source.slice(source.indexOf('function renderCards()'), source.indexOf('\nfunction render()'));
  vm.runInNewContext(`${renderSource}\n${cardsSource}\nrenderCards()`, {
    activeRoute: 'cards',
    activeTabs: { cards: 2 },
    payments: { isBillOpen: false },
    document: { getElementById: id => id === 'dashboard-grid' ? grid : null },
    window: { requestAnimationFrame: callback => callback() }
  });
  return { classes, attributes, html: grid.innerHTML };
}

const html = renderForYou({ today: frozenToday });

test('For You demo shows the generated payment date, compact interval selector, and inert CTA', () => {
  const defaultDeadline = sampleDeadline('15-days', frozenToday);
  const deadline = deadlineBlock(html);
  const picker = html.match(/<details class="fee-demo-picker"[^>]*>([\s\S]*?)<\/details>/)?.[1];
  assert.ok(picker, 'payment interval selector exists');
  assert.ok(deadline, 'payment deadline block exists');
  assert.doesNotMatch(picker, /<select\b|\bDemo\b/, 'picker has no native select or visible Demo label');
  assert.match(html, /class="fee-demo-label">Payment date is</);
  assert.match(html, /<h2 id="fee-month-title" class="is-open" aria-live="polite">OPEN<\/h2>/);
  assert.doesNotMatch(deadline, /<span>ON<\/span>/);
  assert.ok(deadline.includes(`datetime="${defaultDeadline}" data-payment-start="2026-10-17"`));
  assert.match(deadline, /<span class="fee-calendar-day" aria-hidden="true">15<\/span>/);
  assert.match(deadline, /<span class="fee-calendar-month" aria-hidden="true">Days Left<\/span>/);
  assert.match(html, /<details class="fee-demo-picker">\s*<summary class="fee-interval-pill" id="payment-demo-interval" aria-label="Payment interval"(?: aria-describedby="payment-interval-value")? aria-haspopup="listbox"><span id="payment-interval-value">/);
  assert.match(html, /<div class="fee-interval-menu" role="listbox" aria-label="Payment interval options">/);
  for (const [value, label] of [['1-month', '1 month'], ['2-months', '2 month'], ['3-months', '3 month'], ['15-days', '15 days']]) {
    assert.match(html, new RegExp(`<button class="fee-interval-option" type="button" role="option" aria-selected="(?:true|false)" data-payment-interval="${value}">${label}<\\/button>`));
  }
  assert.equal((picker.match(/class="fee-interval-option"/g) || []).length, 4);
  assert.match(picker, /<span id="payment-interval-value">15 days<\/span>/);
  assert.match(picker, /aria-selected="true" data-payment-interval="15-days">15 days<\/button>/);
  assert.match(html, /<button class="fee-continue" type="button" data-open-bill>Continue to Pay<\/button>/);
  const cta = html.match(/<button class="fee-continue"[\s\S]*?<\/button>/)?.[0];
  assert.ok(cta, 'Continue to Pay CTA exists');
  assert.doesNotMatch(cta, /data-tab|data-route|data-payment-slide/);
  assert.doesNotMatch(html, /fee-preview-note|data-fee-preview/);
  assert.match(html, /class="fee-demo-caption">Please pay by the due date to avoid penalties\.<\/p>/);
  assert.doesNotMatch(html, /skeleton-shimmer/);
});

test('interval selector is compact and right-aligned within centered demo controls', () => {
  assert.match(styles, /\.fee-demo-controls\s*\{[^}]*position:\s*relative[^}]*justify-content:\s*center/);
  assert.match(styles, /\.fee-demo-picker\s*\{[^}]*position:\s*absolute[^}]*right:\s*0/);
  assert.match(styles, /\.fee-interval-pill\s*\{[^}]*min-height:\s*26px[^}]*border-radius:\s*999px/);
  assert.match(styles, /\.fee-interval-menu\s*\{[^}]*position:\s*absolute[^}]*right:\s*0[^}]*width:\s*110px/);
});

test('interval selector retains each selected value and renders that interval deadline', () => {
  for (const interval of intervals) {
    const rendered = renderForYou({ today: frozenToday, interval });
    const deadline = sampleDeadline(interval, frozenToday);
    assert.ok(rendered.includes(`datetime="${deadline}"`), `${interval} deadline`);
    const label = interval === '1-month' ? '1 month' : interval === '2-months' ? '2 month' : interval === '3-months' ? '3 month' : '15 days';
    assert.match(rendered, new RegExp(`<button class="fee-interval-option" type="button" role="option" aria-selected="true" data-payment-interval="${interval}">${label}<\\/button>`));
    assert.match(rendered, new RegExp(`<span id="payment-interval-value">${label}<\\/span>`));
  }
});

test('payment history is 25 static, valid, descending transactions with monthly fee recurrence', () => {
  const entries = historyEntries();
  assert.equal(entries.length, 25);
  for (const entry of entries) {
    assert.deepEqual(Object.keys(entry).sort(), ['amount', 'date', 'label', 'title']);
    assert.ok(['string'].every(type => [entry.title, entry.date, entry.label, entry.amount].every(value => typeof value === type)));
    assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(new Date(`${entry.date}T00:00:00Z`).toISOString().slice(0, 10), entry.date, `valid date ${entry.date}`);
    assert.ok(entry.date <= '2026-10-17', `${entry.date} is not in the future`);
  }
  const dates = entries.map(({ date }) => date);
  assert.deepEqual(dates, [...dates].sort((left, right) => right.localeCompare(left)), 'transactions are newest first');
  assert.equal(new Set(dates).size, 25, 'each transaction has a unique date');
  const monthlyFees = entries.filter(({ title }) => title === 'Monthly fee');
  assert.equal(monthlyFees.length, 12);
  const recurringDates = [
    '2026-10-15', '2026-09-25', '2026-08-25', '2026-07-25', '2026-06-25', '2026-05-25',
    '2026-04-25', '2026-03-25', '2026-02-25', '2026-01-25', '2025-12-25', '2025-11-25'
  ];
  assert.deepEqual(monthlyFees.map(({ date }) => date), recurringDates);
  assert.equal(new Set(monthlyFees.map(({ date }) => date.slice(0, 7))).size, 12, 'monthly fee recurs in 12 distinct months');
});

test('five-row payment preview retains its original leading transactions without demo/sample labels or a count', () => {
  const preview = html.match(/<article class="fee-history-card"[\s\S]*?<\/article>/)?.[0];
  assert.ok(preview, 'payment history preview exists');
  assert.match(preview, /Payment activity · ETB/);
  const rows = [...preview.matchAll(/<li>([\s\S]*?)<\/li>/g)].map(([, row]) => row);
  assert.equal(rows.length, 5);
  const leadingTransactions = [
    ['Monthly fee', '2026-10-15', '1,250'],
    ['Library', '2026-10-12', '150'],
    ['Lab fee', '2026-10-08', '300'],
    ['Monthly fee', '2026-09-25', '1,250'],
    ['ID card', '2026-09-21', '100']
  ];
  rows.forEach((row, index) => {
    const [title, date, amount] = leadingTransactions[index];
    assert.match(row, new RegExp(`<strong>${title}<\\/strong>[\\s\\S]*<time datetime="${date}"`));
    assert.match(row, new RegExp(`<span class="fee-history-total"><strong>${amount}<\\/strong><span>ETB<\\/span>`));
    assert.doesNotMatch(row, /Sample|Demo/i);
  });
  assert.doesNotMatch(visibleText(preview), /Sample|Demo|\b\d+\s+(?:payments|transactions|entries)\b/i);
  assert.match(preview, /<article class="fee-history-card" aria-labelledby="fee-history-title">/);
  assert.match(preview, /data-tab="2" aria-label="View all payment history"/);
  assert.equal((html.match(/class="fee-view-history"/g) || []).length, 1);
});

test('full history renders all 25 transactions as an accessible article and list, with no visible count or demo language', () => {
  const rendered = fullHistory();
  assert.match(rendered, /<article class="fee-history-card payment-history-panel" aria-labelledby="payment-history-title">/);
  assert.match(rendered, /<h2 id="payment-history-title">History<\/h2>/);
  assert.match(rendered, /Monthly payments and other fees · ETB/);
  assert.match(rendered, /<ul class="fee-history-list" aria-label="Payment transactions">/);
  assert.equal((rendered.match(/<li>/g) || []).length, 25);
  assert.doesNotMatch(visibleText(rendered), /Sample|Demo|\b\d+\s+(?:payments|transactions|entries)\b/i);
  assert.doesNotMatch(renderSource, /fetch\s*\(|localStorage|sessionStorage|XMLHttpRequest|\.\s*(?:push|pop|splice|shift|unshift|sort|reverse)\s*\(/i);
  const before = JSON.stringify(historyEntries());
  fullHistory();
  renderForYou({ today: frozenToday });
  assert.equal(JSON.stringify(historyEntries()), before, 'rendering does not mutate the static transaction data');
});

test('the history tab renders the full history on the existing cards grid with scrollable, unclipped rows', () => {
  const tab = paymentHistoryTab();
  assert.ok(tab.classes.has('payment-history-grid'), 'history tab adds the payment-history-grid class');
  assert.equal((tab.html.match(/<li>/g) || []).length, 25);
  assert.match(tab.html, /aria-label="Payment transactions"/);
  const grid = cssRulesMatching('.dashboard-grid.payment-history-grid').find(({ selector }) => selector === '.dashboard-grid.payment-history-grid');
  assert.ok(grid, 'history grid has a dedicated layout rule');
  assert.match(grid.declarations, /display:\s*block/);
  assert.match(grid.declarations, /overflow-y:\s*auto/);
  assert.match(grid.declarations, /overflow-x:\s*hidden/);
  const list = cssRulesMatching('.payment-history-panel .fee-history-list').find(({ selector }) => selector === '.payment-history-panel .fee-history-list');
  assert.ok(list, 'full-history list does not flex-shrink into the preview card height');
  assert.match(list.declarations, /flex:\s*none/);
  assert.match(list.declarations, /justify-content:\s*flex-start/);
  const rows = cssRulesMatching('.payment-history-panel .fee-history-list li').find(({ selector }) => selector === '.payment-history-panel .fee-history-list li');
  assert.ok(rows, 'history rows have full-height spacing instead of clipping');
  assert.match(rows.declarations, /min-height:\s*66px/);
});

test('history action continues to target cards tab index 2', () => {
  assert.match(html, /data-tab="2" aria-label="View all payment history"/);
});

test('history action overlay spans its card and keyboard focus remains visible', () => {
  assert.match(styles, /\.fee-history-card\s*\{[^}]*position:\s*relative/);
  assert.match(styles, /\.fee-view-history::after\s*\{[^}]*position:\s*absolute[^}]*inset:\s*0/);
  assert.match(styles, /\.fee-history-card:has\(\.fee-view-history:focus-visible\)\s*\{[^}]*outline:\s*2px solid/);
  assert.match(styles, /\.fee-view-history:focus-visible\s*\{[^}]*outline:\s*none/);
});

test('friends remains a whole-card slide button and history targets tab index 2', () => {
  assert.match(html, /<button class="fee-friends-card" type="button" data-payment-slide="1"[^>]*aria-label="Pay for your friends\. Open For friend slide">[\s\S]*?<\/button>/);
  assert.equal((html.match(/data-payment-slide="1"/g) || []).length, 1);
  assert.match(html, /<button class="fee-continue" type="button" data-open-bill>Continue to Pay<\/button>/);
  assert.match(html, /data-tab="2" aria-label="View all payment history"/);
  assert.doesNotMatch(source, /data-fee-preview|fee-preview-note/);
});

test('Continue to Pay opens the bill preview without opening the payment sheet', () => {
  const listenerStart = source.indexOf("document.addEventListener('click'");
  const listenerEnd = source.indexOf('\n});', listenerStart) + 4;
  assert.ok(listenerStart >= 0 && listenerEnd > listenerStart, 'document click listener exists');
  let clickListener;
  const calls = [];
  const payments = {
    isBillOpen: false,
    isReceiptOpen: true,
    showSheet: () => calls.push('showSheet')
  };
  vm.runInNewContext(source.slice(listenerStart, listenerEnd), {
    document: { addEventListener: (_type, listener) => { clickListener = listener; }, querySelectorAll: () => [] },
    window: { matchMedia: () => ({ matches: false }) },
    activeRoute: 'cards',
    paymentSlideIndex: 0,
    payments,
    render: () => { calls.push('render'); },
    renderTabs: () => { calls.push('renderTabs'); }
  });
  const button = { dataset: {}, closest: selector => selector === '[data-open-bill]' ? button : null };
  clickListener({ target: button });
  assert.equal(payments.isBillOpen, true);
  assert.equal(payments.isReceiptOpen, false, 'opening bill details resets any prior receipt');
  assert.deepEqual(calls, ['render']);
});

test('Continue on the bill preview opens the payment sheet exactly once', () => {
  const listenerStart = source.indexOf("document.addEventListener('click'");
  const listenerEnd = source.indexOf('\n});', listenerStart) + 4;
  let clickListener;
  let showSheetCalls = 0;
  vm.runInNewContext(source.slice(listenerStart, listenerEnd), {
    document: { addEventListener: (_type, listener) => { clickListener = listener; }, querySelectorAll: () => [] },
    window: { matchMedia: () => ({ matches: false }) },
    activeRoute: 'cards',
    paymentSlideIndex: 0,
    payments: { isBillOpen: true, showSheet: () => { showSheetCalls += 1; } },
    render: () => {},
    renderTabs: () => {}
  });
  const button = { closest: selector => selector === '[data-review-bill]' ? button : null };
  clickListener({ target: button });
  assert.equal(showSheetCalls, 1);
});

test('Back from the bill preview closes it and renders the prior payment view', () => {
  const listenerStart = source.indexOf("document.addEventListener('click'");
  const listenerEnd = source.indexOf('\n});', listenerStart) + 4;
  let clickListener;
  const calls = [];
  const payments = {
    isBillOpen: true,
    isReceiptOpen: true,
    closeSheet: () => { calls.push('closeSheet'); }
  };
  vm.runInNewContext(source.slice(listenerStart, listenerEnd), {
    document: {
      addEventListener: (_type, listener) => { clickListener = listener; },
      querySelectorAll: () => [],
      querySelector: () => ({ focus: () => { calls.push('focus'); } })
    },
    window: { matchMedia: () => ({ matches: false }) },
    activeRoute: 'cards',
    paymentSlideIndex: 0,
    payments,
    render: () => { calls.push('render'); },
    renderTabs: () => {}
  });
  const button = { closest: selector => selector === '[data-bill-back]' ? button : null };
  clickListener({ target: button });
  assert.equal(payments.isBillOpen, false);
  assert.equal(payments.isReceiptOpen, false, 'back to payment view clears receipt state');
  assert.deepEqual(calls, ['closeSheet', 'render', 'focus']);
});

test('payment deadline heading uses exact UTC calendar-day thresholds', () => {
  const cases = [
    [0, 'Payment Date is Open'],
    [15, 'Payment Date is Open'],
    [16, 'This Month'],
    [30, 'This Month'],
    [45, 'This Month'],
    [46, 'Next Month'],
    [60, 'Next Month'],
    [75, 'Next Month'],
    [76, 'In 3 Months'],
    [90, 'In 3 Months']
  ];
  for (const [days, expected] of cases) {
    assert.equal(headingFor(addCalendarDays(frozenToday, days), frozenToday), expected, `${days} days away`);
  }
  assert.equal(headingFor(addCalendarDays(frozenToday, -1), frozenToday), 'Payment Date');
  assert.equal(headingFor('not-a-date', frozenToday), 'Payment Date');
  assert.equal(headingFor('2026-02-30', frozenToday), 'Payment Date');
});

test('sample payment intervals add calendar months with end-of-month clamping and calendar days', () => {
  const oct31 = new Date('2026-10-31T12:00:00');
  assert.deepEqual(intervals.map(interval => sampleDeadline(interval, oct31)), [
    '2026-11-30', '2026-12-31', '2027-01-31', '2026-11-15'
  ]);
  const jan31Leap = new Date('2024-01-31T12:00:00');
  assert.equal(sampleDeadline('1-month', jan31Leap), '2024-02-29');
  assert.equal(sampleDeadline('2-months', jan31Leap), '2024-03-31');
  assert.equal(sampleDeadline('3-months', jan31Leap), '2024-04-30');
  assert.equal(sampleDeadline('15-days', new Date('2026-12-25T12:00:00')), '2027-01-09');
});

test('rendered heading and calendar fields agree with the generated selected-interval deadline', () => {
  const interval = '3-months';
  const deadline = sampleDeadline(interval, frozenToday);
  const rendered = renderForYou({ today: frozenToday, interval });
  const [year, month, day] = deadline.split('-').map(Number);
  const date = new Date(`${deadline}T12:00:00`);
  const monthYear = date.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const ariaLabel = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  assert.match(rendered, /<h2 id="fee-month-title"[^>]*>In 3 Months<\/h2>/);
  const block = deadlineBlock(rendered);
  assert.ok(block, 'non-open deadline block exists');
  assert.match(block, /<span>ON<\/span>/);
  assert.ok(block.includes(`<time class="fee-calendar" datetime="${deadline}" aria-label="${ariaLabel}">`));
  assert.doesNotMatch(block, /data-payment-start=/);
  assert.match(block, new RegExp(`<span class="fee-calendar-day" aria-hidden="true">${day}<\\/span>`));
  assert.ok(block.includes(`<span class="fee-calendar-month" aria-hidden="true">${monthYear}</span>`));
  assert.equal(month, 1);
  assert.equal(year, 2027);
});

test('open payment windows render the start date and UTC calendar days remaining', () => {
  const cases = [
    { name: 'default 15-day interval', rendered: renderForYou({ today: frozenToday }), deadline: '2026-11-01', start: '2026-10-17', days: 15 },
    { name: 'explicit ten-day deadline', rendered: renderForYou({ today: frozenToday, deadline: '2026-10-27' }), deadline: '2026-10-27', start: '2026-10-12', days: 10 },
    { name: 'deadline today', rendered: renderForYou({ today: frozenToday, deadline: '2026-10-17' }), deadline: '2026-10-17', start: '2026-10-02', days: 0 }
  ];
  for (const { name, rendered, deadline, start, days } of cases) {
    const block = deadlineBlock(rendered);
    assert.ok(block, `${name}: deadline block exists`);
    assert.match(rendered, /<h2 id="fee-month-title" class="is-open" aria-live="polite">OPEN<\/h2>/, name);
    assert.doesNotMatch(block, /<span>ON<\/span>/, name);
    assert.ok(block.includes(`datetime="${deadline}" data-payment-start="${start}"`), `${name}: start and deadline dates`);
    assert.match(block, new RegExp(`<span class="fee-calendar-day" aria-hidden="true">${days}<\\/span>`), name);
    assert.match(block, /<span class="fee-calendar-month" aria-hidden="true">Days Left<\/span>/, name);
    assert.match(block, new RegExp(`Payment window starts ${start}; ${days} days remaining`), name);
  }
});

test('rendered payment-open state follows the unchanged deadline heading thresholds', () => {
  const cases = [
    { days: 0, open: true, heading: 'OPEN' },
    { days: 15, open: true, heading: 'OPEN' },
    { days: 16, open: false, heading: 'This Month' },
    { days: 30, open: false, heading: 'This Month' },
    { days: 60, open: false, heading: 'Next Month' },
    { days: 90, open: false, heading: 'In 3 Months' }
  ];
  for (const { days, open, heading } of cases) {
    const deadline = addCalendarDays(frozenToday, days);
    const rendered = renderForYou({ deadline, today: frozenToday });
    assert.match(rendered, new RegExp(`<article class="fee-month-card" data-payment-open="${open}" aria-labelledby="fee-month-title">`), `${days} days: payment-open attribute`);
    assert.match(rendered, new RegExp(`<h2 id="fee-month-title"[^>]*>${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<\\/h2>`), `${days} days: heading`);
    const cta = rendered.match(/<button class="fee-continue"[^>]*>[\s\S]*?<\/button>/)?.[0];
    assert.ok(cta, `${days} days: Continue/Deposit CTA exists`);
    if (open) {
      assert.match(cta, /type="button" data-open-bill>Continue to Pay<\/button>/, `${days} days: open CTA retains bill preview action`);
      assert.doesNotMatch(cta, /data-tab="1"/, `${days} days: open CTA does not navigate to Deposit`);
    } else {
      assert.match(cta, /type="button" data-tab="1">Deposit Now<\/button>/, `${days} days: pending CTA navigates to Deposit`);
      assert.doesNotMatch(cta, /data-open-bill/, `${days} days: pending CTA does not open the bill preview`);
    }
    const block = deadlineBlock(rendered);
    assert.ok(block, `${days} days: deadline block exists`);
    if (open) {
      assert.doesNotMatch(block, /<span>ON<\/span>/, `${days} days: open window has no ON marker`);
      assert.match(block, /<span class="fee-calendar-month" aria-hidden="true">Days Left<\/span>/, `${days} days: open window retains Days Left`);
    } else {
      assert.match(block, /<span>ON<\/span>/, `${days} days: closed window retains ON marker`);
      assert.doesNotMatch(block, /<span class="fee-calendar-month" aria-hidden="true">Days Left<\/span>/, `${days} days: closed window has no Days Left marker`);
    }
  }
});

test('closed payment card uses the shared light-gold palette and pending CTA colors', () => {
  const sharedCard = cssRulesMatching('.fee-month-card, .fee-friends-card, .fee-history-card')
    .find(({ selector }) => selector === '.fee-month-card, .fee-friends-card, .fee-history-card');
  assert.ok(sharedCard, 'shared card rule remains present');
  assert.match(sharedCard.declarations, /background:\s*linear-gradient\(140deg,\s*rgba\(251,241,200,\.94\),\s*rgba\(251,241,200,\.58\)\)/);

  const closedRules = cssRulesMatching('.fee-month-card[data-payment-open="false"]');
  const cardPalette = closedRules.find(({ selector }) => selector === '.fee-month-card[data-payment-open="false"]');
  assert.ok(cardPalette, 'closed state is scoped to the payment card');
  assert.match(cardPalette.declarations, /background:\s*linear-gradient\(140deg,\s*rgba\(251,241,200,\.94\),\s*rgba\(251,241,200,\.58\)\)/);
  assert.match(cardPalette.declarations, /color:\s*var\(--brand-burgundy\)/);
  for (const [target, color] of [
    ['h2', /color:\s*var\(--brand-burgundy\)/],
    ['.fee-calendar', /color:\s*var\(--brand-burgundy\)/],
    ['.fee-deadline', /color:\s*var\(--brand-burgundy\)/],
    ['.fee-demo-label', /color:\s*rgba\(104,27,29,\.75\)/],
    ['.fee-demo-caption', /color:\s*rgba\(104,27,29,\.75\)/]
  ]) {
    assert.ok(closedRules.some(({ selector, declarations }) => selector.includes(target) && color.test(declarations)), `closed ${target} typography is burgundy`);
  }
  const pendingCta = closedRules.find(({ selector }) => selector.replace(/\s+/g, ' ').trim() === '.fee-month-card[data-payment-open="false"] .fee-continue, .fee-month-card[data-payment-open="false"] .fee-continue:hover');
  assert.ok(pendingCta, 'pending CTA and hover selectors are grouped and scoped to the closed payment card');
  assert.deepEqual(pendingCta.selector.split(',').map(selector => selector.trim()), [
    '.fee-month-card[data-payment-open="false"] .fee-continue',
    '.fee-month-card[data-payment-open="false"] .fee-continue:hover'
  ]);
  assert.match(pendingCta.declarations, /background:\s*var\(--brand-burgundy\)/, 'pending CTA and hover use burgundy background');
  assert.match(pendingCta.declarations, /color:\s*var\(--brand-gold\)/, 'pending CTA and hover use gold text');

  const cta = cssRulesMatching('.fee-continue').find(({ selector }) => selector === '.fee-continue');
  const ctaHover = cssRulesMatching('.fee-continue:hover').find(({ selector }) => selector === '.fee-continue:hover');
  assert.ok(cta, 'base Continue to Pay button rule exists');
  assert.match(cta.declarations, /background:\s*var\(--brand-gold\)/);
  assert.match(cta.declarations, /color:\s*var\(--brand-burgundy\)/);
  assert.ok(ctaHover, 'Continue to Pay hover rule exists');
  assert.match(ctaHover.declarations, /background:\s*var\(--brand-gold\)/);
  assert.doesNotMatch(ctaHover.declarations, /color:/, 'open CTA keeps its original text color on hover');
});
