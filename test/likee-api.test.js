import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import express from 'express';
import http from 'node:http';
import test from 'node:test';
import { registerLikeeApi, MAX_VIDEO_BYTES } from '../likee-api.js';

const VIDEO_ID='a0180394-241f-4f7b-a489-d583ab4a9c42';
function box(type,payload) { const b=Buffer.alloc(8+payload.length);b.writeUInt32BE(b.length,0);b.write(type,4,'ascii');payload.copy(b,8);return b; }
function durationHeader(type,duration) { const p=Buffer.alloc(20);p.writeUInt32BE(1000,12);p.writeUInt32BE(duration,16);return box(type,p); }
function makeMp4(durationMs=240_000) {
  const ftyp=box('ftyp',Buffer.from('isom\0\0\0\0isom','ascii'));
  const movieHeader=durationHeader('mvhd',durationMs),mediaHeader=durationHeader('mdhd',durationMs);
  const handlerPayload=Buffer.alloc(12);handlerPayload.write('vide',8,'ascii');const handler=box('hdlr',handlerPayload);
  const sttsPayload=Buffer.alloc(16);sttsPayload.writeUInt32BE(1,4);sttsPayload.writeUInt32BE(1,8);sttsPayload.writeUInt32BE(durationMs,12);const stts=box('stts',sttsPayload);
  const visual=Buffer.alloc(78);visual.writeUInt16BE(640,24);visual.writeUInt16BE(480,26);
  const entry=box('avc1',Buffer.concat([visual,box('avcC',Buffer.from([1,100,0,31,255,224,0]))]));
  const stsdPayload=Buffer.alloc(8);stsdPayload.writeUInt32BE(1,4);const stsd=box('stsd',Buffer.concat([stsdPayload,entry]));
  const stszPayload=Buffer.alloc(16);stszPayload.writeUInt32BE(1,8);stszPayload.writeUInt32BE(50,12);const stsz=box('stsz',stszPayload);
  const stscPayload=Buffer.alloc(20);stscPayload.writeUInt32BE(1,4);stscPayload.writeUInt32BE(1,8);stscPayload.writeUInt32BE(1,12);stscPayload.writeUInt32BE(1,16);const stsc=box('stsc',stscPayload);
  const makeMovie=offset=>{const p=Buffer.alloc(12);p.writeUInt32BE(1,4);p.writeUInt32BE(offset,8);return box('moov',Buffer.concat([movieHeader,box('trak',box('mdia',Buffer.concat([mediaHeader,handler,box('minf',box('stbl',Buffer.concat([stsd,stts,stsc,stsz,box('stco',p)])))])))]));};
  const placeholder=makeMovie(0),chunkOffset=ftyp.length+placeholder.length+8,movie=makeMovie(chunkOffset),media=box('mdat',Buffer.alloc(50,1));return Buffer.concat([ftyp,movie,media]);
}
function ebmlElement(id,payload) { if(payload.length>=127)throw new Error('fixture payload too large');return Buffer.concat([Buffer.from(id,'hex'),Buffer.from([0x80|payload.length]),payload]); }
function makeWebm(seconds=240) {
  const header=ebmlElement('1a45dfa3',Buffer.from([0x42,0x86,0x81,0x01]));
  const scale=ebmlElement('2ad7b1',Buffer.from([0x0f,0x42,0x40]));const duration=Buffer.alloc(8);duration.writeDoubleBE(seconds*1000);
  const info=ebmlElement('1549a966',Buffer.concat([scale,ebmlElement('4489',duration)]));
  const entry=ebmlElement('ae',Buffer.concat([ebmlElement('d7',Buffer.from([1])),ebmlElement('83',Buffer.from([1])),ebmlElement('86',Buffer.from('V_VP9'))]));
  const tracks=ebmlElement('1654ae6b',entry);const block=ebmlElement('a3',Buffer.from([0x81,0,0,0x80,1]));
  const cluster=ebmlElement('1f43b675',Buffer.concat([ebmlElement('e7',Buffer.from([0])),block]));
  return Buffer.concat([header,ebmlElement('18538067',Buffer.concat([info,tracks,cluster]))]);
}
const imageFixtures={
  'image/jpeg':Buffer.from([0xff,0xd8,0xff,0xd9]),
  'image/png':Buffer.from([137,80,78,71,13,10,26,10]),
  'image/webp':Buffer.from([0x52,0x49,0x46,0x46,4,0,0,0,0x57,0x45,0x42,0x50]),
  'image/gif':Buffer.from('GIF89a'+String.fromCharCode(1,0,1,0,0,0,0),'binary')
};
const profileRow={id:VIDEO_ID,ownerSubject:'creator',nickName:'Creator',username:'creator1',caption:'test clip',mimeType:'video/mp4',hasAvatar:true,following:false,liked:true,reposted:false,bookmarked:false,likes:3,comments:2,reposts:0,bookmarks:1};
async function harness(){
  const captured={}; const video=makeMp4();
  const store={
    listVideos:async()=>[profileRow], getVideo:async()=>profileRow,
    createVideo:async(subject,input)=>{captured.upload={subject,...input};return {id:VIDEO_ID};},
    getVideoMedia:async()=>({data:video,mimeType:'video/mp4',byteSize:video.length}),
    getVideoAvatar:async()=>({data:Buffer.from([1,2]),mimeType:'image/png'}),
    getRecipientAvatar:async()=>null, listRecipients:async()=>[],
    videoExists:async()=>true,listComments:async()=>[],addComment:async()=>null,
    setAction:async(_subject,_id,action,active)=>({action,active}),
    shareVideo:async(_subject,_id,conversationIds)=>({conversationIds,alreadyShared:false})
  };
  const app=express();
  registerLikeeApi(app,{likeeStore:store,config:{appOrigin:''},requireGoogleSession:(req,res,next)=>{
    if(req.get('cookie')!=='auth=yes')return res.status(401).json({error:'Authentication required.'});
    req.session={stemmaUser:{subject:'viewer'}};return next();
  }});
  app.use((error,_req,res,_next)=>res.status(error.status||500).json({error:'request error'}));
  const server=app.listen(0,'127.0.0.1'); await once(server,'listening');
  const origin=`http://127.0.0.1:${server.address().port}`;
  return {captured,origin,async close(){server.close();await once(server,'close');}};
}
const headers=(origin,extra={})=>({'cookie':'auth=yes',...(origin?{origin}:{}),...extra});
const post=(base,path,origin,body,contentType='application/json')=>fetch(`${base}${path}`,{method:'POST',headers:headers(origin,{'content-type':contentType}),body:typeof body==='string'?body:JSON.stringify(body)});

test('Likee API requires an authenticated session for feed and private video bytes',async t=>{
  const h=await harness();t.after(()=>h.close());
  const anonymous=await fetch(`${h.origin}/api/likee/videos`);
  assert.equal(anonymous.status,401);
  const feed=await fetch(`${h.origin}/api/likee/videos`,{headers:headers()});
  assert.equal(feed.status,200); assert.equal(feed.headers.get('cache-control').includes('no-store'),true);
  const body=await feed.json(); assert.equal(body.videos.length,1);
  assert.deepEqual(body.videos[0],{id:VIDEO_ID,nickName:'Creator',username:'creator1',caption:'test clip',mimeType:'video/mp4',mediaUrl:`/api/likee/videos/${VIDEO_ID}/media`,avatarUrl:`/api/likee/videos/${VIDEO_ID}/avatar`,thumbnailUrl:`/api/likee/videos/${VIDEO_ID}/media`,mine:false,following:false,liked:true,reposted:false,bookmarked:false,likes:3,comments:2,reposts:0,bookmarks:1});
  const media=await fetch(`${h.origin}/api/likee/videos/${VIDEO_ID}/media`,{headers:{cookie:'auth=yes',range:'bytes=2-7'}});
  assert.equal(media.status,206);assert.equal(media.headers.get('content-range'),`bytes 2-7/${makeMp4().length}`);assert.equal(media.headers.get('cache-control').includes('no-store'),true);
  assert.deepEqual(Buffer.from(await media.arrayBuffer()),makeMp4().subarray(2,8));
});

test('Likee upload enforces same-origin JSON, real container signatures, Base64 and legacy JSON compatibility',async t=>{
  const h=await harness();t.after(()=>h.close());
  const payload={caption:'  new clip ',mimeType:'video/mp4',data:makeMp4().toString('base64')};
  assert.equal((await post(h.origin,'/api/likee/videos',null,payload)).status,403);
  assert.equal((await post(h.origin,'/api/likee/videos',h.origin,payload,'text/plain')).status,415);
  assert.equal((await post(h.origin,'/api/likee/videos',h.origin,{...payload,data:Buffer.from('not video').toString('base64')})).status,400);
  assert.equal((await post(h.origin,'/api/likee/videos',h.origin,{...payload,mimeType:'video/webm'})).status,400,'MP4 bytes cannot be relabelled as WebM');
  assert.equal((await post(h.origin,'/api/likee/videos',h.origin,{...payload,data:Buffer.from('000000106674797069736f6d0000000069736f6d','hex').toString('base64')})).status,400,'a plausible ftyp header without readable timing is rejected');
  assert.equal((await post(h.origin,'/api/likee/videos',h.origin,{...payload,data:'not-base64!'})).status,400);
  const accepted=await post(h.origin,'/api/likee/videos',h.origin,payload);
  assert.equal(accepted.status,201);assert.equal(h.captured.upload.subject,'viewer');
  assert.equal(h.captured.upload.caption,'new clip');assert.deepEqual(h.captured.upload.data,makeMp4());
  assert.equal(h.captured.upload.mimeType,'video/mp4');
  for (const [mimeType,data] of Object.entries(imageFixtures)) {
    const photo=await post(h.origin,'/api/likee/videos',h.origin,{caption:'photo',mimeType,data:data.toString('base64')});
    assert.equal(photo.status,201,`${mimeType} photo is accepted`);
    assert.equal(h.captured.upload.mimeType,mimeType);assert.deepEqual(h.captured.upload.data,data);
  }
  assert.equal((await post(h.origin,'/api/likee/videos',h.origin,{caption:'spoof',mimeType:'image/png',data:makeMp4().toString('base64')})).status,400);
  assert.equal((await post(h.origin,'/api/likee/videos',h.origin,{caption:'spoof',mimeType:'image/svg+xml',data:Buffer.from('<svg/>').toString('base64')})).status,400);
  assert.equal((await post(h.origin,'/api/likee/videos',h.origin,{caption:'limit',mimeType:'video/mp4',data:makeMp4(240_000).toString('base64')})).status,201,'exactly 240 seconds is accepted');
  assert.equal((await post(h.origin,'/api/likee/videos',h.origin,{caption:'too long',mimeType:'video/mp4',data:makeMp4(240_001).toString('base64')})).status,400,'a video longer than 240 seconds is rejected from parsed bytes');
  assert.equal((await post(h.origin,'/api/likee/videos',h.origin,{caption:'webm',mimeType:'video/webm',data:makeWebm(240).toString('base64')})).status,201,'well-formed WebM with readable exact-boundary duration remains supported');
  assert.equal((await post(h.origin,'/api/likee/videos',h.origin,{caption:'long webm',mimeType:'video/webm',data:makeWebm(241).toString('base64')})).status,400);
  assert.equal((await post(h.origin,'/api/likee/videos',h.origin,{caption:'bad webm',mimeType:'video/webm',data:Buffer.from([0x1a,0x45,0xdf,0xa3,0,0]).toString('base64')})).status,400,'unreadable WebM duration metadata is rejected');
  assert.equal(MAX_VIDEO_BYTES, 256 * 1024 * 1024);
  const webm=Buffer.from([0x1a,0x45,0xdf,0xa3,0,0]);
  assert.equal((await post(h.origin,'/api/likee/videos',h.origin,{caption:'webm',mimeType:'video/webm',data:webm.toString('base64')})).status,400,'magic bytes alone do not establish readable duration');
});

test('Likee migration and API implementation encode persistent uniqueness, database counts, and atomic membership-checked sharing',async()=>{
  const migration=await fs.readFile(new URL('../migrations/018_likee.sql',import.meta.url),'utf8');
  const api=await fs.readFile(new URL('../likee-api.js',import.meta.url),'utf8');
  assert.match(migration,/stemma_likee_videos[\s\S]*?data BYTEA NOT NULL/);
  assert.match(migration,/byte_size INTEGER NOT NULL CHECK \(byte_size BETWEEN 1 AND 5242880\)/);
  const photoMigration=await fs.readFile(new URL('../migrations/019_likee_photos.sql',import.meta.url),'utf8');
  assert.match(photoMigration,/image\/jpeg.*image\/png.*image\/webp.*image\/gif/);
  assert.match(photoMigration,/video\/mp4.*video\/quicktime.*video\/webm/);
  assert.match(migration,/PRIMARY KEY \(video_id, google_subject, kind\)/);
  assert.match(migration,/PRIMARY KEY \(follower_subject, creator_subject\)/);
  assert.match(migration,/PRIMARY KEY \(google_subject, request_id\)/);
  assert.match(api,/participant_a=\$2 OR participant_b=\$2/);
  assert.match(api,/BEGIN[\s\S]*?stemma_direct_chat_messages[\s\S]*?COMMIT/);
  assert.match(api,/Likee video\\n#likee\/video\/\$\{videoId\}/);
  assert.doesNotMatch(api,/v\.data, v\.byte_size/,'feed metadata must not fetch the stored media blob');
});

test('Likee binary uploads allow four-minute media above 5 MiB, photos, and preserve auth and validation', async t => {
  const h = await harness(); t.after(() => h.close());
  const binary = (data, mimeType = 'video/mp4', extra = {}) => fetch(`${h.origin}/api/likee/videos`, {
    method:'POST', headers:headers(h.origin, {'content-type':mimeType, 'x-likee-caption':encodeURIComponent('  café photo & video  '), ...extra}), body:data
  });
  const large = Buffer.concat([makeMp4(240000), box('free',Buffer.alloc(6 * 1024 * 1024))]);
  const response = await binary(large);
  assert.equal(response.status,201); assert.deepEqual(h.captured.upload.data,large);
  assert.equal(h.captured.upload.caption,'café photo & video');
  assert.equal((await binary(makeMp4(240001))).status,400);
  assert.equal((await binary(makeWebm(240),'video/webm')).status,201);
  for (const [mime,data] of Object.entries(imageFixtures)) assert.equal((await binary(data,mime)).status,201);
  assert.equal((await binary(large,'image/png')).status,400);
  assert.equal((await binary(large,'video/mp4',{'x-likee-caption':'%invalid'})).status,400);
  assert.equal((await binary(large,'video/mp4',{'x-likee-caption':'x'.repeat(1001)})).status,400);
  assert.equal((await binary(large,'video/mp4',{origin:'https://outsider.invalid'})).status,403);
  assert.equal((await binary(large,'video/mp4',{cookie:''})).status,401);
  const status = await new Promise((resolve,reject) => {
    const request = http.request(`${h.origin}/api/likee/videos`, {method:'POST',headers:headers(h.origin,{'content-type':'video/mp4','content-length':MAX_VIDEO_BYTES+1})}, response => { response.resume(); resolve(response.statusCode); });
    request.on('error',reject); request.end();
  });
  assert.equal(status,413,'oversized uploads rejected before reading the body');
  const migration=await fs.readFile(new URL('../migrations/020_likee_media_size.sql',import.meta.url),'utf8');
  assert.match(migration,/DROP CONSTRAINT IF EXISTS stemma_likee_videos_byte_size_check/);
  assert.match(migration,/byte_size BETWEEN 1 AND 268435456/);
});
