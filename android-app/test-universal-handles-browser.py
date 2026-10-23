"""Local-only synthetic Android username regression; no live account requests."""
from pathlib import Path
import importlib.util
import json
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('ui_fixture', ROOT / 'test-ui-107.py')
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
BASE = 'http://127.0.0.1:8972'
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
    context = browser.new_context(viewport={'width':390,'height':844}, is_mobile=True, has_touch=True)
    context.add_init_script(fixture.INIT)
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.route('**/*', lambda route: route.continue_() if route.request.url.startswith(BASE) or route.request.url.startswith('data:') else route.abort())
    page.goto(BASE + '/', wait_until='networkidle')
    page.wait_for_function('window.StemmaAndroidAppState?.isAuthenticated?.() === true', timeout=15000)
    page.evaluate("""() => {
      window.__usernamePayloads = [];
      const original = window.fetch;
      const channel = {id:'77',identityId:'19795538-51ae-47ce-9cd1-3dfcd956ff59',uuid:'19795538-51ae-47ce-9cd1-3dfcd956ff59',username:'mixed_handle',name:'Handle Fixture',isOwner:true,subscriberCount:0,isSubscribed:false,muted:false,createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z'};
      window.fetch = async (input, options = {}) => {
        const url = new URL(typeof input === 'string' ? input : input.url, location.href);
        let body;
        if (url.pathname === '/api/pulse/channels' && options.method === 'POST') {
          window.__usernamePayloads.push(JSON.parse(options.body)); body = {channel};
        } else if (url.pathname === '/api/pulse/channels') body = {channels:[]};
        else if (url.pathname.startsWith('/api/pulse/channels/')) body = url.pathname.endsWith('/posts') ? {posts:[],hasMore:false} : {channel};
        if (body) return new Response(JSON.stringify(body), {status:200,headers:{'Content-Type':'application/json'}});
        return original(input, options);
      };
    }""")
    page.locator('.nav-item[data-route="pulse"]').click()
    page.wait_for_function("window.StemmaAndroidAppState.capture().route === 'pulse'")
    page.evaluate("""() => {
      const trigger = document.querySelector('[data-channel-create]');
      if (trigger) trigger.click();
      else { const shell = document.querySelector('.channel-dialog')?.closest('.pulse-panel') || document.querySelector('.channel-dialog')?.parentElement; const opener = shell?.querySelector('[data-channel-new]'); if (!opener) throw Error('Channel creation trigger missing'); opener.click(); }
    }""")
    dialog = page.locator('.channel-dialog[open]')
    dialog.wait_for(state='visible')
    username = dialog.locator('input[name="username"]')
    assert username.get_attribute('minlength') == '5'
    dialog.locator('input[name="name"]').fill('Handle Fixture')
    username.fill('abcd')
    assert username.evaluate('(input) => input.validity.tooShort || input.validity.patternMismatch')
    dialog.locator('button[type="submit"]').click()
    assert page.evaluate('window.__usernamePayloads.length') == 0
    username.fill('MiXeD_Handle')
    dialog.locator('button[type="submit"]').click()
    page.wait_for_function('window.__usernamePayloads.length === 1')
    assert page.evaluate('window.__usernamePayloads[0]') == {'name':'Handle Fixture','username':'mixed_handle'}
    page.locator('[data-channel-handle]').filter(has_text='@mixed_handle').wait_for(state='visible')
    assert not errors, errors
    result = {'minimumFiveCharacters':True,'shortNameBlockedWithoutRequest':True,'uppercaseCanonicalized':True,'readableHandleDisplayed':True,'syntheticLocalOnly':True,'pageErrors':errors}
    Path('/workspace/stemma-delivery/Stemma-1.0.9-username-browser-results.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result,indent=2))
    browser.close()
