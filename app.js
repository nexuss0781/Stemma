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
const paymentSlides = ['For You', 'For friend'];

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
  const paymentCarousel = activeRoute === 'cards' && activeTabs.cards === 0;
  grid.classList.toggle('payment-carousel', paymentCarousel);
  if (paymentCarousel) {
    grid.setAttribute('role', 'region');
    grid.setAttribute('aria-roledescription', 'carousel');
    grid.setAttribute('aria-label', 'Pay fee options. Swipe horizontally to move between For You and For friend.');
    grid.tabIndex = 0;
    grid.innerHTML = paymentSlides.map((label, index) => `
      <section class="payment-slide" role="group" aria-roledescription="slide" aria-label="${index + 1} of ${paymentSlides.length}: ${label}">
        <div class="payment-slide-grid">${renderSkeletonCards()}</div>
      </section>`).join('');
    window.requestAnimationFrame(syncPaymentCarousel);
    return;
  }
  grid.removeAttribute('role');
  grid.removeAttribute('aria-roledescription');
  grid.removeAttribute('tabindex');
  grid.setAttribute('aria-label', 'Content placeholders');
  grid.innerHTML = renderSkeletonCards();
}

function render() {
  const main = document.getElementById('app-main');
  const overview = activeRoute === 'overview';
  const paymentView = activeRoute === 'cards';
  const paymentCarousel = paymentView && activeTabs.cards === 0;
  main.classList.toggle('overview-view', overview);
  main.classList.toggle('secondary-view', !overview);
  main.classList.toggle('payment-view', paymentView);
  main.classList.remove('route-from-left', 'route-from-right');
  if (routeDirection) main.classList.add(routeDirection > 0 ? 'route-from-right' : 'route-from-left');
  main.querySelector('.hero-card').hidden = !overview;
  main.querySelector('.page-title').hidden = !paymentView;
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
  if (route === activeRoute) { closeDrawer(); return; }
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

document.addEventListener('click', event => {
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

function setOnboardingProgress() {
  const currentIndex = Math.max(0, Math.min(onboardingSlides.length - 1, Math.round(onboardingStage.scrollLeft / Math.max(1, onboardingStage.clientWidth))));
  document.getElementById('active-step').textContent = `0${currentIndex + 1}`;
  document.getElementById('progress-dot-one').classList.toggle('is-active', currentIndex === 0);
  document.getElementById('progress-dot-two').classList.toggle('is-active', currentIndex === 1);
}

function goToOnboardingSlide(index) {
  const target = Math.max(0, Math.min(onboardingSlides.length - 1, index));
  onboardingStage.scrollTo({
    left: target * onboardingStage.clientWidth,
    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'
  });
}

function enterDashboard() {
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
        enterDashboard();
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
  if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
  event.preventDefault();
  const currentIndex = Math.round(onboardingStage.scrollLeft / Math.max(1, onboardingStage.clientWidth));
  goToOnboardingSlide(currentIndex + (event.key === 'ArrowRight' ? 1 : -1));
});
window.addEventListener('resize', setOnboardingProgress);

document.getElementById('menu-trigger').addEventListener('click', openDrawer);
document.getElementById('drawer-close').addEventListener('click', closeDrawer);
document.getElementById('drawer-backdrop').addEventListener('click', closeDrawer);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeDrawer();
});

function bindSwipeNavigation(element) {
  let start = null;
  element.addEventListener('touchstart', event => {
    if (event.target.closest('.payment-carousel')) { start = null; return; }
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
