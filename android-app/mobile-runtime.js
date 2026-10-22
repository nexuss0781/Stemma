import { Capacitor, registerPlugin } from '@capacitor/core';
import { persistence, DurableResponseCache } from './native-cache.js';
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Network } from '@capacitor/network';
import { Preferences } from '@capacitor/preferences';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';

const ORIGIN = 'https://stemma.wasmer.app';
const nativeMedia = registerPlugin('StemmaMedia');
const media = Object.freeze({
  requestAccess: options=>nativeMedia.requestAccess(options),
  listAlbums: options=>nativeMedia.listAlbums(options),
  listMedia: options=>nativeMedia.listMedia(options),
  thumbnail: options=>nativeMedia.thumbnail(options),
  readFile: options=>nativeMedia.readFile(options),
  recentFiles: options=>nativeMedia.recentFiles(options),
  selectFile: options=>nativeMedia.selectFile(options),
  pickDocuments: async()=>{const file=await nativeMedia.selectFile();return {files:file?.cancelled?[]:[file]};}
});
const transport = registerPlugin('StemmaTransport');
const nativeFetch = window.fetch.bind(window);
const nativeOpen = XMLHttpRequest.prototype.open;
let connected = navigator.onLine, account = '', authPending = false;
const responseCache = new DurableResponseCache();
let authRevision = 0;
const CACHE_PATH = 'offline/snapshot-v1.json';
const isBackend = path => /^\/(?:api\/|auth\/)/.test(path);
let reconnectTimer, reconnectDelay = 5000;
function scheduleReconnect() {
  if(reconnectTimer) return;
  reconnectTimer=setTimeout(async()=>{
    reconnectTimer=null;
    if(connected) return;
    try {
      const response=await nativeFetch(`${ORIGIN}/auth/session`,{headers:{Accept:'application/json',Origin:ORIGIN},credentials:'include',signal:AbortSignal.timeout(8000)});
      if(response.status<500) { reconnectDelay=5000; updateConnection(true); window.dispatchEvent(new Event('stemma:reconnected')); return; }
    } catch {}
    reconnectDelay=Math.min(reconnectDelay*2,60000); scheduleReconnect();
  },reconnectDelay);
}
const cacheable = path => /^\/(?:auth\/session(?:\?|$)|api\/(?:student-profile|pulse|groups|channels|notifications|likee|system-apps\/attendance)(?:[/?]|$))/.test(path) && !/\/(?:media|photo|avatar|attachments\/[^/?]+)(?:[/?]|$)/.test(path);
function backendUrl(value) {
  const url = new URL(value, location.href);
  return url.origin === location.origin && isBackend(url.pathname) ? ORIGIN + url.pathname + url.search : url.href;
}
function updateConnection(value) {
  connected = value;
  if(!value) scheduleReconnect();
  else { clearTimeout(reconnectTimer); reconnectTimer=null; reconnectDelay=5000; }
  const render = () => {
    let banner = document.getElementById('stemma-offline-status');
    if (!banner) { banner = document.createElement('div'); banner.id = 'stemma-offline-status'; banner.role = 'status'; banner.textContent = 'Offline · Saved data only. Sending and changes need a connection.'; document.body.append(banner); }
    banner.hidden = connected;
    document.documentElement.classList.toggle('stemma-is-offline', !connected);
  };
  if (document.body) render(); else document.addEventListener('DOMContentLoaded', render, { once:true });
}
async function clearAccount() {
  account = ''; authRevision++;
  clearTimeout(draftTimer); draftState = {};
  window.dispatchEvent(new Event('stemma:account-cleared'));
  try { await persistence.setSessionActive(false); } catch {}
  await Promise.allSettled([
    responseCache.clear(),
    Filesystem.deleteFile({path:CACHE_PATH,directory:Directory.Data}),
    Preferences.remove({key:'drafts-v1'}), persistence.remove('drafts-v2')
  ]);
  try { await transport.clearPrivateCache(); } catch {}
  try { await persistence.flush(); } catch {}
}
async function saved(path) {
  const current = account;
  const hit = await responseCache.get(path);
  if (!hit || !current || current !== account) return null;
  return new Response(JSON.stringify(hit.body), { status:200, headers:{'Content-Type':'application/json','X-Stemma-Offline':'true','X-Stemma-Saved-At':String(hit.at)} });
}
window.fetch = async (input, init={}) => {
  const source = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
  const url = new URL(backendUrl(source));
  if (url.origin !== ORIGIN || !isBackend(url.pathname)) return nativeFetch(input,init);
  const path = url.pathname+url.search;
  const requestRevision = authRevision;
  const method = (init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init.headers).forEach((value,key)=>headers.set(key,value));
  headers.set('Origin',ORIGIN);
  if (!connected) {
    if (method==='GET') { const value=await saved(path); if(value) return value; }
    throw new TypeError('You are offline. Your draft is kept; reconnect before sending or making changes.');
  }
  try {
    let response;
    if(['POST','PUT','PATCH','DELETE'].includes(method)) {
      const signal=init.signal || (input instanceof Request ? input.signal : undefined);
      if(signal?.aborted) throw new DOMException('Request cancelled.','AbortError');
      const body=init.body ?? (input instanceof Request ? await input.clone().text() : '');
      if(typeof body!=='string') throw new Error('This server operation requires a JSON payload.');
      const result=await transport.request({url:url.href,method,body,contentType:headers.get('Content-Type')||'application/json'});
      if(signal?.aborted) throw new DOMException('Request cancelled.','AbortError');
      response=new Response([204,205,304].includes(result.status)?null:result.body,{status:result.status,headers:{'Content-Type':result.contentType||'application/json'}});
    } else if(method==='GET' && url.pathname==='/api/student-profile/photo') {
      // The generic Capacitor HTTP proxy omits Content-Type from fetch headers
      // and can forward localhost cookies instead of the backend account cookie.
      // Keep photo bytes on our streaming proxy, which supplies both explicitly.
      const localUrl = new URL(path,location.origin).href;
      response = await nativeFetch(input instanceof Request ? new Request(localUrl,input) : localUrl,{...init,headers,credentials:'same-origin'});
    } else response = await nativeFetch(input instanceof Request ? new Request(url.href,input) : url.href,{...init,headers,credentials:'include'});
    if (response.status===401) { if(requestRevision===authRevision) await clearAccount(); return response; }
    if (url.pathname==='/auth/logout' && response.ok) await clearAccount();
    if (method==='GET' && response.ok && cacheable(path) && /json/i.test(response.headers.get('Content-Type')||'')) {
      try {
        const body = await response.clone().json();
        if (url.pathname==='/auth/session') {
          const next = body.googleProfile?.email?.trim().toLowerCase() || body.user?.id || body.profile?.id || '';
          if (!body.authenticated) await clearAccount();
          else if(next) { if(account && account!==next) await clearAccount(); account=String(next); await responseCache.activate(account); try { await persistence.setSessionActive(true); } catch {} window.dispatchEvent(new Event('stemma:account-ready')); }
          else await clearAccount();
        }
        if(account && (url.pathname==='/auth/session' || requestRevision===authRevision)) { void responseCache.put(path,body).catch(()=>{}); }
      } catch {}
    }
    return response;
  } catch(error) {
    if(error.name==='AbortError' || init.signal?.aborted) throw error;
    updateConnection(false);
    if(method==='GET') { const value=await saved(path); if(value) return value; }
    throw new TypeError('Connection unavailable. Your draft is kept. Please try again when connected.');
  }
};
XMLHttpRequest.prototype.open = function(method,url,...rest) {
  const target = backendUrl(String(url));
  const result = nativeOpen.call(this,method,target,...rest);
  if(new URL(target).origin===ORIGIN) this.setRequestHeader('Origin',ORIGIN);
  return result;
};
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
async function signIn(provider) {
  if(!connected || authPending) return;
  authPending=true;
  try {
    const verifier=b64url(crypto.getRandomValues(new Uint8Array(32)));
    const state=b64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge=b64url(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))));
    await Preferences.set({key:'auth-pending-v1',value:JSON.stringify({verifier,state,at:Date.now()})});
    await Browser.open({url:`${ORIGIN}/auth/mobile/start?provider=${encodeURIComponent(provider)}&challenge=${challenge}&state=${state}`});
  } finally { authPending=false; }
}
async function handleLink(url) {
  let link; try { link=new URL(url); } catch { return; }
  if(link.protocol!=='app.stemma.mobile:' || link.hostname!=='auth') return;
  try {
    const {value}=await Preferences.get({key:'auth-pending-v1'});
    const pending=JSON.parse(value||'null');
    if(!pending || Date.now()-pending.at>10*60*1000 || link.searchParams.get('state')!==pending.state) return;
    const code=link.searchParams.get('code');
    if(!code) {await Preferences.remove({key:'auth-pending-v1'});throw new Error('Sign-in was not completed. Please try again.');}
    const response=await window.fetch('/auth/mobile/exchange',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code,state:pending.state,verifier:pending.verifier})});
    if(!response.ok) throw new Error('Sign-in expired. Please try again.');
    await Preferences.remove({key:'auth-pending-v1'});
    await Browser.close().catch(()=>{});
    location.assign('/?auth=success');
  } catch(error) {
    const target=document.getElementById('fayda-feedback'); if(target) target.textContent=error.message;
  }
}
const ready = (async()=>{
  account = await responseCache.initialize();
  // One-time migration preserves the previous APK's offline data during an in-place update.
  if (!account) try {
    const {data}=await Filesystem.readFile({path:CACHE_PATH,directory:Directory.Data,encoding:Encoding.UTF8});
    const stored=JSON.parse(data);
    if(typeof stored.account==='string' && stored.account && stored.cache && typeof stored.cache==='object') {
      account=stored.account; await responseCache.activate(account);
      for(const [path,hit] of Object.entries(stored.cache)) {
        if(cacheable(path) && hit && typeof hit.body==='object') await responseCache.put(path,hit.body,hit.at || Date.now());
      }
      await Filesystem.deleteFile({path:CACHE_PATH,directory:Directory.Data});
    }
  } catch {}
  try { updateConnection((await Network.getStatus()).connected); await Network.addListener('networkStatusChange',status=>{updateConnection(status.connected); if(status.connected) window.dispatchEvent(new Event('stemma:reconnected'));}); } catch {updateConnection(navigator.onLine);}
  await App.addListener('appUrlOpen',event=>void handleLink(event.url));
  const launch=await App.getLaunchUrl(); if(launch?.url) void handleLink(launch.url);
  await App.addListener('backButton',()=>{
    const dialog=document.querySelector('dialog[open]');
    if(dialog) { dialog.dispatchEvent(new Event('cancel',{cancelable:true})); return; }
    if(location.pathname!=='/' && location.pathname!=='/index.html') { location.assign('/#apps'); return; }
    if(window.StemmaParentNavigation?.back?.()) return;
    if(history.length>1) history.back(); else void App.minimizeApp();
  });
  const flush = () => { window.dispatchEvent(new Event('stemma:checkpoint')); void responseCache.flush().catch(()=>{}); };
  await App.addListener('appStateChange',state=>{if(!state.isActive) flush();});
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden') flush();});
  window.addEventListener('pagehide',flush);
  window.addEventListener('online',()=>updateConnection(true));
  window.addEventListener('offline',()=>updateConnection(false));
  window.addEventListener('stemma:reconnected',()=>{ /* No toast, reload, or mutation replay. */ });
})();
window.StemmaNative={ready,media,transport,persistence,signIn,origin:ORIGIN,isNative:Capacitor.isNativePlatform(),get account(){return account;},get connected(){return connected;},clearAccount,flush:()=>responseCache.flush()};
window.StemmaNative.upload=async function({endpoint,body,contentType,headers={},signal,onProgress=()=>{}}) {
  if(!body?.nativePath) return null;
  if(!connected) throw new Error('You are offline. Reconnect before uploading; your file is unchanged.');
  const requestId=crypto.randomUUID();
  const listener=await transport.addListener('uploadProgress',event=>{if(event.requestId===requestId) onProgress({percent:Math.floor(100*event.loaded/event.total),loaded:event.loaded,total:event.total,complete:event.loaded===event.total});});
  const cancel=()=>void transport.cancelUpload({requestId});
  signal?.addEventListener('abort',cancel,{once:true});
  try {
    if(signal?.aborted) throw new Error('Upload cancelled.');
    const result=await transport.upload({requestId,url:backendUrl(endpoint),path:body.nativePath,headers:{...headers,'Content-Type':contentType}});
    if(result.status<200 || result.status>=300) throw new Error(result.data?.error || 'Could not upload this file.');
    return result.data;
  } finally {await listener.remove();signal?.removeEventListener('abort',cancel);}
};
// Durable, account-scoped drafts: never store passwords and never auto-submit.
let draftTimer, draftState = {};
const draftsReady = (async () => {
  try {
    const current = await persistence.get('drafts-v2');
    if(current) draftState = JSON.parse(current);
    else { const {value}=await Preferences.get({key:'drafts-v1'}); draftState=JSON.parse(value||'{}'); }
  } catch { draftState = {}; }
})();
function draftKey(input) {
  if(!account || input?.tagName!=='TEXTAREA') return null;
  const scope=input.closest('[data-native-draft-scope]')?.dataset.nativeDraftScope;
  if(!scope && !location.pathname.startsWith('/system-apps/attendance/')) return null;
  return `${account}:${scope || location.pathname}:${input.id||input.name}`;
}
function writeDrafts() {
  clearTimeout(draftTimer);
  if(!account) return;
  const snapshot=JSON.stringify(draftState);
  void persistence.set('drafts-v2',snapshot).catch(()=>{});
}
document.addEventListener('input',event=>{
  const input=event.target, key=draftKey(input); if(!key) return;
  if(input.value.length<=100000) draftState[key]=input.value;
  clearTimeout(draftTimer); draftTimer=setTimeout(writeDrafts,100);
});
for(const name of ['stemma:checkpoint','pagehide']) window.addEventListener(name,writeDrafts);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden') writeDrafts();});
document.addEventListener('focusout',event=>{if(draftKey(event.target))writeDrafts();});
document.addEventListener('focusin',async event=>{
  const input=event.target,key=draftKey(input); if(!key || input.value) return;
  await draftsReady;
  const draft=draftState[key];
  if(typeof draft==='string' && !input.value && draftKey(input)===key) { input.value=draft; input.dispatchEvent(new Event('input',{bubbles:true})); }
});
document.addEventListener('click',event=>{
  const anchor=event.target.closest?.('a[href]'); if(!anchor) return;
  const url=new URL(anchor.href,location.href);
  if(url.origin===location.origin && /^\/api\/pulse\/attachments\/[a-f0-9-]{36}$/i.test(url.pathname)) {
    event.preventDefault();
    if(!connected) {updateConnection(false);return;}
    void transport.openAttachment({path:url.pathname}).catch(error=>{anchor.setAttribute('title',error.message);});
  }
});
