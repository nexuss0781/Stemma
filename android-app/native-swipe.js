/* Android-only fixed-sequence horizontal navigation. Captures navigation metadata only. */
(function attachStemmaAndroidSwipe(root) {
  'use strict';
  if (!root.document || root.__StemmaAndroidSwipeInstalled) return;
  root.__StemmaAndroidSwipeInstalled = true;
  const STEPS = [
    { route: 'cards', tab: 0, slide: 0 }, { route: 'cards', tab: 0, slide: 1 },
    { route: 'cards', tab: 1 }, { route: 'cards', tab: 2 },
    ...[0, 1, 2, 3, 4].map(tab => ({ route: 'pulse', tab })),
    { route: 'overview', tab: 0 }, { route: 'likee', tab: 0 },
    { route: 'profile', tab: 0 }, { route: 'notifications' }
  ];
  const memory = new Map();
  let memoryAccount = '';
  let pointer = null;
  let activeIndex = -1;
  let locked = false;
  let visualTimer = 0;
  let dragClick = null;
  const app = () => root.StemmaAndroidAppState;
  const nav = () => root.StemmaAndroidNavigation;
  const notifications = () => root.StemmaAndroidSwipeBridge;
  const account = () => { try { return String(root.StemmaNative?.account || '').trim().slice(0, 320); } catch (_) { return ''; } };
  const reduceMotion = () => root.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  const routeState = () => {
    const state = nav()?.capture?.();
    if (!state) return null;
    if (root.StemmaNotifications?.captureForAndroidSwipe?.().active) state.route = 'notifications';
    return state;
  };
  function indexFor(state) {
    if (!state) return -1;
    if (root.StemmaNotifications?.captureForAndroidSwipe?.().active || state.route === 'notifications') return 12;
    if (state.route === 'cards') return state.tabs?.cards === 0 ? (state.paymentSlide === 1 ? 1 : 0) : state.tabs?.cards === 1 ? 2 : state.tabs?.cards === 2 ? 3 : -1;
    if (state.route === 'pulse') return 4 + Math.max(0, Math.min(4, Number(state.tabs?.pulse ?? state.pulse?.tab) || 0));
    if (state.route === 'overview') return 9;
    if (state.route === 'likee') return 10;
    if (state.route === 'profile') return 11;
    return -1;
  }
  function stepState(index, base) {
    const cached = memory.get(index);
    if (cached) return structuredClone(cached);
    const state = base ? structuredClone(base) : { version: 1, route: 'overview', document: '/', tabs: {}, paymentSlide: 0, scroll: {}, pulse: {}, attendance: {} };
    const step = STEPS[index];
    if (step.route === 'notifications') return { ...state, route: 'notifications', notification: { sortOrder: 'newest', scrollTop: 0, returnHash: '#profile' } };
    state.route = step.route;
    state.swipeScroll = [];
    state.tabs ||= {};
    if (step.route === 'cards') { state.tabs.cards = step.tab; state.paymentSlide = step.slide || 0; }
    else if (step.route === 'pulse') { state.tabs.pulse = step.tab; state.pulse = { tab: step.tab, stage: 0, scroll: {} }; }
    else if (!Number.isInteger(state.tabs[step.route])) state.tabs[step.route] = step.tab;
    if (base?.route !== step.route) state.scroll = { mainTop: 0, mainLeft: 0, windowY: 0 };
    return state;
  }
  function captureScroll(surface) {
    if (!surface) return [];
    const records=[];
    const walker=root.document.createTreeWalker(surface,1);
    for(let node=surface,count=0;node&&count<3000&&records.length<64;node=walker.nextNode(),count++){
      const top=Math.max(0,Math.min(1000000,Math.round(node.scrollTop||0)));
      const left=node.matches('#dashboard-grid.payment-carousel')?null:Math.max(0,Math.min(1000000,Math.round(node.scrollLeft||0)));
      if(!top&&!left)continue;
      const path=[];let cursor=node;
      while(cursor!==surface&&cursor?.parentElement&&path.length<12){path.unshift(Array.prototype.indexOf.call(cursor.parentElement.children,cursor));cursor=cursor.parentElement;}
      if(cursor===surface)records.push({path,top,left});
    }
    return records;
  }
  function restoreScroll(surface,records){
    if(!surface||!Array.isArray(records))return;
    for(const item of records.slice(0,64)){
      let node=surface;
      for(const index of item.path||[]){node=node?.children[index];if(!node)break;}
      if(node){node.scrollTop=item.top||0;if(item.left!==null&&!node.matches('#dashboard-grid.payment-carousel'))node.scrollLeft=item.left||0;}
    }
  }
  function captureCurrent() {
    const state = routeState();
    if (!state) return null;
    const index = indexFor(state);
    if (index < 0) return null;
    if (state.route === 'notifications') state.notification = root.StemmaNotifications?.captureForAndroidSwipe?.() || {};
    state.swipeScroll=captureScroll(root.document.getElementById(index===12?'notifications-page':'app-main'));
    return { index, state };
  }
  function syncAccount() {
    const current = account();
    if (memoryAccount && current !== memoryAccount) { memory.clear(); activeIndex = -1; }
    memoryAccount = current;
    return current;
  }
  function eligibleTarget(target) {
    if (!(target instanceof Element)) return null;
    if (!app()?.isAuthenticated?.()) return null;
    const visible = element => !element.hidden && element.getClientRects().length > 0;
    if ([...root.document.querySelectorAll('dialog[open],#navigation-drawer.open,[role="menu"]:not([hidden]),.pulse-direct-chat:not([hidden]),.group-detail:not([hidden]),.channel-view:not([hidden]),.pulse-search:not([hidden]),.pulse-saved:not([hidden])')].some(visible)) return null;
    if (target.closest('#navigation-drawer.open,#drawer-backdrop:not([hidden]),[role="dialog"],[aria-modal="true"],dialog[open],.sheet-open,.payment-sheet,.fee-interval-menu,[role="listbox"],[role="menu"],[data-picker-open],.pulse-create-previews:not([inert]),.notification-detail-dialog,.is-modal-open')) return null;
    if (target.closest('input,textarea,select,option,[role="tab"],summary,[data-photo-diagnostics],[contenteditable="true"],[contenteditable=""],[data-gesture-owner],[data-native-swipe-block]')) return null;
    const surfaceHit = target.closest('#app-main,#notifications-page,.topbar');
    if (!surfaceHit || surfaceHit.hidden) return null;
    if (target.closest('.pulse-stories,.story-rail,.stories-rail,.channel-view:not([hidden]),.pulse-direct-chat:not([hidden]),.direct-chat-view:not([hidden]),.group-detail:not([hidden]),.pulse-saved:not([hidden]),#pulse-search:not([hidden]),[data-horizontal-scroll],.horizontal-scroll,.carousel-rail')) return null;
    const state = routeState();
    const idx = indexFor(state);
    if (idx < 0 || idx >= STEPS.length) return null;
    if(state.route==='pulse'&&(state.pulse?.directId||state.pulse?.groupId||state.pulse?.channelId||state.pulse?.savedOpen||state.pulse?.searchOpen))return null;
    const main = root.document.getElementById(idx===12?'notifications-page':'app-main');
    if (!main || main.hidden) return null;
    // Likee's video/feed surface owns vertical feed gestures; only non-feed page chrome may navigate.
    if (state.route === 'likee' && target.closest('#dashboard-grid,.likee-feed,.likee-video-feed,[data-likee-feed]')) return null;
    if (state.route === 'pulse' && target.closest('.groups-view:not([hidden]) .group-detail:not([hidden]),.pulse-direct-chat:not([hidden]),.channel-view:not([hidden]),#pulse-search:not([hidden]),.pulse-saved:not([hidden])')) return null;
    if (state.route === 'cards' && root.document.getElementById('dashboard-grid')?.classList.contains('bill-content-grid')) return null;
    // Preserve any actually scrollable horizontal owner. The Pay fee carousel is the one explicit exception.
    const exception = state.route === 'cards' && idx <= 1 && target.closest('#dashboard-grid.payment-carousel');
    if (!exception) {
      for (let node = target; node && node !== main; node = node.parentElement) {
        if (node.scrollWidth > node.clientWidth + 4 && (node.scrollLeft > 0 || getComputedStyle(node).overflowX === 'auto' || getComputedStyle(node).overflowX === 'scroll')) return null;
      }
    }
    return { main, state, idx };
  }
  function setVisual(x, animate = false, surface = null) {
    const main = surface || root.document.getElementById('app-main');
    if (!main) return;
    root.document.documentElement.classList.add('android-swipe-tracking');
    main.style.setProperty('--android-swipe-x', `${x}px`);
    if (animate) main.classList.add('android-swipe-ease'); else main.classList.remove('android-swipe-ease');
  }
  function resetVisual(surface = null) {
    const main = surface || root.document.getElementById('app-main');
    if (!main) return;
    main.classList.add('android-swipe-ease');
    main.style.setProperty('--android-swipe-x', '0px');
    root.clearTimeout(visualTimer);
    visualTimer=root.setTimeout(() => { main.classList.remove('android-swipe-ease'); root.document.documentElement.classList.remove('android-swipe-tracking'); }, reduceMotion() ? 0 : 230);
  }
  function begin(event) {
    if(!event.isPrimary){if(pointer){const surface=pointer.eligible.main;pointer=null;resetVisual(surface);}return;}
    dragClick=null;
    if (locked || pointer || (event.pointerType === 'mouse' && event.button !== 0)) return;
    syncAccount();
    const eligible = eligibleTarget(event.target);
    if (!eligible) return;
    root.clearTimeout(visualTimer);
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, dx: 0, dy: 0, axis: '', eligible, width: eligible.main.clientWidth || root.innerWidth };
  }
  function move(event) {
    if (!pointer || event.pointerId !== pointer.id) return;
    const dx = event.clientX - pointer.x, dy = event.clientY - pointer.y;
    pointer.dx = dx; pointer.dy = dy;
    if (!pointer.axis && Math.max(Math.abs(dx), Math.abs(dy)) >= 10) {
      if (Math.abs(dx) > Math.abs(dy) * 1.25) {pointer.axis = 'x';root.StemmaNotifications?.cancelAndroidSwipePress?.();try{pointer.eligible.main.setPointerCapture(event.pointerId);}catch(_){}}
      else if (Math.abs(dy) > Math.abs(dx) * 1.25) { pointer = null; return; }
      else return;
    }
    if (pointer.axis !== 'x') return;
    event.stopImmediatePropagation();
    // Keep the payment carousel's own inner slide changes disabled only for Android route-owned Pay fee gestures.
    if (Math.abs(dx) > Math.abs(dy) * 1.1) event.preventDefault();
    const edge = (pointer.eligible.idx === 0 && dx > 0) || (pointer.eligible.idx === STEPS.length - 1 && dx < 0);
    setVisual(edge ? dx * .22 : dx, false, pointer.eligible.main);
  }
  function finish(event) {
    if (!pointer || event.pointerId !== pointer.id) return;
    const gesture = pointer; pointer = null;
    if (gesture.axis !== 'x') return;
    event.stopImmediatePropagation();
    dragClick={surface:gesture.eligible.main,x:event.clientX,y:event.clientY,until:performance.now()+450};
    if (event.type === 'pointercancel') { resetVisual(gesture.eligible.main); return; }
    if(Math.abs(gesture.dx)<=Math.abs(gesture.dy)*1.25){resetVisual(gesture.eligible.main);return;}
    const threshold = Math.max(58, Math.min(104, gesture.width * .19));
    const goNext = gesture.dx < -threshold, goPrevious = gesture.dx > threshold;
    const target = gesture.eligible.idx + (goNext ? 1 : goPrevious ? -1 : 0);
    if ((!goNext && !goPrevious) || target < 0 || target >= STEPS.length) { resetVisual(gesture.eligible.main); return; }
    void transition(gesture.eligible.idx, target, gesture.dx);
  }
  async function transition(from, to, dx) {
    if (locked) return;
    locked = true;
    const oldSurface = root.document.getElementById(from===12?'notifications-page':'app-main');
    try {
      const current = captureCurrent();
      if (current) { memory.set(current.index, current.state); activeIndex = current.index; }
      const target = stepState(to, current?.state);
      const notificationsOpen = to === 12;
      if (oldSurface) { oldSurface.classList.add('android-swipe-ease'); root.document.documentElement.classList.add('android-swipe-tracking'); }
      if (current?.index === 12 && !notificationsOpen) await root.StemmaNotifications?.applyAndroidSwipeRoute?.(false);
      if (notificationsOpen) {
        const notice = target.notification || { sortOrder: 'newest', scrollTop: 0 };
        await root.StemmaNotifications?.applyAndroidSwipeRoute?.(true, { ...notice, returnHash: '#profile' });
      } else {
        await root.StemmaNotifications?.applyAndroidSwipeRoute?.(false);
        const state = { ...target, route: STEPS[to].route, tabs: { ...(target.tabs || {}) } };
        if (state.route === 'pulse') { state.tabs.pulse = STEPS[to].tab; state.pulse = { ...(state.pulse || {}), tab: STEPS[to].tab }; }
        if (state.route === 'cards') { state.tabs.cards = STEPS[to].tab; state.paymentSlide = STEPS[to].slide || 0; }
        if (!await root.StemmaAndroidNavigation?.restore?.(state,{userInitiated:true})) throw new Error('Swipe restore unavailable');
        root.history.replaceState({},'',`#${state.route}`);
      }
      const dest = notificationsOpen ? root.document.getElementById('notifications-page') : root.document.getElementById('app-main');
      restoreScroll(dest,target.swipeScroll);
      if (dest) {
        dest.classList.remove('android-swipe-ease');
        dest.style.setProperty('--android-swipe-x', `${dx < 0 ? Math.min(64, root.innerWidth * .12) : -Math.min(64, root.innerWidth * .12)}px`);
        void dest.offsetWidth;
        dest.classList.add('android-swipe-ease'); root.document.documentElement.classList.add('android-swipe-tracking');
        root.requestAnimationFrame(() => { if (dest.isConnected) dest.style.setProperty('--android-swipe-x', '0px'); });
        root.clearTimeout(visualTimer);
        visualTimer=root.setTimeout(() => { dest.classList.remove('android-swipe-ease'); root.document.documentElement.classList.remove('android-swipe-tracking'); }, reduceMotion() ? 0 : 230);
      }
      activeIndex = to;
    } catch (error) {
      console.warn('Android swipe navigation skipped', error);
      resetVisual(oldSurface);
    } finally { locked = false; }
  }
  root.addEventListener('pointerdown', begin, true);
  root.addEventListener('pointermove', move, true);
  root.addEventListener('pointerup', finish, true);
  root.addEventListener('pointercancel', finish, true);
  root.addEventListener('lostpointercapture', event => {
    if(pointer?.id===event.pointerId&&event.target===pointer.eligible.main&&!pointer.eligible.main.hasPointerCapture(event.pointerId)){
      const surface=pointer.eligible.main;pointer=null;resetVisual(surface);
    }
  }, true);
  root.addEventListener('click',event=>{
    const blocked=dragClick&&performance.now()<dragClick.until&&Math.hypot(event.clientX-dragClick.x,event.clientY-dragClick.y)<40&&(dragClick.surface.contains(event.target)||event.composedPath().includes(dragClick.surface));
    dragClick=null;
    if(blocked){event.preventDefault();event.stopImmediatePropagation();return;}
    syncAccount();const current=captureCurrent();
    const nested=current?.state.route==='pulse'&&(current.state.pulse?.directId||current.state.pulse?.groupId||current.state.pulse?.channelId||current.state.pulse?.savedOpen||current.state.pulse?.searchOpen);
    if(current&&!nested)memory.set(current.index,current.state);
  },true);
  root.addEventListener('stemma:account-cleared', () => { memory.clear(); memoryAccount = ''; activeIndex = -1; pointer = null; resetVisual(); });
  root.addEventListener('stemma:account-ready', syncAccount);
  root.addEventListener('stemma:android-app-auth-ready', syncAccount);
  const api = Object.freeze({
    get steps() { return STEPS.map((step, index) => ({ index, route: step.route, tab: step.tab ?? null, slide: step.slide ?? null })); },
    get activeIndex() { return captureCurrent()?.index ?? activeIndex; },
    capture: captureCurrent,
    async goTo(index) { if (!Number.isInteger(index) || index < 0 || index >= STEPS.length) return false; const current = captureCurrent(); if (current?.index === index) return true; if (current) memory.set(current.index, current.state); await transition(current?.index ?? index, index, index > (current?.index ?? index) ? -80 : 80); return true; }
  });
  root.StemmaAndroidSwipe = api;
  root.StemmaAndroidSwipeBridge = api;
})(typeof window !== 'undefined' ? window : globalThis);
