from pathlib import Path
import ast,json
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parent
module=ast.parse((ROOT/'test-bundle.py').read_text())
INIT=next(ast.literal_eval(n.value) for n in module.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='INIT' for t in n.targets))
INIT=INIT.replace('window.__persistent={};',"window.__persistent=JSON.parse(localStorage.getItem('__navigationDisk')||'{}');")
INIT=INIT.replace("if(method==='remove')delete window.__persistent[options.key];return {};", "if(method==='remove')delete window.__persistent[options.key];localStorage.setItem('__navigationDisk',JSON.stringify(window.__persistent));return {};")
INIT=INIT.replace("window.__testSession || {authenticated:false,googleConfigured:true,faydaConfigured:false}","{authenticated:true,authProvider:'google',googleConfigured:true,googleProfile:{email:'nav@example.invalid',name:'Test Student'}}")
INIT=INIT.replace("else if(url.pathname.startsWith('/api/likee'))", "else if(url.pathname==='/api/student-profile')data={profile:{firstName:'Test',middleName:'Middle',lastName:'Student',studentId:'TEST-102',department:'Computing',nickName:'Tester',username:'test_native',bio:''}};else if(url.pathname==='/api/student-profile/photo')return new Response(null,{status:404});else if(url.pathname.startsWith('/api/likee'))")
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 context=browser.new_context(viewport={'width':390,'height':844});context.add_init_script(INIT)
 page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto('http://127.0.0.1:8972/',wait_until='networkidle')
 page.wait_for_function('window.StemmaAndroidAppState?.isAuthenticated() && window.StemmaAndroidNavigation?.accountReady')
 page.evaluate('''async()=>{if(!window.StemmaAndroidAppState.restore({route:'profile',tabs:{profile:1,cards:2,pulse:3,overview:2},paymentSlide:1}))throw Error('state hook rejected');await window.StemmaAndroidNavigation.persist();await window.StemmaNative.flush();}''')
 page.goto('http://127.0.0.1:8972/',wait_until='networkidle');page.wait_for_function("window.StemmaAndroidAppState?.capture().route==='profile' && window.StemmaAndroidAppState.capture().tabs.profile===1")
 state=page.evaluate('window.StemmaAndroidAppState.capture()');assert state['tabs']['cards']==2 and state['tabs']['pulse']==3 and state['tabs']['overview']==2,state
 assert state['paymentSlide']==1,state
 assert page.locator('.nav-item[data-route="profile"]').get_attribute('aria-current')=='page'
 assert page.locator('.page-tab[data-tab="1"]').get_attribute('aria-selected')=='true'
 assert not errors,errors
 result={'signedInAppBoot':True,'allParentSubtabsSurviveReload':True,'activeTabMatchesRestoredState':True,'paymentSlideSurvivesReload':True,'browserErrors':errors}
 (ROOT/'navigation-browser-results.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2));browser.close()
