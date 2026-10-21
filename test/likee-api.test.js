import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import express from 'express';
import test from 'node:test';
import { registerLikeeApi, MAX_VIDEO_BYTES } from '../likee-api.js';

const VIDEO_ID='a0180394-241f-4f7b-a489-d583ab4a9c42';
const makeMp4=()=>{const b=Buffer.alloc(16);b.writeUInt32BE(16,0);b.write('ftyp',4);b.write('isom',8);return b;};
const profileRow={id:VIDEO_ID,ownerSubject:'creator',nickName:'Creator',username:'creator1',caption:'test clip',hasAvatar:true,following:false,liked:true,reposted:false,bookmarked:false,likes:3,comments:2,reposts:0,bookmarks:1};
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
  assert.deepEqual(body.videos[0],{id:VIDEO_ID,nickName:'Creator',username:'creator1',caption:'test clip',mediaUrl:`/api/likee/videos/${VIDEO_ID}/media`,avatarUrl:`/api/likee/videos/${VIDEO_ID}/avatar`,thumbnailUrl:`/api/likee/videos/${VIDEO_ID}/media`,mine:false,following:false,liked:true,reposted:false,bookmarked:false,likes:3,comments:2,reposts:0,bookmarks:1});
  const media=await fetch(`${h.origin}/api/likee/videos/${VIDEO_ID}/media`,{headers:{cookie:'auth=yes',range:'bytes=2-7'}});
  assert.equal(media.status,206);assert.equal(media.headers.get('content-range'),'bytes 2-7/16');assert.equal(media.headers.get('cache-control').includes('no-store'),true);
  assert.deepEqual(Buffer.from(await media.arrayBuffer()),makeMp4().subarray(2,8));
});

test('Likee upload enforces same-origin JSON, real container signatures, Base64 and the 5 MiB bound',async t=>{
  const h=await harness();t.after(()=>h.close());
  const payload={caption:'  new clip ',mimeType:'video/mp4',data:makeMp4().toString('base64')};
  assert.equal((await post(h.origin,'/api/likee/videos',null,payload)).status,403);
  assert.equal((await post(h.origin,'/api/likee/videos',h.origin,payload,'text/plain')).status,415);
  assert.equal((await post(h.origin,'/api/likee/videos',h.origin,{...payload,data:Buffer.from('not video').toString('base64')})).status,400);
  assert.equal((await post(h.origin,'/api/likee/videos',h.origin,{...payload,data:'not-base64!'})).status,400);
  const accepted=await post(h.origin,'/api/likee/videos',h.origin,payload);
  assert.equal(accepted.status,201);assert.equal(h.captured.upload.subject,'viewer');
  assert.equal(h.captured.upload.caption,'new clip');assert.deepEqual(h.captured.upload.data,makeMp4());
  assert.equal(h.captured.upload.mimeType,'video/mp4');
  const tooBig=Buffer.alloc(MAX_VIDEO_BYTES+1).toString('base64');
  assert.equal((await post(h.origin,'/api/likee/videos',h.origin,{...payload,data:tooBig})).status,400);
  const webm=Buffer.from([0x1a,0x45,0xdf,0xa3,0,0]);
  assert.equal((await post(h.origin,'/api/likee/videos',h.origin,{caption:'webm',mimeType:'video/webm',data:webm.toString('base64')})).status,201);
});

test('Likee migration and API implementation encode persistent uniqueness, database counts, and atomic membership-checked sharing',async()=>{
  const migration=await fs.readFile(new URL('../migrations/018_likee.sql',import.meta.url),'utf8');
  const api=await fs.readFile(new URL('../likee-api.js',import.meta.url),'utf8');
  assert.match(migration,/stemma_likee_videos[\s\S]*?data BYTEA NOT NULL/);
  assert.match(migration,/byte_size INTEGER NOT NULL CHECK \(byte_size BETWEEN 1 AND 5242880\)/);
  assert.match(migration,/PRIMARY KEY \(video_id, google_subject, kind\)/);
  assert.match(migration,/PRIMARY KEY \(follower_subject, creator_subject\)/);
  assert.match(migration,/PRIMARY KEY \(google_subject, request_id\)/);
  assert.match(api,/participant_a=\$2 OR participant_b=\$2/);
  assert.match(api,/BEGIN[\s\S]*?stemma_direct_chat_messages[\s\S]*?COMMIT/);
  assert.match(api,/Likee video\\n#likee\/video\/\$\{videoId\}/);
  assert.doesNotMatch(api,/v\.data, v\.byte_size/,'feed metadata must not fetch the stored media blob');
});
