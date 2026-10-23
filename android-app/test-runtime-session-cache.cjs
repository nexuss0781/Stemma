const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const esbuild = require('esbuild');
const { webcrypto } = require('node:crypto');

(async () => {
  let releaseIndex;
  const indexGate = new Promise(resolve => { releaseIndex = resolve; });
  const disk = new Map();
  const calls = [];
  const plugins = {};
  const nativeFetchCalls = [];
  let currentSession = { authenticated: true, googleProfile: { email: 'alice@example.invalid' } };
  let pendingFetch;
  let releaseLateSession;
  plugins.StemmaPersistence = {
    async load({ key }) {
      calls.push({ plugin: 'StemmaPersistence', method: 'load', key });
      if (key === 'response-index-v2') await indexGate;
      return { value: disk.get(key) ?? null };
    },
    async save({ key, value }) { calls.push({ plugin: 'StemmaPersistence', method: 'save', key }); disk.set(key, value); },
    async remove({ key }) { calls.push({ plugin: 'StemmaPersistence', method: 'remove', key }); disk.delete(key); },
    async flushCookies() { calls.push({ plugin: 'StemmaPersistence', method: 'flushCookies' }); },
    async setSessionActive({ active }) { calls.push({ plugin: 'StemmaPersistence', method: 'setSessionActive', active }); }
  };
  plugins.StemmaTransport = {
    async request({ url, method }) { calls.push({ plugin: 'StemmaTransport', method, url }); return { status: url.endsWith('/auth/logout') ? 204 : 200, body: '{}', contentType: 'application/json' }; },
    async clearPrivateCache() { calls.push({ plugin: 'StemmaTransport', method: 'clearPrivateCache' }); }
  };
  plugins.Network = { async getStatus() { return { connected: true }; }, async addListener() {} };
  plugins.App = { async addListener() {}, async getLaunchUrl() { return {}; }, async minimizeApp() {} };
  plugins.Browser = { async open() {}, async close() {} };
  plugins.Preferences = { async get() { return { value: null }; }, async set() {}, async remove() {} };
  plugins.Filesystem = { async readFile() { throw new Error('no migration snapshot'); }, async deleteFile() {} };
  plugins.StemmaMedia = {};
  const mocks = {
    '@capacitor/core': `export const Capacitor={isNativePlatform:()=>true}; export const registerPlugin=(name)=>globalThis.__plugins[name];`,
    '@capacitor/app': `export const App=globalThis.__plugins.App;`,
    '@capacitor/browser': `export const Browser=globalThis.__plugins.Browser;`,
    '@capacitor/network': `export const Network=globalThis.__plugins.Network;`,
    '@capacitor/preferences': `export const Preferences=globalThis.__plugins.Preferences;`,
    '@capacitor/filesystem': `export const Filesystem=globalThis.__plugins.Filesystem; export const Directory={Data:'DATA'}; export const Encoding={UTF8:'utf8'};`,
    './photo-diagnostics.js': `export const installPhotoDiagnostics=()=>({request:()=>null,response:()=>{},fetchError:()=>{},offline:()=>{}});`,
    './photo-response.js': `export const installPhotoResponseValidation=()=>{};`,
    './package.json': `export default {version:'1.0.8'};`
  };
  const build = await esbuild.build({
    entryPoints: [__dirname + '/mobile-runtime.js'], bundle: true, format: 'iife', platform: 'browser', write: false,
    plugins: [{
      name: 'runtime-test-mocks',
      setup(builder) {
        builder.onResolve({ filter: /^@capacitor\// }, args => ({ path: args.path, namespace: 'test-mock' }));
        builder.onResolve({ filter: /^\.\/native-cache\.js$/ }, () => ({ path: 'native-cache.js', namespace: 'test-mock' }));
        builder.onResolve({ filter: /^\.\/(?:photo-diagnostics|photo-response)\.js$/ }, args => ({ path: args.path, namespace: 'test-mock' }));
        builder.onResolve({ filter: /^\.\/package\.json$/ }, () => ({ path: './package.json', namespace: 'test-mock' }));
        builder.onLoad({ filter: /.*/, namespace: 'test-mock' }, args => {
          if (args.path === 'native-cache.js') {
            const source = fs.readFileSync(__dirname + '/native-cache.js', 'utf8').replace(
              '  async activate(account) {',
              '  async activate(account) { globalThis.__cacheActivations.push(account);'
            );
            return { contents: source, loader: 'js' };
          }
          return { contents: mocks[args.path], loader: args.path.endsWith('.json') ? 'js' : 'js' };
        });
      }
    }]
  });
  const eventNames = [];
  const nativeWindowFetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url, 'https://local.invalid');
    nativeFetchCalls.push(url.pathname);
    if (url.pathname === '/auth/session') {
      if (pendingFetch) {
        const hold = pendingFetch;
        pendingFetch = null;
        return await new Promise(resolve => { releaseLateSession = resolve; });
      }
      return new Response(JSON.stringify(currentSession), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const window = {
    fetch: nativeWindowFetch,
    dispatchEvent(event) { eventNames.push(event.type); return true; },
    addEventListener() {},
    StemmaParentNavigation: null
  };
  const document = {
    body: { append() {} },
    documentElement: { classList: { toggle() {} } },
    addEventListener() {}, createElement() { return {}; }, getElementById() { return null; }, querySelector() { return null; },
    visibilityState: 'visible'
  };
  function XMLHttpRequest() {}
  XMLHttpRequest.prototype.open = function () {};
  XMLHttpRequest.prototype.setRequestHeader = function () {};
  const context = {
    window, document, navigator: { onLine: true }, location: { href: 'https://local.invalid/', origin: 'https://local.invalid', pathname: '/' },
    XMLHttpRequest, __plugins: plugins, __cacheActivations: [], URL, Request, Response, Headers, Event, DOMException, AbortSignal,
    crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array, btoa, setTimeout, clearTimeout,
    history: { length: 1, back() {} }, console, JSON, Date, Promise, Map, Object, String, Number, RegExp, Error, TypeError
  };
  vm.runInNewContext(build.outputFiles[0].text, context, { filename: 'mobile-runtime.bundle.js' });

  // A backend request is held until the durable index has initialized; the request
  // cannot race an empty in-memory account and then overwrite the restored state.
  const firstSession = window.fetch('/auth/session');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(nativeFetchCalls.length, 0, 'network request waits for startup cache initialization');
  releaseIndex();
  await firstSession;
  await window.StemmaNative.ready;
  await window.fetch('/auth/session');
  await window.fetch('/auth/session');
  assert.equal(context.__cacheActivations.length, 1, 'same-account refresh activates the durable cache once');
  assert.equal(calls.filter(call => call.method === 'setSessionActive' && call.active).length, 1, 'same-account refresh activates native session once');
  assert.equal(eventNames.filter(name => name === 'stemma:account-ready').length, 1, 'same-account refresh emits account-ready once');
  assert.equal(window.StemmaNative.account, 'alice@example.invalid');

  // A successful response from a request made before logout cannot restore the
  // account after the logout revision has advanced.
  pendingFetch = {};
  const lateSession = window.fetch('/auth/session');
  while (!releaseLateSession) await new Promise(resolve => setTimeout(resolve, 0));
  const logout = await window.fetch('/auth/logout', { method: 'POST' });
  assert.equal(logout.status, 204);
  releaseLateSession(new Response(JSON.stringify(currentSession), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  await lateSession;
  await window.StemmaNative.flush();
  assert.equal(window.StemmaNative.account, '', 'late verified response cannot restore a logged-out account');
  assert.equal(eventNames.filter(name => name === 'stemma:account-ready').length, 1, 'late response does not re-emit account-ready');
  assert.equal(disk.has('response-index-v2'), false, 'late response cannot recreate a cleared account cache');
  console.log(JSON.stringify({ startupCacheGate: true, sameAccountRefreshIdempotent: true, staleSessionAfterLogoutRejected: true }));
})().catch(error => { console.error(error); process.exitCode = 1; });
