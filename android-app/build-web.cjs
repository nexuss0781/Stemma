const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const esbuild=require('esbuild');
const source=path.resolve(process.env.STEMMA_WEB_SOURCE || path.join(__dirname,'..'));
const out=path.join(__dirname,'www');
	const hash=text=>crypto.createHash('sha256').update(text).digest('hex').slice(0,12);
	async function writeHashed(stem,ext,text){const name=`${stem}.${hash(text)}.${ext}`;await fs.writeFile(path.join(out,name),text);return name;}
	function replaceOnce(code,needle,replacement,label){const first=code.indexOf(needle);if(first<0||code.indexOf(needle,first+needle.length)>=0)throw new Error(`Android navigation transform anchor missing or ambiguous: ${label}`);return code.slice(0,first)+replacement+code.slice(first+needle.length);}
	function nativeNavigationTransform(file,code){
	 if(file==='/app.js'){
	  code=replaceOnce(code,'    refreshProfileIfVisible();\n  }\n}\n\nvoid restoreAuthenticationState();','    refreshProfileIfVisible();\n    window.dispatchEvent(new CustomEvent(\'stemma:android-app-auth-ready\',{detail:{authenticated:Boolean(googleAuthenticated&&dashboardEntered)}}));\n  }\n}\n\nvoid restoreAuthenticationState();','app auth-ready');
	  const tail='// Authenticated account memory is restored only after /auth/session confirms its owner.\n// A stale hash from a different account must never select its initial screen.\nrender();';
	  code=replaceOnce(code,tail,tail+'\nwindow.StemmaAndroidAppState=Object.freeze({isAuthenticated:()=>Boolean(googleAuthenticated&&dashboardEntered),capture:()=>({route:activeRoute,tabs:{...activeTabs},paymentSlide:paymentSlideIndex}),restore(state){if(!googleAuthenticated||!dashboardEntered||!state||!pageTabs[state.route])return false;activeRoute=state.route;for(const route of Object.keys(activeTabs)){const value=state.tabs?.[route];if(Number.isInteger(value))activeTabs[route]=Math.max(0,Math.min((pageTabs[route]||[]).length-1,value));}paymentSlideIndex=state.paymentSlide===1?1:0;routeDirection=0;window.StemmaParentNavigation?.reset();render();return true;}});\n','app state bridge');
	 }
	 if(file==='/pulse-ui.js'){
	  code=replaceOnce(code,'    cleanup = () => { searchTrigger?.setAttribute(\'aria-expanded\', \'false\'); abort.abort(); clearTimeout(wheelTimer); states.forEach(stop); };','    root.StemmaAndroidPulseNavigation=Object.freeze({capture:()=>({tab:selected,stage:Number(panels[selected]?.dataset.stage)||0,searchOpen:!search.hidden,searchQuery:searchInput?.value||\'\',searchTab:Number(search.querySelector(\'[aria-selected="true"][data-pulse-search-tab]\')?.dataset.pulseSearchTab)||0,scroll:{pulsePanelTop:panels[selected]?.scrollTop||0,pulseFeedTop:feed?.scrollTop||0}}),async restore(value={}){select(Number(value.tab)||0);if(Number.isInteger(value.stage))reveal(panels[selected],value.stage);if(value.searchOpen)setSearchOpen(true,true);if(value.searchTab!=null)selectSearch(Number(value.searchTab));if(typeof value.searchQuery===\'string\'&&searchInput){searchInput.value=value.searchQuery.slice(0,80);searchInput.dispatchEvent(new Event(\'input\',{bubbles:true}));}return true;}});\n    cleanup = () => { searchTrigger?.setAttribute(\'aria-expanded\', \'false\'); abort.abort(); clearTimeout(wheelTimer); states.forEach(stop); };','pulse navigation bridge');
	 }
	 if(file==='/direct-chat-ui.js') code=replaceOnce(code,'return Object.freeze({ open, closeView, refresh, isOpen: () => !panel.hidden });','return Object.freeze({ open, closeView, refresh, isOpen: () => !panel.hidden, getConversationId: () => conversation?.id ? String(conversation.id) : \'\', historyElement: history, waitForLoad: async () => { for (let n=0;n<80&&loading;n++) await new Promise(resolve=>setTimeout(resolve,100)); return !loading; } });','direct chat state');
	 if(file==='/pulse-data-ui.js'){
	  const anchor="    listen(signal, 'abort', () => { resetSearch(); notes = []; items.replaceChildren(); text.value = ''; paintPreview(); clearTimeout(pollTimer); });";
	  code=replaceOnce(code,anchor,"    async function restoreDirect(id, scroll={}) { for(let n=0;n<40&&conversationsState!=='ready';n++){if(!conversationsLoading)await loadConversations();if(conversationsState!=='ready')await new Promise(resolve=>setTimeout(resolve,125));} const found=conversations.find(item=>String(item.id)===String(id)); if(!found)return false; openConversation(found); await directView?.waitForLoad?.(); if(directView?.historyElement)directView.historyElement.scrollTop=Math.max(0,Number(scroll.directHistoryTop)||0); return true; }\n    async function restoreSaved(scroll={}) { if(!saved)return false; closeSearch(); feed.hidden=feed.inert=true; saved.hidden=false; root.StemmaParentNavigation?.enter('pulse-saved',()=>closeSaved(true),{signal}); await loadNotes(); history.scrollTop=Math.max(0,Number(scroll.savedHistoryTop)||0); return true; }\n    root.StemmaAndroidPulseData=Object.freeze({capture:()=>({directId:directView?.getConversationId?.()||'',savedOpen:Boolean(saved&&!saved.hidden),scroll:{directHistoryTop:directView?.historyElement?.scrollTop||0,savedHistoryTop:history?.scrollTop||0,searchResultsTop:search?.querySelector('.pulse-search-body')?.scrollTop||0}}),restoreDirect,restoreSaved});\n"+anchor,'pulse data state');
	 }
	 if(file==='/groups-ui.js'){
	  const anchor="    listen(dialog, 'cancel', event => { event.preventDefault(); closeDialog(); });";
	  code=replaceOnce(code,anchor,"    root.StemmaAndroidGroups=Object.freeze({capture:()=>({groupId:current?.id?String(current.id):'',groupInfo:Boolean(current&&detail.classList.contains('is-info')),groupQuery:searchInput?.value||'',scroll:{groupViewTop:view.scrollTop||0,groupDetailTop:detail.scrollTop||0,groupMessagesTop:detail.querySelector('[data-group-messages]')?.scrollTop||0,groupListTop:listView.scrollTop||0}}),async restore(id,info=false,scroll={},query=''){if(!/^[1-9]\\d{0,18}$/.test(String(id||'')))return false;await openById(String(id));if(String(current?.id)!==String(id))return false;if(typeof query==='string'){searchInput.value=query.slice(0,80);if(query)searchInput.dispatchEvent(new Event('input',{bubbles:true}));}for(let n=0;n<40&&messageLoads.has(String(id));n++)await new Promise(resolve=>setTimeout(resolve,100));if(info&&current.isMember)openInfo(detail.querySelector('[data-group-info]'));await new Promise(resolve=>requestAnimationFrame(resolve));view.scrollTop=Number(scroll.groupViewTop)||0;detail.scrollTop=Number(scroll.groupDetailTop)||0;const messages=detail.querySelector('[data-group-messages]');if(messages)messages.scrollTop=Number(scroll.groupMessagesTop)||0;return true;}});\n"+anchor,'group state');
	 }
	 if(file==='/channels-ui.js'){
	  code=replaceOnce(code,'let portal = null, appInert = false, unreadAfter = null, initialPaint = true, readTimer = null, readPending = false, savedScroll = [], controlBusy = false;','let portal = null, appInert = false, unreadAfter = null, initialPaint = true, readTimer = null, readPending = false, savedScroll = [], controlBusy = false, androidRestoring = false;','channel restore guard');
	  code=replaceOnce(code,'function scheduleRead() { clearTimeout(readTimer); readTimer = setTimeout(markVisibleRead, 650); }','function scheduleRead() { clearTimeout(readTimer); if (androidRestoring) return; readTimer = setTimeout(markVisibleRead, 650); }','channel read guard');
	  const anchor="    listen(shell, 'click', event => {\n      const row = event.target.closest('[data-channel-open]');";
	  code=replaceOnce(code,anchor,"    root.StemmaAndroidChannels=Object.freeze({capture:()=>({channelId:current?.id?String(current.id):'',scroll:{channelHistoryTop:history.scrollTop||0,channelListTop:feed?.scrollTop||0}}),async restore(id,scroll={}){if(!/^[1-9]\\d{0,18}$/.test(String(id||'')))return false;androidRestoring=true;try{await open(String(id));await new Promise(resolve=>requestAnimationFrame(resolve));history.scrollTop=Number(scroll.channelHistoryTop)||0;return String(current?.id)===String(id);}finally{androidRestoring=false;}}});\n"+anchor,'channel state');
	 }
	 if(file==='/system-apps/attendance/app.ts'){
	  code=replaceOnce(code,'    loaded = true;\n    render();\n    setStatus("saved", "Attendance loaded");','    loaded = true;\n    render();\n    window.dispatchEvent(new CustomEvent("stemma:android-app-auth-ready",{detail:{authenticated:true}}));\n    setStatus("saved", "Attendance loaded");','attendance auth-ready');
	  const anchor='dateInput.value = localISODate();\nrender();\nvoid loadDate(dateInput.value);';
	  code=replaceOnce(code,anchor,'dateInput.value = localISODate();\nrender();\nvoid loadDate(dateInput.value);\nwindow.StemmaAndroidAttendanceState=Object.freeze({isAuthenticated:()=>loaded&&!authFailure,capture:()=>({date:dateInput.value||state.date,month:monthInput.value,reportOpen:!reportView.hidden,scroll:{attendanceY:window.scrollY||0,reportWrapLeft:gridWrap.scrollLeft||0,reportWrapTop:gridWrap.scrollTop||0}}),async restore(value={}){if(!loaded||busy||dirty)return false;const date=/^\\d{4}-\\d{2}-\\d{2}$/.test(value.date||\'\')?value.date:state.date;if(date&&date!==state.date){dateInput.value=date;await loadDate(date);}if(!loaded||authFailure)return false;if(value.reportOpen){reportView.hidden=false;appShell.hidden=true;const month=/^\\d{4}-(0[1-9]|1[0-2])$/.test(value.month||\'\')?value.month:state.date.slice(0,7);await loadMonth(month);gridWrap.scrollLeft=Math.max(0,Number(value.scroll?.reportWrapLeft)||0);gridWrap.scrollTop=Math.max(0,Number(value.scroll?.reportWrapTop)||0);}window.scrollTo(0,Math.max(0,Number(value.scroll?.attendanceY)||0));return true;}});');
	 }
	 return code;
	}
	async function main(){
 await fs.rm(out,{recursive:true,force:true});await fs.mkdir(out,{recursive:true});
 await fs.cp(path.join(source,'assets'),path.join(out,'assets'),{recursive:true});
 await fs.cp(path.join(source,'system-apps'),path.join(out,'system-apps'),{recursive:true});
 for(const file of ['attendance/app.ts'])await fs.rm(path.join(out,'system-apps',file),{force:true});
 const registryPath=path.join(out,'system-apps/apps.json');
 const registry=JSON.parse(await fs.readFile(registryPath,'utf8'));
 for(const app of registry.apps||[]) if(app.launch?.url?.endsWith('/')) app.launch.url+='index.html';
 delete registry.$schema;
 await fs.writeFile(registryPath,JSON.stringify(registry));
 let html=await fs.readFile(path.join(source,'index.html'),'utf8');
 const scripts=[...html.matchAll(/<script\s+src="([^"?]+)(?:\?[^\"]*)?"([^>]*)><\/script>/g)];
 const ordered=[...scripts.filter(x=>!x[2].includes('defer')),...scripts.filter(x=>x[2].includes('defer'))];
 let legacy='';
 for(const item of ordered){
	   let code=await fs.readFile(path.join(source,item[1].replace(/^\//,'')),'utf8');
	   code=nativeNavigationTransform(item[1],code);
   if(item[1]==='/app.js'){
     code=code.replace("window.location.assign('/auth/fayda/start');","void window.StemmaNative.signIn('fayda');");
     code=code.replace(/window\.location\.assign\('\/auth\/google\/start' \+ \(groupPath \? `\?returnTo=\$\{encodeURIComponent\(groupPath\)\}` : ''\)\);/,"void window.StemmaNative.signIn('google');");
   }
   if(item[1]==='/direct-chat-ui.js'){
     code=code.replace('conversation = next; messages = []; hasMore = false;',"conversation = next; panel.dataset.nativeDraftScope = 'direct:' + String(next.id); messages = []; hasMore = false;");
     code=code.replace("paint(); if (input.value.trim() === value) input.value = '';", "paint(); if (input.value.trim() === value) { input.value = ''; input.dispatchEvent(new Event('input', {bubbles:true})); }");
   }
   legacy+=`\n/* ${item[1]} */\n${code}\n;\n`;
 }
	 if(legacy.includes("window.location.assign('/auth/google/start'"))throw new Error('Mobile OAuth rewrite missing.');
	 const nativeNavigation=await fs.readFile(path.join(__dirname,'native-navigation.js'),'utf8');
	 const js=await esbuild.transform(`(async()=>{await window.StemmaNative.ready;window.__StemmaAndroidInitialHash=window.location.hash;window.__StemmaAndroidInitialPath=window.location.pathname;window.__StemmaAndroidAuthReturn=new URLSearchParams(window.location.search).has('auth');\n${legacy}\n${nativeNavigation}\n})().catch(error=>console.error('App initialization failed',error));`,{minify:true,target:'chrome100',legalComments:'none'});
 const jsName=await writeHashed('app','js',js.code);
 const runtime=await esbuild.build({entryPoints:[path.join(__dirname,'mobile-runtime.js')],bundle:true,write:false,format:'iife',minify:true,target:'chrome100',legalComments:'none'});
 const runtimeName=await writeHashed('native','js',runtime.outputFiles[0].text);
 const sheets=[...html.matchAll(/<link rel="stylesheet" href="([^"?]+)(?:\?[^\"]*)?"\s*\/>/g)];
 let css='';for(const item of sheets)css+=await fs.readFile(path.join(source,item[1].replace(/^\//,'')),'utf8')+'\n';
 try{css+=await fs.readFile(path.join(__dirname,'native-gallery.css'),'utf8');}catch{}
 css+='\n#stemma-offline-status{position:fixed;bottom:0;left:0;right:0;z-index:2147483640;background:#29282c;color:#fff;font:12px/1.4 system-ui;text-align:center;padding:7px 12px max(7px,env(safe-area-inset-bottom));pointer-events:none}#stemma-offline-status[hidden]{display:none}.stemma-is-offline .attachment-feedback:empty::after{content:"Offline — your files are unchanged."}html{overscroll-behavior:none}body{overscroll-behavior-y:none;-webkit-tap-highlight-color:transparent}';
	 const cssMin=await esbuild.transform(css,{loader:'css',minify:true,target:'chrome100'});
	 const cssName=await writeHashed('app','css',cssMin.code);
	 html=html.replace(/<script\s+src="[^\"]+"[^>]*><\/script>\s*/g,'').replace(/<link rel="stylesheet" href="[^\"]+"\s*\/>\s*/g,'');
	 const launchCode=await esbuild.transform(await fs.readFile(path.join(__dirname,'launch-screen.js'),'utf8'),{minify:true,target:'chrome100'});
	 const launchName=await writeHashed('launch','js',launchCode.code);
	 html=html.replace('<body>',`<body><div id="stemma-launch-screen" aria-hidden="true" style="position:fixed;inset:0;z-index:2147483647;background:#681b1d;display:grid;place-items:center"><video muted playsinline preload="auto" poster="/assets/stemma-splash.png" style="display:block;width:100%;height:100%;object-fit:contain;transform:translateY(-12vh)" src="/assets/stemma-launch.mp4"></video></div><script src="/${launchName}"></script>`);
	 html=html.replace('</head>',`<link rel="stylesheet" href="/${cssName}"/><script src="/${runtimeName}"></script><script src="/${jsName}" defer></script></head>`);
	 // No server-rendered shell or third-party code is needed to start this app.
	 await fs.writeFile(path.join(out,'index.html'),html);
	 let attendance=await fs.readFile(path.join(source,'system-apps/attendance/app.ts'),'utf8');
	 attendance=nativeNavigationTransform('/system-apps/attendance/app.ts',attendance);
	 attendance=`(async()=>{await window.StemmaNative.ready;window.__StemmaAndroidInitialHash=window.location.hash;window.__StemmaAndroidInitialPath=window.location.pathname;window.__StemmaAndroidAuthReturn=new URLSearchParams(window.location.search).has('auth');\n${attendance}\n${nativeNavigation}\n})().catch(console.error);`;
 const attendanceJs=await esbuild.transform(attendance,{loader:'ts',minify:true,target:'chrome100'});
 await fs.writeFile(path.join(out,'system-apps/attendance/app.js'),attendanceJs.code);
 const attendanceHtmlPath=path.join(out,'system-apps/attendance/index.html');
 let attendanceHtml=await fs.readFile(attendanceHtmlPath,'utf8');
 attendanceHtml=attendanceHtml.replace('<script type="module" src="./app.js"></script>',`<script src="/${runtimeName}"></script><script src="./app.js" defer></script>`);
 await fs.writeFile(attendanceHtmlPath,attendanceHtml);
 for(const file of ['attendance/app.css','launcher.css']){const target=path.join(out,'system-apps',file);const min=await esbuild.transform(await fs.readFile(target,'utf8'),{loader:'css',minify:true});await fs.writeFile(target,min.code);}
 // Strip development-only launcher source and schema; registry/icon/splash stay local.
	 await fs.rm(path.join(out,'system-apps/launcher.js'),{force:true});
	 await fs.rm(path.join(out,'system-apps/schema.json'),{force:true});
	 const manifest={app:'Stemma',version:'1.0.2',backend:'https://stemma.wasmer.app',entry:jsName,runtime:runtimeName,styles:cssName,launch:launchName,bundledAt:new Date().toISOString(),files:[]};
	 async function walk(dir){for(const item of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,item.name);if(item.isDirectory())await walk(p);else{const data=await fs.readFile(p);manifest.files.push({path:path.relative(out,p),bytes:data.length,sha256:crypto.createHash('sha256').update(data).digest('hex')});}}}
	 await walk(out);await fs.writeFile(path.join(__dirname,'bundle-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
	 console.log(JSON.stringify({files:manifest.files.length,bytes:manifest.files.reduce((n,x)=>n+x.bytes,0),js:js.code.length,css:cssMin.code.length,backend:manifest.backend},null,2));
}
main().catch(e=>{console.error(e);process.exit(1);});
