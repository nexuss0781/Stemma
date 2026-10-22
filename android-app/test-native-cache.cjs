const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const esbuild=require('esbuild');
const {webcrypto}=require('node:crypto');
const disk=new Map();
const mock={
 async load({key}) {return {value:disk.get(key)??null};},
 async save({key,value}) {await new Promise(r=>setTimeout(r,1));disk.set(key,value);},
 async remove({key}) {disk.delete(key);}, async flushCookies() {}
};
const source=fs.readFileSync(__dirname+'/native-cache.js','utf8').replace("import { registerPlugin } from '@capacitor/core';",'const registerPlugin=()=>mock;');
const compiled=esbuild.transformSync(source,{format:'cjs',target:'node22'}).code;
const sandbox={exports:{},module:{exports:{}},mock,crypto:webcrypto,TextEncoder,setTimeout,console};
vm.runInNewContext(compiled,sandbox);
const {DurableResponseCache,persistence}=sandbox.module.exports;
(async()=>{
 const cache=new DurableResponseCache(); assert.equal(await cache.initialize(),'');
 await cache.activate('alice@example.invalid');
 for(let i=0;i<12;i++)await cache.put('/api/pulse/'+i,{text:'x'.repeat(900000),id:i});
 assert.equal(Object.keys(JSON.parse(disk.get('response-index-v2')).entries).length,12);
 assert(disk.size>=13,'retains more than original 8MiB budget');
 const cold=new DurableResponseCache(); assert.equal(await cold.initialize(),'alice@example.invalid');
 assert.equal((await cold.get('/api/pulse/0')).body.id,0,'readthrough after cold restart');
 for(let i=12;i<43;i++)await cold.put('/api/pulse/'+i,{text:'x'.repeat(900000),id:i});
 assert(cold.memoryBytes<=32*1024*1024,'memory working set bounded');
 assert.equal((await cold.get('/api/pulse/0')).body.id,0,'evicted RAM data retained on disk');
 await cold.put('/oversize',{text:'x'.repeat(9*1024*1024)});
 assert.equal(await cold.get('/oversize'),null,'individual over-budget entries rejected');
 const pending=cold.put('/pending',{secret:'alice'}); const cleared=cold.clear(); await Promise.all([pending,cleared]);
 await cold.activate('bob@example.invalid');
 assert.equal(await cold.get('/api/pulse/0'),null,'no cross-account cached data');
 assert.equal(await cold.get('/pending'),null,'queued prior-account write cannot return');
 assert.equal(disk.size,1,'prior account response files removed');
 await cold.put('/auth/session',{authenticated:true}); await cold.flush();
 await cold.clear(); assert.equal(disk.size,0,'logout removes index and all response files');
 await persistence.set('nav-test','saved'); assert.equal(await persistence.get('nav-test'),'saved'); await persistence.remove('nav-test');
 console.log(JSON.stringify({largeDiskRetention:true,coldRestartReadthrough:true,boundedMemory:true,accountIsolation:true,logoutPurge:true,writeRaceProtected:true,persistenceAdapter:true},null,2));
})().catch(error=>{console.error(error);process.exit(1);});
