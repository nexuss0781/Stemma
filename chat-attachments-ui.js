/* Attachment bytes are uploaded to durable account/conversation storage, never localStorage. */
(function attachChatFiles(root) {
  'use strict';
  const MAX_BYTES = 5 * 1024 * 1024;
  const ACCEPT = '.jpg,.jpeg,.png,.webp,.gif,.pdf,.txt,.csv,.zip,.docx,.xlsx,.pptx,.mp3,.wav,.ogg,.mp4,.webm';
  const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', zip: 'application/zip', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm' };
  const clip = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 12 6.5-6.5a3.5 3.5 0 0 1 5 5L10 20a5 5 0 0 1-7-7L13 3a2 2 0 0 1 3 3L6.5 15.5a.8.8 0 0 1-1-1L14 6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  function control() {
    return `<button type="button" class="pulse-attach-button" aria-label="Attach file" title="Attach file · up to 5 MB">${clip}<span class="pulse-attachment-plus" aria-hidden="true">+</span></button><input type="file" class="pulse-attach-input" aria-label="Choose files to attach" accept="${ACCEPT}" multiple hidden>`;
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
  function mount(form, { listen, signal, endpoint, status, onMessage, ready = () => true, extraBody = () => ({}) }) {
    const button = form.querySelector('.pulse-attach-button');
    const picker = form.querySelector('.pulse-attach-input');
    if (!button || !picker) return;
    let uploading = false;
    listen(button, 'click', () => {
      if (uploading || !ready()) return;
      picker.value = ''; picker.click();
    });
    listen(picker, 'change', async () => {
      const files = [...picker.files];
      const target = endpoint();
      if (!files.length || !target || uploading || !ready()) return;
      const extra = extraBody();
      uploading = true; button.disabled = true;
      try {
        for (const file of files) {
          if (!file.size || file.size > MAX_BYTES) throw new Error('Choose a nonempty file up to 5 MB.');
          if (!ACCEPT.split(',').some(ext => file.name.toLowerCase().endsWith(ext))) throw new Error('Use an image, PDF, text/CSV, Office document, ZIP, audio, or video file.');
          if (signal.aborted) return;
          if (endpoint() === target) status.textContent = `Uploading ${file.name}…`;
          const data = await base64(file);
          const response = await fetch(target, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ name: file.name, mimeType: MIME[file.name.toLowerCase().split('.').at(-1)] || file.type, data, ...extra }) });
          let result = {}; try { result = await response.json(); } catch { /* Keep generic errors. */ }
          if (!response.ok) throw new Error(result.error || 'Could not upload the file. Please try again.');
          if (!signal.aborted && endpoint() === target && result.message) onMessage(result.message);
        }
        if (!signal.aborted && endpoint() === target) status.textContent = '';
      } catch (error) {
        if (!signal.aborted && endpoint() === target) status.textContent = error.message;
      } finally {
        uploading = false;
        if (!signal.aborted) { button.disabled = false; picker.value = ''; }
      }
    });
  }
  root.StemmaChatAttachments = Object.freeze({ control, render, mount, MAX_BYTES });
})(typeof window !== 'undefined' ? window : globalThis);
