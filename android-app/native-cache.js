import { registerPlugin } from '@capacitor/core';

const native = registerPlugin('StemmaPersistence');
let writes = Promise.resolve();
const enqueue = action => {
  const next = writes.catch(() => {}).then(action);
  writes = next;
  return next;
};
export const persistence = Object.freeze({
  async get(key) { await writes.catch(() => {}); return (await native.load({key})).value ?? null; },
  set(key, value) { return enqueue(() => native.save({key, value:String(value)})); },
  remove(key) { return enqueue(() => native.remove({key})); },
  setSessionActive(active) { return native.setSessionActive({active:Boolean(active)}); },
  flush() { return writes.catch(() => {}).then(() => native.flushCookies()); }
});
const INDEX = 'response-index-v2';
const DISK_LIMIT = 512 * 1024 * 1024;
const MEMORY_LIMIT = 32 * 1024 * 1024;
const ITEM_LIMIT = 8 * 1024 * 1024;
const bytes = text => new TextEncoder().encode(text).byteLength;
const digest = async text => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),x=>x.toString(16).padStart(2,'0')).join('');

// Separate atomic response files avoid rewriting a large snapshot on every request.
// Internal persistent storage, not Android's disposable cache directory, owns these files.
export class DurableResponseCache {
  account = '';
  entries = {};
  memory = new Map();
  memoryBytes = 0;
  generation = 0;
  serial = Promise.resolve();
  async initialize() {
    try {
      const state = JSON.parse(await persistence.get(INDEX) || 'null');
      if (state?.version === 2 && typeof state.account === 'string' && state.entries && typeof state.entries === 'object') {
        this.account = state.account;
        for (const [path, entry] of Object.entries(state.entries)) {
          if (/^response-[a-f0-9]{64}$/.test(entry?.key) && Number.isFinite(entry.size) && entry.size >= 0 && entry.size <= ITEM_LIMIT) this.entries[path] = entry;
        }
      }
    } catch { /* An absent or damaged index must not prevent startup. */ }
    return this.account;
  }
  run(action) { const next = this.serial.catch(() => {}).then(action); this.serial = next; return next; }
  remember(path, text) {
    const old = this.memory.get(path);
    if (old) this.memoryBytes -= old.size;
    const item = {text, size:bytes(text)};
    this.memory.delete(path); this.memory.set(path,item); this.memoryBytes += item.size;
    while (this.memoryBytes > MEMORY_LIMIT && this.memory.size) {
      const first = this.memory.keys().next().value;
      this.memoryBytes -= this.memory.get(first).size; this.memory.delete(first);
    }
  }
  async activate(account) {
    if (this.account === account) return;
    await this.clear();
    this.account = account;
    await this.run(() => this.writeIndex());
  }
  writeIndex() { return persistence.set(INDEX,JSON.stringify({version:2,account:this.account,entries:this.entries})); }
  put(path,body,at=Date.now()) {
    const account = this.account, generation = this.generation;
    if (!account) return Promise.resolve();
    const text = JSON.stringify({body,at});
    if (bytes(text) > ITEM_LIMIT) return Promise.resolve();
    return this.run(async () => {
      if (account !== this.account || generation !== this.generation) return;
      const existing=this.entries[path], cached=this.memory.get(path);
      if(existing && cached) {
        try {
          if(JSON.stringify(JSON.parse(cached.text).body)===JSON.stringify(body)) {
            this.remember(path,text);
            existing.at=at;
            await this.writeIndex();
            return;
          }
        } catch { /* Replace an unreadable in-memory record with the fresh response. */ }
      }
      this.remember(path,text);
      const key = 'response-' + await digest(account + '\n' + path);
      await persistence.set(key,text);
      if (account !== this.account || generation !== this.generation) { await persistence.remove(key); return; }
      this.entries[path] = {key,size:bytes(text),at};
      let total = Object.values(this.entries).reduce((sum,item)=>sum+item.size,0);
      const evicted = [];
      for (const [oldPath,item] of Object.entries(this.entries).sort((a,b)=>a[1].at-b[1].at)) {
        if (total <= DISK_LIMIT) break;
        total -= item.size; delete this.entries[oldPath]; evicted.push(item.key);
        const memory = this.memory.get(oldPath); if(memory){this.memoryBytes-=memory.size;this.memory.delete(oldPath);}
      }
      await this.writeIndex();
      await Promise.allSettled(evicted.map(key=>persistence.remove(key)));
    });
  }
  async get(path) {
    const account = this.account, generation = this.generation;
    if (!account) return null;
    let text = this.memory.get(path)?.text;
    if (!text) {
      const entry = this.entries[path]; if (!entry) return null;
      try { text = await persistence.get(entry.key); } catch { return null; }
      if (!text || account !== this.account || generation !== this.generation) return null;
      this.remember(path,text);
    }
    try {
      const value=JSON.parse(text);
      const entry=this.entries[path];
      if(entry) value.at=entry.at;
      return value;
    } catch { return null; }
  }
  clear() {
    this.generation++;
    this.account = ''; this.memory.clear(); this.memoryBytes = 0;
    return this.run(async () => {
      const entries = this.entries; this.entries = {};
      // Remove the index first so a crash during cleanup cannot resurrect an account.
      await persistence.remove(INDEX);
      await Promise.allSettled(Object.values(entries).map(item=>persistence.remove(item.key)));
    });
  }
  async flush() { await this.serial.catch(()=>{}); await persistence.flush(); }
}
