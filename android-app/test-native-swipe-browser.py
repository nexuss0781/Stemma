from __future__ import annotations

import ast
import json
import os
import struct
import threading
import zlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent
WWW = Path(os.environ.get("STEMMA_SWIPE_TEST_WWW", str(ROOT / "www")))
PORT = int(os.environ.get("STEMMA_SWIPE_TEST_PORT", "8987"))
BASE_URL = f"http://127.0.0.1:{PORT}"
PREVIEW_DIR = Path("/workspace/stemma-delivery/swipe-preview")
RESULT_PATH = PREVIEW_DIR / "native-swipe-browser-results.json"
SCREENSHOT_PATH = PREVIEW_DIR / "swipe-sample.png"

# Reuse the browser/native bridge fixture as Python syntax only; do not import or
# execute test-bundle.py. Its authenticated-session and profile fixtures are
# changed here to synthetic, complete student data.
bundle_test = ast.parse((ROOT / "test-bundle.py").read_text())
INIT = next(
    ast.literal_eval(node.value)
    for node in bundle_test.body
    if isinstance(node, ast.Assign)
    and any(isinstance(target, ast.Name) and target.id == "INIT" for target in node.targets)
)
assert "window.__testSession || {authenticated:false,googleConfigured:true,faydaConfigured:false}" in INIT
INIT = INIT.replace(
    "window.__testSession || {authenticated:false,googleConfigured:true,faydaConfigured:false}",
    "window.__testSession || {authenticated:true,authProvider:'google',googleConfigured:true,faydaConfigured:false,googleProfile:{email:'swipe-student@example.invalid',name:'Swipe Test Student'}}",
    1,
)
# The native wrapper sometimes performs a host-origin session/profile fetch;
# keep those deterministic as well as serving same-origin API requests locally.
assert "let data={};" in INIT
INIT = INIT.replace(
    "else if(url.pathname.startsWith('/api/likee'))",
    "else if(url.pathname==='/api/student-profile')data={profile:{firstName:'Swipe',middleName:'Fixture',lastName:'Student',studentId:'TEST-SWIPE-102',department:'Computing',nickName:'Swipe Test',username:'swipe_fixture',bio:'Synthetic browser fixture'}};else if(url.pathname==='/api/notifications')data={notifications:[{id:'fixture-read-1',type:'system',title:'Synthetic notification',message:'Read-only swipe fixture',createdAt:'2026-10-20T12:00:00.000Z',read:true,readAt:'2026-10-20T12:01:00.000Z'}]};else if(url.pathname.startsWith('/api/likee'))",
    1,
)


def make_png(width: int = 24, height: int = 24) -> bytes:
    """Small valid synthetic PNG available to fixtures without external assets."""
    raw = b"".join(b"\0" + bytes((61, 135, 201, 255)) * width for _ in range(height))

    def chunk(kind: bytes, data: bytes) -> bytes:
        payload = kind + data
        return struct.pack(">I", len(data)) + payload + struct.pack(">I", zlib.crc32(payload) & 0xFFFFFFFF)

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">2I5B", width, height, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


PNG_FIXTURE = make_png()
API_REQUESTS: list[dict] = []


def fixture_response(path: str):
    """Read-only synthetic backend; no request reaches production or a network."""
    if path == "/auth/session":
        return {"authenticated": True, "authProvider": "google", "googleConfigured": True,
                "faydaConfigured": False, "googleProfile": {"email": "swipe-student@example.invalid",
                "name": "Swipe Test Student"}}
    if path == "/api/student-profile":
        return {"profile": {"firstName": "Swipe", "middleName": "Fixture", "lastName": "Student",
                "studentId": "TEST-SWIPE-102", "department": "Computing", "nickName": "Swipe Test",
                "username": "swipe_fixture", "bio": "Synthetic browser fixture"}}
    if path == "/api/notifications":
        # Read notification only: opening its detail cannot mark anything read.
        return {"notifications": [{"id": "fixture-read-1", "type": "system", "title": "Synthetic notification",
                "message": "Read-only swipe fixture", "createdAt": "2026-10-20T12:00:00.000Z",
                "read": True, "readAt": "2026-10-20T12:01:00.000Z"}]}
    if path.startswith("/api/likee"):
        return {"videos": [], "profile": None}
    if path.startswith("/api/pulse") or path.startswith("/api/groups") or path.startswith("/api/channels"):
        return {"threads": [], "stories": [], "groups": [], "channels": [], "notifications": [],
                "items": [], "users": [], "authenticated": True}
    return {"ok": True, "threads": [], "stories": [], "groups": [], "channels": [],
            "notifications": [], "items": [], "authenticated": True}


class LocalAppHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WWW), **kwargs)

    def log_message(self, _format, *_args):
        pass

    def _respond(self):
        path = self.path.split("?", 1)[0]
        API_REQUESTS.append({"path": path, "method": self.command})
        if path == "/test-fixtures/profile.png":
            body, content_type = PNG_FIXTURE, "image/png"
        elif path == "/api/student-profile/photo":
            body, content_type = PNG_FIXTURE, "image/png"
        elif path.startswith("/api/") or path == "/auth/session":
            body, content_type = json.dumps(fixture_response(path)).encode(), "application/json"
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path.startswith("/api/") or path == "/auth/session" or path == "/test-fixtures/profile.png":
            return self._respond()
        return super().do_GET()

    do_POST = _respond
    do_PUT = _respond
    do_PATCH = _respond
    do_DELETE = _respond


def start_server():
    server = ThreadingHTTPServer(("0.0.0.0", PORT), LocalAppHandler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def state(page) -> dict:
    return page.evaluate("window.StemmaAndroidAppState.capture()")


def assert_step(page, route: str, tab: int | None = None, payment_slide: int | None = None):
    current = state(page)
    if route == "notifications":
        assert current["route"] == "profile" and page.evaluate("location.hash") == "#notifications", {
            "expectedView": "notifications", "state": current, "hash": page.evaluate("location.hash")}
        assert not page.locator("#notifications-page").is_hidden(), "Notifications view is not visible"
        return current
    assert current["route"] == route, {"expectedRoute": route, "state": current}
    if tab is not None:
        assert current["tabs"][route] == tab, {"expectedTab": tab, "state": current}
    if payment_slide is not None:
        assert current["paymentSlide"] == payment_slide, {"expectedPaymentSlide": payment_slide, "state": current,"debug":page.evaluate("""()=>({installed:window.__StemmaAndroidSwipeInstalled,navReady:window.StemmaAndroidNavigation?.accountReady,active:window.StemmaAndroidSwipe?.activeIndex,trace:window.__pointerTrace,owners:[...document.querySelectorAll('dialog[open],#navigation-drawer.open,[role=menu]:not([hidden]),.pulse-direct-chat:not([hidden]),.group-detail:not([hidden]),.channel-view:not([hidden]),.pulse-search:not([hidden]),.pulse-saved:not([hidden])')].map(e=>({tag:e.tagName,id:e.id,cls:e.className,hidden:e.hidden,rects:e.getClientRects().length,visibility:getComputedStyle(e).visibility})),target:(()=>{const r=document.querySelector('#dashboard-grid').getBoundingClientRect();const e=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {html:e?.outerHTML.slice(0,240),form:e?.closest('form')?.id};})()})""") }
    if route in {"cards", "pulse", "overview", "likee", "profile"}:
        assert page.locator(f'.nav-item[data-route="{route}"]').get_attribute("aria-current") == "page"
    return current


def center_of(locator):
    box = locator.bounding_box()
    assert box, f"gesture target has no visible bounds: {locator}"
    return (box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)


def touch_gesture(page, start, end=None, *, cancel=False, steps=5, hold_ms=45):
    """Send trusted touch input through Chromium CDP, never call app swipe APIs."""
    cdp = page.context.new_cdp_session(page)

    def dispatch(kind, point=None):
        points = [] if point is None else [{"x": point[0], "y": point[1], "id": 7,
                                            "radiusX": 1, "radiusY": 1, "force": 1}]
        cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": points})

    dispatch("touchStart", start)
    page.wait_for_timeout(hold_ms)
    if end is not None:
        for index in range(1, steps + 1):
            fraction = index / steps
            point = (start[0] + (end[0] - start[0]) * fraction,
                     start[1] + (end[1] - start[1]) * fraction)
            dispatch("touchMove", point)
            if index < steps:
                page.wait_for_timeout(12)
    if cancel:
        dispatch("touchCancel")
    else:
        dispatch("touchEnd")
    page.wait_for_timeout(350)
    cdp.detach()


def route_snapshot(page):
    return page.evaluate("""()=>({state:window.StemmaAndroidAppState.capture(),hash:location.hash,
      trusted:window.__lastTouchTrusted===true,dialogOpen:[...document.querySelectorAll('dialog')].some(d=>d.open)})""")


def assert_no_swipe_side_effects(page, case_name):
    observed = page.evaluate("""()=>{
      const calls=window.__calls||[];
      return {
        transportWrites:calls.filter(c=>c.name==='StemmaTransport'&&c.method==='request'&&
          !['GET','HEAD','OPTIONS'].includes(String(c.options?.method||'GET').toUpperCase())),
        galleryReads:calls.filter(c=>c.name==='StemmaMedia'&&
          ['requestAccess','listAlbums','listMedia','thumbnail','readFile','selectFile','recentFiles'].includes(c.method)),
        filesystemWrites:calls.filter(c=>c.name==='Filesystem'&&c.method==='writeFile'),
        queueReplays:calls.filter(c=>c.name==='StemmaTransport'&&['upload','request'].includes(c.method)&&
          c.options?.replayed===true)
      };
    }""")
    assert not observed["transportWrites"], (case_name, observed)
    assert not observed["galleryReads"], (case_name, observed)
    assert not observed["filesystemWrites"], (case_name, observed)
    assert not observed["queueReplays"], (case_name, observed)
    writes = [r for r in API_REQUESTS if r["method"] not in {"GET", "HEAD", "OPTIONS"}]
    assert not writes, (case_name, writes)
    return observed


def drag_between(page, locator, dx, dy, *, cancel=False, steps=5):
    x, y = center_of(locator)
    touch_gesture(page, (x, y), (x + dx, y + dy), cancel=cancel, steps=steps)


def route_gesture(page, dx, dy=0):
    """Swipe a noninteractive page surface; Likee/notifications/profile use blank topbar chrome."""
    current = state(page)
    notification_open = page.evaluate("location.hash==='#notifications'")
    route = "notifications" if notification_open else current["route"]
    if route=="notifications":
        x,y=center_of(page.locator('#notifications-title'))
        target={"route":route,"selector":"#notifications-title","x":x,"y":y,"target":"h1#notifications-title"}
    elif route in {"likee", "profile", "pulse", "overview"} or (route=="cards" and (current["tabs"]["cards"]!=0 or current["paymentSlide"]==1)):
        point = page.evaluate("""()=>{
          const bar=document.querySelector('.topbar'), r=bar?.getBoundingClientRect();
          if(!r||r.width<1||r.height<1)return null;
          const interactive='input,textarea,select,[role="tab"],[contenteditable="true"],button:disabled';
          for(let y=Math.ceil(r.top+r.height/2);y<r.bottom;y+=2){
            for(let x=Math.ceil(r.left+r.width*.38);x<r.right-r.width*.18;x+=3){
              const el=document.elementFromPoint(x,y);
              if(el&&bar.contains(el)&&!el.closest(interactive))return {x,y,target:el.tagName.toLowerCase()+(el.id?'#'+el.id:'')+(el.classList?.length?'.'+[...el.classList].join('.'):'' )};
            }
          }
          return null;
        }""")
        assert point, f"no safe blank topbar target on {route}"
        target = {"route": route, "selector": ".topbar", **point}
    else:
        x, y = center_of(page.locator("#dashboard-grid"))
        target = {"route": route, "selector": "#dashboard-grid", "x": x, "y": y,
                  "target": page.evaluate("""([x,y])=>{const e=document.elementFromPoint(x,y);return e?.tagName.toLowerCase()+(e?.id?'#'+e.id:'')+(e?.classList?.length?'.'+[...e.classList].join('.'): '')}""", [x, y])}
        assert not page.evaluate("""([x,y])=>!!document.elementFromPoint(x,y)?.closest('input,textarea,select,[role="tab"],[contenteditable="true"]')""", [x, y]), ("gesture start landed on interactive control", target)
    target["chain"]=page.evaluate("""([x,y])=>{let e=document.elementFromPoint(x,y);const out=[];for(;e;e=e.parentElement){const s=getComputedStyle(e);out.push({tag:e.tagName,cls:e.className,id:e.id,touch:s.touchAction,overflow:s.overflow,sw:e.scrollWidth,cw:e.clientWidth})}return out}""",[target["x"],target["y"]])
    touch_gesture(page, (target["x"], target["y"]), (target["x"] + dx, target["y"] + dy))
    target["trace"]=page.evaluate("window.__pointerTrace.slice(-9)")
    target["endX"], target["endY"] = target["x"] + dx, target["y"] + dy
    return target


def main():
    PREVIEW_DIR.mkdir(parents=True, exist_ok=True)
    API_REQUESTS.clear()
    server = start_server()
    result = {
        "status": "running",
        "app": "bundled regular www app",
        "viewport": {"width": 390, "height": 844, "isMobile": True, "hasTouch": True,
                     "reducedMotion": "no-preference"},
        "fixture": {"auth": "synthetic complete Google student profile; *.example.invalid account",
                    "backend": "local synthetic GET fixtures only", "png": "valid in-memory 24x24 RGBA PNG",
                    "notification": "read-only fixture to prevent mark-read mutations"},
        "physicalAndroidOrRealAccountTest": False,
        "steps": [],
        "limitations": [],
    }
    browser = None
    context = None
    page = None
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path="/usr/bin/chromium", headless=True, args=["--no-sandbox"])
            context = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True,
                                         has_touch=True, reduced_motion="no-preference",
                                         record_video_dir=str(PREVIEW_DIR), record_video_size={"width": 390, "height": 844})
            context.add_init_script(INIT)
            context.add_init_script("window.__pointerTrace=[];for(const type of ['pointerdown','pointermove','pointerup','pointercancel'])addEventListener(type,e=>{window.__pointerTrace.push({type,trusted:e.isTrusted,tag:e.target.tagName,cls:e.target.className,x:e.clientX,y:e.clientY});if(window.__pointerTrace.length>60)window.__pointerTrace.shift()},true)")
            context.add_init_script("""(()=>{const original=window.fetch.bind(window);window.__fetchTrace=[];
              window.fetch=async(...args)=>{const url=String(args[0]?.url||args[0]);
                window.__fetchTrace.push({url,phase:'start'});try{const response=await original(...args);
                  window.__fetchTrace.push({url,status:response.status,phase:'complete'});return response;
                }catch(error){window.__fetchTrace.push({url,error:String(error),phase:'error'});throw error;}};})();""")
            context.add_init_script("addEventListener('touchstart',e=>{window.__lastTouchTrusted=e.isTrusted},{capture:true,passive:true});")
            page = context.new_page()
            errors = []
            external_requests = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.on("request", lambda request: external_requests.append(request.url)
                    if not request.url.startswith(BASE_URL) and not request.url.startswith("data:") else None)
            # Defense in depth: no remote host is contacted, even if a fixture or
            # app path bypasses fetch interception.
            page.route("**/*", lambda route: route.continue_() if route.request.url.startswith(BASE_URL)
                       or route.request.url.startswith("data:") else route.abort())
            response = page.goto(BASE_URL + "/", wait_until="networkidle")
            assert response and response.ok, "bundled www shell did not load"
            page.wait_for_function("window.StemmaAndroidAppState?.capture && window.StemmaAndroidAppState.capture().route")
            try:
                page.wait_for_function("window.StemmaAndroidAppState?.isAuthenticated?.() === true", timeout=15000)
            except Exception as error:
                auth_snapshot = page.evaluate("""()=>({
                  authenticated:window.StemmaAndroidAppState?.isAuthenticated?.(),
                  state:window.StemmaAndroidAppState?.capture?.(),
                  onboardingHidden:document.getElementById('onboarding-screen')?.hidden,
                  authText:document.getElementById('onboarding-feedback')?.textContent||null,
                  shellHidden:document.getElementById('app-shell')?.hidden,
                  fetchTrace:window.__fetchTrace
                })""")
                raise AssertionError({"authWait": str(error), "snapshot": auth_snapshot,
                                      "apiRequests": API_REQUESTS, "pageErrors": errors}) from error
            page.wait_for_function("!document.getElementById('onboarding-screen') || document.getElementById('onboarding-screen').hidden", timeout=15000)
            # Start at the first defined stop using the shipped button control;
            # every subsequent route/tab change is driven solely by trusted swipes.
            if state(page)["route"] != "cards":
                page.locator('.nav-item[data-route="cards"]').click()
            page.wait_for_function("window.StemmaAndroidAppState.capture().route==='cards'")
            page.wait_for_function("window.StemmaAndroidAppState.capture().tabs.cards===0")
            assert_step(page, "cards", 0, 0)

            # Cancellation, a small below-threshold drag, and vertical movement
            # must not leave or mutate the current page.
            grid = page.locator("#dashboard-grid")
            before = state(page)
            drag_between(page, grid, -115, 0, cancel=True)
            assert state(page) == before, "cancelled gesture changed app navigation state"
            drag_between(page, grid, -18, 0, steps=2)
            assert state(page) == before, "small horizontal drag changed app navigation state"
            drag_between(page, grid, 0, -170)
            assert state(page) == before, "predominantly vertical drag changed app navigation state"
            result["cancellationSmallDragVertical"] = True

            # Page content remains stationary throughout the gesture; routing
            # happens directly after the deliberate horizontal release.
            x, y = center_of(grid)
            cdp = context.new_cdp_session(page)
            cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": y, "id": 9, "radiusX": 1, "radiusY": 1, "force": 1}]})
            cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x - 42, "y": y, "id": 9, "radiusX": 1, "radiusY": 1, "force": 1}]})
            page.wait_for_timeout(80)
            tracking = page.evaluate("""()=>['#dashboard-grid','.app-shell','#app-main'].map(selector=>{
              const el=document.querySelector(selector);if(!el)return null;
              const style=getComputedStyle(el);return {selector,transform:style.transform,inline:el.style.transform};
            }).filter(Boolean)""")
            result["midGestureTrackingTransform"] = {"observed": any(
                item["transform"] not in ("none", "matrix(1, 0, 0, 1, 0, 0)") or item["inline"]
                for item in tracking), "samples": tracking}
            assert not result["midGestureTrackingTransform"]["observed"], "page transform introduced swipe drag/staged movement"
            cdp.send("Input.dispatchTouchEvent", {"type": "touchCancel", "touchPoints": []})
            cdp.detach()
            page.wait_for_timeout(250)
            assert state(page) == before, "tracking-only gesture changed route before release"

            stops = [("cards", 0, 0), ("cards", 0, 1), ("cards", 1, None), ("cards", 2, None)]
            stops.extend(("pulse", tab, None) for tab in range(5))
            stops.extend([("overview", None, None), ("likee", None, None), ("profile", None, None),
                          ("notifications", None, None)])
            assert len(stops) == 13
            labels = ["Payment / Pay fee / slide 0", "Payment / Pay fee / slide 1",
                      "Payment / Deposit", "Payment / History"]
            labels.extend([f"Pulse / {name}" for name in ("All", "User", "Group", "Channel", "App")])
            labels.extend(["Overview", "Likee", "Profile", "Notifications"])
            result["steps"].append({"index": 0, "label": labels[0], "state": state(page)})
            assert page.evaluate("window.__lastTouchTrusted===true"), "Chromium CDP did not produce trusted touch events"
            main_scroll_at_pulse_app = None
            for index in range(1, len(stops)):
                target_info = route_gesture(page, -235)
                result.setdefault("forwardGestureTargets", []).append(target_info)
                expected_route, expected_tab, expected_slide = stops[index]
                current = assert_step(page, expected_route, expected_tab, expected_slide)
                assert page.evaluate("window.__lastTouchTrusted===true"), "swipe was not a trusted touch input"
                if index == 8:  # Pulse / App: seed measurable route scroll, if content allows it.
                    scroll_info = page.evaluate("""()=>{const el=document.getElementById('dashboard-grid');
                      const max=Math.max(0,el.scrollHeight-el.clientHeight);el.scrollTop=Math.min(72,max);
                      return {max,top:el.scrollTop};}""")
                    main_scroll_at_pulse_app = scroll_info["top"]
                    result["pulseAppScrollSeed"] = scroll_info
                result["steps"].append({"index": index, "label": labels[index], "state": current})
                if index == 10:
                    page.screenshot(path=str(SCREENSHOT_PATH), full_page=False)

            # The end bound cannot advance farther; then reverse across all 12
            # transitions and verify the retained tab/slide state at every stop.
            at_end = state(page)
            result.setdefault("boundaryGestureTargets", []).append(route_gesture(page, -235))
            assert state(page) == at_end, "forward swipe moved past Notifications edge"
            for index in range(len(stops) - 2, -1, -1):
                target_info = route_gesture(page, 235)
                result.setdefault("reverseGestureTargets", []).append(target_info)
                expected_route, expected_tab, expected_slide = stops[index]
                current = assert_step(page, expected_route, expected_tab, expected_slide)
                result["steps"].append({"index": index, "label": labels[index], "direction": "reverse", "state": current})
                if index == 8 and main_scroll_at_pulse_app:
                    restored_scroll = page.evaluate("document.querySelector('#dashboard-grid')?.scrollTop ?? null")
                    assert restored_scroll == main_scroll_at_pulse_app, {
                        "expectedGridScrollTop": main_scroll_at_pulse_app, "actualGridScrollTop": restored_scroll, "state": current}
            at_start = state(page)
            result["boundaryGestureTargets"].append(route_gesture(page, 235))
            assert state(page) == at_start, "reverse swipe moved past Pay fee slide 0 edge"
            result["all13StopsForwardReverse"] = True
            result["startAndEndBounds"] = True
            result["scrollPreservedOnReturn"] = bool(main_scroll_at_pulse_app)
            if not main_scroll_at_pulse_app:
                result["limitations"].append("Pulse/App had no scrollable overflow in the fixture, so nonzero main-scroll restoration could not be demonstrated; tab/route state was verified on return.")

            # Existing button-based tab controls remain functional. Use the
            # shipped controls, observe capture(), then restore the initial stop.
            page.locator('.page-tab[data-tab="1"]').click()
            assert_step(page, "cards", 1)
            page.locator('.page-tab[data-tab="2"]').click()
            assert_step(page, "cards", 2)
            page.locator('.page-tab[data-tab="0"]').click()
            assert_step(page, "cards", 0, 0)
            result["existingTabButtons"] = True
            # Controlled overflow fixture on the real Pay Fee scrolling wrapper:
            # the layout rule survives rerender, but is never part of the APK.
            overflow_style=page.add_style_tag(content=".fee-for-you{grid-template-rows:600px 400px!important}")
            page.evaluate("document.querySelector('.fee-for-you').scrollTop=80")
            seeded_scroll=page.evaluate("document.querySelector('.fee-for-you').scrollTop")
            assert seeded_scroll==80
            route_gesture(page,-235);assert_step(page,"cards",0,1)
            route_gesture(page,235);assert_step(page,"cards",0,0)
            assert page.evaluate("document.querySelector('.fee-for-you').scrollTop")==80
            result["nonzeroNestedScrollRestored"]={"top":80,"controlledOverflowFixture":True}
            overflow_style.evaluate("el=>el.remove()")

            # Overview and Profile have real filters/tabs too; keep their chosen
            # selection across an away-and-back swipe rather than only checking route labels.
            overview_nav = page.locator('.nav-item[data-route="overview"]')
            overview_nav.click()
            overview_button_animation = page.locator('#app-main').evaluate("el => getComputedStyle(el).animationName")
            assert overview_button_animation == "none", {"buttonRoute": "overview", "animationName": overview_button_animation}
            page.locator('.page-tab[data-tab="2"]').click()
            assert state(page)["tabs"]["overview"] == 2
            assert page.locator('.page-tab[data-tab="2"]').get_attribute("aria-selected") == "true"
            overview_outbound = route_gesture(page, -235)
            assert_step(page, "likee")
            overview_return = route_gesture(page, 235)
            assert_step(page, "overview", 2)
            assert page.locator('.page-tab[data-tab="2"]').get_attribute("aria-selected") == "true"
            result["overviewFilter2Restored"] = True
            result.setdefault("additionalGestureTargets", []).extend([overview_outbound, overview_return])

            profile_nav = page.locator('.nav-item[data-route="profile"]')
            profile_nav.click()
            profile_button_animation = page.locator('#app-main').evaluate("el => getComputedStyle(el).animationName")
            assert profile_button_animation == "none", {"buttonRoute": "profile", "animationName": profile_button_animation}
            # Profile's internal Security tab is not exposed in this UI. Seed its
            # valid bridge state, then test actual swipe preservation separately.
            page.evaluate("()=>{const s=window.StemmaAndroidAppState.capture();s.tabs.profile=1;window.StemmaAndroidAppState.restore(s)}")
            result["profileTabStateSeededThroughBridgeNotVisibleControl"]=True
            assert state(page)["tabs"]["profile"] == 1
            assert page.locator('.page-tab[data-tab="1"]').get_attribute("aria-selected") == "true"
            profile_outbound = route_gesture(page, -235)
            assert_step(page, "notifications")
            profile_return = route_gesture(page, 235)
            assert_step(page, "profile", 1)
            assert page.locator('.page-tab[data-tab="1"]').get_attribute("aria-selected") == "true"
            result["profileFilter1Restored"] = True
            result["additionalGestureTargets"].extend([profile_outbound, profile_return])

            guard_results = {"inputEditor": "not found", "ownedHorizontalRail": "not found",
                             "modal": "not found", "chat": "not found", "likeeFeedVertical": False,
                             "likeeFeedHorizontalBidirectional": False}
            # Deposit form exposes a real app-owned editable input. Horizontal
            # touch beginning on the editor must not route away from Payment.
            page.locator('.nav-item[data-route="cards"]').click()
            page.locator('.page-tab[data-tab="1"]').click()
            input_locator = page.locator('#dashboard-grid input:visible, #dashboard-grid textarea:visible, #dashboard-grid [contenteditable="true"]:visible').first
            if input_locator.count():
                state_before = state(page)
                drag_between(page, input_locator, -190, 0)
                assert state(page) == state_before, "gesture starting inside an editor hijacked navigation"
                guard_results["inputEditor"] = "passed"
            page.locator('.page-tab[data-tab="0"]').click()

            # Look for a real horizontal-overflow rail in the rendered app; do
            # not fabricate DOM or assume a private swipe-guard selector.
            rail = page.locator('#dashboard-grid *').evaluate_all("""els=>els.find(el=>{
              const s=getComputedStyle(el),r=el.getBoundingClientRect();
              return r.width>100&&r.height>40&&el.clientWidth>0&&el.scrollWidth>el.clientWidth+8&&
                ['auto','scroll'].includes(s.overflowX)&&!el.closest('[hidden]');
            })""")
            if rail:
                # Locator recovery by an exact visible geometry selector avoids
                # touching content programmatically; if it cannot be recovered,
                # record a fixture limitation instead of claiming coverage.
                candidate = page.locator("#dashboard-grid *").evaluate_all("""els=>els.find(el=>{
                  const s=getComputedStyle(el),r=el.getBoundingClientRect();
                  return r.width>100&&r.height>40&&el.clientWidth>0&&el.scrollWidth>el.clientWidth+8&&
                    ['auto','scroll'].includes(s.overflowX)&&!el.closest('[hidden]');
                })""")
                if candidate:
                    box = page.evaluate("""()=>{const els=[...document.querySelectorAll('#dashboard-grid *')];
                      const el=els.find(el=>{const s=getComputedStyle(el),r=el.getBoundingClientRect();return r.width>100&&r.height>40&&el.clientWidth>0&&el.scrollWidth>el.clientWidth+8&&['auto','scroll'].includes(s.overflowX)&&!el.closest('[hidden]')});
                      if(!el)return null;const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};}""")
                    if box:
                        prior = state(page)
                        touch_gesture(page, (box["x"], box["y"]), (box["x"] - 180, box["y"]))
                        assert state(page) == prior, "owned horizontal rail gesture hijacked app navigation"
                        guard_results["ownedHorizontalRail"] = "passed"
            # Return to Profile then Notifications with real app navigation for
            # list-target return and modal/chat containment checks; fixture is read-only.
            page.locator('.nav-item[data-route="profile"]').click()
            page.wait_for_function("window.StemmaAndroidAppState.capture().route==='profile'")
            page.locator('#profile-notifications-button').click()
            page.wait_for_function("location.hash==='#notifications' && !document.getElementById('notifications-page').hidden")
            page.locator('.notification-open').first.wait_for(state="visible")
            notification_item = page.locator('.notification-open').first
            drag_between(page, notification_item, 190, 0)
            assert_step(page, "profile")
            guard_results["notificationListRightToProfile"] = "passed"
            page.locator('#profile-notifications-button').click()
            page.wait_for_function("location.hash==='#notifications' && !document.getElementById('notifications-page').hidden")
            page.locator('.notification-open').first.wait_for(state="visible")
            page.locator('.notification-open').first.click()
            dialog = page.locator('#notification-detail-dialog')
            dialog.wait_for(state="visible")
            state_before = state(page)
            drag_between(page, dialog, -170, 0)
            assert state(page) == state_before and dialog.evaluate("el=>el.open"), "modal gesture escaped its owner"
            guard_results["modal"] = "passed"
            page.locator('#notification-detail-close').click()

            # Likee retains vertical feed movement; horizontal feed gestures
            # select the adjacent route in either direction.
            page.locator('.nav-item[data-route="likee"]').click()
            page.wait_for_function("window.StemmaAndroidAppState.capture().route==='likee'")
            feed = page.locator('.likee-feed')
            feed.wait_for(state="visible")
            before = state(page)
            drag_between(page, feed, 0, -220)
            assert state(page) == before, "Likee vertical feed swipe hijacked app navigation"
            feed_touch_action = feed.evaluate("el=>getComputedStyle(el).touchAction")
            assert "pan-y" in feed_touch_action, {"LikeeVerticalTouchAction": feed_touch_action}
            guard_results["likeeFeedVertical"] = True
            drag_between(page, feed, -190, 0)
            assert_step(page, "profile")
            drag_between(page, page.locator("#app-main"), 190, 0)
            assert_step(page, "likee")
            guard_results["likeeFeedHorizontalBidirectional"] = True

            chat = page.locator('.direct-chat-panel:visible, [data-direct-chat]:visible, .pulse-chat-view:visible').first
            if chat.count():
                prior = state(page)
                drag_between(page, chat, -190, 0)
                assert state(page) == prior, "chat gesture hijacked app navigation"
                guard_results["chat"] = "passed"
            else:
                result["limitations"].append("No chat panel was mounted by the empty synthetic Pulse fixtures; chat-owner guard was not exercised.")
            # Controlled real overflow scroller verifies native horizontal
            # panning remains functional beneath the app's pan-y surfaces.
            page.evaluate("""()=>{const r=document.createElement('div');r.id='controlled-owned-rail';r.dataset.horizontalScroll='';r.style.cssText='position:fixed;left:40px;top:260px;width:300px;height:70px;overflow-x:auto;overflow-y:hidden;touch-action:pan-x pinch-zoom;z-index:9999;background:#eee';r.innerHTML='<div style="width:1200px;height:60px;background:linear-gradient(90deg,#691919,#f6e99c)">Controlled gesture-ownership fixture</div>';document.querySelector('#app-main').append(r)}""")
            before=state(page)
            touch_gesture(page,(290,290),(90,290))
            assert state(page)==before
            rail_scroll=page.evaluate("document.querySelector('#controlled-owned-rail').scrollLeft")
            assert rail_scroll>50, {"nativeRailDidNotScroll":rail_scroll}
            page.evaluate("document.querySelector('#controlled-owned-rail').remove()")
            result["controlledHorizontalRail"]={"nativeScrollLeft":rail_scroll,"routeUnchanged":True}
            controlled_owners=[]
            for owner in ['pulse-direct-chat','group-detail','channel-view']:
                page.evaluate("cls=>{const e=document.createElement('div');e.id='controlled-fullscreen-owner';e.className=cls;e.style.cssText='position:fixed;inset:100px 10px 100px;background:#eee;z-index:9999';e.textContent='Controlled fullscreen gesture owner';document.body.append(e)}",owner)
                before=state(page);touch_gesture(page,(290,340),(90,340));assert state(page)==before
                page.evaluate("document.querySelector('#controlled-fullscreen-owner').remove()")
                controlled_owners.append(owner)
            result["controlledFullscreenOwnerGuards"]=controlled_owners
            motion=page.evaluate("()=>({transition:getComputedStyle(document.querySelector('#app-main')).transitionDuration,transform:getComputedStyle(document.querySelector('#app-main')).transform,swipeCss:!!document.querySelector('style')?.textContent?.includes('android-swipe-ease')})")
            assert motion["transform"] in ("none", "matrix(1, 0, 0, 1, 0, 0)"), motion
            assert not motion["swipeCss"], motion
            result["swipeVisualMotion"] = motion
            result["guardCases"] = guard_results
            result["noSwipeWritesGalleryReadsOrQueueReplay"] = assert_no_swipe_side_effects(page, "completed gesture suite")
            assert not external_requests, f"external resource/network request attempted: {external_requests}"
            result["externalRequests"] = external_requests
            result["apiRequests"] = API_REQUESTS
            result["browserErrors"] = errors
            assert not errors, errors
            result["status"] = "passed"
            result["screenshot"] = str(SCREENSHOT_PATH)
            result["videoDirectory"] = str(PREVIEW_DIR)
            result["videoPath"]=str(page.video.path())
            result["videoCaveat"] = "Playwright records a browser viewport demo; this is synthetic-data Chromium output, not a physical-phone recording."
            context.close()  # finalizes the .webm recording
            context = None
            browser.close()
            browser = None
    except Exception as error:
        result["status"] = "failed"
        result["error"] = f"{type(error).__name__}: {error}"
        result["apiRequests"] = API_REQUESTS
        raise
    finally:
        if context:
            try:
                context.close()
            except Exception:
                pass
        if browser:
            try:
                browser.close()
            except Exception:
                pass
        server.shutdown()
        RESULT_PATH.write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
