from pathlib import Path
import ast, json
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parent
module=ast.parse((ROOT/'test-bundle.py').read_text())
INIT=next(ast.literal_eval(n.value) for n in module.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='INIT' for t in n.targets))
INIT=INIT.replace('window.__persistent={};',"window.__persistent=JSON.parse(localStorage.getItem('__nativeTestDisk')||'{}');window.__testOfflineBootstrap=localStorage.getItem('__offlineBoot')==='true';")
INIT=INIT.replace("if(method==='remove')delete window.__persistent[options.key];return {};", "if(method==='remove')delete window.__persistent[options.key];localStorage.setItem('__nativeTestDisk',JSON.stringify(window.__persistent));return {};")
INIT=INIT.replace("return {connected:true,connectionType:'wifi'};", "return {connected:!window.__testOfflineBootstrap,connectionType:'wifi'};")
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 context=browser.new_context(viewport={'width':390,'height':844});context.add_init_script(INIT)
 page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto('http://127.0.0.1:8972/',wait_until='networkidle');page.wait_for_function('window.StemmaNative && window.StemmaChatAttachments')
 page.evaluate('''async()=>{
 window.__testSession={authenticated:true,authProvider:'google',googleProfile:{email:'alice@example.invalid'}};
 await fetch('/auth/session');await fetch('/api/pulse/cold-restart-fixture');
 const box=document.createElement('div');box.dataset.nativeDraftScope='direct:fixture';box.innerHTML='<textarea id="native-test-draft"></textarea>';document.body.append(box);
 const input=box.firstElementChild;input.value='Keep my unsent message';input.dispatchEvent(new Event('input',{bubbles:true}));
 window.dispatchEvent(new Event('stemma:checkpoint'));await window.StemmaNative.flush();
 if(!window.__persistent['drafts-v2'])throw Error('draft not durable');
 localStorage.setItem('__offlineBoot','true');
 }''')
 page.reload(wait_until='networkidle');page.wait_for_function('window.StemmaNative && window.StemmaChatAttachments')
 page.evaluate('''async()=>{
 await window.StemmaNative.ready;
 if(window.StemmaNative.connected)throw Error('not offline bootstrap');
 if(window.StemmaNative.account!=='alice@example.invalid')throw Error('cold account not restored');
 const session=await fetch('/auth/session');if(session.headers.get('X-Stemma-Offline')!=='true')throw Error('offline session missing');
 const cached=await fetch('/api/pulse/cold-restart-fixture');if(cached.headers.get('X-Stemma-Offline')!=='true')throw Error('cold disk read missing');
 const box=document.createElement('div');box.dataset.nativeDraftScope='direct:fixture';box.innerHTML='<textarea id="native-test-draft"></textarea>';document.body.append(box);box.firstElementChild.focus();
 }''')
 page.wait_for_function("document.querySelector('#native-test-draft').value==='Keep my unsent message'")
 page.evaluate('''async()=>{
 window.dispatchEvent(new Event('online'));
 window.__testSession={authenticated:true,authProvider:'google',googleProfile:{email:'bob@example.invalid'}};await fetch('/auth/session');
 window.dispatchEvent(new Event('offline'));let blocked=false;try{await fetch('/api/pulse/cold-restart-fixture');}catch{blocked=true;}if(!blocked)throw Error('cross account cache leak');
 const box=document.createElement('div');box.dataset.nativeDraftScope='direct:fixture';box.innerHTML='<textarea id="new-account-draft"></textarea>';document.body.append(box);box.firstElementChild.focus();
 }''')
 page.wait_for_timeout(150);assert page.locator('#new-account-draft').input_value()==''
 page.evaluate('''async()=>{window.dispatchEvent(new Event('online'));await fetch('/auth/logout',{method:'POST'});await window.StemmaNative.flush();if(window.__persistent['drafts-v2']||Object.keys(window.__persistent).some(k=>k.startsWith('response-')))throw Error('private cache survived logout');}''')
 assert not errors,errors
 result={'coldRestartOfflineSession':True,'coldRestartDiskResponses':True,'draftCheckpointSurvivesReload':True,'draftAccountIsolation':True,'cacheAccountIsolation':True,'logoutPurgesDurablePrivateData':True,'browserErrors':errors}
 (ROOT/'runtime-persistence-results.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2));browser.close()
