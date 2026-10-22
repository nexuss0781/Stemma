from __future__ import annotations

import ast
import json
import os
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent
WWW = Path(os.environ.get("STEMMA_UI_TEST_WWW", str(ROOT / "www")))
PORT = int(os.environ.get("STEMMA_UI_TEST_PORT", "8991"))
BASE_URL = f"http://127.0.0.1:{PORT}"
DELIVERY = Path("/workspace/stemma-delivery")
PULSE_SCREENSHOT = DELIVERY / "Stemma-1.0.7-pulse-preview.png"
DRAWER_SCREENSHOT = DELIVERY / "Stemma-1.0.7-drawer-preview.png"

# Reuse the known Capacitor/native mocks as Python syntax only. All app data is
# deterministic and synthetic; browser requests to non-local origins are blocked.
bundle_ast = ast.parse((ROOT / "test-bundle.py").read_text())
INIT = next(
    ast.literal_eval(node.value)
    for node in bundle_ast.body
    if isinstance(node, ast.Assign)
    and any(isinstance(target, ast.Name) and target.id == "INIT" for target in node.targets)
)
SESSION_DEFAULT = "window.__testSession || {authenticated:false,googleConfigured:true,faydaConfigured:false}"
assert SESSION_DEFAULT in INIT, "test-bundle auth mock changed; update the test extension point"
INIT = INIT.replace(
    SESSION_DEFAULT,
    "window.__testSession || {authenticated:true,authProvider:'google',googleConfigured:true,faydaConfigured:false,googleProfile:{email:'ui-107@example.invalid',name:'Synthetic UI Student'}}",
    1,
)
assert "let data={};" in INIT
INIT = INIT.replace(
    "else if(url.pathname.startsWith('/api/likee'))",
    "else if(url.pathname==='/api/student-profile')data={profile:{firstName:'Synthetic',middleName:'UI',lastName:'Student',studentId:'TEST-UI-107',department:'Computing',nickName:'Synthetic Student',username:'ui_fixture_107',bio:'Synthetic UI fixture'}};else if(url.pathname.startsWith('/api/likee'))",
    1,
)


class QuietHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WWW), **kwargs)

    def log_message(self, _format, *_args):
        pass


def start_server():
    server = ThreadingHTTPServer(("0.0.0.0", PORT), QuietHandler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def css_asset_path() -> Path:
    html = (WWW / "index.html").read_text()
    import re

    match = re.search(r'<link rel="stylesheet" href="([^"]+\.css)', html)
    assert match, "bundled app stylesheet link missing"
    return WWW / match.group(1).lstrip("/")


def assert_avatar_css_contract(css_text: str):
    import re

    # The patch is one tightly scoped rule and introduces no literal/new color
    # tokens, dimensions, layout, geometry, effects, or unrelated selectors.
    rules = re.findall(r"([^{}]+)\{([^{}]*)\}", css_text)
    matches = [(selector.strip(), body.strip()) for selector, body in rules
               if "#navigation-drawer .drawer-profile-avatar-fallback" in selector
               and "#app-shell .pulse-person-mark" in selector]
    assert len(matches) == 1, f"expected one scoped avatar rule, found {matches}"
    selector, body = matches[0]
    normalized_selector = re.sub(r"\s+", "", selector)
    expected_selector = re.sub(r"\s+", "", (
        "#app-shell .pulse-person-mark:not(.pulse-peer-photo-avatar):not(:has(img)),"
        "#navigation-drawer .drawer-profile-avatar-fallback"
    ))
    assert normalized_selector == expected_selector, selector
    declarations = [item.strip() for item in body.split(";") if item.strip()]
    assert declarations == ["background:var(--brand-burgundy)", "color:var(--brand-gold)"], declarations
    assert "#" not in body and "rgb(" not in body and "hsl(" not in body, body
    return {"selector": selector, "declarations": declarations}


def main():
    assert WWW.is_dir() and (WWW / "index.html").is_file(), f"APK/web assets missing: {WWW}"
    css_contract = assert_avatar_css_contract(css_asset_path().read_text())
    DELIVERY.mkdir(parents=True, exist_ok=True)
    server = start_server()
    errors: list[str] = []
    result = {"assetRoot": str(WWW), "fixture": "synthetic local-only UI student; no live account/network"}
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(
                executable_path=os.environ.get("CHROMIUM_PATH", "/usr/bin/chromium"),
                headless=True,
                args=["--no-sandbox"],
            )
            context = browser.new_context(
                viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True
            )
            context.add_init_script(INIT)
            page = context.new_page()
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.route(
                "**/*",
                lambda route: route.continue_()
                if route.request.url.startswith(BASE_URL) or route.request.url.startswith("data:")
                else route.abort(),
            )
            response = page.goto(BASE_URL + "/", wait_until="networkidle")
            assert response and response.ok, "bundled APK app shell failed to load"
            page.wait_for_function("window.StemmaAndroidAppState?.isAuthenticated?.() === true", timeout=15000)
            page.wait_for_function("!document.getElementById('onboarding-screen') || document.getElementById('onboarding-screen').hidden", timeout=15000)
            page.wait_for_function("document.querySelector('#bottom-nav .nav-item[data-route=profile]')")

            bottom_order = page.locator("#bottom-nav [data-route]").evaluate_all("items=>items.map(e=>e.dataset.route)")
            expected_bottom = ["cards", "pulse", "overview", "likee", "profile"]
            assert bottom_order == expected_bottom, {"bottomNav": bottom_order, "expectedUnchanged": expected_bottom}

            # Sample the initial drawer footer skeleton's stylesheet appearance
            # (before toggling its authenticated/profile state), without changing it.
            initial_footer = page.evaluate("""()=>{
              const e=document.querySelector('#drawer-profile-placeholder');
              if(!e)return {missing:true};
              const hidden=e.hidden;e.hidden=false;
              const s=getComputedStyle(e),avatar=e.querySelector('.drawer-avatar-skeleton'),line=e.querySelector('.drawer-foot-line');
              const a=avatar?getComputedStyle(avatar):null,l=line?getComputedStyle(line):null;
              const out={display:s.display,position:s.position,minHeight:s.minHeight,padding:s.padding,
                gap:s.gap,avatarDisplay:a?.display||null,avatarWidth:a?.width||null,avatarHeight:a?.height||null,
                lineWidth:l?.width||null,lineHeight:l?.height||null,lineBackground:line?getComputedStyle(line,'::after').backgroundColor:null};
              e.hidden=hidden;return out;
            }""")
            assert not initial_footer.get("missing") and initial_footer["display"] != "none", initial_footer

            page.locator("#menu-trigger").click()
            drawer = page.locator("#navigation-drawer")
            drawer.wait_for(state="visible")
            drawer_order = page.locator("#drawer-links [data-route]").evaluate_all("items=>items.map(e=>e.dataset.route)")
            expected_drawer = ["overview", "profile", "cards", "pulse", "likee"]
            assert drawer_order == expected_drawer, {"drawer": drawer_order, "expected": expected_drawer}
            assert page.locator("#drawer-profile").is_visible(), "authenticated drawer footer profile did not render"
            drawer_avatar = page.locator("#drawer-profile-avatar-fallback")
            drawer_avatar.wait_for(state="visible")
            colors = page.evaluate("""()=>{
              const root=getComputedStyle(document.documentElement);
              const burgundy=root.getPropertyValue('--brand-burgundy').trim();
              const gold=root.getPropertyValue('--brand-gold').trim();
              const e=document.querySelector('#drawer-profile-avatar-fallback'),s=getComputedStyle(e);
              const probe=document.createElement('span');probe.style.cssText='position:absolute;background:var(--brand-burgundy);color:var(--brand-gold)';
              document.body.append(probe);const expected={background:getComputedStyle(probe).backgroundColor,color:getComputedStyle(probe).color};probe.remove();
              return {vars:{burgundy,gold},expected,actual:{background:s.backgroundColor,color:s.color}};
            }""")
            assert colors["actual"] == colors["expected"], colors
            page.screenshot(path=str(DRAWER_SCREENSHOT), full_page=False)

            # Clicking the relocated Profile item must still navigate correctly.
            page.locator('#drawer-links [data-route="profile"]').click()
            page.locator('#dashboard-grid[aria-label="Your profile"]').wait_for(state="visible")
            assert page.locator('.nav-item[data-route="profile"]').get_attribute("aria-current") == "page"
            assert page.locator("#bottom-nav [data-route]").evaluate_all("items=>items.map(e=>e.dataset.route)") == expected_bottom

            # Real app CSS is exercised against four explicitly synthetic Pulse
            # placeholder cases plus photo-backed avatars in actual Pulse row markup.
            # The host is test-only and never written into APK assets.
            page.locator('.nav-item[data-route="pulse"]').click()
            page.wait_for_function("window.StemmaAndroidAppState.capture().route==='pulse'")
            page.evaluate("""()=>{
              const shell=document.querySelector('#pulse-panel-0');
              const host=document.createElement('section');host.id='ui-107-pulse-fixtures';
              host.setAttribute('aria-label','Synthetic Pulse avatar fixture preview');
              host.className='pulse-conversations pulse-unified-list';
              const title=document.createElement('strong');title.textContent='Synthetic Pulse avatar fixtures';host.append(title);
              const cases=[['Direct, no photo','pulse-direct-no-photo'],['Saved, no photo','pulse-saved-no-photo'],['Group, no photo','pulse-group-no-photo'],['Channel, no photo','pulse-channel-no-photo']];
              for(const [label,kind] of cases){const row=document.createElement('button');row.type='button';row.className='pulse-conversation pulse-direct-row'+(kind.includes('saved')?' pulse-saved-row':'')+(kind.includes('group')?' pulse-group-row':'')+(kind.includes('channel')?' pulse-channel-row':'');
                const avatar=document.createElement('span');avatar.className='pulse-person-mark';avatar.dataset.ui107Fixture=kind;avatar.setAttribute('aria-label',label);avatar.textContent=label[0];
                const text=document.createElement('span');text.className='pulse-copy';const name=document.createElement('strong');name.textContent=label;text.append(name);row.append(avatar,text);host.append(row);}
              const photo=document.createElement('span');photo.className='pulse-person-mark pulse-peer-photo-avatar';photo.dataset.ui107Fixture='photo-avatar';photo.style.cssText='width:44px;height:44px;overflow:hidden;position:relative';
              const img=document.createElement('img');img.alt='Synthetic photo avatar';img.width=12;img.height=12;img.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2212%22 height=%2212%22%3E%3Crect width=%2212%22 height=%2212%22 fill=%22%2300a0ff%22/%3E%3C/svg%3E';
              img.style.cssText='position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:inherit';photo.append(img);
              const actualPhoto=document.createElement('span');actualPhoto.className='pulse-person-mark';actualPhoto.dataset.ui107Fixture='has-image-avatar';actualPhoto.style.cssText='width:44px;height:44px;flex:0 0 44px;overflow:hidden;position:relative';
              const img2=img.cloneNode();img2.dataset.ui107FixtureImage='yes';actualPhoto.append(img2);
              const photoRow=document.createElement('div');photoRow.style.cssText='grid-column:1 / -1;display:flex;align-items:center;gap:9px';
              photoRow.append(photo,actualPhoto);const note=document.createElement('span');note.textContent='Photo avatars (untouched)';photoRow.append(note);host.append(photoRow);
              shell.replaceChildren(host);
            }""")
            page.locator("#ui-107-pulse-fixtures").wait_for(state="visible")
            avatar_eval = page.evaluate("""()=>{
              const root=getComputedStyle(document.documentElement);
              const probe=document.createElement('span');probe.style.cssText='position:absolute;background:var(--brand-burgundy);color:var(--brand-gold)';
              document.body.append(probe);const expected={background:getComputedStyle(probe).backgroundColor,color:getComputedStyle(probe).color};probe.remove();
              const placeholders=[...document.querySelectorAll('[data-ui107-fixture$="no-photo"]')];
              const photos=[...document.querySelectorAll('[data-ui107-fixture="photo-avatar"],[data-ui107-fixture="has-image-avatar"]')];
              const selectors=[...document.styleSheets].flatMap(sheet=>{try{return [...sheet.cssRules]}catch{return []}})
                .filter(r=>r.selectorText?.includes('#app-shell .pulse-person-mark')&&r.selectorText?.includes(':has(img)'))
                .map(r=>r.selectorText);
              const ruleMatches=(el)=>selectors.some(selector=>selector.split(',').some(part=>{try{return el.matches(part.trim())}catch{return false}}));
              return {expected,placeholders:placeholders.map(e=>({kind:e.dataset.ui107Fixture,bg:getComputedStyle(e).backgroundColor,color:getComputedStyle(e).color,ruleMatches:ruleMatches(e)})),
                photos:photos.map(e=>({kind:e.dataset.ui107Fixture,bg:getComputedStyle(e).backgroundColor,color:getComputedStyle(e).color,ruleMatches:ruleMatches(e),
                  imageSrc:e.querySelector('img')?.getAttribute('src'),imageWidth:e.querySelector('img')?.getBoundingClientRect().width,
                  imageHeight:e.querySelector('img')?.getBoundingClientRect().height,imageFit:getComputedStyle(e.querySelector('img')).objectFit,imageComplete:e.querySelector('img')?.complete}))};
            }""")
            assert len(avatar_eval["placeholders"]) == 4, avatar_eval
            for avatar in avatar_eval["placeholders"]:
                assert avatar["bg"] == avatar_eval["expected"]["background"] and avatar["color"] == avatar_eval["expected"]["color"], avatar
                assert avatar["ruleMatches"], avatar
            assert len(avatar_eval["photos"]) == 2, avatar_eval
            for avatar in avatar_eval["photos"]:
                assert not avatar["ruleMatches"], avatar
                assert avatar["imageSrc"].startswith("data:image/svg+xml,") and avatar["imageComplete"], avatar
                assert avatar["imageWidth"] > 0 and avatar["imageHeight"] > 0 and avatar["imageFit"] == "cover", avatar
            page.screenshot(path=str(PULSE_SCREENSHOT), full_page=False)
            assert not errors, errors
            result.update({
                "status": "PASS",
                "drawerOrder": drawer_order,
                "profileDrawerClickWorks": True,
                "bottomNavUnchanged": bottom_order,
                "drawerFooterInitialStyle": initial_footer,
                "drawerFallbackColors": colors,
                "pulsePlaceholderCases": [item["kind"] for item in avatar_eval["placeholders"]],
                "photoAvatarExclusionsAndRendering": avatar_eval["photos"],
                "cssContract": css_contract,
                "screenshots": [str(PULSE_SCREENSHOT), str(DRAWER_SCREENSHOT)],
                "pageErrors": errors,
                "liveNetworkUsed": False,
            })
            print(json.dumps(result, indent=2))
            context.close()
            browser.close()
    finally:
        server.shutdown()


if __name__ == "__main__":
    main()
