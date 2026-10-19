const sections = [
  { id: 'cards', icon: 'card', label: 'Payment' },
  { id: 'pulse', icon: 'pulse', label: 'Pulse' },
  { id: 'activity', icon: 'activity', label: 'Activity' },
  { id: 'overview', icon: 'grid', label: 'Overview' },
  { id: 'goals', icon: 'target', label: 'Goals' },
  { id: 'profile', icon: 'user', label: 'Profile' }
];

const pageTabs = {
  pulse: ['All', 'User', 'Group', 'Channel', 'App', 'Story'],
  overview: ['Snapshot', 'Cash flow', 'This month'],
  cards: ['Pay fee', 'Deposit', 'History'],
  activity: ['All activity', 'Incoming', 'Outgoing'],
  goals: ['Active goals', 'Completed', 'Create goal'],
  profile: ['Personal', 'Security', 'Preferences']
};

let activeRoute = 'overview';
const activeTabs = Object.fromEntries(sections.map(({ id }) => [id, 0]));
let routeDirection = 0;
let navIndicatorReady = false;
let onboardingScrollFrame = 0;
let paymentScrollFrame = 0;
let paymentSlideIndex = 0;
let paymentDemoInterval = '15-days';
const paymentSlides = ['For You', 'For friend'];

const payments = new PaymentExperience();
const friends = new FriendPaymentFlow();
let friendInteractionToken = 0;
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
    const drawerSections = [sections.find(item => item.id === 'overview'), ...sections.filter(item => item.id !== 'overview')];
    drawerLinks.innerHTML = drawerSections.map(item => `
      <button class="drawer-link" type="button" data-route="${item.id}" aria-current="false" aria-label="${item.label}">
        ${icon(item.icon)}<span class="drawer-link-label">${item.label}</span>
      </button>`).join('');
  }
  drawerLinks.querySelectorAll('.drawer-link').forEach(button => {
    button.setAttribute('aria-current', button.dataset.route === activeRoute ? 'page' : 'false');
  });
  updateNavIndicator();
  renderSidebarIdentity();
  renderOverviewIdentity();
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
  dialog.dataset.historyId = entry.id;
  dialog.showModal();
  queueNavigationSave();
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

function friendContextActive() {
  return activeRoute === 'cards' && activeTabs.cards === 0 && paymentSlideIndex === 1 && !payments.isBillOpen;
}
function updateFriendPicker(focusChoice = false) {
  const dialog = document.getElementById('friend-student-dialog');
  if (!dialog) return;
  dialog.innerHTML = friends.renderPicker();
  if (dialog.open) {
    const choice = focusChoice ? Array.from(dialog.querySelectorAll('[data-friend-student]')).find(button => button.dataset.friendStudent === friends.selectedBillId) : null;
    (choice || dialog.querySelector('[data-close-friend-picker]'))?.focus({ preventScroll: true });
  }
}
function closeFriendPicker() {
  friendInteractionToken += 1;
  friends.cancel();
  const dialog = document.getElementById('friend-student-dialog');
  if (dialog?.open) dialog.close();
  queueNavigationSave();
}
async function openFriendPicker(rawQuery, selectedBillId = '') {
  if (!friendContextActive()) return false;
  const query = normalizeFriendUsername(rawQuery);
  if (!query) return false;
  const dialog = document.getElementById('friend-student-dialog');
  if (!dialog) return false;
  const account = navigationAccountKey;
  const operation = ++friendInteractionToken;
  friends.query = query;
  friends.selectedBillId = '';
  friends.students = [];
  friends.notice = '';
  friends.status = googleAuthenticated ? 'loading' : 'guest';
  updateFriendPicker();
  if (!dialog.open) {
    dialog.showModal();
    dialog.addEventListener('close', () => {
      if (document.getElementById('friend-student-dialog') !== dialog) return;
      friendInteractionToken += 1;
      friends.cancel();
      queueNavigationSave();
    }, { once: true });
  }
  queueNavigationSave();
  if (!googleAuthenticated) return true;
  const updated = await friends.search(query);
  if (!updated || operation !== friendInteractionToken || account !== navigationAccountKey || !friendContextActive() || !dialog.open) return false;
  if (friends.students.some(student => student.billId === selectedBillId)) friends.selectedBillId = selectedBillId;
  updateFriendPicker(Boolean(friends.selectedBillId));
  queueNavigationSave();
  return true;
}
async function confirmFriendSelection() {
  const selected = friends.selected;
  const dialog = document.getElementById('friend-student-dialog');
  if (!googleAuthenticated || !friendContextActive() || !dialog?.open || friends.status !== 'ready' || !selected) return;
  const account = navigationAccountKey;
  const operation = ++friendInteractionToken;
  friends.status = 'loading';
  friends.notice = '';
  updateFriendPicker();
  try {
    const current = await friends.resolve(selected.billId);
    if (operation !== friendInteractionToken || account !== navigationAccountKey || !friendContextActive() || !dialog.open) return;
    friends.students = friends.students.map(student => student.billId === current.billId ? current : student);
    friends.status = 'ready';
    if (['username', 'firstName', 'lastName', 'amountDue', 'currency', 'month', 'dueDate'].some(key => current[key] !== selected[key])) {
      friends.notice = 'The bill details changed. Please review them and confirm again.';
      updateFriendPicker(true);
      return;
    }
    if (!payments.openFriendBill(current)) throw new Error('Bill could not be verified.');
    closeFriendPicker();
    render();
  } catch (error) {
    if (operation !== friendInteractionToken || account !== navigationAccountKey || !dialog.open) return;
    friends.students = [];
    friends.selectedBillId = '';
    friends.status = error.status === 404 ? 'empty' : 'error';
    friends.notice = error.status === 404 ? 'This bill is no longer eligible. Please search again.' : 'The bill could not be verified. Please search again.';
    updateFriendPicker();
    queueNavigationSave();
  }
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
  grid.classList.toggle('profile-content-grid', activeRoute === 'profile');
  grid.classList.toggle('payment-carousel', paymentCarousel);
  grid.classList.toggle('bill-content-grid', billView);
  grid.classList.toggle('deposit-entry-grid', activeRoute === 'cards' && activeTabs.cards === 1 && !billView);
  grid.classList.toggle('payment-history-grid', activeRoute === 'cards' && activeTabs.cards === 2 && !billView);
  grid.classList.toggle('pulse-content-grid', activeRoute === 'pulse');
  if (activeRoute === 'pulse') {
    grid.removeAttribute('role');
    grid.removeAttribute('aria-roledescription');
    grid.removeAttribute('tabindex');
    grid.setAttribute('aria-label', 'Pulse skeleton preview');
    grid.innerHTML = StemmaPulse.render(activeTabs.pulse);
    StemmaPulse.mount(grid, activeTabs.pulse, index => { activeTabs.pulse = index; queueNavigationSave(); });
    return;
  }
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
        ${index === 0 ? renderForYou() : friends.renderForm()}
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
  if (activeRoute === 'profile') {
    grid.setAttribute('role', 'region');
    grid.setAttribute('aria-label', 'Your profile');
    grid.tabIndex = 0;
    grid.innerHTML = renderStudentProfile(savedStudentProfile, { state: profileReadState, email: signedInEmail, photoURL: studentPhotoURL, photoNotice: profilePhotoNotice });
    return;
  }
  grid.setAttribute('aria-label', 'Content placeholders');
  grid.innerHTML = renderSkeletonCards();
}

function render() {
  const main = document.getElementById('app-main');
  const overview = activeRoute === 'overview';
  const profileView = activeRoute === 'profile';
  const paymentView = activeRoute === 'cards';
  const billView = paymentView && payments.isBillOpen;
  const historyView = paymentView && activeTabs.cards === 2 && !billView;
  const depositView = paymentView && activeTabs.cards === 1 && !billView;
  const paymentCarousel = paymentView && activeTabs.cards === 0 && !billView;
  main.classList.toggle('pulse-view', activeRoute === 'pulse');
  main.classList.toggle('profile-view', profileView);
  main.classList.toggle('overview-view', overview);
  main.classList.toggle('secondary-view', !overview);
  main.classList.toggle('payment-view', paymentView);
  main.classList.toggle('bill-payment-view', billView);
  main.classList.toggle('payment-history-view', historyView);
  main.classList.toggle('deposit-entry-view', depositView);
  main.classList.remove('route-from-left', 'route-from-right');
  if (routeDirection) main.classList.add(routeDirection > 0 ? 'route-from-right' : 'route-from-left');
  main.querySelector('.hero-card').hidden = !overview;
  main.querySelector('.page-title').hidden = billView || (!paymentView && !profileView);
  main.querySelector('.page-title').textContent = profileView ? 'Profile' : 'Payment';
  document.getElementById('page-tabs').hidden = billView || profileView || activeRoute === 'pulse';
  main.querySelector('.section-intro').hidden = billView || historyView || depositView || profileView || activeRoute === 'pulse';
  main.querySelector('.section-intro').classList.toggle('has-payment-carousel', paymentCarousel);
  document.getElementById('payment-carousel-meta').hidden = !paymentCarousel;
  main.setAttribute('aria-label', `${sections.find(item => item.id === activeRoute).label} ${paymentView || profileView ? 'page' : 'placeholders'}`);
  const currentCrumb = document.getElementById('breadcrumb-current');
  currentCrumb.dataset.route = activeRoute;
  currentCrumb.textContent = profileView ? 'Profile' : paymentView ? 'Payment' : '';
  currentCrumb.classList.toggle('is-label', paymentView || profileView);
  currentCrumb.setAttribute('aria-hidden', String(!paymentView && !profileView));
  document.querySelector('.crumb-parent').dataset.route = activeRoute;
  renderTabs();
  renderCards();
  renderBottomNav();
  queueNavigationSave();
  window.StemmaNotifications?.syncRoute();
}

function navigate(route) {
  if (!pageTabs[route]) return;
  window.StemmaNotifications?.leave();
  cancelPendingNavigationRestoration();
  closeFriendPicker();
  closeHistoryDetails();
  payments.closeSheet();
  const wasBillOpen = payments.isBillOpen;
  payments.isBillOpen = false;
  payments.isReceiptOpen = false;
  payments.isDeposit = false;
  payments.isFriend = false;
  payments.friendBill = null;
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
  cancelPendingNavigationRestoration();
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
  if (event.target.id === 'friend-username') {
    cancelPendingNavigationRestoration();
    event.target.setCustomValidity('');
    friends.query = normalizeFriendUsername(event.target.value, true) || '';
    queueNavigationSave();
  }
  if (event.target.id === 'deposit-amount') {
    event.target.setCustomValidity('');
    depositDraftAmount = normalizeDepositAmount(event.target.value) || '';
    payments.depositAmount = depositDraftAmount;
    queueNavigationSave();
  }
});

document.addEventListener('submit', event => {
  if (event.target.id !== 'friend-username-form') return;
  event.preventDefault();
  cancelPendingNavigationRestoration();
  if (!friendContextActive()) return;
  const input = document.getElementById('friend-username');
  if (!input || !normalizeFriendUsername(input.value)) {
    if (input) { input.setCustomValidity('Enter a username with 3–30 letters, numbers, underscores, or periods.'); input.reportValidity(); }
    return;
  }
  void openFriendPicker(input.value);
});
document.addEventListener('error', event => {
  if (event.target.matches?.('.friend-student-photo')) event.target.hidden = true;
}, true);

document.addEventListener('click', event => {
  document.querySelectorAll('.fee-demo-picker[open]').forEach(picker => {
    if (!picker.contains(event.target)) picker.open = false;
  });
  const friendChoice = event.target.closest('[data-friend-student]');
  if (friendChoice) {
    if (friendContextActive() && friends.status === 'ready' && friends.students.some(student => student.billId === friendChoice.dataset.friendStudent)) {
      friends.selectedBillId = friendChoice.dataset.friendStudent; friends.notice = ''; updateFriendPicker(true); queueNavigationSave();
    }
    return;
  }
  if (event.target.closest('[data-close-friend-picker]')) { closeFriendPicker(); return; }
  if (event.target.closest('[data-confirm-friend]')) { void confirmFriendSelection(); return; }
  if (event.target.id === 'friend-student-dialog') {
    const bounds = event.target.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeFriendPicker();
    return;
  }
  if (event.target.closest('[data-setup-profile]')) { openProfileSetup(); return; }
  if (event.target.closest('[data-retry-profile]')) { void restoreAuthenticationState(); return; }
  if (event.target.closest('[data-profile-photo]')) {
    if (googleAuthenticated && savedStudentProfile) { profilePhotoInput.value = ''; profilePhotoInput.click(); }
    return;
  }
  const historyEntry = event.target.closest('[data-history-entry]');
  if (historyEntry) { showHistoryDetails(historyEntry.dataset.historyEntry); return; }
  if (event.target.closest('[data-close-history-details]')) { closeHistoryDetails(); return; }
  if (event.target.id === 'history-details-dialog') {
    const bounds = event.target.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeHistoryDetails();
    return;
  }
  if (event.target.closest('[data-open-bill]')) {
    payments.isFriend = false;
    payments.friendBill = null;
    payments.isDeposit = false;
    payments.isReceiptOpen = false;
    payments.isBillOpen = true;
    activeRoute = 'cards';
    render();
    return;
  }
  if (event.target.closest('[data-bill-back]')) {
    const wasDeposit = payments.isDeposit;
    const wasFriend = payments.isFriend;
    payments.isFriend = false;
    payments.friendBill = null;
    payments.isDeposit = false;
    payments.closeSheet();
    payments.isReceiptOpen = false;
    payments.isBillOpen = false;
    render();
    document.querySelector(wasFriend ? '#friend-username' : wasDeposit ? '#deposit-amount' : '.fee-continue')?.focus({ preventScroll: true });
    return;
  }
  if (event.target.closest('[data-close-bill-sheet]')) { payments.closeSheet(); queueNavigationSave(); return; }
  if (event.target.closest('[data-review-bill]')) { payments.showSheet(); queueNavigationSave(); return; }
  if (event.target.closest('[data-demo-pay]')) {
    // Visual simulation only: no payment, wallet, or persistence operation.
    if (!payments.isFriend && payments.isBillOpen && !payments.isReceiptOpen && document.querySelector('#bill-payment-dialog')?.open) {
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
    queueNavigationSave();
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
    cancelPendingNavigationRestoration();
    closeFriendPicker();
    activeTabs[activeRoute] = Number(tabButton.dataset.tab);
    if (activeRoute === 'cards') {
      if (activeTabs.cards === 0) paymentSlideIndex = 0;
      render();
    } else {
      renderTabs();
    }
    queueNavigationSave();
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
  queueNavigationSave();
  if (!dashboardGrid.classList.contains('payment-carousel')) return;
  if (paymentScrollFrame) window.cancelAnimationFrame(paymentScrollFrame);
  paymentScrollFrame = window.requestAnimationFrame(() => {
    updatePaymentProgress();
    paymentScrollFrame = 0;
    queueNavigationSave();
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
let savedStudentProfile = null;
let profileReadState = 'loading';
let signedInEmail = '';
let profilePhotoAccountKey = '';
let profilePhotoNotice = '';
let deviceProfilePhotoStore = null;
let authenticatedProfilePhotoStore = null;
let pendingLegacyProfilePhoto = null;
let profilePhotoPersistence = null;
let preparedProfilePhoto = null;
let selectedProfilePhotoChanged = false;
let profilePhotoPreparationError = false;
let profilePhotoPreparation = Promise.resolve();
let profilePhotoRevision = 0;
const studentFieldNames = ['firstName', 'middleName', 'lastName', 'studentId', 'department'];

// Account-scoped UI location only: never a payment, wallet, or profile record.
const navigationMemory = new StemmaNavigationMemory();
let navigationAccountKey = '';
let navigationRestoredFor = null;
let navigationRestoring = false;
let navigationSaveFrame = 0;
let navigationRestoreFrame = 0;
let depositDraftAmount = '';
let pendingNavigationRestore = null;

// Overview identity uses only the signed-in student's persisted profile and photo.
function renderOverviewIdentity() {
  const name = document.getElementById('overview-student-name');
  const namePlaceholder = document.getElementById('overview-name-placeholder');
  const photo = document.getElementById('overview-profile-photo');
  const photoPlaceholder = document.getElementById('overview-photo-placeholder');
  const frame = document.getElementById('overview-photo-frame');
  const reflection = document.getElementById('overview-photo-reflection');
  const nickname = document.getElementById('overview-student-nickname');
  if (!name || !namePlaceholder || !photo || !photoPlaceholder || !frame || !reflection || !nickname) return;
  const profile = googleAuthenticated ? savedStudentProfile : null;
  const displayName = profile ? ['firstName', 'middleName']
    .map(key => typeof profile[key] === 'string' ? profile[key].trim() : '')
    .filter(Boolean).join(' ') : '';
  name.textContent = displayName;
  name.title = displayName;
  name.hidden = !displayName;
  namePlaceholder.hidden = Boolean(displayName);
  const savedNickname = typeof profile?.nickName === 'string' ? profile.nickName.trim() : '';
  nickname.textContent = savedNickname;
  nickname.title = savedNickname;
  nickname.hidden = !savedNickname;
  const photoURL = profile && studentPhotoURL ? studentPhotoURL : '';
  photo.hidden = !photoURL;
  photoPlaceholder.hidden = Boolean(photoURL);
  frame.setAttribute('aria-hidden', String(!photoURL));
  frame.classList.toggle('has-profile-photo', Boolean(photoURL));
  reflection.hidden = !photoURL;
  if (photoURL) {
    if (photo.getAttribute('src') !== photoURL) photo.src = photoURL;
    if (reflection.getAttribute('src') !== photoURL) reflection.src = photoURL;
  } else {
    photo.removeAttribute('src');
    reflection.removeAttribute('src');
  }
  photo.onerror = () => {
    photo.hidden = true;
    reflection.hidden = true;
    reflection.removeAttribute('src');
    photoPlaceholder.hidden = false;
    frame.classList.remove('has-profile-photo');
    frame.setAttribute('aria-hidden', 'true');
  };
  reflection.onerror = () => { reflection.hidden = true; };
}

function renderSidebarIdentity() {
  const name = document.getElementById('drawer-student-name');
  const username = document.getElementById('drawer-student-username');
  if (!name || !username) return;
  const profile = googleAuthenticated ? savedStudentProfile : null;
  const fullName = profile ? ['firstName', 'lastName'].map(key => typeof profile[key] === 'string' ? profile[key].trim() : '').filter(Boolean).join(' ') : '';
  const nickName = typeof profile?.nickName === 'string' ? profile.nickName.trim() : '';
  const displayName = nickName || fullName;
  const handle = typeof profile?.username === 'string' ? profile.username.trim().replace(/^@+/, '') : '';
  name.textContent = displayName;
  username.textContent = handle ? `@${handle}` : '';
  name.hidden = !displayName;
  username.hidden = !handle;
}

function captureNavigationLocation() {
  const grid = document.getElementById('dashboard-grid');
  const history = document.getElementById('history-details-dialog');
  const sheet = document.getElementById('bill-payment-dialog');
  let view = 'main';
  if (activeRoute === 'cards') {
    if (payments.isBillOpen) view = payments.isReceiptOpen ? 'receipt' : sheet?.open ? 'sheet' : 'bill';
    else if (activeTabs.cards === 2 && history?.open) view = 'history-details';
    else if (activeTabs.cards === 0 && paymentSlideIndex === 1 && document.getElementById('friend-student-dialog')?.open) view = 'friend-picker';
  }
  return {
    version: 1, route: activeRoute, tabs: { ...activeTabs },
    paymentSlide: paymentSlideIndex, interval: paymentDemoInterval, view,
    isDeposit: payments.isDeposit,
    isFriend: Boolean(payments.isFriend),
    friendBillId: payments.isFriend ? payments.friendBill?.billId || '' : friends.selectedBillId,
    friendUsernameQuery: friends.query,
    depositAmount: payments.isDeposit ? payments.depositAmount : depositDraftAmount,
    receiptTime: payments.demoReceiptTime || '',
    historyId: view === 'history-details' ? history.dataset.historyId || '' : '',
    scrollTop: window.StemmaNotifications?.underlyingScrollTop() ?? Math.max(0, Math.round(grid?.scrollTop || 0))
  };
}

function persistNavigationLocation() {
  if (!dashboardEntered || navigationRestoring || !navigationAccountKey) return;
  navigationMemory.save(navigationAccountKey, captureNavigationLocation());
}

function queueNavigationSave() {
  if (navigationRestoring || navigationSaveFrame) return;
  navigationSaveFrame = window.requestAnimationFrame(() => {
    navigationSaveFrame = 0;
    persistNavigationLocation();
  });
}

function restoreNavigationLocation(accountKey) {
  if (navigationRestoredFor === accountKey) return;
  persistNavigationLocation();
  if (navigationSaveFrame) window.cancelAnimationFrame(navigationSaveFrame);
  if (navigationRestoreFrame) window.cancelAnimationFrame(navigationRestoreFrame);
  navigationSaveFrame = 0;
  navigationRestoring = true;
  navigationAccountKey = accountKey;
  navigationRestoredFor = accountKey;
  const saved = navigationMemory.load(accountKey);
  payments.closeSheet();
  closeFriendPicker();
  closeHistoryDetails();
  friends.clear();
  friends.query = saved?.friendUsernameQuery || '';
  friends.selectedBillId = saved?.friendBillId || '';
  payments.isFriend = false;
  payments.friendBill = null;
  activeRoute = saved?.route || 'overview';
  for (const route of Object.keys(activeTabs)) activeTabs[route] = saved?.tabs?.[route] || 0;
  paymentSlideIndex = saved?.paymentSlide || 0;
  paymentDemoInterval = saved?.interval || '15-days';
  depositDraftAmount = saved?.depositAmount || '';
  payments.depositAmount = saved?.depositAmount || '';
  payments.isDeposit = Boolean(saved?.isDeposit);
  payments.isBillOpen = Boolean(saved && !saved.isFriend && ['bill', 'sheet', 'receipt'].includes(saved.view));
  payments.isReceiptOpen = !saved?.isFriend && saved?.view === 'receipt';
  payments.demoReceiptTime = saved?.receiptTime || '';
  routeDirection = 0;
  render();
  window.StemmaNotifications?.setUnderlyingScrollTop(saved?.scrollTop || 0);
  if (window.location.hash !== '#notifications' && window.location.hash !== `#${activeRoute}`) {
    window.history.replaceState({}, '', `${window.location.pathname}${window.location.search}#${activeRoute}`);
  }
  pendingNavigationRestore = saved;
  finishNavigationRestoration();
}

function cancelPendingNavigationRestoration() {
  if (!navigationRestoring) return;
  if (navigationRestoreFrame) window.cancelAnimationFrame(navigationRestoreFrame);
  navigationRestoreFrame = 0;
  navigationRestoring = false;
  pendingNavigationRestore = null;
  friendInteractionToken += 1;
  friends.cancel();
}
function finishNavigationRestoration() {
  if (!dashboardEntered || !navigationRestoring || navigationRestoreFrame) return;
  const saved = pendingNavigationRestore;
  const accountKey = navigationAccountKey;
  navigationRestoreFrame = window.requestAnimationFrame(async () => {
    navigationRestoreFrame = 0;
    if (navigationAccountKey !== accountKey || !navigationRestoring) return;
    syncPaymentCarousel();
    const grid = document.getElementById('dashboard-grid');
    if (grid && saved) grid.scrollTop = saved.scrollTop;
    if (saved?.isFriend) {
      try {
        const current = await friends.resolve(saved.friendBillId);
        if (navigationAccountKey !== accountKey || !navigationRestoring) return;
        if (googleAuthenticated && friendContextActive() && payments.openFriendBill(current)) {
          friends.students = [current]; friends.selectedBillId = current.billId; friends.status = 'ready';
          render();
          if (saved.view === 'sheet') payments.showSheet();
        }
      } catch {
        if (navigationAccountKey !== accountKey || !navigationRestoring) return;
        friends.students = []; friends.selectedBillId = ''; friends.status = 'empty';
        friends.notice = 'The saved student bill is no longer available. Please search again.';
        const dialog = document.getElementById('friend-student-dialog');
        if (dialog) { updateFriendPicker(); dialog.showModal(); }
      }
    } else if (saved?.view === 'friend-picker') {
      await openFriendPicker(saved.friendUsernameQuery, saved.friendBillId);
      if (navigationAccountKey !== accountKey || !navigationRestoring) return;
    } else {
      if (saved?.view === 'sheet') {
        document.querySelector('[data-review-bill]')?.focus({ preventScroll: true });
        payments.showSheet();
      }
      if (saved?.view === 'history-details') {
        Array.from(grid.querySelectorAll('[data-history-entry]')).find(button => button.dataset.historyEntry === saved.historyId)?.focus({ preventScroll: true });
        showHistoryDetails(saved.historyId);
      }
    }
    pendingNavigationRestore = null;
    navigationRestoring = false;
    persistNavigationLocation();
  });
}

window.addEventListener('pagehide', persistNavigationLocation);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') persistNavigationLocation();
});
document.addEventListener('close', event => {
  if (event.target.matches?.('#bill-payment-dialog, #history-details-dialog, #friend-student-dialog')) queueNavigationSave();
}, true);


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
  document.getElementById('progress-dot-four').classList.toggle('is-active', currentIndex === 3);
}

function goToOnboardingSlide(index) {
  if (dashboardEntered) return;
  const target = Math.max(0, Math.min(googleAuthenticated ? 3 : 1, index));
  if (target === 3 && !isStudentProfileComplete(savedStudentProfile)) return;
  onboardingIndex = target;
  updateOnboardingAccess();
  onboardingStage.scrollTo({
    left: target * onboardingStage.clientWidth,
    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'
  });
}

function enterDashboard() {
  dashboardEntered = true;
  renderSidebarIdentity();
  renderOverviewIdentity();
  finishNavigationRestoration();
  persistNavigationLocation();
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
const personalizationForm = document.getElementById('personalization-form');
const personalizationFeedback = document.getElementById('personalization-feedback');
const personalizationAccept = document.getElementById('personalization-accept');
const personalizationBack = document.getElementById('personalization-back');
let personalizationSaving = false;
// Onboarding photo preview: account-backed photo selection, outside the profile save payload.
const studentPhotoButton = document.getElementById('student-photo-button');
const studentPhotoInput = document.getElementById('student-photo-input');
const studentPhotoPreview = document.getElementById('student-photo-preview');
const studentPhotoPlaceholder = document.getElementById('student-photo-placeholder');
const studentPhotoLabel = document.getElementById('student-photo-label');
const studentPhotoStatus = document.getElementById('student-photo-status');
let studentPhotoURL = '';
let studentPhotoPendingURL = '';
function resetStudentPhotoPreview() {
  if (studentPhotoURL) URL.revokeObjectURL(studentPhotoURL);
  if (studentPhotoPendingURL) URL.revokeObjectURL(studentPhotoPendingURL);
  studentPhotoURL = '';
  studentPhotoPendingURL = '';
  renderOverviewIdentity();
  studentPhotoInput.value = '';
  studentPhotoPreview.removeAttribute('src');
  studentPhotoPreview.hidden = true;
  studentPhotoPlaceholder.hidden = false;
  studentPhotoButton.classList.remove('has-photo');
  studentPhotoButton.setAttribute('aria-label', 'Choose profile photo');
  studentPhotoLabel.textContent = 'Add photo';
  studentPhotoStatus.textContent = '';
  if (typeof resetDevicePhotoDraft === 'function') resetDevicePhotoDraft();
}
function previewStudentPhoto(file) {
  if (!file) return;
  if (studentPhotoPendingURL) URL.revokeObjectURL(studentPhotoPendingURL);
  studentPhotoPendingURL = '';
  const isImage = /^image\//i.test(file.type || '') || (!file.type && /\.(?:jpe?g|png|webp|gif|avif|bmp|heic|heif)$/i.test(file.name || ''));
  if (!isImage || !file.size || file.size > 10 * 1024 * 1024) {
    studentPhotoStatus.textContent = 'Choose an image file up to 10 MB.';
    if (typeof onStudentPhotoError === 'function') onStudentPhotoError(studentPhotoStatus.textContent);
    if (typeof updatePersonalizationSubmit === 'function') updatePersonalizationSubmit();
    return;
  }
  const candidateURL = URL.createObjectURL(file);
  studentPhotoPendingURL = candidateURL;
  const candidateImage = new Image();
  candidateImage.onload = () => {
    if (studentPhotoPendingURL !== candidateURL) return;
    if (studentPhotoURL) URL.revokeObjectURL(studentPhotoURL);
    studentPhotoURL = candidateURL;
    studentPhotoPendingURL = '';
    studentPhotoPreview.src = candidateURL;
    studentPhotoPreview.hidden = false;
    studentPhotoPlaceholder.hidden = true;
    studentPhotoButton.classList.add('has-photo');
    studentPhotoButton.setAttribute('aria-label', 'Replace profile photo');
    studentPhotoLabel.textContent = 'Replace photo';
    studentPhotoStatus.textContent = 'Photo ready. It will be saved to your signed-in profile when you accept.';
    if (typeof onStudentPhotoReady === 'function') onStudentPhotoReady(candidateImage);
    if (typeof updatePersonalizationSubmit === 'function') updatePersonalizationSubmit();
  };
  candidateImage.onerror = () => {
    if (studentPhotoPendingURL !== candidateURL) return;
    URL.revokeObjectURL(candidateURL);
    studentPhotoPendingURL = '';
    studentPhotoStatus.textContent = 'This image could not be previewed. Choose another image.';
    if (typeof onStudentPhotoError === 'function') onStudentPhotoError(studentPhotoStatus.textContent);
    if (typeof updatePersonalizationSubmit === 'function') updatePersonalizationSubmit();
  };
  candidateImage.src = candidateURL;
}
studentPhotoButton.addEventListener('click', () => {
  studentPhotoInput.value = '';
  studentPhotoInput.click();
});
studentPhotoInput.addEventListener('change', () => {
  const file = studentPhotoInput.files?.[0];
  if (file) previewStudentPhoto(file);
  if (typeof updatePersonalizationSubmit === 'function') updatePersonalizationSubmit();
});
personalizationForm.addEventListener('reset', resetStudentPhotoPreview);
window.addEventListener('pagehide', resetStudentPhotoPreview);
// End onboarding photo preview.

// Profile photo integration: authenticated photo bytes are saved to the signed-in account; IndexedDB is legacy-import-only.
function refreshProfileIfVisible() {
  renderOverviewIdentity();
  if (activeRoute === 'profile') renderCards();
}
function onStudentPhotoError(message) {
  if (activeRoute === 'profile' && dashboardEntered) { profilePhotoNotice = message; renderCards(); }
}
function getDevicePhotoStore() {
  if (!deviceProfilePhotoStore) deviceProfilePhotoStore = new DeviceProfilePhotoStore();
  return deviceProfilePhotoStore;
}
function getAuthenticatedPhotoStore() {
  if (!authenticatedProfilePhotoStore) authenticatedProfilePhotoStore = new AuthenticatedProfilePhotoStore();
  return authenticatedProfilePhotoStore;
}
function resetDevicePhotoDraft() {
  profilePhotoRevision += 1;
  selectedProfilePhotoChanged = false;
  preparedProfilePhoto = null;
  pendingLegacyProfilePhoto = null;
  profilePhotoPreparationError = false;
  profilePhotoPreparation = Promise.resolve();
}
function setCurrentPhoto(blob, revision = profilePhotoRevision) {
  if (revision !== profilePhotoRevision) return false;
  const nextURL = URL.createObjectURL(blob);
  const oldURL = studentPhotoURL;
  studentPhotoURL = nextURL;
  studentPhotoPreview.src = nextURL;
  studentPhotoPreview.hidden = false;
  studentPhotoPlaceholder.hidden = true;
  studentPhotoButton.classList.add('has-photo');
  studentPhotoButton.setAttribute('aria-label', 'Replace profile photo');
  studentPhotoLabel.textContent = 'Replace photo';
  renderOverviewIdentity();
  if (oldURL && oldURL !== nextURL) URL.revokeObjectURL(oldURL);
  return true;
}
function onStudentPhotoReady(image) {
  profilePhotoRevision += 1;
  const revision = profilePhotoRevision;
  selectedProfilePhotoChanged = true;
  pendingLegacyProfilePhoto = null;
  preparedProfilePhoto = null;
  profilePhotoPreparationError = false;
  const selectedURL = studentPhotoURL;
  profilePhotoPreparation = DeviceProfilePhotoStore.prepare(image).then(blob => {
    if (studentPhotoURL === selectedURL && revision === profilePhotoRevision) preparedProfilePhoto = blob;
  }).catch(() => {
    if (revision === profilePhotoRevision) profilePhotoPreparationError = true;
  });
  if (activeRoute === 'profile' && dashboardEntered) void saveProfilePhotoFromPage();
}
async function decodeAndPrepareLegacyPhoto(blob, key, revision) {
  const temporaryURL = URL.createObjectURL(blob);
  try {
    const image = await new Promise((resolve, reject) => {
      const candidate = new Image();
      candidate.onload = () => resolve(candidate);
      candidate.onerror = () => reject(new Error('The older device photo could not be decoded.'));
      candidate.src = temporaryURL;
    });
    if (key !== profilePhotoAccountKey || revision !== profilePhotoRevision || selectedProfilePhotoChanged) return null;
    return await DeviceProfilePhotoStore.prepare(image);
  } finally {
    URL.revokeObjectURL(temporaryURL);
  }
}
async function deleteImportedLegacyPhoto(key) {
  try { await getDevicePhotoStore().remove(key); } catch { /* A confirmed remote copy remains authoritative. */ }
}
async function persistSelectedPhotoLoop() {
  while (selectedProfilePhotoChanged || pendingLegacyProfilePhoto) {
    if (!profilePhotoAccountKey) throw new Error('Sign in again before saving your profile photo.');
    const revision = profilePhotoRevision;
    const key = profilePhotoAccountKey;
    let blob;
    let importingLegacy = false;
    if (pendingLegacyProfilePhoto) {
      blob = pendingLegacyProfilePhoto;
      importingLegacy = true;
    } else {
      await profilePhotoPreparation;
      if (revision !== profilePhotoRevision) continue;
      if (profilePhotoPreparationError || !preparedProfilePhoto) throw new Error('The selected photo could not be prepared below the 1 MiB account limit.');
      blob = preparedProfilePhoto;
    }
    try {
      await getAuthenticatedPhotoStore().put(blob, { onlyIfAbsent: importingLegacy });
    } catch (error) {
      if (importingLegacy && error?.status === 412) {
        const remote = await getAuthenticatedPhotoStore().get();
        if (!remote) throw new Error('A profile photo already exists, but it could not be loaded from your account.');
        if (key !== profilePhotoAccountKey || revision !== profilePhotoRevision) continue;
        setCurrentPhoto(remote, revision);
        pendingLegacyProfilePhoto = null;
        selectedProfilePhotoChanged = false;
        profilePhotoNotice = '';
        studentPhotoStatus.textContent = 'Your saved profile photo was restored from your account.';
        continue;
      }
      throw error;
    }
    if (key !== profilePhotoAccountKey) throw new Error('The signed-in account changed before the photo save completed.');
    if (revision !== profilePhotoRevision) continue;
    if (importingLegacy) await deleteImportedLegacyPhoto(key);
    pendingLegacyProfilePhoto = null;
    selectedProfilePhotoChanged = false;
    profilePhotoNotice = '';
    studentPhotoStatus.textContent = 'Profile photo saved to your account.';
  }
}
async function persistSelectedProfilePhoto() {
  if (profilePhotoPersistence) return profilePhotoPersistence;
  profilePhotoPersistence = persistSelectedPhotoLoop();
  try { await profilePhotoPersistence; }
  finally { profilePhotoPersistence = null; }
}
async function restoreAccountProfilePhoto() {
  if (!profilePhotoAccountKey) return;
  const key = profilePhotoAccountKey;
  const revision = profilePhotoRevision;
  try {
    const remoteBlob = await getAuthenticatedPhotoStore().get();
    if (key !== profilePhotoAccountKey || revision !== profilePhotoRevision || selectedProfilePhotoChanged) return;
    if (remoteBlob) {
      setCurrentPhoto(remoteBlob, revision);
      studentPhotoStatus.textContent = 'Profile photo loaded from your account.';
      return;
    }
  } catch (error) {
    if (key === profilePhotoAccountKey) profilePhotoNotice = error?.status === 401
      ? 'Sign in again to load your profile photo. Your profile text remains available.'
      : 'Your profile photo could not be loaded from your account. It was not replaced with a device copy.';
    return; // Only an explicit 404 means absent; network/5xx/auth errors never trigger import.
  }
  if (key !== profilePhotoAccountKey || revision !== profilePhotoRevision || selectedProfilePhotoChanged) return;
  try {
    const legacyBlob = await getDevicePhotoStore().get(key);
    if (!legacyBlob || key !== profilePhotoAccountKey || revision !== profilePhotoRevision || selectedProfilePhotoChanged) return;
    const boundedBlob = await decodeAndPrepareLegacyPhoto(legacyBlob, key, revision);
    if (!boundedBlob || key !== profilePhotoAccountKey || revision !== profilePhotoRevision || selectedProfilePhotoChanged) return;
    pendingLegacyProfilePhoto = boundedBlob;
    setCurrentPhoto(boundedBlob, revision);
    studentPhotoStatus.textContent = 'Older device photo found. Saving it to your account…';
    try {
      await persistSelectedProfilePhoto();
    } catch (error) {
      if (error?.status === 409) {
        profilePhotoNotice = 'Your student profile must be completed before its saved photo can be imported.';
        studentPhotoStatus.textContent = 'Photo kept on this device; it will be imported after your profile is saved.';
      } else {
        profilePhotoNotice = 'Your older device photo could not yet be saved to your account.';
        studentPhotoStatus.textContent = 'Photo remains on this device; account save is still pending.';
      }
    }
  } catch {
    if (key === profilePhotoAccountKey) profilePhotoNotice = 'An older device photo could not be prepared for your account.';
  }
}
async function saveProfilePhotoFromPage() {
  profilePhotoNotice = 'Saving photo to your account…';
  if (activeRoute === 'profile') renderCards();
  try {
    await persistSelectedProfilePhoto();
  } catch (error) {
    profilePhotoNotice = error?.status === 401
      ? 'Sign in again; this photo was not saved to your account.'
      : error?.status === 409
        ? 'Complete your student profile before saving this photo. The photo remains selected.'
        : 'This photo was not saved to your account. Check your connection and try again.';
  }
  if (activeRoute === 'profile') renderCards();
}
function openProfileSetup() {
  closeDrawer();
  dashboardEntered = false;
  document.getElementById('app-shell').hidden = true;
  document.getElementById('onboarding-screen').hidden = false;
  goToOnboardingSlide(googleAuthenticated ? (isStudentProfileComplete(savedStudentProfile) ? 3 : 2) : 1);
}
const profilePhotoInput = document.getElementById('profile-photo-file');
profilePhotoInput.addEventListener('change', () => {
  const file = profilePhotoInput.files?.[0];
  if (file && googleAuthenticated && savedStudentProfile) previewStudentPhoto(file);
});
// End Profile photo integration.

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
  profileLoadFailed = false;
  savedStudentProfile = profile || null;
  if (profile) {
    for (const name of studentFieldNames) {
      studentForm.elements.namedItem(name).value = typeof profile[name] === 'string' ? profile[name] : '';
    }
  }
  for (const name of ['nickName', 'username', 'bio']) {
    personalizationForm.elements.namedItem(name).value = typeof profile?.[name] === 'string' ? profile[name] : '';
  }
  updateStudentSubmit();
  updatePersonalizationSubmit();
  renderSidebarIdentity();
  renderOverviewIdentity();
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
    if (!isStudentProfileComplete(result.profile)) throw new Error('Save was not confirmed.');
    savedStudentProfile = result.profile;
    for (const name of studentFieldNames) studentForm.elements.namedItem(name).value = result.profile[name];
    updatePersonalizationSubmit();
    goToOnboardingSlide(3);
  } catch {
    showStudentFeedback('Your profile could not be confirmed as saved. Please try Finish again.');
  } finally {
    profileSaving = false;
    updateStudentSubmit();
    studentForm.removeAttribute('aria-busy');
  }
});
// Fourth onboarding profile: save profile text only; the image remains a local preview.
function isPersonalizationComplete(profile) {
  return typeof profile?.nickName === 'string' && Boolean(profile.nickName.trim()) &&
    typeof profile?.username === 'string' && /^[A-Za-z0-9_.]{3,30}$/.test(profile.username);
}
function updatePersonalizationSubmit() {
  const nickName = personalizationForm.elements.namedItem('nickName');
  const username = personalizationForm.elements.namedItem('username');
  const bio = personalizationForm.elements.namedItem('bio');
  const complete = Boolean(nickName.value.trim()) && nickName.validity.valid &&
    /^[A-Za-z0-9_.]{3,30}$/.test(username.value.trim()) && username.validity.valid && bio.validity.valid;
  personalizationAccept.disabled = !googleAuthenticated || !isStudentProfileComplete(savedStudentProfile) ||
    !complete || personalizationSaving || profileLoadFailed || Boolean(studentPhotoPendingURL);
  personalizationAccept.classList.toggle('is-ready', !personalizationAccept.disabled);
  personalizationAccept.textContent = personalizationSaving ? 'Saving…' : 'Accept';
  personalizationBack.disabled = personalizationSaving;
  studentPhotoButton.disabled = personalizationSaving;
}
function showPersonalizationFeedback(message) {
  personalizationFeedback.textContent = message;
  personalizationFeedback.hidden = !message;
}
personalizationForm.addEventListener('input', updatePersonalizationSubmit);
personalizationForm.addEventListener('change', updatePersonalizationSubmit);
personalizationForm.addEventListener('reset', () => queueMicrotask(updatePersonalizationSubmit));
personalizationBack.addEventListener('click', () => {
  if (!personalizationSaving) goToOnboardingSlide(2);
});
personalizationForm.addEventListener('submit', async event => {
  event.preventDefault();
  updatePersonalizationSubmit();
  if (personalizationAccept.disabled || !personalizationForm.reportValidity()) return;
  personalizationSaving = true;
  updatePersonalizationSubmit();
  personalizationForm.setAttribute('aria-busy', 'true');
  showPersonalizationFeedback('');
  const profile = Object.fromEntries(studentFieldNames.map(name => [name, savedStudentProfile[name]]));
  for (const name of ['nickName', 'username', 'bio']) {
    profile[name] = personalizationForm.elements.namedItem(name).value.trim();
  }
  try {
    const response = await fetch('/api/student-profile', {
      method: 'PUT', credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(profile)
    });
    if (!response.ok) {
      showPersonalizationFeedback(response.status === 400 || response.status === 422
        ? 'Check your nick name and username, then try Accept again.'
        : 'Your profile could not be saved. Please try Accept again.');
      return;
    }
    const result = await response.json();
    if (!isStudentProfileComplete(result.profile) || !isPersonalizationComplete(result.profile)) {
      throw new Error('Profile save was not confirmed.');
    }
    savedStudentProfile = result.profile;
    try {
      await persistSelectedProfilePhoto();
    } catch {
      showPersonalizationFeedback('Your profile text was saved, but the photo was not saved to your account. It remains selected; please retry Accept.');
      return;
    }
    profileReadState = 'ready';
    refreshProfileIfVisible();
    enterDashboard();
  } catch {
    showPersonalizationFeedback('Your profile could not be confirmed as saved. Please try Accept again.');
  } finally {
    personalizationSaving = false;
    updatePersonalizationSubmit();
    personalizationForm.removeAttribute('aria-busy');
  }
});
updatePersonalizationSubmit();
// End fourth onboarding profile.

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
  if (authReturn && !dashboardEntered) goToOnboardingSlide(1);
  profileReadState = 'loading';
  refreshProfileIfVisible();
  try {
    const response = await fetch('/auth/session', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('Sign-in could not be confirmed.');
    const status = await response.json();
    googleAuthenticated = Boolean(status.authenticated && status.authProvider === 'google' && status.googleProfile);
    signedInEmail = googleAuthenticated && typeof status.googleProfile.email === 'string' ? status.googleProfile.email.trim() : '';
    const email = signedInEmail.toLowerCase();
    const nextPhotoKey = email ? `google:${email}` : '';
    if (nextPhotoKey !== profilePhotoAccountKey) {
      resetStudentPhotoPreview();
      savedStudentProfile = null;
      studentForm.reset();
      personalizationForm.reset();
      profilePhotoAccountKey = nextPhotoKey;
      profilePhotoNotice = '';
    }
    restoreNavigationLocation(nextPhotoKey);
    renderSidebarIdentity();
    renderOverviewIdentity();
    updateStudentSubmit();
    updatePersonalizationSubmit();
    if (!status.authenticated) {
      profileReadState = 'guest';
      renderGoogleProfile(null);
      if (!dashboardEntered && authReturn) faydaFeedback.textContent = 'Sign-in could not be completed. Please try again or use Skip as a guest.';
      return;
    }
    if (!googleAuthenticated) {
      profileReadState = status.authProvider === 'google' ? 'error' : 'guest';
      renderGoogleProfile(null);
      if (!dashboardEntered) {
        goToOnboardingSlide(1);
        faydaFeedback.textContent = status.authProvider === 'google'
          ? 'Please continue with Google again to grant profile access and load your name, email, and photo.'
          : 'Continue with Google to set up your student profile, or use Skip as a guest.';
      }
      return;
    }
    renderGoogleProfile(status.googleProfile);
    try {
      const profile = await loadStudentProfile();
      await restoreAccountProfilePhoto();
      profileReadState = 'ready';
      if (!dashboardEntered) {
        if (!isStudentProfileComplete(profile)) goToOnboardingSlide(2);
        else if (!isPersonalizationComplete(profile)) goToOnboardingSlide(3);
        else enterDashboard();
      }
    } catch {
      profileReadState = 'error';
      profileLoadFailed = true;
      updateStudentSubmit();
      updatePersonalizationSubmit();
      if (!dashboardEntered) {
        goToOnboardingSlide(2);
        showStudentFeedback('Your saved profile could not be loaded. Please refresh before making changes.');
      }
    }
  } catch {
    profileReadState = 'error';
    if (authReturn) faydaFeedback.textContent = 'Sign-in could not be confirmed. Please try again or use Skip as a guest.';
  } finally {
    if (authReturn) window.history.replaceState({}, '', `${window.location.pathname}${window.location.hash}`);
    refreshProfileIfVisible();
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
  if (onboardingIndex >= 2) return;
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
  if (onboardingIndex >= 2 || Math.abs(event.deltaX) <= Math.abs(event.deltaY) || Math.abs(event.deltaX) < 20) return;
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
    if (event.target.closest('.payment-carousel, .bill-page, .pulse-shell')) { start = null; return; }
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
// Authenticated account memory is restored only after /auth/session confirms its owner.
// A stale hash from a different account must never select its initial screen.
render();
