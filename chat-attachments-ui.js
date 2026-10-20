/* Attachment bytes are uploaded to durable account/conversation storage, never localStorage. */
(function attachChatFiles(root) {
  'use strict';
  const MAX_BYTES = 5 * 1024 * 1024;
  const ACCEPT = '.jpg,.jpeg,.png,.webp,.gif,.pdf,.txt,.csv,.zip,.docx,.xlsx,.pptx,.mp3,.wav,.ogg,.mp4,.webm';
  const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', zip: 'application/zip', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm' };
  // Android chooser routing uses MIME filters; validation still uses the original allowlist.
  const PHOTO_MIME = { ...MIME, avif: 'image/avif', bmp: 'image/bmp', heic: 'image/heic', heif: 'image/heif' };
  const GALLERY_ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm';
  const clip = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 12 6.5-6.5a3.5 3.5 0 0 1 5 5L10 20a5 5 0 0 1-7-7L13 3a2 2 0 0 1 3 3L6.5 15.5a.8.8 0 0 1-1-1L14 6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  function control() {
    return `<button type="button" class="pulse-attach-button" aria-label="Attach file" aria-haspopup="dialog" title="Attach file · up to 5 MB">${clip}<span class="pulse-attachment-plus" aria-hidden="true">+</span></button><input type="file" class="pulse-attach-input" aria-label="Choose files to attach" accept="${ACCEPT}" multiple hidden>`;
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
  let pickerSerial = 0;
  function mount(form, options) {
    const button = form.querySelector('.pulse-attach-button');
    if (!button || !form.querySelector('.pulse-attach-input')) return;
    options.listen(button, 'click', () => openPicker(button, options));
  }
  let activePicker = null;
  function pickPhoto({ button, signal = new AbortController().signal, ready = () => true, accept = '.jpg,.jpeg,.png,.webp,.gif,.avif,.bmp,.heic,.heif', maxBytes = 10 * 1024 * 1024, onSelect, title = 'Photo' }) {
    return openPicker(button, { signal, ready, photo: true, accept, maxBytes, onSelect, title, endpoint: () => 'photo' });
  }
  function openPicker(button, { signal, endpoint, onMessage, ready = () => true, extraBody = () => ({}), photo = false, accept = ACCEPT, maxBytes = MAX_BYTES, onSelect, title = 'Attachments' }) {
      if (activePicker || !ready() || signal.aborted) return;
      const target = endpoint();
      if (!target) return;
      const extra = extraBody();
      const id = `attachment-picker-${++pickerSerial}`;
      const dialog = root.document.createElement('dialog');
      dialog.className = 'pulse-attachment-dialog';
      dialog.setAttribute('aria-labelledby', `${id}-title`);
      dialog.setAttribute('aria-describedby', `${id}-help`);
      dialog.innerHTML = `<div class="attachment-sheet"><div class="attachment-handle" aria-hidden="true"></div>
        <header class="attachment-header"><button type="button" data-attachment-back aria-label="Back">←</button><h2 id="${id}-title">${photo ? 'Photo' : 'Attachments'}</h2><button type="button" data-attachment-cancel aria-label="Cancel">×</button></header>
        <p class="visually-hidden" id="${id}-help">Only chosen files are accessed. ${photo ? 'Review your photo before saving.' : 'Up to 5 MB per attachment.'}</p>
        <div class="attachment-content"><div class="attachment-empty"><button type="button" data-attachment-browse aria-label="Choose photos">${clip}<span>Choose photos</span></button></div><div class="attachment-grid" role="group" aria-label="Chosen files"></div><section class="attachment-preview" aria-label="File preview" hidden><button type="button" data-preview-close aria-label="Back to selection">←</button><div class="attachment-preview-media"></div><p class="attachment-preview-name visually-hidden"></p></section></div>
        <p class="attachment-feedback" role="status" aria-live="polite"></p>
        <div class="attachment-confirm"><button type="button" data-attachment-add aria-label="Add photos or files">+</button><span data-attachment-count aria-live="polite"></span><button type="button" data-attachment-send disabled aria-label="${photo ? 'Use photo' : 'Send selected'}">${photo ? 'Use photo' : 'Send'}</button></div>
        <div class="attachment-tray"><div role="tablist" aria-label="Attachment type">${[['Gallery', '<rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 6-6 4 4 3-3 5 5"/>'], ['File', '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zm0 0v6h6"/>']].map(([name, icon]) => `<button type="button" role="tab" aria-selected="${name === 'Gallery'}" data-attachment-category="${name}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">${icon}</svg><strong>${name}</strong></button>`).join('')}</div><button type="button" data-attachment-camera aria-label="Camera"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M8 6l2-3h4l2 3h4a1 1 0 0 1 1 1v13H3V7a1 1 0 0 1 1-1z"/><circle cx="12" cy="12.5" r="4"/></svg><strong>Camera</strong></button></div>
        <input type="file" data-modal-input aria-label="Choose attachment files" ${photo ? '' : 'multiple'} hidden>
        <input type="file" data-camera-input accept="image/*" capture="environment" aria-label="Take photo" hidden>
      </div>`;
      root.document.body.append(dialog);
      activePicker = dialog;
      const key = id;
      const controller = new AbortController();
      const localInput = dialog.querySelector('[data-modal-input]');
      const grid = dialog.querySelector('.attachment-grid');
      const empty = dialog.querySelector('.attachment-empty');
      const feedback = dialog.querySelector('.attachment-feedback');
      const cameraInput = dialog.querySelector('[data-camera-input]');
      const preview = dialog.querySelector('.attachment-preview');
      const media = dialog.querySelector('.attachment-preview-media');
      const confirm = dialog.querySelector('[data-attachment-send]');
      const browse = dialog.querySelector('[data-attachment-browse]');
      let entries = [], serial = 0, sending = false, category = 'Gallery', closed = false, afterPreview = null;
      const galleryAccept = photo ? [...new Set(accept.split(',').map(ext => PHOTO_MIME[ext.trim().replace(/^\./, '')]).filter(Boolean))].join(',') || 'image/*' : GALLERY_ACCEPT;
      localInput.accept = galleryAccept;
      const guidance = root.document.createElement('small');
      guidance.className = 'attachment-device-help';
      guidance.textContent = 'Tap Gallery to open your device photo chooser. Only photos you choose appear here; your library is not scanned.';
      empty.append(guidance);
      function close() {
        if (closed) return;
        closed = true; controller.abort();
        for (const item of entries) if (item.url) root.URL.revokeObjectURL(item.url);
        signal.removeEventListener('abort', close);
        root.StemmaParentNavigation?.forget(`${key}-preview`);
        root.StemmaParentNavigation?.forget(key);
        dialog.close(); dialog.remove(); activePicker = null;
        if (!signal.aborted && button.isConnected) button.focus({ preventScroll: true });
      }
      function dismiss() {
        if (sending) return;
        if (!preview.hidden) { leavePreview(); return; }
        if (!root.StemmaParentNavigation?.back(key)) close();
      }
      function choose(nextCategory) {
        if (sending || closed) return;
        category = nextCategory;
        localInput.accept = category === 'Gallery' ? galleryAccept : photo ? accept : ACCEPT;
        localInput.value = '';
        for (const item of dialog.querySelectorAll('[data-attachment-category]')) {
          const selected = item.dataset.attachmentCategory === category;
          item.setAttribute('aria-selected', String(selected));
          item.setAttribute('aria-pressed', String(selected));
        }
        paint();
        browse.querySelector('span').textContent = category === 'Gallery' ? 'Choose photos' : 'Choose files';
        browse.setAttribute('aria-label', category === 'Gallery' ? 'Choose photos' : 'Choose files');
        guidance.textContent = category === 'Gallery' ? 'Tap Gallery to open your device photo chooser. Only photos you choose appear here; your library is not scanned.' : 'Tap File to open your device file chooser. Only files you choose appear here.';
        feedback.textContent = '';
        // Keep this synchronous in the explicit tap handler to preserve browser user activation.
        try { localInput.click(); } catch { feedback.textContent = 'File access is unavailable. Try again in your browser.'; }
      }
      function camera() {
        if (sending || closed) return;
        cameraInput.value = '';
        feedback.textContent = 'If camera capture is unavailable, choose a photo with Gallery.';
        try { cameraInput.click(); } catch { feedback.textContent = 'Camera unavailable. Use Gallery to choose a photo.'; }
      }
      function hidePreview() {
        root.StemmaParentNavigation?.forget(`${key}-preview`);
        paint(); grid.querySelector('button')?.focus({ preventScroll: true });
        const next = afterPreview; afterPreview = null; next?.();
      }
      function leavePreview(next = null) {
        afterPreview = next;
        if (!root.StemmaParentNavigation?.back(`${key}-preview`)) hidePreview();
      }
      function element(tag, className, text) {
        const node = root.document.createElement(tag); node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
      }
      function kind(file) {
        const mime = MIME[file.name.toLowerCase().split('.').at(-1)] || file.type || '';
        return mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : 'file';
      }
      function showPreview(item) {
        media.replaceChildren();
        dialog.querySelector('.attachment-preview-name').textContent = `${item.file.name} · ${sizeLabel(item.file.size)}`;
        if (item.kind === 'image') {
          const image = element('img', ''); image.src = item.url; image.alt = item.file.name; media.append(image);
        } else if (item.kind === 'video' || /^audio\//.test(MIME[item.file.name.toLowerCase().split('.').at(-1)] || '')) {
          const player = element(item.kind === 'video' ? 'video' : 'audio', ''); player.src = item.url; player.controls = true; player.preload = 'metadata'; media.append(player);
        } else if (/\.(txt|csv)$/i.test(item.file.name)) {
          const text = element('pre', '', 'Loading preview…'); media.append(text);
          item.file.slice(0, 16000).text().then(value => { if (!closed && text.isConnected) text.textContent = value; }).catch(() => { text.textContent = 'Preview unavailable. The selected file can still be sent.'; });
        } else media.append(element('p', '', 'This file is ready to attach. An inline preview is not available for this format.'));
        preview.hidden = false; dialog.dataset.preview = 'true'; grid.hidden = empty.hidden = true;
        root.StemmaParentNavigation?.enter(`${key}-preview`, hidePreview, { signal });
        preview.querySelector('button').focus({ preventScroll: true });
      }
      function paint() {
        preview.hidden = true; dialog.dataset.preview = 'false'; media.replaceChildren(); grid.hidden = false;
        grid.replaceChildren();
        const visible = entries.filter(item => category === 'File' || item.kind === 'image' || item.kind === 'video');
        empty.hidden = entries.length > 0;
        for (const item of visible) {
          const card = element('article', 'attachment-tile');
          const open = element('button', 'attachment-thumbnail'); open.type = 'button'; open.setAttribute('aria-label', `Preview ${item.file.name}`);
          if (item.kind === 'image') { const image = element('img', ''); image.src = item.url; image.alt = ''; open.append(image); }
          else { open.append(element('span', 'attachment-type', item.file.name.split('.').at(-1).toUpperCase())); }
          open.addEventListener('click', () => showPreview(item), { signal: controller.signal });
          const label = element('label', 'attachment-select');
          const checkbox = element('input', ''); checkbox.type = 'checkbox'; checkbox.checked = item.selected; checkbox.disabled = sending;
          checkbox.setAttribute('aria-label', `Select ${item.file.name}`);
          checkbox.addEventListener('change', () => { if (photo && checkbox.checked) entries.forEach(other => { other.selected = false; }); item.selected = checkbox.checked; if (photo) paint(); else updateCount(); }, { signal: controller.signal });
          label.append(checkbox, element('span', 'visually-hidden', item.file.name));
          card.append(open, label); grid.append(card);
        }
        if (entries.length && !visible.length) { empty.hidden = false; browse.querySelector('span').textContent = 'Choose photos'; }
        updateCount();
      }
      function updateCount() {
        const count = entries.filter(item => item.selected).length;
        dialog.querySelector('[data-attachment-count]').textContent = count ? String(count) : '';
        confirm.textContent = sending ? '…' : photo ? 'Use photo' : 'Send';
        confirm.disabled = sending || !count;
      }
      function receiveFiles(input) {
        if (!input.files?.length) return;
        const errors = [];
        for (const file of [...input.files]) {
          if (!file.size || file.size > maxBytes) { errors.push(`${file.name}: choose a nonempty file up to ${sizeLabel(maxBytes)}.`); continue; }
          if (!(photo ? accept : ACCEPT).split(',').some(ext => file.name.toLowerCase().endsWith(ext))) { errors.push(`${file.name}: unsupported file type.`); continue; }
          const existing = entries.find(item => item.file.name === file.name && item.file.size === file.size && item.file.lastModified === file.lastModified);
          if (photo) entries.forEach(item => { item.selected = false; });
          if (existing) { existing.selected = true; continue; }
          entries.push({ id: ++serial, file, kind: kind(file), selected: true, url: root.URL.createObjectURL(file) });
        }
        feedback.textContent = errors.join(' '); input.value = ''; paint();
      }
      localInput.addEventListener('change', () => receiveFiles(localInput), { signal: controller.signal });
      localInput.addEventListener('cancel', () => { feedback.textContent = entries.length ? 'No new files chosen. Your previous choices are still here.' : 'No files chosen. Tap Gallery or File and select items in your device chooser.'; }, { signal: controller.signal });
      cameraInput.addEventListener('change', () => receiveFiles(cameraInput), { signal: controller.signal });
      dialog.querySelector('[data-attachment-camera]').addEventListener('click', camera, { signal: controller.signal });
      dialog.querySelector('[data-attachment-add]').addEventListener('click', () => choose(category), { signal: controller.signal });
      browse.addEventListener('click', () => choose(category), { signal: controller.signal });
      for (const item of dialog.querySelectorAll('[data-attachment-category]:not([disabled])')) item.addEventListener('click', () => choose(item.dataset.attachmentCategory), { signal: controller.signal });
      dialog.querySelector('[data-attachment-back]').addEventListener('click', dismiss, { signal: controller.signal });
      dialog.querySelector('[data-attachment-cancel]').addEventListener('click', () => { if (!preview.hidden) leavePreview(dismiss); else dismiss(); }, { signal: controller.signal });
      dialog.querySelector('[data-preview-close]').addEventListener('click', () => leavePreview(), { signal: controller.signal });
      dialog.addEventListener('cancel', event => { event.preventDefault(); dismiss(); }, { signal: controller.signal });
      dialog.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(); } }, { signal: controller.signal });
      confirm.addEventListener('click', async () => {
        if (sending || !entries.some(item => item.selected) || !ready() || endpoint() !== target) return;
        if (!preview.hidden) { leavePreview(() => confirm.click()); return; }
        if (photo) {
          const file = entries.find(item => item.selected)?.file;
          if (!file) return;
          sending = true; updateCount();
          try { await onSelect(file); } catch (error) { sending = false; feedback.textContent = error.message || 'Could not use this photo. Try again.'; updateCount(); return; }
          sending = false;
          if (!closed) { if (!preview.hidden) hidePreview(); dismiss(); }
          return;
        }
        sending = true; paint(); browse.disabled = true;
        dialog.querySelector('[data-attachment-camera]').disabled = true;
        dialog.querySelector('[data-attachment-add]').disabled = true;
        for (const item of dialog.querySelectorAll('[data-attachment-category]:not([disabled])')) item.disabled = true;
        try {
          for (const item of [...entries].filter(item => item.selected)) {
            if (closed || signal.aborted || endpoint() !== target || !ready()) break;
            feedback.textContent = `Uploading ${item.file.name}…`;
            const data = await base64(item.file);
            if (closed || signal.aborted || endpoint() !== target) break;
            const response = await fetch(target, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
              headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ name: item.file.name, mimeType: MIME[item.file.name.toLowerCase().split('.').at(-1)] || item.file.type, data, ...extra }) });
            let result = {}; try { result = await response.json(); } catch { /* Keep generic errors. */ }
            if (!response.ok) throw new Error(result.error || 'Could not upload this file.');
            if (!closed && !signal.aborted && endpoint() === target && result.message) onMessage(result.message);
            entries = entries.filter(entry => entry !== item); root.URL.revokeObjectURL(item.url);
          }
          if (!closed) { if (!entries.some(item => item.selected)) { sending = false; dismiss(); } else feedback.textContent = 'Chat changed. Close the picker and try again in the intended chat.'; }
        } catch (error) {
          // Do not automatically retry a request whose delivery may be uncertain.
          if (!closed && !signal.aborted) { feedback.textContent = `${error.message} Check the chat before selecting and sending again.`; entries.forEach(item => { item.selected = false; }); }
        } finally {
          if (!closed) { sending = false; browse.disabled = false; dialog.querySelector('[data-attachment-camera]').disabled = false; dialog.querySelector('[data-attachment-add]').disabled = false; for (const item of dialog.querySelectorAll('[data-attachment-category="Gallery"], [data-attachment-category="File"]')) item.disabled = false; paint(); }
        }
      }, { signal: controller.signal });
      signal.addEventListener('abort', close, { once: true });
      root.StemmaParentNavigation?.enter(key, close, { signal });
      dialog.showModal(); dialog.querySelector('[data-attachment-category="Gallery"]').setAttribute('aria-pressed', 'true');
      browse.focus({ preventScroll: true });
      return dialog;
  }
  root.StemmaChatAttachments = Object.freeze({ control, render, mount, pickPhoto, MAX_BYTES });
})(typeof window !== 'undefined' ? window : globalThis);
