/* Attachment bytes are uploaded to durable account/conversation storage, never localStorage. */
(function attachChatFiles(root) {
  'use strict';
  const MAX_BYTES = 5 * 1024 * 1024;
  const ACCEPT = '.jpg,.jpeg,.png,.webp,.gif,.pdf,.txt,.csv,.zip,.docx,.xlsx,.pptx,.mp3,.wav,.ogg,.mp4,.webm';
  const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', zip: 'application/zip', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm' };
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
  function mount(form, { listen, signal, endpoint, status, onMessage, ready = () => true, extraBody = () => ({}) }) {
    const button = form.querySelector('.pulse-attach-button');
    const picker = form.querySelector('.pulse-attach-input');
    if (!button || !picker) return;
    let modal = null;
    listen(button, 'click', () => {
      if (modal || !ready() || signal.aborted) return;
      const target = endpoint();
      if (!target) return;
      const extra = extraBody();
      const id = `attachment-picker-${++pickerSerial}`;
      const dialog = root.document.createElement('dialog');
      dialog.className = 'pulse-attachment-dialog';
      dialog.setAttribute('aria-labelledby', `${id}-title`);
      dialog.setAttribute('aria-describedby', `${id}-help`);
      dialog.innerHTML = `<div class="attachment-sheet"><div class="attachment-handle" aria-hidden="true"></div>
        <header class="attachment-header"><button type="button" data-attachment-back aria-label="Back to chat">←</button><div><h2 id="${id}-title">Attach to chat</h2><p>Review before sending</p></div><button type="button" data-attachment-cancel>Cancel</button></header>
        <p class="attachment-help" id="${id}-help">Only files you choose are accessed. Up to 5 MB per file.</p>
        <div class="attachment-source"><label for="${id}-source">Source</label><select id="${id}-source" aria-label="Album or source"><option value="all">All selected items</option><option value="image">Selected images</option><option value="video">Selected videos</option><option value="file">Selected files</option></select><button type="button" data-attachment-browse>Choose photos or videos</button></div>
        <div class="attachment-content"><div class="attachment-empty"><span aria-hidden="true">${clip}</span><h3>Your selection starts here</h3><p>Tap Gallery or File to choose items from your device. Albums and folders are available in your system picker.</p></div><div class="attachment-grid" role="group" aria-label="Chosen files"></div><section class="attachment-preview" aria-label="File preview" hidden><button type="button" data-preview-close>Back to selection</button><div class="attachment-preview-media"></div><p class="attachment-preview-name"></p></section></div>
        <p class="attachment-feedback" role="status" aria-live="polite"></p>
        <div class="attachment-confirm"><span data-attachment-count>Nothing selected</span><button type="button" data-attachment-send disabled>Send selected</button></div>
        <div class="attachment-tray" role="group" aria-label="Attachment categories">${[['Gallery', '<rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 6-6 4 4 3-3 5 5"/>'], ['File', '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zm0 0v6h6"/>'], ['Location', '<path d="M20 10c0 6-8 11-8 11S4 16 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="3"/>'], ['Article', '<rect x="4" y="3" width="16" height="18" rx="3"/><path d="M8 8h8M8 12h8M8 16h5"/>'], ['Poll', '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M8 16v-5m4 5V7m4 9v-3"/>'], ['Contact', '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="9" r="3"/><path d="M6 19a6 6 0 0 1 12 0"/>']].map(([name, icon], index) => `<button type="button" data-attachment-category="${name}" ${index > 1 ? 'disabled aria-disabled="true" title="Not available yet"' : ''}><span aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${icon}</svg></span><strong>${name}</strong>${index > 1 ? '<small>Not available</small>' : ''}</button>`).join('')}</div>
        <input type="file" data-modal-input aria-label="Choose attachment files" multiple hidden>
      </div>`;
      root.document.body.append(dialog);
      modal = dialog;
      const key = id;
      const controller = new AbortController();
      const localInput = dialog.querySelector('[data-modal-input]');
      const grid = dialog.querySelector('.attachment-grid');
      const empty = dialog.querySelector('.attachment-empty');
      const feedback = dialog.querySelector('.attachment-feedback');
      const source = dialog.querySelector('select');
      const preview = dialog.querySelector('.attachment-preview');
      const media = dialog.querySelector('.attachment-preview-media');
      const confirm = dialog.querySelector('[data-attachment-send]');
      const browse = dialog.querySelector('[data-attachment-browse]');
      let entries = [], serial = 0, sending = false, category = 'Gallery', closed = false;
      function close() {
        if (closed) return;
        closed = true; controller.abort();
        for (const item of entries) if (item.url) root.URL.revokeObjectURL(item.url);
        signal.removeEventListener('abort', close);
        root.StemmaParentNavigation?.forget(key);
        dialog.close(); dialog.remove(); modal = null;
        if (!signal.aborted && button.isConnected) button.focus({ preventScroll: true });
      }
      function dismiss() {
        if (!root.StemmaParentNavigation?.back(key)) close();
      }
      function choose(nextCategory) {
        if (sending || closed) return;
        category = nextCategory;
        localInput.accept = category === 'Gallery' ? '.jpg,.jpeg,.png,.webp,.gif,.mp4,.webm' : ACCEPT;
        localInput.value = '';
        browse.textContent = category === 'Gallery' ? 'Choose photos or videos' : 'Choose files';
        for (const item of dialog.querySelectorAll('[data-attachment-category]')) item.setAttribute('aria-pressed', String(item.dataset.attachmentCategory === category));
        localInput.click();
      }
      function element(tag, className, text) {
        const node = root.document.createElement(tag); node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
      }
      function kind(file) {
        const mime = MIME[file.name.toLowerCase().split('.').at(-1)] || '';
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
        preview.hidden = false; grid.hidden = empty.hidden = true;
        preview.querySelector('button').focus({ preventScroll: true });
      }
      function paint() {
        preview.hidden = true; media.replaceChildren(); grid.hidden = false;
        grid.replaceChildren();
        const visible = entries.filter(item => source.value === 'all' || item.kind === source.value);
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
          checkbox.addEventListener('change', () => { item.selected = checkbox.checked; updateCount(); }, { signal: controller.signal });
          label.append(checkbox, element('span', '', item.file.name));
          card.append(open, label, element('small', '', sizeLabel(item.file.size))); grid.append(card);
        }
        if (entries.length && !visible.length) grid.append(element('p', '', 'No chosen items in this source.'));
        updateCount();
      }
      function updateCount() {
        const count = entries.filter(item => item.selected).length;
        dialog.querySelector('[data-attachment-count]').textContent = count ? `${count} selected` : 'Nothing selected';
        confirm.textContent = sending ? 'Sending…' : count ? `Send ${count} ${count === 1 ? 'item' : 'items'}` : 'Send selected';
        confirm.disabled = sending || !count;
      }
      localInput.addEventListener('change', () => {
        const errors = [];
        for (const file of [...localInput.files]) {
          if (!file.size || file.size > MAX_BYTES) { errors.push(`${file.name}: choose a nonempty file up to 5 MB.`); continue; }
          if (!ACCEPT.split(',').some(ext => file.name.toLowerCase().endsWith(ext))) { errors.push(`${file.name}: unsupported file type.`); continue; }
          if (entries.some(item => item.file.name === file.name && item.file.size === file.size && item.file.lastModified === file.lastModified)) continue;
          entries.push({ id: ++serial, file, kind: kind(file), selected: true, url: root.URL.createObjectURL(file) });
        }
        feedback.textContent = errors.join(' '); localInput.value = ''; paint();
      }, { signal: controller.signal });
      source.addEventListener('change', paint, { signal: controller.signal });
      browse.addEventListener('click', () => choose(category), { signal: controller.signal });
      for (const item of dialog.querySelectorAll('[data-attachment-category]:not([disabled])')) item.addEventListener('click', () => choose(item.dataset.attachmentCategory), { signal: controller.signal });
      for (const item of dialog.querySelectorAll('[data-attachment-back], [data-attachment-cancel]')) item.addEventListener('click', dismiss, { signal: controller.signal });
      dialog.querySelector('[data-preview-close]').addEventListener('click', () => { paint(); grid.querySelector('button')?.focus(); }, { signal: controller.signal });
      dialog.addEventListener('cancel', event => { event.preventDefault(); dismiss(); }, { signal: controller.signal });
      dialog.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(); } }, { signal: controller.signal });
      confirm.addEventListener('click', async () => {
        if (sending || !entries.some(item => item.selected) || !ready() || endpoint() !== target) return;
        sending = true; paint(); browse.disabled = source.disabled = true;
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
          if (!closed) { if (!entries.some(item => item.selected)) dismiss(); else feedback.textContent = 'Chat changed. Close the picker and try again in the intended chat.'; }
        } catch (error) {
          // Do not automatically retry a request whose delivery may be uncertain.
          if (!closed && !signal.aborted) { feedback.textContent = `${error.message} Check the chat before selecting and sending again.`; entries.forEach(item => { item.selected = false; }); }
        } finally {
          if (!closed) { sending = false; browse.disabled = source.disabled = false; for (const item of dialog.querySelectorAll('[data-attachment-category="Gallery"], [data-attachment-category="File"]')) item.disabled = false; paint(); }
        }
      }, { signal: controller.signal });
      signal.addEventListener('abort', close, { once: true });
      root.StemmaParentNavigation?.enter(key, close, { signal });
      dialog.showModal(); dialog.querySelector('[data-attachment-category="Gallery"]').setAttribute('aria-pressed', 'true');
      browse.focus({ preventScroll: true });
    });
  }
  root.StemmaChatAttachments = Object.freeze({ control, render, mount, MAX_BYTES });
})(typeof window !== 'undefined' ? window : globalThis);
