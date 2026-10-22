// Android-only diagnostics. No storage, uploads, cookie values, account identifiers,
// response bodies, image bytes, full URLs, query strings or arbitrary error messages.
export function installPhotoDiagnostics({ version, versionCode }, root = window) {
  const endpoint = '/api/student-profile/photo';
  const stages = new Set(['idle','request','native-connect','native-headers','native-body','http','response-validation','signature-validation','body-read','image-decode','complete','offline','timeout']);
  const categories = new Set(['none','dns','tls','connect-timeout','read-timeout','connection','redirect','protocol','unknown','network','aborted','offline','timeout','http','not-found','mime','content-length','body-size','empty-body','mime-mismatch','body-read','image-decode','non-image','corrupt-image','image-dimensions','validation']);
  const magicTypes = new Set(['PNG','JPEG','WebP','GIF','unknown']);
  const imageMimes = new Set(['image/png','image/jpeg','image/webp']);
  const nativePhases = new Set(['connect','headers','body','http']);
  let state = null, attempts = 0, signedIn = false, serial = 0, renderQueued = false;
  const native = { route:'not-observed', status:null, phase:null, error:null };
  const requestIds = new WeakMap();
  const safeInt = value => value!==null && value!==undefined && value!=='' && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;
  const readMime = value => ['missing','invalid'].includes(value) ? value : root.StemmaAndroidPhotoResponse.normalizeMime(value);
  const readLength = value => ['missing','invalid'].includes(value) ? value : root.StemmaAndroidPhotoResponse.normalizeLength(value);
  function snapshot() {
    if (!state) return null;
    return { appVersion:String(version),versionCode, timestamp:state.timestamp,phase:state.phase,endpoint,signedIn:state.signedIn,
      httpStatus:state.httpStatus,errorCategory:state.errorCategory,responseMime:state.responseMime,
      declaredByteLength:state.declaredByteLength,byteLength:state.byteLength,magicType:state.magicType,normalizedMime:state.normalizedMime,route:state.route,
      nativeStatus:state.nativeStatus,nativePhase:state.nativePhase,nativeError:state.nativeError,nativeMime:state.nativeMime,nativeDeclaredByteLength:state.nativeDeclaredByteLength,
      decode:state.decode,retries:state.retries,attempt:state.attempt,elapsedMs:state.elapsedMs??Math.max(0,Math.round(performance.now()-state.started)),
      result:state.result };
  }
  function queueRender() {
    if (renderQueued) return;
    renderQueued=true;
    Promise.resolve().then(()=>{renderQueued=false;render();}).catch(()=>{});
  }
  function begin() {
    const id=++serial;
    state={id,started:performance.now(),timestamp:new Date().toISOString(),phase:'request',signedIn,
      httpStatus:null,errorCategory:null,responseMime:null,declaredByteLength:'missing',byteLength:null,magicType:'unknown',normalizedMime:null,route:'not-observed',
      nativeStatus:null,nativePhase:null,nativeError:null,nativeMime:'missing',nativeDeclaredByteLength:'missing',decode:{ok:null,width:null,height:null},retries:attempts++,attempt:attempts,result:'pending'};
    queueRender();return id;
  }
  function update(id, fields) {
    if(state && state.id===id){
      Object.assign(state,fields);
      if(fields.result==='failure'||fields.result==='success')state.elapsedMs=Math.max(0,Math.round(performance.now()-state.started));
      queueRender();
    }
  }
  function fail(id, category, phase) {
    update(id,{result:'failure',errorCategory:categories.has(category)?category:'unknown',phase:stages.has(phase)?phase:'response-validation'});
  }
  function request(options) { const id=(options && requestIds.get(options)) ?? state?.id ?? begin(); update(id,{phase:'request',route:'localhost-webview'}); return id; }
  function response(id, response) {
    if (!state || state.id!==id) return;
    const h=response.headers;
    const route=h.get('X-Stemma-Photo-Route')==='native-proxy'?'native-proxy':'browser-unconfirmed';
    const nStatus=safeInt(h.get('X-Stemma-Photo-Status'));
    const nPhase=h.get('X-Stemma-Photo-Phase');const nError=h.get('X-Stemma-Photo-Error');
    const length=h.get('content-length');
    Object.assign(native,{route,status:nStatus,phase:nativePhases.has(nPhase)?nPhase:null,error:categories.has(nError)?nError:null});
    update(id,{phase:'response-validation',httpStatus:response.status,responseMime:readMime(h.get('content-type')),
      declaredByteLength:readLength(length),route,
      nativeMime:readMime(h.get('X-Stemma-Photo-Content-Type')),nativeDeclaredByteLength:readLength(h.get('X-Stemma-Photo-Content-Length')),
      nativeStatus:native.status,nativePhase:native.phase,nativeError:native.error,
      ...(response.status===401?{signedIn:false}:{})});
    if(!response.ok && response.status!==404) {
      const category=native.error && native.error!=='none'?native.error:'http';
      const phase=native.phase && category!=='http' && native.phase!=='http'?'native-'+native.phase:'http';
      fail(id,category,phase);
    } else if(response.status===200) update(id,{phase:'body-read'});
  }
  function fetchError(id,error) {
    const category=error?.name==='AbortError'?'aborted':'network';
    fail(id,category,'request');
  }
  function storeError(id,error) {
    if(!state||state.id!==id)return;
    if(state.result!=='failure' && error?.photoCategory)return fail(id,error.photoCategory,error.photoPhase);
    // Match only known validation conditions; never retain/copy raw error text.
    const text=String(error?.message||'').toLowerCase();
    if(/timed out/.test(text))return fail(id,'timeout','timeout');
    if(state.result==='failure')return;
    if(error?.status)return fail(id,'http','http');
    if(/unsupported image format/.test(text))return fail(id,'mime','response-validation');
    if(/content length/.test(text))return fail(id,'content-length','response-validation');
    if(/exceed|size limit|oversiz/.test(text))return fail(id,'body-size','body-read');
    if(/empty/.test(text))return fail(id,'empty-body','body-read');
    if(/type did not match/.test(text))return fail(id,'mime-mismatch','response-validation');
    if(error?.name==='AbortError')return fail(id,'aborted','request');
    return fail(id,state.httpStatus===200?'body-read':'validation',state.httpStatus===200?'body-read':'response-validation');
  }
  function validation(id, fields) {
    const safe={};
    if(stages.has(fields.phase))safe.phase=fields.phase;
    if('responseMime' in fields)safe.responseMime=readMime(fields.responseMime);
    if('declaredByteLength' in fields)safe.declaredByteLength=readLength(fields.declaredByteLength);
    if('byteLength' in fields)safe.byteLength=safeInt(fields.byteLength);
    if(magicTypes.has(fields.magicType))safe.magicType=fields.magicType;
    if('normalizedMime' in fields)safe.normalizedMime=imageMimes.has(fields.normalizedMime)?fields.normalizedMime:null;
    if(fields.decode)safe.decode={ok:fields.decode.ok===true,width:safeInt(fields.decode.width),height:safeInt(fields.decode.height)};
    update(id,safe);
  }
  function blob(id, value) {
    if(value===null){fail(id,'not-found','http');return;}
    update(id,{phase:'image-decode',byteLength:safeInt(value?.size),normalizedMime:imageMimes.has(value?.type)?value.type:null,result:'pending'});
  }
  function imageResult(image, ok) {
    if(!state || !['overview-profile-photo','profile-photo-image','student-photo-preview'].includes(image?.id))return;
    // Ignore device selections and stale events; only the URL installed by setCurrentPhoto qualifies.
    if(!state.serverUrl || image.getAttribute('src')!==state.serverUrl)return;
    const width=safeInt(image.naturalWidth),height=safeInt(image.naturalHeight);
    update(state.id,{decode:{ok:Boolean(ok&&width&&height),width,height}});
    if(ok&&width&&height)update(state.id,{phase:'complete',result:'success',errorCategory:null});
    else fail(state.id,'image-decode','image-decode');
  }
  function applied(url) {
    if(!state || state.result==='failure')return;
    // Used only internally for event correlation. NEVER included in snapshot/copy output.
    state.serverUrl=url;
    for(const id of ['overview-profile-photo','profile-photo-image','student-photo-preview']){
      const image=root.document.getElementById(id);
      if(image?.getAttribute('src')===url && image.complete && image.naturalWidth)imageResult(image,true);
    }
  }
  function reportText() { return JSON.stringify(snapshot(),null,2); }
  function render(container) {
    const doc=root.document;const grid=container||doc.getElementById('dashboard-grid');
    if(!grid || grid.getAttribute('aria-label')!=='Your profile')return;
    let panel=grid.querySelector('[data-photo-diagnostics]');
    if(!state || state.result!=='failure'){panel?.remove();grid.querySelector('[data-photo-diagnostic-notice]')?.remove();return;}
    let notice=grid.querySelector('.student-profile-notice');
    if(!notice){
      notice=doc.createElement('p');notice.className='student-profile-notice';notice.dataset.photoDiagnosticNotice='';notice.textContent='Your account photo could not be displayed. Diagnostic details are available below. ';
      const retry=doc.createElement('button');retry.type='button';retry.dataset.retryProfilePhoto='';retry.textContent='Retry account photo';notice.append(retry);
      (grid.querySelector('.student-profile-header')||grid).append(notice);
    }
    if(!panel){
      panel=doc.createElement('details');panel.dataset.photoDiagnostics='';panel.className='stemma-photo-diagnostics';
      const summary=doc.createElement('summary');summary.textContent='Photo diagnostics';panel.append(summary);
      const pre=doc.createElement('pre');pre.dataset.photoDiagnosticText='';panel.append(pre);
      const button=doc.createElement('button');button.type='button';button.textContent='Copy details';button.dataset.copyPhotoDiagnostics='';panel.append(button);
      const feedback=doc.createElement('span');feedback.role='status';feedback.dataset.photoDiagnosticCopyStatus='';panel.append(feedback);
      button.addEventListener('click',async()=>{
        const text=reportText();let copied=false;
        try { if(root.navigator.clipboard?.writeText){await root.navigator.clipboard.writeText(text);copied=true;} } catch {}
        if(!copied){
          const input=doc.createElement('textarea');input.value=text;input.readOnly=true;input.style.cssText='position:fixed;opacity:0;pointer-events:none';doc.body.append(input);input.select();
          try{copied=doc.execCommand('copy');}catch{}input.remove();
        }
        feedback.textContent=copied?'Details copied':'Copy unavailable. Select the details above to copy.';
      });
      notice.insertAdjacentElement('afterend',panel);
    }
    const text=reportText();const pre=panel.querySelector('[data-photo-diagnostic-text]');if(pre.textContent!==text)pre.textContent=text;
  }
  function installStore(Store) {
    if(!Store?.prototype || Store.prototype.__stemmaDiagnosticWrapped)return;
    const get=Store.prototype.get;
    Object.defineProperty(Store.prototype,'__stemmaDiagnosticWrapped',{value:true});
    Store.prototype.get=async function(...args){
      const id=begin();
      // A per-call receiver associates the existing fetch options with this attempt.
      // It adds no request headers/fields and does not mutate the real store or its fetch.
      const receiver=Object.create(this),fetch=this.fetch;
      receiver.photoObserver=fields=>validation(id,fields);
      receiver.fetch=(input,options)=>{if(options && typeof options==='object')requestIds.set(options,id);return fetch.call(this,input,options);};
      try{const value=await get.apply(receiver,args);blob(id,value);return value;}
      catch(error){storeError(id,error);throw error;}
    };
  }
  const api=Object.freeze({context(value={}){signedIn=Boolean(value.signedIn);},begin,request,response,fetchError,storeError,blob,applied,render,installStore,snapshot,
    offline(){const id=state?.id??begin();fail(id,'offline','offline');},
    clear(){state=null;attempts=0;signedIn=false;queueRender();}});
  root.document.addEventListener('load',event=>imageResult(event.target,true),true);
  root.document.addEventListener('error',event=>imageResult(event.target,false),true);
  root.addEventListener('stemma:account-cleared',()=>{if(state?.httpStatus===401){signedIn=false;state.signedIn=false;}else api.clear();});
  root.StemmaPhotoDiagnostics=api;
  return api;
}
