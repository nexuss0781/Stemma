/* Attachment bytes are uploaded to durable account/conversation storage, never localStorage. */
(function attachChatFiles(root) {
  'use strict';
  const MAX_BYTES = 5 * 1024 * 1024;
  const clip = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 12 6.5-6.5a3.5 3.5 0 0 1 5 5L10 20a5 5 0 0 1-7-7L13 3a2 2 0 0 1 3 3L6.5 15.5a.8.8 0 0 1-1-1L14 6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  function control() {
    return `<button type="button" class="pulse-attach-button" aria-label="Attach file" aria-haspopup="dialog" title="Attach file · up to 5 MB">${clip}<span class="pulse-attachment-plus" aria-hidden="true">+</span></button>`;
  }
  function sizeLabel(size) {
    return size >= 1024 * 1024 ? `${(size / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.ceil(size / 1024))} KB`;
  }
  function render(attachment) {
    if (!attachment || typeof attachment.url !== 'string' || !/^\/api\/pulse\/attachments\/[a-f0-9-]{36}$/i.test(attachment.url)) return null;
    const link = root.document.createElement('a');
    link.className = 'pulse-file-attachment'; link.href = attachment.url;
    link.target = '_blank'; link.rel = 'noopener noreferrer';
    const name = typeof attachment.name === 'string' ? attachment.name : 'Attachment';
    link.setAttribute('aria-label', `Open attachment: ${name}`);
    const mime = attachment.mimeType || attachment.mime || '';
    if (/^image\/(jpeg|png|webp|gif)$/.test(mime)) {
      link.classList.add('is-image');
      const image = root.document.createElement('img');
      image.src = attachment.url; image.alt = name; image.loading = 'lazy'; image.decoding = 'async'; image.referrerPolicy = 'no-referrer';
      image.addEventListener('error', () => { image.hidden = true; }, { once: true });
      link.append(image);
    } else {
      const icon = root.document.createElement('span'); icon.className = 'pulse-file-icon'; icon.innerHTML = clip; icon.setAttribute('aria-hidden', 'true'); link.append(icon);
    }
    const copy = root.document.createElement('span'); copy.className = 'pulse-file-copy';
    const title = root.document.createElement('strong'); title.textContent = name;
    const meta = root.document.createElement('small');
    meta.textContent = `${(name.split('.').at(-1) || 'FILE').slice(0, 10).toUpperCase()} · ${sizeLabel(Number(attachment.size) || 0)}`;
    copy.append(title, meta); link.append(copy);
    return link;
  }
  function base64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(new Error('Could not read that file. Please choose it again.'));
      reader.readAsDataURL(file);
    });
  }
  // Shared network uploader: reports actual transport progress, never a timer.
  function upload({ endpoint, body, size, signal = new AbortController().signal, onProgress = () => {}, contentType = 'application/json', headers = {}, timeout = 180000 }) {
    if (body?.nativePath && typeof root.StemmaNative?.upload === 'function') {
      return Promise.resolve().then(async () => {
        if (signal.aborted) throw new Error('Upload cancelled.');
        onProgress({ percent: 0, loaded: 0, total: size, complete: false });
        const result = await root.StemmaNative.upload({ endpoint, body, contentType, headers, signal, onProgress });
        if (result) return result;
        const fallback = typeof root.Blob === 'function' && body instanceof root.Blob ? body.slice(0, body.size, body.type) : body?.blob;
        if (!fallback) throw new Error('Native upload is unavailable for this selected file.');
        return upload({ endpoint, body: fallback, size, signal, onProgress, contentType, headers, timeout });
      });
    }
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new Error('Upload cancelled.')); return; }
      const request = new root.XMLHttpRequest();
      const abort = () => request.abort(); signal.addEventListener('abort', abort, { once: true });
      request.open('POST', endpoint); request.withCredentials = true; request.timeout = timeout;
      request.setRequestHeader('Content-Type', contentType); request.setRequestHeader('Accept', 'application/json');
      for (const [name, value] of Object.entries(headers)) request.setRequestHeader(name, value);
      request.upload.onprogress = event => {
        if (!event.lengthComputable || signal.aborted) return;
        // JSON/base64 adds transport overhead; report its measured fraction as media bytes.
        const ratio = Math.min(1, event.loaded / event.total);
        onProgress({ percent: Math.floor(ratio * 100), loaded: size * ratio, total: size, complete: false });
      };
      request.upload.onload = () => { if (!signal.aborted) onProgress({ percent: 100, loaded: size, total: size, complete: true }); };
      request.onload = () => {
        let result = {}; try { result = JSON.parse(request.responseText); } catch { /* Never expose server HTML. */ }
        if (request.status >= 200 && request.status < 300) resolve(result);
        else reject(new Error(request.status === 401 ? 'Sign in to upload files.' : result.error || 'Could not upload this file.'));
      };
      request.onerror = request.ontimeout = () => reject(new Error('Upload interrupted. Check the destination before trying again.'));
      request.onabort = () => reject(new Error('Upload cancelled.'));
      request.onloadend = () => signal.removeEventListener('abort', abort);
      onProgress({ percent: 0, loaded: 0, total: size, complete: false });
      const isBlob = typeof root.Blob === 'function' && body instanceof root.Blob;
      request.send(typeof body === 'string' || isBlob ? body : JSON.stringify(body));
    });
  }
  const uploadMB = bytes => `${(bytes / 1000000).toFixed(2)} MB`;
  let pickerSerial = 0;
  function mount(form, options) {
    const button = form.querySelector('.pulse-attach-button');
    if (!button) return;
    options.listen(button, 'click', () => openPicker(button, options));
  }
  let activePicker = null;
  function pickPhoto({ button, signal = new AbortController().signal, ready = () => true, accept = '.jpg,.jpeg,.png,.webp,.gif,.avif,.bmp,.heic,.heif', maxBytes = 10 * 1024 * 1024, onSelect, title = 'Photo' }) {
    return openPicker(button, { signal, ready, photo: true, maxBytes, onSelect, title, endpoint: () => 'photo' });
  }
  function pickMedia(options) {
    return openPicker(options.button, { signal: new AbortController().signal, ...options, photo: true, media: true, endpoint: () => 'media', maxBytes: options.maxBytes ?? MAX_BYTES });
  }
  const PAGE_SIZE = 60;
  const MAX_VIDEO_MS = 240000;
  function openPicker(button, { signal, endpoint, onMessage, ready = () => true, extraBody = () => ({}), photo = false, media: mediaMode = false, galleryOnly = false, maxBytes = MAX_BYTES, onSelect, title = 'Attachments' }) {
    const bridge = root.StemmaNative?.media;
    if (activePicker || !ready() || signal?.aborted || !bridge) return;
    const target = endpoint(); if (!target) return;
    const extra = extraBody();
    const id = `attachment-picker-${++pickerSerial}`;
    const dialog = root.document.createElement('dialog'); dialog.className = 'pulse-attachment-dialog native-picker';
    dialog.setAttribute('aria-labelledby', `${id}-title`);
    const head = root.document.createElement('div'); head.className = 'attachment-sheet';
    head.innerHTML = `<div class="attachment-handle" aria-hidden="true"></div><header class="attachment-header"><button type="button" data-back aria-label="Back">←</button><h2 id="${id}-title">${mediaMode ? 'Photo or video' : photo ? 'Photo' : 'Attachments'}</h2><button type="button" data-close aria-label="Cancel">×</button></header><p class="visually-hidden">Review selected files before using them. ${mediaMode ? 'Videos are limited to four minutes.' : 'Formats browse broadly; server, action, or device codec support may vary.'}</p><div class="native-picker-body"><div class="native-picker-toolbar"><div class="native-picker-tabs" role="tablist" aria-label="Choose source"></div>${galleryOnly ? '' : '<button type="button" data-camera class="native-camera-action">Take photo</button>'}</div><div class="native-picker-message" role="status" aria-live="polite"></div><div class="native-picker-panel"></div></div><div class="native-picker-review" hidden></div><div class="attachment-confirm"><span data-count aria-live="polite"></span><button type="button" data-confirm disabled>${mediaMode ? 'Use media' : photo ? 'Use photo' : 'Send'}</button></div></div>`;
    dialog.append(head); root.document.body.append(dialog); activePicker = dialog;
    const controller = new AbortController(); const panel = head.querySelector('.native-picker-panel');
    const message = head.querySelector('.native-picker-message'); const tabs = head.querySelector('.native-picker-tabs');
    const confirm = head.querySelector('[data-confirm]'); const countNode = head.querySelector('[data-count]');
    const review = head.querySelector('.native-picker-review');
    const cameraButton = head.querySelector('[data-camera]');
    const categories = ['Gallery', ...(!galleryOnly ? ['Files'] : [])];
    let category = 'Gallery', albumId = null, albums = [], page = 0, hasMore = false, loading = false, closed = false, sending = false, reviewing = false, loadRevision = 0;
    let filePath = '', fileParent = '', roots = [], fileOffset = 0, fileMore = false;
    let entries = [], selectionOrder = 0, thumbObserver = null, thumbQueue = [], thumbRunning = 0, previewURLs = [], capturePending = false;
    function releasePreviews(){for(const url of previewURLs)root.URL.revokeObjectURL(url);previewURLs=[];for(const player of review.querySelectorAll('video,audio')){player.pause();player.removeAttribute('src');player.load();}}
    const mediaModeType = photo && !mediaMode ? 'images' : 'all';
    const icon = (tag, cls, text) => { const n = root.document.createElement(tag); n.className = cls || ''; if (text !== undefined) n.textContent = text; return n; };
    function statusText(value) { const s = String(value?.status || value?.access || '').toLowerCase(); return s; }
    function allowedAccess(value) { const s = statusText(value); return ['granted','limited','authorized','partial','full'].includes(s) || value?.granted === true; }
    function makeTab(name) { const b = icon('button','native-picker-tab',name); b.type='button'; b.setAttribute('role','tab'); b.setAttribute('aria-selected',String(name===category)); b.dataset.attachmentCategory=name; b.onclick=()=>switchCategory(name); tabs.append(b); }
    categories.forEach(makeTab); if(cameraButton)cameraButton.hidden=true;
    function setMessage(text, kind='') { message.textContent=text; message.dataset.state=kind; }
    function updateCount() { const selected=entries.filter(x=>x.selected); countNode.textContent=selected.length ? `${selected.length} selected` : ''; confirm.disabled=sending || !selected.length; confirm.textContent=sending?'…':reviewing?'Confirm':mediaMode?'Use media':photo?'Use photo':'Send'; }
    function close() { if (closed) return; closed=true; if(entries.some(e=>e.pendingFile))void bridge.cancelPreparation?.().catch(()=>{}); releasePreviews(); loadRevision++; loading=false; controller.abort(); thumbObserver?.disconnect(); signal?.removeEventListener('abort',close); root.StemmaParentNavigation?.forget(`${id}-review`); root.StemmaParentNavigation?.forget(id); dialog.close?.(); dialog.remove(); activePicker=null; if (!signal?.aborted && button?.isConnected) button.focus?.({preventScroll:true}); }
    function dismiss() { if (sending) return; if (reviewing) { releasePreviews(); reviewing=false; review.hidden=true; panel.hidden=false; updateCount(); return; } if (category==='Files' && fileParent) { void navigateFiles(fileParent); return; } close(); }
    function switchCategory(name) { if (sending || !categories.includes(name)) return; loadRevision++; loading=false; category=name; reviewing=false; review.hidden=true; panel.hidden=false; for (const t of tabs.children) t.setAttribute('aria-selected',String(t.textContent===name)); setMessage(''); if(name==='Gallery') {page=0; albumId=null; entries=[]; void loadGallery(true);} else {filePath='';fileParent='';fileOffset=0;entries=[];void prepareFiles();} }
    function pathName(item) { return String(item?.name || item?.displayName || 'Untitled'); }
    function mimeOf(item) { return String(item?.mimeType || item?.mime || (item?.mediaType==='video'?'video/mp4':'') || 'application/octet-stream').toLowerCase(); }
    function itemKind(item) { const mime=mimeOf(item); return mime.startsWith('image/')?'image':mime.startsWith('video/')?'video':'file'; }
    function itemKey(item) { const identity=String(item?.id ?? item?.path ?? item?.uri ?? `${item?.name}-${item?.size}`); return item?.id!=null ? `${item?.mediaType||itemKind(item)}:${item?.source||''}:${identity}` : identity; }
    function selected(item) { return entries.find(x=>x.key===itemKey(item)); }
    function showAccessControls(state) {
      if (!allowedAccess(state)) { panel.replaceChildren(); const p=icon('p','native-picker-empty','Gallery access is not available. Grant access to browse your photos and videos.'); panel.append(p); const b=icon('button','native-picker-action','Grant or retry access'); b.type='button'; b.onclick=()=>void loadGallery(true); panel.append(b); }
      else if (statusText(state)==='limited' || statusText(state)==='partial') setMessage('Limited access: only media you allowed is shown.','limited');
    }
    async function ensureAccess(forceRequest=false) {
      let state;
      try { state = bridge.getAccess ? await bridge.getAccess() : null; }
      catch { state = null; }
      if (forceRequest || !state || !allowedAccess(state)) {
        if (typeof bridge.requestAccess !== 'function') throw new Error('Gallery permission controls are unavailable.');
        state=await bridge.requestAccess();
      }
      showAccessControls(state);
      if (!allowedAccess(state)) throw new Error(statusText(state)==='limited'?'Gallery access is limited. Retry to choose accessible media.':'Gallery access was denied. Grant access and retry.');
      return state;
    }
    function addErrorTile(tile, text='Preview unavailable') { tile.replaceChildren(icon('span','native-fallback-icon', '▧'),icon('small','native-fallback-label',text)); tile.classList.add('is-fallback'); }
    function queueThumbnail(item, image) { if (!bridge.thumbnail || !item.id) { addErrorTile(image.parentElement); return; } thumbQueue.push({item,image}); void pumpThumbnails(); }
    async function pumpThumbnails() { while(thumbRunning<4 && thumbQueue.length) { const job=thumbQueue.shift(); thumbRunning++; (async()=>{try { const result=await bridge.thumbnail({id:String(job.item.id),mediaType:itemKind(job.item)==='video'?'video':'images'}); if(!closed && job.image.isConnected && result?.webPath) job.image.src=result.webPath; else if(job.image.isConnected) addErrorTile(job.image.parentElement); } catch { if(job.image.isConnected) addErrorTile(job.image.parentElement); } finally { thumbRunning--; void pumpThumbnails(); }})(); } }
    function makeSelect(item, key) { const checkbox=icon('input'); checkbox.type='checkbox'; checkbox.checked=Boolean(selected(item)?.selected); checkbox.setAttribute('aria-label',`Select ${pathName(item)}`); checkbox.onchange=()=>{let e=selected(item);if(!e){e={key,item,selected:false,order:0};entries.push(e);}if(photo&&checkbox.checked)for(const other of entries)other.selected=false;e.selected=checkbox.checked;e.order=checkbox.checked?++selectionOrder:0;paintSelectedCircles();updateCount();}; return checkbox; }
    function paintSelectedCircles() { for(const tile of panel.querySelectorAll('[data-native-key]')) { const entry=entries.find(e=>e.key===tile.dataset.nativeKey); const circle=tile.querySelector('.native-picker-number'); if(circle) { circle.textContent=entry?.selected?String(entries.filter(e=>e.selected && e.order<=entry.order).length):''; circle.classList.toggle('is-selected',Boolean(entry?.selected)); } const box=tile.querySelector('input[type=checkbox]'); if(box)box.checked=Boolean(entry?.selected); } }
    function makeGalleryTile(item) { const tile=icon('article','native-gallery-tile'); tile.dataset.nativeKey=itemKey(item); const open=icon('button','native-gallery-thumbnail'); open.type='button'; open.setAttribute('aria-label',`Select ${pathName(item)}`); const img=icon('img',''); img.alt=''; img.loading='lazy'; img.decoding='async'; img.onerror=()=>addErrorTile(open); itemsByImage.set(img,item); open.append(img); const kind=itemKind(item); if(kind==='video')open.append(icon('span','native-video-badge','Video')); if(thumbObserver)thumbObserver.observe(img); else queueThumbnail(item,img); const selector=icon('label','native-gallery-select'); const input=makeSelect(item,itemKey(item)); const number=icon('span','native-picker-number'); const existing=selected(item); if(existing?.selected){number.textContent=String(entries.filter(e=>e.selected && e.order<=existing.order).length);number.classList.add('is-selected');input.checked=true;} selector.append(input,number); open.onclick=()=>{const choice=tile.querySelector('input[type=checkbox]');if(choice){choice.checked=!choice.checked;choice.dispatchEvent(new root.Event('change',{bubbles:true}));}}; tile.append(open,selector); return tile; }
    function renderGallery(items, append=false) { if(!append){panel.replaceChildren();} if(!items.length && !append){panel.append(icon('p','native-picker-empty','No accessible photos or videos found.'));return;} const grid=panel.querySelector('.native-gallery-grid'); if(!galleryOnly && grid && !grid.querySelector('.native-camera-tile')){const cameraTile=icon('article','native-gallery-tile native-camera-tile');const camera=icon('button','native-gallery-thumbnail native-camera-tile-button','Take photo');camera.type='button';camera.setAttribute('aria-label','Take a photo');camera.onclick=()=>void capture();cameraTile.append(camera);grid.append(cameraTile);} for(const item of items){ if(photo && !mediaMode && itemKind(item)!=='image')continue; if(!photo && !['image','video'].includes(itemKind(item)))continue; if(!selected(item)) entries.push({key:itemKey(item),item,selected:false,order:0}); panel.querySelector('.native-gallery-grid')?.append(makeGalleryTile(item)); } }
    async function loadGallery(reset,forceRequest=false) { if(loading||closed)return; loading=true;const revision=loadRevision;setMessage('Loading your Gallery…');panel.replaceChildren(); try { const access=await ensureAccess(forceRequest); if(closed||revision!==loadRevision)return; if(!albums.length && bridge.listAlbums){const result=await bridge.listAlbums({mediaType:mediaModeType});albums=Array.isArray(result?.albums)?result.albums:[];} if(closed||revision!==loadRevision)return; panel.replaceChildren(); if(albums.length){const wrap=icon('label','native-album-control','Album');const select=icon('select','');select.setAttribute('aria-label','Choose album');const all=icon('option','','All media');all.value='';select.append(all);for(const album of albums){const o=icon('option','',album.name||'Album');o.value=String(album.id);select.append(o);}select.value=albumId||'';select.onchange=()=>{loadRevision++;loading=false;albumId=select.value||null;page=0;entries=entries.filter(e=>e.selected);void loadGallery(true);};wrap.append(select);panel.append(wrap);} let grid=icon('div','native-gallery-grid');grid.setAttribute('role','group');grid.setAttribute('aria-label','Gallery media');panel.append(grid); if(typeof root.IntersectionObserver==='function'){thumbObserver?.disconnect();thumbObserver=new root.IntersectionObserver(entries=>{for(const e of entries)if(e.isIntersecting){thumbObserver.unobserve(e.target);const item=itemsByImage.get(e.target);if(item)queueThumbnail(item,e.target);}}, {root:panel,rootMargin:'240px'});} const offset=reset?0:page*PAGE_SIZE; const result=await bridge.listMedia({mediaType:mediaModeType,albumId:albumId||undefined,limit:PAGE_SIZE,offset}); if(closed||revision!==loadRevision)return; const items=Array.isArray(result?.items)?result.items:[]; renderGallery(items,true); page=Math.floor(offset/PAGE_SIZE)+1;hasMore=Boolean(result?.hasMore); const more=icon('button','native-picker-action',hasMore?'Load more':'');more.type='button';more.dataset.more='';more.hidden=!hasMore;more.onclick=()=>void loadMoreGallery();panel.append(more);if(!items.length)setMessage('No media in this album.'); else setMessage(['limited','partial'].includes(statusText(access)||statusText(result))?'Limited access: showing permitted media.':''); if(['limited','partial'].includes(statusText(access)||statusText(result))) {const retry=icon('button','native-picker-action','Manage Gallery access');retry.type='button';retry.onclick=()=>void loadGallery(true,true);panel.prepend(retry);} }
      catch(error){if(closed||revision!==loadRevision)return;setMessage(error?.message||'Could not load Gallery. Retry access or try again.','error');const retry=icon('button','native-picker-action','Retry');retry.type='button';retry.onclick=()=>void loadGallery(true,true);panel.append(retry);} finally {if(revision===loadRevision)loading=false;} }
    const itemsByImage=new WeakMap();
    async function loadMoreGallery(){if(loading||!hasMore)return;loading=true;const revision=loadRevision;const more=panel.querySelector('[data-more]');if(more)more.disabled=true;setMessage('Loading more media…');try{const offset=page*PAGE_SIZE;const result=await bridge.listMedia({mediaType:mediaModeType,albumId:albumId||undefined,limit:PAGE_SIZE,offset});if(closed||revision!==loadRevision)return;const items=Array.isArray(result?.items)?result.items:[];renderGallery(items,true);page++;hasMore=Boolean(result?.hasMore);if(more){more.hidden=!hasMore;more.disabled=false;more.textContent=hasMore?'Load more':'';}setMessage('');}catch(error){if(revision===loadRevision){setMessage(error?.message||'Could not load more media.','error');if(more)more.disabled=false;}}finally{if(revision===loadRevision)loading=false;}}
    function makeFileRow(item) { const row=icon('button','native-file-row');row.type='button';row.dataset.filePath=String(item.path||'');row.append(icon('span',item.isDirectory?'native-file-icon is-folder':'native-file-icon',item.isDirectory?'▰':'▤'),icon('span','native-file-copy',pathName(item)),icon('small','native-file-size',item.isDirectory?'Folder':`${mimeOf(item)} · ${Number(item.size||0)} bytes`));row.onclick=()=>{if(item.isDirectory)void navigateFiles(item.path);else {let e=selected(item);if(!e){e={key:itemKey(item),item,selected:false,order:0};entries.push(e);}if(photo)for(const other of entries)other.selected=false;e.selected=!e.selected;e.order=e.selected?++selectionOrder:0;renderFileSelection();updateCount();}};return row; }
    function renderFileSelection(){for(const row of panel.querySelectorAll('[data-file-path]')){const e=entries.find(x=>String(x.item.path)===row.dataset.filePath);row.classList.toggle('is-selected',Boolean(e?.selected));}}
    function renderFiles(items, append=false){let list=panel.querySelector('.native-files-list');if(!list){list=icon('div','native-files-list');panel.append(list);}if(!append)list.replaceChildren();for(const item of items||[])list.append(makeFileRow(item));if(!items?.length&&!append)list.append(icon('p','native-picker-empty','This folder is empty.'));}
    function showFileGate(state){panel.replaceChildren(icon('p','native-picker-empty','Files access lets Stemma browse shared device storage so you can choose a document or original media file. It is separate from Gallery access and will be requested only after you tap Grant access.'));if(state?.fileAccess){void loadFiles(true);return;}const grant=icon('button','native-picker-action','Grant Files access');grant.type='button';grant.onclick=()=>void grantFileAccess();panel.append(grant);}
    async function prepareFiles(){const revision=loadRevision;let state;try{state=bridge.getAccess?await bridge.getAccess():null;}catch{}if(closed||revision!==loadRevision||category!=='Files')return;if(state?.fileAccess){await loadFiles(true);return;}showFileGate(state);}
    async function grantFileAccess(){const revision=loadRevision;if(!bridge.requestFileAccess){setMessage('Files access is unavailable in this app version.','error');return;}setMessage('Opening storage access settings…');try{const state=await bridge.requestFileAccess();if(closed||revision!==loadRevision||category!=='Files')return;if(state?.fileAccess){loadRevision++;loading=false;await loadFiles(true);}else showFileGate(state);}catch(error){setMessage(error?.message||'Files access was not granted. Retry when ready.','error');showFileGate();}}
    async function loadFiles(reset){if(loading||closed)return;loading=true;const revision=loadRevision;setMessage('Loading device Files…');try{if(!bridge.listFiles)throw new Error('Device Files browsing is unavailable in this app version.');if(reset){fileOffset=0;panel.replaceChildren();}const result=await bridge.listFiles({path:filePath||undefined,limit:PAGE_SIZE,offset:fileOffset});if(closed||revision!==loadRevision)return;filePath=String(result?.path||filePath||'');fileParent=String(result?.parentPath||'');roots=Array.isArray(result?.roots)?result.roots:roots;const bar=icon('div','native-files-nav');const back=icon('button','native-picker-action','Up one folder');back.type='button';back.disabled=!fileParent;back.onclick=()=>void navigateFiles(fileParent);bar.append(back);const rootSelect=icon('select','');rootSelect.setAttribute('aria-label','Browse storage root');for(const r of roots){const p=typeof r==='string'?r:r.path;const o=icon('option','',typeof r==='string'?r:(r.name||r.path||'Storage'));o.value=String(p||'');rootSelect.append(o);}if(roots.length){rootSelect.value=filePath;rootSelect.onchange=()=>void navigateFiles(rootSelect.value);}bar.append(rootSelect);if(reset)panel.append(bar);const items=Array.isArray(result?.items)?result.items:[];renderFiles(items,!reset);renderFileSelection();fileOffset+=items.length;fileMore=Boolean(result?.hasMore);panel.querySelector('[data-files-more]')?.remove();const more=icon('button','native-picker-action',fileMore?'Load more':'');more.type='button';more.dataset.filesMore='';more.hidden=!fileMore;more.onclick=()=>void loadMoreFiles();panel.append(more);setMessage('All file extensions are browsable and uploadable as attachments, including extensionless files. Preview and playback depend on the device; size and destination limits still apply.');}catch(error){if(closed||revision!==loadRevision)return;if(String(error?.code||'')==='PERMISSION_DENIED'){showFileGate();}else{setMessage(error?.message||'Could not browse Files.','error');const retry=icon('button','native-picker-action','Retry');retry.type='button';retry.onclick=()=>void loadFiles(true);panel.append(retry);}}finally{if(revision===loadRevision)loading=false;}}
    async function loadMoreFiles(){if(loading||!fileMore)return;const b=panel.querySelector('[data-files-more]');if(b)b.disabled=true;await loadFiles(false);}
    async function navigateFiles(path){loadRevision++;loading=false;filePath=String(path||'');fileOffset=0;updateCount();await loadFiles(true);}
    function activateReview(){const chosen=entries.filter(e=>e.selected).sort((a,b)=>a.order-b.order);if(!chosen.length)return;panel.hidden=true;review.hidden=false;review.replaceChildren(icon('h3','','Review selection'));for(const e of chosen){const m=e.item;const box=icon('article','native-review-card');box.append(icon('strong','',pathName(m)),icon('small','',`${mimeOf(m)} · ${Number(m.size||0)} bytes${m.isDirectory?' · folder':''}`));review.append(box);}reviewing=true;confirm.textContent=mediaMode?'Use media':photo?'Use photo':'Send';confirm.disabled=false;void previewSelection(chosen[0]);}
    async function previewSelection(entry){
      const kind=itemKind(entry.item);if(!['image','video'].includes(kind))return;
      const previewNode=icon('div','native-selected-preview','Loading preview…');review.prepend(previewNode);
      try{const file=entry.file||await materialize(entry);entry.file=file;if(closed||!reviewing||!previewNode.isConnected)return;
        const url=root.URL.createObjectURL(file);previewURLs.push(url);const player=icon(kind==='video'?'video':'img','');
        if(kind==='video'){player.controls=true;player.playsInline=true;player.preload='metadata';}else player.alt=pathName(entry.item);
        player.onerror=()=>{if(previewNode.isConnected)previewNode.textContent='Preview unavailable on this device. The original file is preserved.';};
        player.src=url;previewNode.replaceChildren(player);if(entry.conversionNote)previewNode.append(icon('small','native-conversion-note',entry.conversionNote));
      }catch(error){if(previewNode.isConnected)previewNode.textContent=error.message||'Preview unavailable.';}
    }
    async function fetchBlob(meta) { const url=meta?.webPath||meta?.url; if(!url)throw new Error('The selected file could not be opened by the app.');const response=await root.fetch(url);if(!response.ok)throw new Error('Could not read the selected file. Choose it again.');const blob=await response.blob();if(!blob.size)throw new Error('The selected file is empty.');const name=String(meta.name||'attachment');const type=String(meta.mimeType||blob.type||'application/octet-stream');let file;if(typeof root.File==='function')file=new root.File([blob],name,{type,lastModified:Date.now()});else{file=blob;try{Object.defineProperty(file,'name',{value:name,configurable:true});}catch{}}try{Object.defineProperty(file,'nativePath',{value:meta.path||meta.nativePath||'',configurable:true});Object.defineProperty(file,'nativeDurationMs',{value:Number(meta.durationMs)||0,configurable:true});}catch{}return file; }
    async function materialize(entry){if(entry.file)return entry.file;if(!entry.pendingFile)entry.pendingFile=readSelectedFile(entry).then(file=>{entry.file=file;return file;}).finally(()=>{entry.pendingFile=null;});return entry.pendingFile;}
    async function readSelectedFile(entry){const item=entry.item;const purpose=mediaMode?'likee':photo?'photo':'attachment';if(purpose!=='attachment')setMessage('Preparing compatible media on your device… Your original stays unchanged.');let meta;if(category==='Files'){if(!bridge.readStorageFile)throw new Error('Reading device files is unavailable in this app version.');meta=await bridge.readStorageFile({path:item.path,purpose});}else{if(!bridge.readFile)throw new Error('Reading Gallery media is unavailable in this app version.');meta=await bridge.readFile({id:String(item.id),mediaType:itemKind(item)==='video'?'video':'all',purpose});}if(meta?.cancelled)throw new Error('Selection was cancelled.');if(meta?.converted){entry.conversionNote=`Prepared ${meta.mimeType||'compatible media'} for upload; your original stays unchanged.`;if(!closed)setMessage(entry.conversionNote);}else if(purpose!=='attachment'&&!closed)setMessage('Media is ready. Your original stays unchanged.');if(Number(meta?.size||item.size||0)>maxBytes)throw new Error(`${pathName(item)} exceeds the ${Math.round(maxBytes/1048576)} MiB size limit.`);const file=await fetchBlob({...item,...meta,name:meta?.name||pathName(item),mimeType:meta?.mimeType||mimeOf(item)});if(file.size>maxBytes)throw new Error(`${file.name} exceeds the ${Math.round(maxBytes/1048576)} MiB size limit.`);return file;}
    async function validateLikeeVideo(blob,nativeItem={}){if(!galleryOnly||!mediaMode||!String(blob.type||'').startsWith('video/'))return;const originalDuration=Number(nativeItem.durationMs ?? nativeItem.duration);if(Number.isFinite(originalDuration)&&originalDuration>MAX_VIDEO_MS)throw new Error('Likee videos must be 4 minutes or shorter.');const nativeDuration=Number(blob.nativeDurationMs>0?blob.nativeDurationMs:(nativeItem.durationMs ?? nativeItem.duration));if(!Number.isFinite(nativeDuration)||nativeDuration<=0)throw new Error('Native video duration could not be read. Choose another video.');if(nativeDuration>MAX_VIDEO_MS)throw new Error('Likee videos must be 4 minutes or shorter.');const url=root.URL.createObjectURL(blob);try{const video=root.document.createElement('video');video.preload='metadata';video.src=url;await new Promise((resolve,reject)=>{const timer=root.setTimeout(()=>reject(new Error('Video duration could not be read. Choose another video.')),15000);video.onloadedmetadata=()=>{root.clearTimeout(timer);if(Number.isFinite(video.duration)&&video.duration>0)resolve();else reject(new Error('Video duration could not be read. Choose another video.'));};video.onerror=()=>{root.clearTimeout(timer);reject(new Error('Video duration could not be read. Choose another video.'));};});if(video.duration*1000>MAX_VIDEO_MS)throw new Error('Likee videos must be 4 minutes or shorter.');}finally{root.URL.revokeObjectURL(url);}}
    async function capture(){if(sending||capturePending||galleryOnly||!bridge.capturePhoto)return;capturePending=true;if(cameraButton)cameraButton.disabled=true;setMessage('Opening camera…');try{const result=await bridge.capturePhoto();if(result?.cancelled){setMessage('Camera cancelled.');return;}const file=await fetchBlob(result);if(!file.type.startsWith('image/'))throw new Error('Camera did not return a photo.');if(file.size>maxBytes)throw new Error('The photo exceeds the size limit.');entries=[{key:`capture-${Date.now()}`,item:{name:file.name,mimeType:file.type,size:file.size,path:file.nativePath},file,selected:true,order:++selectionOrder}];updateCount();activateReview();}catch(error){setMessage(error.message||'Camera capture failed.','error');}finally{capturePending=false;if(cameraButton)cameraButton.disabled=false;}}
    async function commit(){if(sending||!entries.some(e=>e.selected)||!ready()||endpoint()!==target)return;if(!reviewing){activateReview();return;}sending=true;updateCount();confirm.disabled=true;try{const chosen=entries.filter(e=>e.selected).sort((a,b)=>a.order-b.order);for(const entry of chosen){if(closed||signal?.aborted||!ready()||endpoint()!==target)break;const file=entry.file||await materialize(entry);if(closed||controller.signal.aborted||signal?.aborted||!ready()||endpoint()!==target)return;if(!file.size||file.size>maxBytes)throw new Error(`${file.name} must be nonempty and no larger than ${Math.round(maxBytes/1048576)} MiB.`);const kind=itemKind({mimeType:file.type,name:file.name});if(photo&&!mediaMode&&kind!=='image')throw new Error('This action requires a photo. Choose an image from Gallery or Files.');if(mediaMode&&!['image','video'].includes(kind))throw new Error('This action requires a photo or video.');if(category==='Gallery'&&!photo&&!['image','video'].includes(kind))throw new Error('Choose an image or video from Gallery.');if(galleryOnly&&mediaMode&&kind==='video')await validateLikeeVideo(file,entry.item);
          if(photo){if(typeof onSelect!=='function')throw new Error('Photo callback is unavailable.');await onSelect(file);close();return;}
          const ext=file.name.toLowerCase().split('.').pop();const mime=file.type||mimeOf(entry.item);const data=await base64(file);const body={name:file.name,mimeType:mime,data,...extra};const result=await upload({endpoint:target,size:file.size,signal:controller.signal,body,onProgress:state=>{if(!closed)setMessage(`${file.name}: ${state.complete?'Uploaded':'Uploading'} ${state.percent}%`);}});if(!closed&&result?.message)onMessage?.(result.message);entries=entries.filter(e=>e!==entry);void ext;
        }if(!closed){if(!entries.some(e=>e.selected))close();else{reviewing=false;review.hidden=true;panel.hidden=false;setMessage('Chat changed. Close the picker and try again in the intended chat.','error');}}}
      catch(error){if(!closed&&!signal?.aborted)setMessage(`${error.message||'Could not use this file.'} Formats browse broadly; support can vary by destination and device codec.`,'error');}
      finally{if(!closed){sending=false;updateCount();}}
    }
    head.querySelector('[data-confirm]').onclick=()=>void commit(); head.querySelector('[data-close]').onclick=close; head.querySelector('[data-back]').onclick=dismiss; cameraButton?.addEventListener('click',()=>void capture());
    dialog.addEventListener('cancel',e=>{e.preventDefault();dismiss();},{signal:controller.signal});dialog.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();dismiss();}},{signal:controller.signal});
    const visibilityRefresh=()=>{if(closed||root.document.visibilityState==='hidden')return;loadRevision++;loading=false;if(category==='Gallery'){albums=[];void loadGallery(true);}else void prepareFiles();};root.document.addEventListener('visibilitychange',visibilityRefresh,{signal:controller.signal});
    signal?.addEventListener('abort',close,{once:true});root.StemmaParentNavigation?.enter(id,close,{signal});dialog.showModal?.(); if(!dialog.open)dialog.setAttribute('open','');
    void loadGallery(true);return dialog;
  }
  root.StemmaChatAttachments = Object.freeze({ control, render, mount, pickPhoto, pickMedia, upload, MAX_BYTES });
})(typeof window !== 'undefined' ? window : globalThis);
