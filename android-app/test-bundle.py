from pathlib import Path
import json
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parent
INIT=r'''(() => {
const realFetch=window.fetch.bind(window);
window.__calls=[];window.__prefs={};window.__files={};window.__persistent={};
window.androidBridge={};
const methods={StemmaPersistence:['load','save','remove','flushCookies','setSessionActive'],App:['addListener','removeListener','getLaunchUrl','minimizeApp'],Browser:['open','close'],Network:['getStatus','addListener','removeListener'],Filesystem:['readFile','writeFile','deleteFile'],Preferences:['get','set','remove'],StemmaTransport:['request','clearPrivateCache','upload','cancelUpload','addListener','removeListener'],StemmaMedia:['getAccess','requestAccess','requestFileAccess','listFiles','readStorageFile','capturePhoto','listAlbums','listMedia','thumbnail','readFile','recentFiles']};
window.Capacitor={PluginHeaders:Object.entries(methods).map(([name,methods])=>({name,methods:methods.map(name=>({name,rtype:name==='addListener'?'callback':'promise'}))})),nativeCallback:()=> 'test-callback',nativePromise:async(name,method,options={})=>{
window.__calls.push({name,method,options});
if(name==='StemmaPersistence'){if(method==='load')return {value:window.__persistent[options.key]??null};if(method==='save')window.__persistent[options.key]=options.value;if(method==='remove')delete window.__persistent[options.key];return {};}
if(name==='StemmaTransport' && method==='request')return {status:options.url.endsWith('/auth/logout')?204:200,body:'{"ok":true}',contentType:'application/json'};
if(name==='Network' && method==='getStatus')return {connected:true,connectionType:'wifi'};
if(name==='App' && method==='getLaunchUrl')return {};
if(name==='Filesystem') {if(method==='readFile'){if(!(options.path in window.__files))throw new Error('not found');return {data:window.__files[options.path]};}if(method==='writeFile'){window.__files[options.path]=options.data;return {};}if(method==='deleteFile'){delete window.__files[options.path];return {};}}
if(name==='Preferences'){if(method==='get')return {value:window.__prefs[options.key]??null};if(method==='set')window.__prefs[options.key]=options.value;if(method==='remove')delete window.__prefs[options.key];return {};}
if(name==='StemmaMedia'){
if(method==='getAccess'||method==='requestAccess')return {status:'granted',mediaAccess:true,fileAccess:false,granted:true,fullAccess:true,partial:false};
if(method==='listAlbums')return {albums:[{id:'camera',name:'Camera',count:2},{id:'screenshots',name:'Screenshots',count:1}]};
if(method==='listMedia')return {items:[{id:'1',name:'camera.jpg',mimeType:'image/jpeg',size:128,uri:'content://media/external/images/media/1'}],hasMore:false};
if(method==='thumbnail')return {webPath:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>'};
if(method==='readFile')return {webPath:'/assets/profile.jpg',path:'/data/user/0/app.stemma.mobile/cache/stemma-media/copy_test.jpg',name:'camera.jpg',mimeType:'image/jpeg'};
if(method==='recentFiles')return {files:[]};
}
return {};
}};
window.fetch=async(input,init={})=>{
const url=new URL(typeof input==='string'?input:input.url,location.href);
if(url.origin==='https://stemma.wasmer.app'){
if(window.__failNetwork)throw new TypeError('network unavailable');
let data={};
if(url.pathname==='/auth/session')data=window.__testSession || {authenticated:false,googleConfigured:true,faydaConfigured:false};
else if(url.pathname.startsWith('/api/likee'))data={videos:[],profile:null};
else if(url.pathname.includes('attendance'))data={students:[],attendance:[],authenticated:false};
else data={threads:[],stories:[],groups:[],channels:[],notifications:[]};
return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
}
return realFetch(input,init);
};
})();'''
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 context=browser.new_context(viewport={'width':390,'height':844})
 context.add_init_script(INIT)
 page=context.new_page();errors=[]
 page.on('pageerror',lambda e:errors.append(str(e)))
 response=page.goto('http://127.0.0.1:8972/',wait_until='networkidle')
 page.wait_for_function('window.StemmaNative && window.StemmaChatAttachments')
 assert page.title()=='Welcome to Stemma'
 assert page.get_by_role('button',name='Skip',exact=True).is_visible()
 page.get_by_role('button',name='Skip',exact=True).click()
 page.wait_for_timeout(300)
 assert not page.locator('#stemma-offline-status').is_visible()
 requests=page.evaluate('performance.getEntriesByType("resource").map(r=>r.name)')
 assert all('127.0.0.1:8972' in u or u.startswith('data:') for u in requests),requests
 page.evaluate('window.dispatchEvent(new Event("offline"))')
 assert page.locator('#stemma-offline-status').is_visible()
 result=page.evaluate('''async()=>{try{await fetch('/api/student-profile',{method:'POST',body:'{}'});return 'incorrect';}catch(e){return e.message;}}''')
 assert 'offline' in result.lower()
 page.evaluate('window.dispatchEvent(new Event("online"))')
 assert not page.locator('#stemma-offline-status').is_visible()
 page.evaluate('''()=>window.StemmaChatAttachments.pickMedia({button:document.querySelector('button'),galleryOnly:true,onSelect:file=>window.__picked={name:file.name,size:file.size,nativePath:file.nativePath}})''')
 page.locator('select[aria-label="Choose album"]').wait_for(state='visible')
 page.locator('.native-gallery-tile').first.wait_for()
 assert page.locator('select[aria-label="Choose album"] option').count()==3
 page.locator('select[aria-label="Choose album"]').select_option('camera')
 page.get_by_role('button',name='Select camera.jpg',exact=True).click()
 page.get_by_role('button',name='Use media',exact=True).click()
 page.locator('.native-picker-review').wait_for(state='visible')
 page.get_by_role('button',name='Use media',exact=True).click()
 page.wait_for_function('window.__picked')
 picked=page.evaluate('window.__picked')
 assert picked['name']=='camera.jpg' and picked['size']>0 and 'stemma-media' in picked['nativePath']
 page.evaluate('''async()=>{await window.StemmaNative.signIn('google');const call=window.__calls.findLast(c=>c.name==='Browser'&&c.method==='open');const url=new URL(call.options.url);if(url.searchParams.get('state').length!==43||url.searchParams.get('challenge').length!==43)throw Error('bad OAuth state');}''')
 cache_result=page.evaluate('''async()=>{
 window.__testSession={authenticated:true,authProvider:'google',googleProfile:{email:'alice@example.invalid'}};
 await fetch('/auth/session');await fetch('/api/pulse/mobile-cache-fixture');await new Promise(r=>setTimeout(r,650));
 await window.StemmaNative.flush();if(JSON.parse(window.__persistent['response-index-v2']).account!=='alice@example.invalid')throw Error('not persisted');
 window.dispatchEvent(new Event('offline'));
 const saved=await fetch('/api/pulse/mobile-cache-fixture');if(saved.headers.get('X-Stemma-Offline')!=='true')throw Error('not cached');
 window.dispatchEvent(new Event('online'));
 window.__testSession={authenticated:true,authProvider:'google',googleProfile:{email:'bob@example.invalid'}};await fetch('/auth/session');
 window.dispatchEvent(new Event('offline'));let isolated=false;try{await fetch('/api/pulse/mobile-cache-fixture');}catch{isolated=true;}if(!isolated)throw Error('cross account data');
 window.dispatchEvent(new Event('online'));const posted=await fetch('/api/student-profile',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"synthetic":true}'});if(!posted.ok)throw Error('native post failed');
 const call=window.__calls.findLast(c=>c.name==='StemmaTransport'&&c.method==='request');if(call.options.url!=='https://stemma.wasmer.app/api/student-profile')throw Error('bad native URL');
 await fetch('/auth/logout',{method:'POST'});if(Object.keys(window.__files).length||Object.keys(window.__persistent).some(k=>k.startsWith('response-')))throw Error('cache survived logout');return true;
 }''')
 assert cache_result
 page.goto('http://127.0.0.1:8972/system-apps/attendance/index.html',wait_until='networkidle')
 page.wait_for_function('window.StemmaNative')
 assert page.title()=='Teacher Attendance'
 assert page.get_by_role('heading',name='Teacher Attendance',exact=True).is_visible()
 assert not errors,errors
 output={'bundledShellStarts':True,'allShellResourcesLocal':True,'offlineBannerOnlyWhenOffline':True,'offlineWritesRejected':True,'nativeGalleryAlbumsAndSelection':True,'oauthStatePkceLengths':True,'privateCachePersistedAndAccountIsolated':True,'nativeMutationTransport':True,'logoutClearsCache':True,'bundledAttendanceStarts':True,'browserErrors':errors,'resourceCount':len(requests)}
 (ROOT/'bundle-smoke-results.json').write_text(json.dumps(output,indent=2)+'\n')
 print(json.dumps(output,indent=2))
 browser.close()
