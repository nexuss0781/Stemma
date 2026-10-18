const sections = [
  { id: 'cards', icon: 'card', label: 'Payment' },
  { id: 'activity', icon: 'activity', label: 'Activity' },
  { id: 'overview', icon: 'grid', label: 'Overview' },
  { id: 'goals', icon: 'target', label: 'Goals' },
  { id: 'profile', icon: 'user', label: 'Profile' }
];

const pageTabs = {
  overview: ['Snapshot', 'Cash flow', 'This month'],
  cards: ['Pay fee', 'Deposit', 'History'],
  activity: ['All activity', 'Incoming', 'Outgoing'],
  goals: ['Active goals', 'Completed', 'Create goal'],
  profile: ['Personal', 'Security', 'Preferences']
};

let activeRoute = 'cards';
const activeTabs = Object.fromEntries(sections.map(({ id }) => [id, 0]));
let routeDirection = 0;
let navIndicatorReady = false;
let onboardingScrollFrame = 0;
let paymentScrollFrame = 0;
let paymentSlideIndex = 0;
let paymentDemoInterval = '15-days';
const paymentSlides = ['For You', 'For friend'];

const payments = new PaymentExperience();
const icon = (name, extra = '') => `<svg class="icon ${extra}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;

function renderBottomNav() {
  const bottomNav = document.getElementById('bottom-nav');
  if (!bottomNav.querySelector('.nav-indicator')) {
    bottomNav.innerHTML = `<span class="nav-indicator" aria-hidden="true"></span>${sections.map(item => `
      <button class="nav-item" type="button" data-route="${item.id}" aria-current="false" aria-label="${item.label}">
        ${icon(item.icon)}
      </button>`).join('')}`;
  }
  bottomNav.querySelectorAll('.nav-item').forEach(button => {
    button.setAttribute('aria-current', button.dataset.route === activeRoute ? 'page' : 'false');
  });

  const drawerLinks = document.getElementById('drawer-links');
  if (!drawerLinks.children.length) {
    drawerLinks.innerHTML = sections.map(item => `
      <button class="drawer-link" type="button" data-route="${item.id}" aria-current="false" aria-label="${item.label}">
        ${icon(item.icon)}<span class="drawer-link-skeleton" aria-hidden="true"></span>
      </button>`).join('');
  }
  drawerLinks.querySelectorAll('.drawer-link').forEach(button => {
    button.setAttribute('aria-current', button.dataset.route === activeRoute ? 'page' : 'false');
  });
  updateNavIndicator();
}

function updateNavIndicator() {
  const nav = document.getElementById('bottom-nav');
  const indicator = nav.querySelector('.nav-indicator');
  const activeButton = nav.querySelector(`.nav-item[data-route="${activeRoute}"]`);
  if (!indicator || !activeButton) return;
  const navRect = nav.getBoundingClientRect();
  const buttonRect = activeButton.getBoundingClientRect();
  const width = `${buttonRect.width}px`;
  const transform = `translateX(${buttonRect.left - navRect.left - nav.clientLeft}px)`;
  if (!navIndicatorReady) {
    indicator.style.transition = 'none';
    indicator.style.width = width;
    indicator.style.transform = transform;
    indicator.getBoundingClientRect();
    indicator.style.transition = '';
    navIndicatorReady = true;
    return;
  }
  indicator.style.width = width;
  indicator.style.transform = transform;
}

function setPreviewBalanceVisible(visible) {
  const value = document.getElementById('overview-balance-value');
  const button = document.getElementById('balance-visibility-toggle');
  if (!value || !button) return;
  // Private local visual fixture only; never a bank/ledger balance.
  value.textContent = visible ? '5,000.00' : '••••••';
  value.setAttribute('aria-label', visible ? 'Balance 5,000.00 ETB' : 'Balance hidden');
  button.setAttribute('aria-pressed', String(visible));
  button.setAttribute('aria-label', visible ? 'Hide balance' : 'Show balance');
}

function renderTabs() {
  const tabs = pageTabs[activeRoute];
  const tabNav = document.getElementById('page-tabs');
  const paymentView = activeRoute === 'cards';
  tabNav.setAttribute('aria-label', `${sections.find(item => item.id === activeRoute).label} tabs`);
  tabNav.innerHTML = tabs.map((tab, index) => `
    <button class="page-tab" type="button" role="tab" aria-selected="${index === activeTabs[activeRoute]}" aria-label="${tab}" aria-controls="dashboard-grid" data-tab="${index}">
      ${paymentView ? `<span class="tab-label">${tab}</span>` : '<span class="tab-skeleton skeleton-shimmer" aria-hidden="true"></span>'}
    </button>`).join('');
}

const cardTargets = ['activity', 'goals', 'cards', 'profile'];
function renderSkeletonCards() {
  return cardTargets.map((route, index) => `
    <article class="skeleton-card" aria-label="Placeholder ${index + 1}">
      <div class="skeleton-card-top">
        <span class="card-title-skeleton skeleton-shimmer" aria-hidden="true"></span>
        <button class="view-more" type="button" data-route="${route}" aria-label="Open ${sections.find(item => item.id === route).label}">
          <span class="view-more-skeleton skeleton-shimmer" aria-hidden="true"></span>${icon('arrow-up-right')}
        </button>
      </div>
      <div class="skeleton-card-middle" aria-hidden="true">
        <span class="card-icon-skeleton skeleton-shimmer"></span>
        <div class="skeleton-lines">
          <span class="skeleton-line line-one skeleton-shimmer"></span>
          <span class="skeleton-line line-two skeleton-shimmer"></span>
          <span class="skeleton-line line-three skeleton-shimmer"></span>
        </div>
      </div>
      <div class="skeleton-card-foot" aria-hidden="true">
        <span class="footer-dot"></span><span class="footer-label-skeleton skeleton-shimmer"></span><span class="footer-value-skeleton skeleton-shimmer"></span>
      </div>
    </article>`).join('');
}
function samplePaymentDeadline(interval, today = new Date()) {
  const date = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (interval === '15-days') {
    date.setDate(date.getDate() + 15);
  } else {
    const months = { '1-month': 1, '2-months': 2, '3-months': 3 }[interval] || 1;
    const day = date.getDate();
    date.setDate(1);
    date.setMonth(date.getMonth() + months);
    const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    date.setDate(Math.min(day, lastDay));
  }
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function paymentDeadlineHeading(deadline, today = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline)) return 'Payment Date';
  const [year, month, day] = deadline.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day || Number.isNaN(today.getTime())) return 'Payment Date';
  // Compare calendar days, not elapsed hours, so DST does not shift the 15-day boundary.
  const daysAway = Math.round((Date.UTC(year, month - 1, day) - Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000);
  if (daysAway < 0) return 'Payment Date';
  if (daysAway <= 15) return 'Payment Date is Open';
  if (daysAway <= 45) return 'This Month';
  if (daysAway <= 75) return 'Next Month';
  return `In ${Math.max(3, Math.round(daysAway / 30))} Months`;
}

// Static presentation fixtures only; never persisted or connected to a wallet or ledger.
function paymentHistoryEntries() {
  return [
    ['Monthly fee', '2026-10-15', '1,250'],
    ['Library', '2026-10-12', '150'],
    ['Lab fee', '2026-10-08', '300'],
    ['Monthly fee', '2026-09-25', '1,250'],
    ['ID card', '2026-09-21', '100'],
    ['Library', '2026-09-10', '150'],
    ['Monthly fee', '2026-08-25', '1,250'],
    ['Lab fee', '2026-08-18', '300'],
    ['Library', '2026-08-05', '150'],
    ['Monthly fee', '2026-07-25', '1,250'],
    ['Lab fee', '2026-07-16', '300'],
    ['Monthly fee', '2026-06-25', '1,250'],
    ['Library', '2026-06-12', '150'],
    ['Monthly fee', '2026-05-25', '1,250'],
    ['Lab fee', '2026-05-14', '300'],
    ['Monthly fee', '2026-04-25', '1,250'],
    ['Library', '2026-04-09', '150'],
    ['Monthly fee', '2026-03-25', '1,250'],
    ['Lab fee', '2026-03-06', '300'],
    ['Monthly fee', '2026-02-25', '1,250'],
    ['Library', '2026-02-10', '150'],
    ['Monthly fee', '2026-01-25', '1,250'],
    ['Lab fee', '2026-01-12', '300'],
    ['Monthly fee', '2025-12-25', '1,250'],
    ['Monthly fee', '2025-11-25', '1,250']
  ].map(([title, date, amount], index) => ({ title, date, amount,
    id: `STM-${date.replaceAll('-', '')}-${String(index + 1).padStart(3, '0')}`,
    qrId: `STEMMA-RECEIPT-${date.replaceAll('-', '')}-${String(index + 1).padStart(3, '0')}`,
    qrSrc: `/assets/history/receipt-${String(index + 1).padStart(3, '0')}.svg`,
    label: new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })
  }));
}

function renderHistoryRows(entries, { interactive = false } = {}) {
  return entries.map(item => {
    const details = `<span class="fee-history-detail"><strong>${item.title}</strong><time datetime="${item.date}">${item.label}</time></span><span class="fee-history-total"><strong>${item.amount}</strong><span>ETB</span></span>`;
    return `<li>${interactive ? `<button class="history-transaction" type="button" data-history-entry="${item.id}" aria-haspopup="dialog" aria-controls="history-details-dialog" aria-label="View transaction: ${item.title}, ${item.label}, ${item.amount} ETB">${details}</button>` : details}</li>`;
  }).join('');
}

function renderHistoryDetails(entry) {
  return `<button class="history-details-close" type="button" data-close-history-details aria-label="Close transaction details" autofocus>${icon('close')}</button>
    <h2 id="history-details-title">Transaction details</h2>
    <figure class="history-details-qr"><img src="${entry.qrSrc}" width="200" height="200" alt="Transaction receipt QR code" data-qr-payload="${entry.qrId}" /><figcaption>Receipt QR</figcaption></figure>
    <dl class="history-details-fields">
      <div><dt>Transaction number</dt><dd>${entry.id}</dd></div>
      <div><dt>Reason</dt><dd>${entry.title}</dd></div>
      <div><dt>Amount</dt><dd class="history-details-amount">${entry.amount} <small>ETB</small></dd></div>
      <div><dt>Date</dt><dd>${entry.label}</dd></div>
    </dl>`;
}

function showHistoryDetails(id) {
  if (activeRoute !== 'cards' || activeTabs.cards !== 2) return;
  const entry = paymentHistoryEntries().find(item => item.id === id);
  const dialog = document.getElementById('history-details-dialog');
  if (!entry || !dialog || dialog.open) return;
  dialog.innerHTML = renderHistoryDetails(entry);
  dialog.showModal();
}

function closeHistoryDetails() {
  const dialog = document.getElementById('history-details-dialog');
  if (dialog?.open) dialog.close();
}

function renderPaymentHistory() {
  return `<article class="fee-history-card payment-history-panel" aria-labelledby="payment-history-title">
    <div class="fee-history-heading"><h2 id="payment-history-title">History</h2></div>
    <p class="payment-history-subtitle">Monthly payments and other fees · ETB</p>
    <ul class="fee-history-list" aria-label="Payment transactions">${renderHistoryRows(paymentHistoryEntries(), { interactive: true })}</ul>
    <dialog class="history-details-dialog" id="history-details-dialog" aria-labelledby="history-details-title"></dialog>
  </article>`;
}

function renderForYou({ deadline, today = new Date(), interval = paymentDemoInterval } = {}) {
  // Static visual fixtures only: never sent to an API or saved as payment records.
  // Demo selection shifts only the sample deadline; no payment action is enabled.
  deadline = deadline || samplePaymentDeadline(interval, today);
  const deadlineDate = new Date(`${deadline}T12:00:00`);
  const deadlineDay = deadlineDate.getDate();
  const deadlineMonth = deadlineDate.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const deadlineLabel = deadlineDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const heading = paymentDeadlineHeading(deadline, today);
  const isOpen = heading === 'Payment Date is Open';
  // The payment window begins 15 calendar days before its due date.
  const openingDate = new Date(deadlineDate);
  openingDate.setDate(openingDate.getDate() - 15);
  const openingDay = `${openingDate.getFullYear()}-${String(openingDate.getMonth() + 1).padStart(2, '0')}-${String(openingDate.getDate()).padStart(2, '0')}`;
  const daysRemaining = Math.max(0, Math.round((Date.UTC(deadlineDate.getFullYear(), deadlineDate.getMonth(), deadlineDate.getDate()) - Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000));
  const recentHistory = paymentHistoryEntries().slice(0, 5);
  return `<div class="fee-for-you">
    <article class="fee-month-card" data-payment-open="${isOpen}" aria-labelledby="fee-month-title">
      <div class="fee-demo-controls">
        <span class="fee-demo-label">Payment date is</span>
        <details class="fee-demo-picker">
          <summary class="fee-interval-pill" id="payment-demo-interval" aria-label="Payment interval" aria-describedby="payment-interval-value" aria-haspopup="listbox"><span id="payment-interval-value">${{ '1-month': '1 month', '2-months': '2 month', '3-months': '3 month', '15-days': '15 days' }[interval]}</span>${icon('chevron')}</summary>
          <div class="fee-interval-menu" role="listbox" aria-label="Payment interval options">
            ${[['1-month', '1 month'], ['2-months', '2 month'], ['3-months', '3 month'], ['15-days', '15 days']].map(([value, label]) => `<button class="fee-interval-option" type="button" role="option" aria-selected="${value === interval}" data-payment-interval="${value}">${label}</button>`).join('')}
          </div>
        </details>
      </div>
      <h2 id="fee-month-title"${isOpen ? ' class="is-open"' : ''} aria-live="polite">${isOpen ? 'OPEN' : heading}</h2>
      <div class="fee-deadline">
        ${isOpen ? '' : '<span>ON</span>'}
        <time class="fee-calendar" datetime="${deadline}"${isOpen ? ` data-payment-start="${openingDay}"` : ''} aria-label="${isOpen ? `Payment window starts ${openingDay}; ${daysRemaining} days remaining, due ${deadlineLabel}` : deadlineLabel}">
          <span class="fee-calendar-day" aria-hidden="true">${isOpen ? daysRemaining : deadlineDay}</span>
          <span class="fee-calendar-month" aria-hidden="true">${isOpen ? 'Days Left' : deadlineMonth}</span>
        </time>
      </div>
      <button class="fee-continue" type="button" ${isOpen ? 'data-open-bill' : 'data-tab="1"'}>${isOpen ? 'Continue to Pay' : 'Deposit Now'}</button>
      <p class="fee-demo-caption">Please pay by the due date to avoid penalties.</p>
    </article>
    <button class="fee-friends-card" type="button" data-payment-slide="1" aria-label="Pay for your friends. Open For friend slide">
      <span class="fee-shortcut-top"><span class="fee-friends-symbol" aria-hidden="true">${icon('user')}${icon('user')}</span>${icon('arrow-up-right')}</span>
      <span class="fee-friends-title">Pay for your<br>friends</span>
      <span class="fee-friends-hint">Go to For friend <span aria-hidden="true">→</span></span>
    </button>
    <article class="fee-history-card" aria-labelledby="fee-history-title">
      <div class="fee-history-heading"><h3 id="fee-history-title">History</h3><button class="fee-view-history" type="button" data-tab="2" aria-label="View all payment history">${icon('arrow-up-right')}</button></div>
      <p class="fee-history-demo">Payment activity · ETB</p>
      <ul class="fee-history-list" aria-label="Recent payment activity">
        ${renderHistoryRows(recentHistory)}
      </ul>
    </article>
  </div>`;
}
function renderDepositForm() {
  return `<section class="deposit-entry-card" aria-labelledby="deposit-entry-title">
    <h2 id="deposit-entry-title">Deposit</h2>
    <form id="deposit-amount-form">
      <label for="deposit-amount">Amount of money</label>
      <div class="deposit-amount-field"><input id="deposit-amount" name="amount" type="number" inputmode="decimal" min="0.01" max="999999999.99" step="0.01" required placeholder="0.00" value="${payments.depositAmount || ''}" aria-describedby="deposit-entry-note" /><span>ETB</span></div>
      <button class="deposit-entry-submit" type="submit">Deposit</button>
      <p id="deposit-entry-note">Visual preview only · No payment will be sent.</p>
    </form>
  </section>`;
}

function updatePaymentProgress() {
  const grid = document.getElementById('dashboard-grid');
  if (!grid.classList.contains('payment-carousel') || !grid.clientWidth) return;
  paymentSlideIndex = Math.max(0, Math.min(paymentSlides.length - 1, Math.round(grid.scrollLeft / grid.clientWidth)));
  document.getElementById('payment-slide-label').textContent = paymentSlides[paymentSlideIndex];
  const progress = document.getElementById('payment-progress');
  progress.setAttribute('aria-label', `${paymentSlides[paymentSlideIndex]}, ${paymentSlideIndex + 1} of ${paymentSlides.length}`);
  progress.querySelectorAll('.progress-dot').forEach((dot, index) => {
    dot.classList.toggle('is-active', index === paymentSlideIndex);
  });
}
function syncPaymentCarousel() {
  const grid = document.getElementById('dashboard-grid');
  if (!grid.classList.contains('payment-carousel') || !grid.clientWidth) return;
  grid.scrollLeft = paymentSlideIndex * grid.clientWidth;
  updatePaymentProgress();
}
function renderCards() {
  const grid = document.getElementById('dashboard-grid');
  const billView = activeRoute === 'cards' && payments.isBillOpen;
  const paymentCarousel = activeRoute === 'cards' && activeTabs.cards === 0 && !billView;
  grid.classList.toggle('payment-carousel', paymentCarousel);
  grid.classList.toggle('bill-content-grid', billView);
  grid.classList.toggle('deposit-entry-grid', activeRoute === 'cards' && activeTabs.cards === 1 && !billView);
  grid.classList.toggle('payment-history-grid', activeRoute === 'cards' && activeTabs.cards === 2 && !billView);
  if (billView) {
    grid.removeAttribute('role');
    grid.removeAttribute('aria-roledescription');
    grid.removeAttribute('tabindex');
    grid.setAttribute('aria-label', payments.isReceiptOpen ? 'Receipt preview' : 'Bill payment details');
    grid.innerHTML = payments.isReceiptOpen ? payments.renderReceipt() : payments.renderBill();
    return;
  }
  if (paymentCarousel) {
    grid.setAttribute('role', 'region');
    grid.setAttribute('aria-roledescription', 'carousel');
    grid.setAttribute('aria-label', 'Pay fee options. Swipe horizontally to move between For You and For friend.');
    grid.tabIndex = 0;
    grid.innerHTML = paymentSlides.map((label, index) => `
      <section class="payment-slide" role="group" aria-roledescription="slide" aria-label="${index + 1} of ${paymentSlides.length}: ${label}">
        ${index === 0 ? renderForYou() : `<div class="payment-slide-grid">${renderSkeletonCards()}</div>`}
      </section>`).join('');
    window.requestAnimationFrame(syncPaymentCarousel);
    return;
  }
  grid.removeAttribute('role');
  grid.removeAttribute('aria-roledescription');
  grid.removeAttribute('tabindex');
  if (activeRoute === 'cards' && activeTabs.cards === 1) {
    grid.setAttribute('aria-label', 'Deposit amount');
    grid.innerHTML = renderDepositForm();
    return;
  }
  if (activeRoute === 'cards' && activeTabs.cards === 2) {
    grid.setAttribute('role', 'region');
    grid.setAttribute('aria-label', 'Payment history');
    grid.tabIndex = 0;
    grid.innerHTML = renderPaymentHistory();
    grid.scrollTop = 0;
    return;
  }
  grid.setAttribute('aria-label', 'Content placeholders');
  grid.innerHTML = renderSkeletonCards();
}

function render() {
  const main = document.getElementById('app-main');
  const overview = activeRoute === 'overview';
  const paymentView = activeRoute === 'cards';
  const billView = paymentView && payments.isBillOpen;
  const historyView = paymentView && activeTabs.cards === 2 && !billView;
  const depositView = paymentView && activeTabs.cards === 1 && !billView;
  const paymentCarousel = paymentView && activeTabs.cards === 0 && !billView;
  main.classList.toggle('overview-view', overview);
  main.classList.toggle('secondary-view', !overview);
  main.classList.toggle('payment-view', paymentView);
  main.classList.toggle('bill-payment-view', billView);
  main.classList.toggle('payment-history-view', historyView);
  main.classList.toggle('deposit-entry-view', depositView);
  main.classList.remove('route-from-left', 'route-from-right');
  if (routeDirection) main.classList.add(routeDirection > 0 ? 'route-from-right' : 'route-from-left');
  main.querySelector('.hero-card').hidden = !overview;
  main.querySelector('.page-title').hidden = billView || !paymentView;
  main.querySelector('.page-title').textContent = 'Payment';
  document.getElementById('page-tabs').hidden = billView;
  main.querySelector('.section-intro').hidden = billView || historyView || depositView;
  main.querySelector('.section-intro').classList.toggle('has-payment-carousel', paymentCarousel);
  document.getElementById('payment-carousel-meta').hidden = !paymentCarousel;
  main.setAttribute('aria-label', `${sections.find(item => item.id === activeRoute).label} ${paymentView ? 'page' : 'placeholders'}`);
  const currentCrumb = document.getElementById('breadcrumb-current');
  currentCrumb.dataset.route = activeRoute;
  currentCrumb.textContent = paymentView ? 'Payment' : '';
  currentCrumb.classList.toggle('is-label', paymentView);
  currentCrumb.setAttribute('aria-hidden', String(!paymentView));
  document.querySelector('.crumb-parent').dataset.route = activeRoute;
  renderTabs();
  renderCards();
  renderBottomNav();
}

function navigate(route) {
  if (!pageTabs[route]) return;
  setPreviewBalanceVisible(false);
  payments.closeSheet();
  const wasBillOpen = payments.isBillOpen;
  payments.isBillOpen = false;
  payments.isReceiptOpen = false;
  payments.isDeposit = false;
  if (route === activeRoute) { if (wasBillOpen) render(); closeDrawer(); return; }
  const currentIndex = sections.findIndex(item => item.id === activeRoute);
  const nextIndex = sections.findIndex(item => item.id === route);
  routeDirection = Math.sign(nextIndex - currentIndex);
  activeRoute = route;
  render();
  routeDirection = 0;
  window.setTimeout(() => document.getElementById('app-main').classList.remove('route-from-left', 'route-from-right'), 320);
  closeDrawer();
  window.location.hash = route;
}

function openDrawer() {
  const drawer = document.getElementById('navigation-drawer');
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');
  document.getElementById('drawer-backdrop').hidden = false;
  document.getElementById('menu-trigger').setAttribute('aria-expanded', 'true');
}

function closeDrawer() {
  const drawer = document.getElementById('navigation-drawer');
  drawer.classList.remove('open');
  drawer.setAttribute('aria-hidden', 'true');
  document.getElementById('drawer-backdrop').hidden = true;
  document.getElementById('menu-trigger').setAttribute('aria-expanded', 'false');
}

document.addEventListener('submit', event => {
  if (event.target.id !== 'deposit-amount-form') return;
  event.preventDefault();
  if (activeRoute !== 'cards' || activeTabs.cards !== 1) return;
  const input = document.getElementById('deposit-amount');
  if (!input || !payments.openDeposit(input.value)) {
    if (input) { input.setCustomValidity('Enter a positive ETB amount with up to two decimal places.'); input.reportValidity(); }
    return;
  }
  render();
});
document.addEventListener('input', event => {
  if (event.target.id === 'deposit-amount') event.target.setCustomValidity('');
});

document.addEventListener('click', event => {
  document.querySelectorAll('.fee-demo-picker[open]').forEach(picker => {
    if (!picker.contains(event.target)) picker.open = false;
  });
  const historyEntry = event.target.closest('[data-history-entry]');
  if (historyEntry) { showHistoryDetails(historyEntry.dataset.historyEntry); return; }
  if (event.target.closest('[data-close-history-details]')) { closeHistoryDetails(); return; }
  if (event.target.id === 'history-details-dialog') {
    const bounds = event.target.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeHistoryDetails();
    return;
  }
  const balanceToggle = event.target.closest('[data-balance-toggle]');
  if (balanceToggle) {
    setPreviewBalanceVisible(balanceToggle.getAttribute('aria-pressed') !== 'true');
    return;
  }
  if (event.target.closest('[data-open-bill]')) {
    payments.isDeposit = false;
    payments.isReceiptOpen = false;
    payments.isBillOpen = true;
    activeRoute = 'cards';
    render();
    return;
  }
  if (event.target.closest('[data-bill-back]')) {
    const wasDeposit = payments.isDeposit;
    payments.isDeposit = false;
    payments.closeSheet();
    payments.isReceiptOpen = false;
    payments.isBillOpen = false;
    render();
    document.querySelector(wasDeposit ? '#deposit-amount' : '.fee-continue')?.focus({ preventScroll: true });
    return;
  }
  if (event.target.closest('[data-close-bill-sheet]')) { payments.closeSheet(); return; }
  if (event.target.closest('[data-review-bill]')) { payments.showSheet(); return; }
  if (event.target.closest('[data-demo-pay]')) {
    // Visual simulation only: no payment, wallet, or persistence operation.
    if (!payments.isDeposit && payments.isBillOpen && !payments.isReceiptOpen && document.querySelector('#bill-payment-dialog')?.open) {
      payments.openDemoReceipt();
      render();
    }
    return;
  }
  if (event.target.closest('[data-receipt-back]')) {
    payments.isReceiptOpen = false;
    render();
    return;
  }
  const intervalOption = event.target.closest('[data-payment-interval]');
  if (intervalOption) {
    paymentDemoInterval = intervalOption.dataset.paymentInterval;
    renderCards();
    document.getElementById('payment-demo-interval')?.focus({ preventScroll: true });
    return;
  }
  const friendShortcut = event.target.closest('[data-payment-slide]');
  if (friendShortcut) {
    const grid = document.getElementById('dashboard-grid');
    grid.scrollTo({ left: Number(friendShortcut.dataset.paymentSlide) * grid.clientWidth, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    return;
  }
  const routeButton = event.target.closest('[data-route]');
  if (routeButton) {
    event.preventDefault();
    navigate(routeButton.dataset.route);
    return;
  }
  const tabButton = event.target.closest('[data-tab]');
  if (tabButton) {
    activeTabs[activeRoute] = Number(tabButton.dataset.tab);
    if (activeRoute === 'cards') {
      if (activeTabs.cards === 0) paymentSlideIndex = 0;
      render();
    } else {
      renderTabs();
    }
  }
});
document.addEventListener('keydown', event => {
  const picker = event.target.closest('.fee-demo-picker');
  if (!picker) return;
  const summary = picker.querySelector('summary');
  if (event.key === 'Escape') {
    event.preventDefault();
    picker.open = false;
    summary.focus();
    return;
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const wasOpen = picker.open;
  picker.open = true;
  const options = [...picker.querySelectorAll('[data-payment-interval]')];
  const currentIndex = options.indexOf(document.activeElement);
  const selectedIndex = options.findIndex(option => option.getAttribute('aria-selected') === 'true');
  let index = currentIndex;
  if (event.key === 'Home') index = 0;
  else if (event.key === 'End') index = options.length - 1;
  else if (!wasOpen || currentIndex < 0) index = selectedIndex;
  else index = (currentIndex + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
  options[Math.max(0, index)]?.focus();
});
document.addEventListener('focusout', event => {
  const picker = event.target.closest('.fee-demo-picker');
  if (picker && !picker.contains(event.relatedTarget)) picker.open = false;
});
const dashboardGrid = document.getElementById('dashboard-grid');
dashboardGrid.addEventListener('scroll', () => {
  if (!dashboardGrid.classList.contains('payment-carousel')) return;
  if (paymentScrollFrame) window.cancelAnimationFrame(paymentScrollFrame);
  paymentScrollFrame = window.requestAnimationFrame(() => {
    updatePaymentProgress();
    paymentScrollFrame = 0;
  });
}, { passive: true });
dashboardGrid.addEventListener('keydown', event => {
  if (event.target.closest('.fee-demo-picker')) return;
  if (!dashboardGrid.classList.contains('payment-carousel') || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  const direction = event.key === 'ArrowRight' ? 1 : -1;
  const target = Math.max(0, Math.min(paymentSlides.length - 1, paymentSlideIndex + direction));
  dashboardGrid.scrollTo({
    left: target * dashboardGrid.clientWidth,
    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'
  });
});

const onboardingStage = document.getElementById('onboarding-stage');
const onboardingSlides = [...onboardingStage.querySelectorAll('.onboarding-slide')];
let onboardingIndex = 0;
let googleAuthenticated = false;
let dashboardEntered = false;
let profileSaving = false;
let profileLoadFailed = false;
const studentFieldNames = ['firstName', 'middleName', 'lastName', 'studentId', 'department'];

function updateOnboardingAccess() {
  onboardingSlides.forEach((slide, index) => {
    slide.inert = index !== onboardingIndex;
    slide.setAttribute('aria-hidden', String(index !== onboardingIndex));
  });
}
updateOnboardingAccess();

function setOnboardingProgress() {
  const currentIndex = Math.max(0, Math.min(onboardingSlides.length - 1, Math.round(onboardingStage.scrollLeft / Math.max(1, onboardingStage.clientWidth))));
  document.getElementById('active-step').textContent = String(currentIndex + 1).padStart(2, '0');
  document.getElementById('progress-dot-one').classList.toggle('is-active', currentIndex === 0);
  document.getElementById('progress-dot-two').classList.toggle('is-active', currentIndex === 1);
  document.getElementById('progress-dot-three').classList.toggle('is-active', currentIndex === 2);
}

function goToOnboardingSlide(index) {
  if (dashboardEntered) return;
  const target = Math.max(0, Math.min(googleAuthenticated ? 2 : 1, index));
  onboardingIndex = target;
  updateOnboardingAccess();
  onboardingStage.scrollTo({
    left: target * onboardingStage.clientWidth,
    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'
  });
}

function enterDashboard() {
  dashboardEntered = true;
  document.getElementById('onboarding-screen').hidden = true;
  document.getElementById('app-shell').hidden = false;
  document.getElementById('app-main').focus({ preventScroll: true });
  window.requestAnimationFrame(() => {
    updateNavIndicator();
    syncPaymentCarousel();
  });
}

function renderGoogleProfile(profile) {
  const placeholder = document.getElementById('drawer-profile-placeholder');
  const footer = document.getElementById('drawer-profile');
  if (!profile) {
    footer.hidden = true;
    placeholder.hidden = false;
    return;
  }

  const name = typeof profile.name === 'string' ? profile.name.trim() : '';
  const email = typeof profile.email === 'string' ? profile.email.trim() : '';
  const displayName = name || (email ? email.split('@')[0] : 'Google account');
  const nameElement = document.getElementById('drawer-profile-name');
  const emailElement = document.getElementById('drawer-profile-email');
  const avatar = document.getElementById('drawer-profile-avatar');
  const fallback = document.getElementById('drawer-profile-avatar-fallback');
  nameElement.textContent = displayName;
  emailElement.textContent = email;
  emailElement.hidden = !email;
  fallback.textContent = [...displayName][0].toLocaleUpperCase();

  let avatarUrl = '';
  try {
    const candidate = new URL(profile.avatarUrl, window.location.origin);
    const host = candidate.hostname.toLowerCase();
    if (candidate.protocol === 'https:' && (host === 'googleusercontent.com' || host.endsWith('.googleusercontent.com'))) {
      avatarUrl = candidate.href;
    }
  } catch {}

  if (avatarUrl) {
    avatar.hidden = false;
    fallback.hidden = true;
    avatar.src = avatarUrl;
  } else {
    avatar.removeAttribute('src');
    avatar.hidden = true;
    fallback.hidden = false;
  }
  footer.hidden = false;
  placeholder.hidden = true;
}

document.getElementById('drawer-profile-avatar').addEventListener('error', () => {
  document.getElementById('drawer-profile-avatar').hidden = true;
  document.getElementById('drawer-profile-avatar-fallback').hidden = false;
});

document.getElementById('drawer-sign-out').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const response = await fetch('/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) throw new Error('Sign-out request failed.');
    window.location.assign('/');
  } catch {
    button.disabled = false;
  }
});

document.getElementById('skip-onboarding').addEventListener('click', enterDashboard);
const studentForm = document.getElementById('student-details-form');
const studentFeedback = document.getElementById('student-form-feedback');
const studentSubmit = studentForm.querySelector('[type="submit"]');
function isStudentProfileComplete(profile) {
  return studentFieldNames.every(name => typeof profile?.[name] === 'string' && profile[name].trim());
}
function updateStudentSubmit() {
  const complete = studentFieldNames.every(name => {
    const input = studentForm.elements.namedItem(name);
    return input.value.trim() && input.validity.valid;
  });
  studentSubmit.disabled = !googleAuthenticated || !complete || profileSaving || profileLoadFailed;
  studentSubmit.classList.toggle('is-ready', !studentSubmit.disabled);
  studentSubmit.querySelector('.finish-label').textContent = profileSaving ? 'Saving…' : 'Finish';
}
studentForm.addEventListener('input', updateStudentSubmit);
studentForm.addEventListener('change', updateStudentSubmit);
studentForm.addEventListener('reset', () => queueMicrotask(updateStudentSubmit));
updateStudentSubmit();
function showStudentFeedback(message) {
  studentFeedback.textContent = message;
  studentFeedback.hidden = !message;
}
async function loadStudentProfile() {
  const response = await fetch('/api/student-profile', {
    credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' }
  });
  if (!response.ok) throw new Error('Profile could not be loaded.');
  const { profile } = await response.json();
  if (profile) {
    for (const name of studentFieldNames) {
      studentForm.elements.namedItem(name).value = typeof profile[name] === 'string' ? profile[name] : '';
    }
  }
  updateStudentSubmit();
  return profile;
}
studentForm.addEventListener('submit', async event => {
  event.preventDefault();
  const button = studentForm.querySelector('[type="submit"]');
  updateStudentSubmit();
  if (button.disabled || !studentForm.reportValidity()) return;
  profileSaving = true;
  updateStudentSubmit();
  studentForm.setAttribute('aria-busy', 'true');
  showStudentFeedback('');
  try {
    const response = await fetch('/api/student-profile', {
      method: 'PUT', credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(new FormData(studentForm)))
    });
    if (!response.ok) {
      const message = response.status === 401 || response.status === 403
        ? 'Please sign in with Google before finishing. Your details have not been saved.'
        : response.status === 400 || response.status === 422
          ? 'Please check your details. Required fields cannot be blank.'
          : 'Your profile could not be saved. Please try Finish again.';
      showStudentFeedback(message);
      return;
    }
    const result = await response.json();
    if (!result.profile) throw new Error('Save was not confirmed.');
    studentForm.reset();
    enterDashboard();
  } catch {
    showStudentFeedback('Your profile could not be confirmed as saved. Please try Finish again.');
  } finally {
    profileSaving = false;
    updateStudentSubmit();
    studentForm.removeAttribute('aria-busy');
  }
});
const faydaContinue = document.getElementById('fayda-continue');
const googleContinue = document.getElementById('google-continue');
const faydaFeedback = document.getElementById('fayda-feedback');
faydaContinue.addEventListener('click', async () => {
  faydaContinue.disabled = true;
  faydaFeedback.textContent = 'Checking sign-in availability…';
  try {
    const response = await fetch('/auth/session', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('Authentication service is unavailable.');
    const status = await response.json();
    if (!(status.faydaConfigured || status.providerConfigured)) {
      faydaFeedback.textContent = 'Fayda sign-in is not configured on this server yet. You can still use Skip to continue as a guest.';
      faydaContinue.disabled = false;
      return;
    }
    window.location.assign('/auth/fayda/start');
  } catch {
    faydaFeedback.textContent = 'Fayda sign-in is unavailable right now. You can still use Skip to continue as a guest.';
    faydaContinue.disabled = false;
  }
});

googleContinue.addEventListener('click', async () => {
  googleContinue.disabled = true;
  faydaFeedback.textContent = 'Checking Google sign-in availability…';
  try {
    const response = await fetch('/auth/session', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('Authentication service is unavailable.');
    const status = await response.json();
    if (!status.googleConfigured) {
      faydaFeedback.textContent = 'Google sign-in is not configured on this server yet. You can still use Skip to continue as a guest.';
      googleContinue.disabled = false;
      return;
    }
    window.location.assign('/auth/google/start');
  } catch {
    faydaFeedback.textContent = 'Google sign-in is unavailable right now. You can still use Skip to continue as a guest.';
    googleContinue.disabled = false;
  }
});

async function restoreAuthenticationState() {
  const authReturn = new URLSearchParams(window.location.search).get('auth');
  if (authReturn) goToOnboardingSlide(1);
  try {
    const response = await fetch('/auth/session', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (response.ok) {
      const status = await response.json();
      if (dashboardEntered) return;
      googleAuthenticated = Boolean(status.authenticated && status.authProvider === 'google' && status.googleProfile);
      updateStudentSubmit();
      if (status.authenticated && status.authProvider === 'google' && !status.googleProfile) {
        renderGoogleProfile(null);
        goToOnboardingSlide(1);
        if (authReturn === 'failed' || authReturn === 'unavailable' || !status.googleConfigured) {
          faydaFeedback.textContent = 'Google sign-in could not be completed. Please try again or use Skip as a guest.';
        } else {
          faydaFeedback.textContent = 'Please continue with Google again to grant profile access and load your name, email, and photo.';
        }
      } else if (status.authenticated) {
        renderGoogleProfile(status.googleProfile);
        if (status.authProvider === 'google') {
          try {
            const profile = await loadStudentProfile();
            if (!isStudentProfileComplete(profile)) goToOnboardingSlide(2);
            else enterDashboard();
          } catch {
            profileLoadFailed = true;
            updateStudentSubmit();
            goToOnboardingSlide(2);
            showStudentFeedback('Your saved profile could not be loaded. Please refresh before making changes.');
          }
        } else {
          goToOnboardingSlide(1);
          faydaFeedback.textContent = 'Continue with Google to set up your student profile, or use Skip as a guest.';
        }
      } else if (authReturn === 'failed') {
        faydaFeedback.textContent = 'Sign-in could not be completed. Please try again or use Skip as a guest.';
      } else if (authReturn === 'unavailable') {
        faydaFeedback.textContent = 'Sign-in is not configured or is temporarily unavailable. You can still use Skip as a guest.';
      } else if (authReturn === 'success') {
        faydaFeedback.textContent = 'Your sign-in could not be confirmed. Please start again or use Skip as a guest.';
      }
    } else if (authReturn) {
      faydaFeedback.textContent = 'Sign-in could not be confirmed. Please try again or use Skip as a guest.';
    }
  } catch {
    if (authReturn) faydaFeedback.textContent = 'Sign-in could not be confirmed. Please try again or use Skip as a guest.';
  } finally {
    if (authReturn) window.history.replaceState({}, '', `${window.location.pathname}${window.location.hash}`);
  }
}

void restoreAuthenticationState();
onboardingStage.addEventListener('scroll', () => {
  if (onboardingScrollFrame) window.cancelAnimationFrame(onboardingScrollFrame);
  onboardingScrollFrame = window.requestAnimationFrame(() => {
    setOnboardingProgress();
    onboardingScrollFrame = 0;
  });
}, { passive: true });
onboardingStage.addEventListener('keydown', event => {
  if (event.target.closest('input, textarea, select')) return;
  if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
  event.preventDefault();
  // Only Welcome and Sign in support manual navigation; authentication unlocks the form.
  if (onboardingIndex === 2) return;
  goToOnboardingSlide(Math.min(1, onboardingIndex + (event.key === 'ArrowRight' ? 1 : -1)));
});
let onboardingTouch = null;
onboardingStage.addEventListener('touchstart', event => {
  onboardingTouch = event.touches.length === 1 && onboardingIndex < 2
    ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null;
}, { passive: true });
onboardingStage.addEventListener('touchend', event => {
  if (!onboardingTouch || !event.changedTouches.length) return;
  const dx = event.changedTouches[0].clientX - onboardingTouch.x;
  const dy = event.changedTouches[0].clientY - onboardingTouch.y;
  onboardingTouch = null;
  if (Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy) * 1.25) {
    goToOnboardingSlide(Math.min(1, onboardingIndex + (dx < 0 ? 1 : -1)));
  }
}, { passive: true });
onboardingStage.addEventListener('touchcancel', () => { onboardingTouch = null; }, { passive: true });
onboardingStage.addEventListener('wheel', event => {
  if (onboardingIndex === 2 || Math.abs(event.deltaX) <= Math.abs(event.deltaY) || Math.abs(event.deltaX) < 20) return;
  goToOnboardingSlide(event.deltaX > 0 ? 1 : 0);
}, { passive: true });
window.addEventListener('resize', () => {
  onboardingStage.scrollTo({ left: onboardingIndex * onboardingStage.clientWidth, behavior: 'instant' });
  setOnboardingProgress();
});

document.getElementById('menu-trigger').addEventListener('click', openDrawer);
document.getElementById('drawer-close').addEventListener('click', closeDrawer);
document.getElementById('drawer-backdrop').addEventListener('click', closeDrawer);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeDrawer();
});

function bindSwipeNavigation(element) {
  let start = null;
  element.addEventListener('touchstart', event => {
    if (event.target.closest('.payment-carousel, .bill-page')) { start = null; return; }
    if (event.touches.length !== 1) { start = null; return; }
    start = { x: event.touches[0].clientX, y: event.touches[0].clientY };
  }, { passive: true });
  element.addEventListener('touchend', event => {
    if (!start || !event.changedTouches.length) return;
    const dx = event.changedTouches[0].clientX - start.x;
    const dy = event.changedTouches[0].clientY - start.y;
    start = null;
    if (Math.abs(dx) < 48 || Math.abs(dx) <= Math.abs(dy) * 1.25) return;
    const index = sections.findIndex(item => item.id === activeRoute);
    const nextIndex = Math.max(0, Math.min(sections.length - 1, index + (dx < 0 ? 1 : -1)));
    if (nextIndex !== index) navigate(sections[nextIndex].id);
  }, { passive: true });
}

bindSwipeNavigation(document.getElementById('app-main'));
bindSwipeNavigation(document.getElementById('navigation-drawer'));
window.addEventListener('resize', () => {
  updateNavIndicator();
  syncPaymentCarousel();
});
const requestedRoute = window.location.hash.slice(1);
if (pageTabs[requestedRoute]) activeRoute = requestedRoute;
render();
