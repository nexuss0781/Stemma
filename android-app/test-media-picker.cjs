const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'chat-attachments-ui.js'), 'utf8');
const calls = [];
const media = {
  getAccess: async () => ({ status: 'partial', fileAccess: false }),
  requestAccess: async () => ({ status: 'granted', fileAccess: false }),
  listAlbums: async options => { calls.push(['listAlbums', options]); return { albums: [] }; },
  listMedia: async options => { calls.push(['listMedia', options]); return { items: [], hasMore: false }; },
  thumbnail: async options => ({ webPath: `thumbnail:${options.id}` }),
  readFile: async options => ({ ...options, path: '/app/cache/media.bin', webPath: 'webview://media.bin', name: 'media.bin', mimeType: 'image/png', size: 4 }),
  requestFileAccess: async () => ({ fileAccess: true }),
  listFiles: async options => { calls.push(['listFiles', options]); return { items: [], roots: [{ name: 'Internal', path: '/storage/emulated/0' }], path: options.path || '/storage/emulated/0', parentPath: null, hasMore: false }; },
  readStorageFile: async options => ({ ...options, path: '/app/cache/original.bin', webPath: 'webview://original.bin', name: 'original.bin', mimeType: 'application/octet-stream', size: 4 }),
  capturePhoto: async () => ({ cancelled: true })
};
let nativeUpload;
const window = {
  StemmaNative: {
    media,
    upload: async options => { nativeUpload = options; options.onProgress({ percent: 100, loaded: 4, total: 4, complete: true }); return { accepted: true }; }
  }
};
vm.runInNewContext(source, { window, Blob, AbortController, Promise, console, URL, setTimeout, clearTimeout });
const api = window.StemmaChatAttachments;
assert.ok(api, 'global picker contract is exported');
for (const name of ['control', 'render', 'mount', 'pickPhoto', 'pickMedia', 'upload', 'MAX_BYTES']) assert.ok(name in api, `exports ${name}`);
assert.equal(api.MAX_BYTES, 5 * 1024 * 1024);
assert.doesNotMatch(api.control(), /<input\b[^>]*type=["']file/i, 'Android attachment control contains no OS file input');
assert.doesNotMatch(source, /<input\b[^>]*type=["']file/i, 'Android override contains no hidden file chooser inputs');
assert.doesNotMatch(source, /localInput\.click|cameraInput\.click|selectFile\(/, 'picker does not activate a system chooser');
assert.match(source, /bridge\.listMedia\(\{mediaType:mediaModeType/);
assert.match(source, /bridge\.listAlbums\(\{mediaType:mediaModeType\}/);
assert.match(source, /bridge\.requestFileAccess\(\)/, 'Files access is requested only by its explicit grant action');
assert.match(source, /bridge\.listFiles\(\{path:filePath\|\|undefined,limit:PAGE_SIZE,offset:fileOffset\}\)/);
assert.match(source, /bridge\.readStorageFile\(\{path:item\.path\}\)/);
assert.match(source, /Likee videos must be 4 minutes or shorter/i);
assert.match(source, /Video duration could not be read/);
assert.match(source, /all file extensions are browsable/i);
assert.match(source, /visibilitychange/);
assert.match(source, /revision!==loadRevision/);
assert.match(source, /categories = \['Gallery', \.\.\.\(!galleryOnly \? \['Files'\] : \[\]\)\]/, 'Likee galleryOnly suppresses Files');

const button = { isConnected: true, focus() {} };
let mounted = false;
api.mount({ querySelector: selector => selector === '.pulse-attach-button' ? button : null }, { listen: (target, event, listener) => { mounted = target === button && event === 'click' && typeof listener === 'function'; } });
assert.equal(mounted, true, 'existing mount contract works without a hidden input');

(async () => {
  const body = new Blob(['test'], { type: 'video/mp4' });
  Object.defineProperty(body, 'nativePath', { value: '/app/private/video.mp4' });
  const progress = [];
  const result = await api.upload({ endpoint: '/api/likee/videos', body, size: 4, signal: new AbortController().signal, contentType: 'video/mp4', headers: { 'X-Likee-Caption': 'mock' }, onProgress: state => progress.push(state) });
  assert.deepEqual(result, { accepted: true });
  assert.equal(nativeUpload.endpoint, '/api/likee/videos');
  assert.equal(nativeUpload.body.nativePath, '/app/private/video.mp4');
  assert.equal(nativeUpload.contentType, 'video/mp4');
  assert.equal(nativeUpload.headers['X-Likee-Caption'], 'mock');
  assert.ok(progress.some(state => state.percent === 0));
  assert.equal(calls.length, 0, 'bridge operations remain lazy until a picker surface is opened');
  console.log('media picker mock tests: exports, callbacks, native upload, scoped permissions, and no-chooser checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
