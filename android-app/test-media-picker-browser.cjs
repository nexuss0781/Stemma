const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch { console.log('media picker DOM tests skipped (optional jsdom is not installed)'); process.exit(0); }
const source = fs.readFileSync(path.join(__dirname, 'chat-attachments-ui.js'), 'utf8');
const tick = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, message) { for (let i=0; i<120; i++) { if (test()) return; await tick(10); } throw new Error(`Timed out: ${message}`); }

(async () => {
  const dom = new JSDOM('<!doctype html><html><body><button id="likee">Choose</button><form id="form"><button class="pulse-attach-button" type="button">Attach</button></form></body></html>', { url: 'https://stemma.test/', pretendToBeVisual: true });
  const w = dom.window;
  w.HTMLMediaElement.prototype.pause = function () {};
  w.HTMLMediaElement.prototype.load = function () {};
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event('close')); };
  let blobUrl = 0;
  w.URL.createObjectURL = () => `blob:mock-${++blobUrl}`;
  w.URL.revokeObjectURL = () => {};
  const makeBlob = type => new w.Blob(['original bytes'], { type });
  Object.defineProperty(w.document, 'visibilityState', { configurable: true, get: () => 'visible' });
  const originalCreate = w.document.createElement.bind(w.document);
  w.document.createElement = function (tag) {
    const node = originalCreate(tag);
    if (tag.toLowerCase() === 'video') {
      let src = '';
      Object.defineProperty(node, 'duration', { configurable: true, value: 240 });
      Object.defineProperty(node, 'src', { configurable: true, get: () => src, set: value => { src = value; queueMicrotask(() => node.dispatchEvent(new w.Event('loadedmetadata'))); } });
    }
    return node;
  };
  const mediaCalls = [];
  const likeeItems = [
    { id: '7', mediaType: 'image', mimeType: 'image/jpeg', name: 'photo.jpg', size: 13, source: 'mediaStore' },
    { id: '7', mediaType: 'video', mimeType: 'video/mp4', name: 'four-minutes.mp4', size: 13, durationMs: 240000, source: 'mediaStore' }
  ];
  let fileGrant = false, filePath = '/storage/emulated/0';
  const native = {
    getAccess: async () => ({ status: 'granted', fileAccess: fileGrant }),
    requestAccess: async () => ({ status: 'granted', fileAccess: fileGrant }),
    listAlbums: async options => { mediaCalls.push(['albums', options]); return { status: 'granted', albums: [{ id: 'album-camera', name: 'Camera Roll' }] }; },
    listMedia: async options => { mediaCalls.push(['media', options]); return { status: 'granted', items: likeeItems, hasMore: false }; },
    thumbnail: async ({ id, mediaType }) => ({ webPath: `thumb://${mediaType}/${id}` }),
    readFile: async ({ id, mediaType }) => ({ path: `/app/cache/${mediaType}-${id}`, webPath: `native://${mediaType}-${id}`, name: mediaType === 'video' ? 'four-minutes.mp4' : 'photo.jpg', mimeType: mediaType === 'video' ? 'video/mp4' : 'image/jpeg', size: 13, durationMs: mediaType === 'video' ? likeeItems[1].durationMs : undefined }),
    requestFileAccess: async () => { fileGrant = true; return { fileAccess: true }; },
    listFiles: async ({ path: requested, offset }) => {
      filePath = requested || filePath;
      mediaCalls.push(['files', { path: filePath, offset }]);
      const items = filePath.endsWith('/Documents')
        ? [{ path: `${filePath}/odd.extensionless`, name: 'odd.extensionless', isDirectory: false, size: 13, mimeType: 'application/octet-stream', source: 'storage' }]
        : [{ path: `${filePath}/Documents`, name: 'Documents', isDirectory: true, size: 0, mimeType: '', source: 'storage' }];
      return { items, path: filePath, parentPath: filePath === '/storage/emulated/0' ? null : '/storage/emulated/0', roots: [{ name: 'Internal', path: '/storage/emulated/0' }], hasMore: false };
    },
    readStorageFile: async ({ path: selectedPath }) => { mediaCalls.push(['readStorageFile', selectedPath]); return { path: '/app/cache/original-file', webPath: 'native://original-file', name: selectedPath.split('/').pop(), mimeType: 'application/octet-stream', size: 13 }; }
  };
  const reads = [];
  w.fetch = async url => {
    reads.push(String(url));
    const blob = String(url).includes('original-file') ? makeBlob('application/octet-stream') : makeBlob(String(url).includes('video') ? 'video/mp4' : 'image/jpeg');
    return { ok: true, status: 200, blob: async () => blob };
  };
  let xhrBody;
  class MockXHR {
    constructor() { this.upload = {}; this.status = 200; this.responseText = '{"message":"saved"}'; this.headers = {}; }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(k,v) { this.headers[k] = v; }
    send(body) { xhrBody = body; queueMicrotask(() => { this.onload?.(); this.onloadend?.(); }); }
    abort() { this.onabort?.(); }
  }
  w.XMLHttpRequest = MockXHR;
  w.StemmaNative = { media: native, upload: async () => null };
  vm.runInNewContext(source, { window: w, Blob: w.Blob, File: w.File, FileReader: w.FileReader, AbortController: w.AbortController, URL: w.URL, Promise, console, setTimeout: w.setTimeout.bind(w), clearTimeout: w.clearTimeout.bind(w) });
  const api = w.StemmaChatAttachments;

  // Likee uses galleryOnly and must see both same-ID image and video entries; 240s is accepted.
  let selectedBlob = null;
  const likeeButton = w.document.querySelector('#likee');
  const likeeDialog = api.pickMedia({ button: likeeButton, galleryOnly: true, maxBytes: 256 * 1024 * 1024, ready: () => true, onSelect: blob => { selectedBlob = blob; } });
  assert.ok(likeeDialog, 'Likee picker opened');
  await until(() => likeeDialog.querySelectorAll('.native-gallery-tile').length >= 2, 'both image and video tiles rendered');
  assert.deepEqual([...likeeDialog.querySelectorAll('[data-attachment-category]')].map(x => x.textContent), ['Gallery'], 'Likee exposes Gallery only');
  await until(() => likeeDialog.querySelector('.native-album-control select'), 'album selector appears');
  const album = likeeDialog.querySelector('.native-album-control select');
  assert.ok([...album.options].some(option => option.textContent === 'Camera Roll'), 'native album names are shown');
  album.value = 'album-camera'; album.dispatchEvent(new w.Event('change', { bubbles: true }));
  await until(() => mediaCalls.some(call => call[0] === 'media' && call[1].albumId === 'album-camera'), 'selected album is sent to native listing');
  await until(() => likeeDialog.querySelector('input[aria-label="Select four-minutes.mp4"]'), 'album media renders');
  assert.equal(likeeDialog.querySelector('[data-camera]'), null, 'Likee markup has no camera control');
  assert.equal(likeeDialog.querySelector('.native-camera-tile'), null, 'Likee Gallery has no camera tile');
  assert.equal(likeeDialog.querySelectorAll('[data-native-key]').length, 2, 'same numeric image/video IDs remain separate tiles');
  const videoCheck = likeeDialog.querySelector('input[aria-label="Select four-minutes.mp4"]');
  assert.ok(videoCheck, 'galleryOnly lists video as well as photo');
  videoCheck.checked = true; videoCheck.dispatchEvent(new w.Event('change', { bubbles: true }));
  likeeDialog.querySelector('[data-confirm]').click(); // metadata review
  likeeDialog.querySelector('[data-confirm]').click(); // Use media callback
  await until(() => selectedBlob, 'Likee callback receives a File/Blob');
  assert.equal(selectedBlob.type, 'video/mp4');
  assert.equal(selectedBlob.nativePath, '/app/cache/video-7');
  assert.equal(JSON.stringify(mediaCalls.find(x => x[0] === 'media')[1]), JSON.stringify({ mediaType: 'all', albumId: undefined, limit: 60, offset: 0 }));
  assert.equal(reads.length, 1);
  assert.equal(w.document.querySelectorAll('input[type="file"]').length, 0, 'no hidden chooser inputs exist');

  async function tryVideo(duration, expectedMessage) {
    likeeItems[1].durationMs = duration;
    const before = selectedBlob;
    const dialog = api.pickMedia({ button: likeeButton, galleryOnly: true, maxBytes: 256 * 1024 * 1024, ready: () => true, onSelect: blob => { selectedBlob = blob; } });
    await until(() => dialog.querySelector('input[aria-label="Select four-minutes.mp4"]'), 'video tile rendered for duration check');
    const choice = dialog.querySelector('input[aria-label="Select four-minutes.mp4"]'); choice.checked = true; choice.dispatchEvent(new w.Event('change', { bubbles: true }));
    dialog.querySelector('[data-confirm]').click(); dialog.querySelector('[data-confirm]').click();
    await until(() => dialog.querySelector('.native-picker-message').textContent.includes(expectedMessage), 'duration validation fails closed');
    assert.equal(selectedBlob, before, 'invalid duration never reaches the media callback');
    dialog.querySelector('[data-close]').click();
    await tick(0);
  }
  await tryVideo(240001, '4 minutes or shorter');
  await tryVideo(undefined, 'Native video duration could not be read');

  // pickPhoto remains photo-only and returns a Blob/File through its existing callback contract.
  let photoBlob = null;
  const photoDialog = api.pickPhoto({ button: likeeButton, onSelect: blob => { photoBlob = blob; } });
  await until(() => photoDialog.querySelector('input[aria-label="Select photo.jpg"]'), 'photo-only Gallery item renders');
  assert.equal(photoDialog.querySelectorAll('.native-gallery-tile:not(.native-camera-tile)').length, 1, 'pickPhoto filters videos but keeps photos');
  assert.ok(mediaCalls.some(call => call[0] === 'albums' && call[1].mediaType === 'images'), 'pickPhoto asks native API for images only');
  photoDialog.querySelector('input[aria-label="Select photo.jpg"]').click();
  photoDialog.querySelector('[data-confirm]').click(); photoDialog.querySelector('[data-confirm]').click();
  await until(() => photoBlob, 'pickPhoto callback receives selected image');
  assert.equal(photoBlob.type, 'image/jpeg');

  // General attachment browsing requests shared-files permission only after the Files tab, then lists unrestricted names.
  const form = w.document.querySelector('#form'); let clickHandler;
  api.mount(form, { endpoint: () => '/api/pulse/attachments', listen: (_button, _event, cb) => { clickHandler = cb; } });
  clickHandler();
  const attachDialog = w.document.querySelector('dialog.native-picker');
  await until(() => attachDialog.querySelectorAll('[data-attachment-category]').length >= 2, 'attachment tabs rendered');
  await until(() => attachDialog.querySelector('.native-camera-tile'), 'regular Gallery camera tile rendered');
  assert.ok(attachDialog.querySelector('.native-camera-tile'), 'regular Gallery puts Camera first');
  attachDialog.querySelector('[data-attachment-category="Files"]')?.click();
  await until(() => attachDialog.querySelector('[data-native-files-grant]') || attachDialog.textContent.includes('Grant Files access'), 'explicit files permission explanation appears');
  assert.equal(fileGrant, false, 'switching to Files does not itself grant broad access');
  const grant = [...attachDialog.querySelectorAll('button')].find(b => b.textContent === 'Grant Files access');
  assert.ok(grant, 'clear explicit grant control is available'); grant.click();
  await until(() => attachDialog.querySelector('.native-file-row'), 'storage root listing appears after grant');
  const rootsSelect = attachDialog.querySelector('.native-files-nav select');
  assert.ok(rootsSelect && [...rootsSelect.options].some(option => option.textContent === 'Internal'), 'storage roots are exposed in the Files navigator');
  const directory = attachDialog.querySelector('.native-file-row'); directory.click();
  await until(() => attachDialog.textContent.includes('odd.extensionless'), 'directory contents display without extension filtering');
  const up = [...attachDialog.querySelectorAll('.native-files-nav button')].find(b => b.textContent.includes('Up one folder'));
  assert.ok(up, 'directory back control is visible'); up.click();
  await until(() => attachDialog.querySelector('.native-file-row'), 'root navigation returns');
  attachDialog.querySelector('.native-file-row').click();
  await until(() => attachDialog.textContent.includes('odd.extensionless'), 're-enter Documents after navigating up');
  attachDialog.querySelector('.native-file-row').click();
  attachDialog.querySelector('[data-confirm]').click();
  attachDialog.querySelector('[data-confirm]').click();
  await until(() => xhrBody, 'selected original file reaches existing JSON uploader');
  const payload = JSON.parse(xhrBody);
  assert.equal(payload.name, 'odd.extensionless');
  assert.equal(payload.mimeType, 'application/octet-stream');
  assert.ok(payload.data, 'original file bytes are base64 encoded for existing attachment API');
  assert.ok(mediaCalls.some(x => x[0] === 'files'));
  assert.ok(mediaCalls.some(x => x[0] === 'readStorageFile'), 'selected file bytes are read through the scoped native storage API');
  console.log('media picker browser mock tests: Likee photo/video listing and callback, 240s allowance, chooser-free Files grant/navigation, unrestricted extension, and JSON upload passed');
  dom.window.close();
})().catch(error => { console.error(error); process.exitCode = 1; });
