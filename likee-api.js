import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { readVideoDuration } from './stories-api.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const MAX_VIDEO_BYTES = 5 * 1024 * 1024;
export const MAX_VIDEO_SECONDS = 240;
const VIDEO_MIMES = new Set(['video/mp4', 'video/quicktime', 'video/webm']);
const PHOTO_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VIDEO_FIELDS = `v.id::text AS id, v.google_subject AS "ownerSubject", v.caption,
  v.mime_type AS "mimeType", v.created_at AS "createdAt",
  COALESCE(p.nick_name, '') AS "nickName", COALESCE(p.username, '') AS username,
  (p.profile_image IS NOT NULL) AS "hasAvatar"`;

function notFound(message = 'Likee video was not found.') { const error = new Error(message); error.code = 'NOT_FOUND'; return error; }
function shareError(code, message) { const error = new Error(message); error.code = code; return error; }

export function createLikeeStore(pool) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new TypeError('A PostgreSQL pool is required.');
  return {
    async migrate() {
      await pool.query(await fs.readFile(path.join(ROOT, 'migrations', '018_likee.sql'), 'utf8'));
      await pool.query(await fs.readFile(path.join(ROOT, 'migrations', '019_likee_photos.sql'), 'utf8'));
    },
    async listVideos(subject, limit = 50) {
      const result = await pool.query(
        `SELECT ${VIDEO_FIELDS},
          EXISTS(SELECT 1 FROM stemma_likee_follows f WHERE f.follower_subject=$1 AND f.creator_subject=v.google_subject) AS following,
          EXISTS(SELECT 1 FROM stemma_likee_reactions r WHERE r.video_id=v.id AND r.google_subject=$1 AND r.kind='like') AS liked,
          EXISTS(SELECT 1 FROM stemma_likee_reactions r WHERE r.video_id=v.id AND r.google_subject=$1 AND r.kind='repost') AS reposted,
          EXISTS(SELECT 1 FROM stemma_likee_reactions r WHERE r.video_id=v.id AND r.google_subject=$1 AND r.kind='bookmark') AS bookmarked,
          (SELECT count(*)::int FROM stemma_likee_reactions r WHERE r.video_id=v.id AND r.kind='like') AS likes,
          (SELECT count(*)::int FROM stemma_likee_comments c WHERE c.video_id=v.id) AS comments,
          (SELECT count(*)::int FROM stemma_likee_reactions r WHERE r.video_id=v.id AND r.kind='repost') AS reposts,
          (SELECT count(*)::int FROM stemma_likee_reactions r WHERE r.video_id=v.id AND r.kind='bookmark') AS bookmarks
         FROM stemma_likee_videos v LEFT JOIN stemma_student_profiles p ON p.google_subject=v.google_subject
         ORDER BY v.created_at DESC, v.id DESC LIMIT $2`, [subject, limit]);
      return result.rows;
    },
    async getVideo(subject, id) {
      const result = await pool.query(
        `SELECT ${VIDEO_FIELDS},
          EXISTS(SELECT 1 FROM stemma_likee_follows f WHERE f.follower_subject=$1 AND f.creator_subject=v.google_subject) AS following,
          EXISTS(SELECT 1 FROM stemma_likee_reactions r WHERE r.video_id=v.id AND r.google_subject=$1 AND r.kind='like') AS liked,
          EXISTS(SELECT 1 FROM stemma_likee_reactions r WHERE r.video_id=v.id AND r.google_subject=$1 AND r.kind='repost') AS reposted,
          EXISTS(SELECT 1 FROM stemma_likee_reactions r WHERE r.video_id=v.id AND r.google_subject=$1 AND r.kind='bookmark') AS bookmarked,
          (SELECT count(*)::int FROM stemma_likee_reactions r WHERE r.video_id=v.id AND r.kind='like') AS likes,
          (SELECT count(*)::int FROM stemma_likee_comments c WHERE c.video_id=v.id) AS comments,
          (SELECT count(*)::int FROM stemma_likee_reactions r WHERE r.video_id=v.id AND r.kind='repost') AS reposts,
          (SELECT count(*)::int FROM stemma_likee_reactions r WHERE r.video_id=v.id AND r.kind='bookmark') AS bookmarks
         FROM stemma_likee_videos v LEFT JOIN stemma_student_profiles p ON p.google_subject=v.google_subject WHERE v.id=$2::uuid`, [subject, id]);
      return result.rows[0] ?? null;
    },
    async createVideo(subject, { caption, mimeType, data }) {
      const id = crypto.randomUUID();
      const result = await pool.query(
        `INSERT INTO stemma_likee_videos (id, google_subject, caption, mime_type, data, byte_size)
         VALUES ($1::uuid,$2,$3,$4,$5,$6) RETURNING id::text AS id`, [id, subject, caption, mimeType, data, data.length]);
      return result.rows[0];
    },
    async getVideoMedia(id) {
      const result = await pool.query('SELECT data,mime_type AS "mimeType",byte_size AS "byteSize" FROM stemma_likee_videos WHERE id=$1::uuid', [id]);
      const row = result.rows[0]; return row ? { data: Buffer.from(row.data), mimeType: row.mimeType, byteSize: row.byteSize } : null;
    },
    async getVideoAvatar(id) {
      const result = await pool.query(`SELECT p.profile_image AS data,p.profile_image_mime AS "mimeType"
        FROM stemma_likee_videos v JOIN stemma_student_profiles p ON p.google_subject=v.google_subject
        WHERE v.id=$1::uuid AND p.profile_image IS NOT NULL`, [id]);
      const row = result.rows[0]; return row ? { data: Buffer.from(row.data), mimeType: row.mimeType } : null;
    },
    async setAction(subject, id, action, active) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const video = await client.query('SELECT google_subject FROM stemma_likee_videos WHERE id=$1::uuid FOR KEY SHARE', [id]);
        if (!video.rows[0]) throw notFound();
        if (action === 'follow') {
          const creator = video.rows[0].google_subject;
          if (creator === subject) throw shareError('SELF_FOLLOW', 'You cannot follow yourself.');
          if (active) await client.query('INSERT INTO stemma_likee_follows(follower_subject,creator_subject) VALUES($1,$2) ON CONFLICT DO NOTHING', [subject, creator]);
          else await client.query('DELETE FROM stemma_likee_follows WHERE follower_subject=$1 AND creator_subject=$2', [subject, creator]);
        } else if (active) {
          await client.query('INSERT INTO stemma_likee_reactions(video_id,google_subject,kind) VALUES($1::uuid,$2,$3) ON CONFLICT DO NOTHING', [id, subject, action]);
        } else {
          await client.query('DELETE FROM stemma_likee_reactions WHERE video_id=$1::uuid AND google_subject=$2 AND kind=$3', [id, subject, action]);
        }
        await client.query('COMMIT');
        return { active };
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      finally { client.release(); }
    },
    async listComments(videoId, limit = 50) {
      const result = await pool.query(`SELECT c.id::text AS id,c.text,c.created_at AS "createdAt",c.google_subject AS "authorSubject",
        COALESCE(p.nick_name,'') AS "nickName" FROM stemma_likee_comments c
        LEFT JOIN stemma_student_profiles p ON p.google_subject=c.google_subject WHERE c.video_id=$1::uuid
        ORDER BY c.id DESC LIMIT $2`, [videoId, limit]);
      return result.rows;
    },
    async addComment(subject, videoId, text) {
      const result = await pool.query(`INSERT INTO stemma_likee_comments(video_id,google_subject,text)
        SELECT v.id,$2,$3 FROM stemma_likee_videos v WHERE v.id=$1::uuid
        RETURNING id::text AS id,text,created_at AS "createdAt",google_subject AS "authorSubject"`, [videoId, subject, text]);
      return result.rows[0] ?? null;
    },
    async listRecipients(subject) {
      const result = await pool.query(`SELECT c.id::text AS id,p.nick_name AS "nickName",p.username,
        (p.profile_image IS NOT NULL) AS "hasAvatar"
        FROM stemma_direct_chat_conversations c JOIN stemma_student_profiles p
          ON p.google_subject=CASE WHEN c.participant_a=$1 THEN c.participant_b ELSE c.participant_a END
        WHERE c.participant_a=$1 OR c.participant_b=$1 ORDER BY c.updated_at DESC,c.id DESC LIMIT 100`, [subject]);
      return result.rows;
    },
    async getRecipientAvatar(subject, conversationId) {
      const result = await pool.query(`SELECT p.profile_image AS data,p.profile_image_mime AS "mimeType"
        FROM stemma_direct_chat_conversations c JOIN stemma_student_profiles p ON p.google_subject=
          CASE WHEN c.participant_a=$2 THEN c.participant_b ELSE c.participant_a END
        WHERE c.id=$1::bigint AND (c.participant_a=$2 OR c.participant_b=$2) AND p.profile_image IS NOT NULL`, [conversationId, subject]);
      const row=result.rows[0]; return row ? {data:Buffer.from(row.data),mimeType:row.mimeType} : null;
    },
    async videoExists(videoId) {
      const result=await pool.query('SELECT 1 FROM stemma_likee_videos WHERE id=$1::uuid',[videoId]);
      return result.rows.length > 0;
    },
    async shareVideo(subject, videoId, conversationIds, requestId) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [`likee-share:${subject}:${requestId}`]);
        const old = await client.query('SELECT video_id::text AS "videoId",conversation_ids::text[] AS "conversationIds" FROM stemma_likee_share_requests WHERE google_subject=$1 AND request_id=$2::uuid FOR UPDATE', [subject, requestId]);
        if (old.rows[0]) {
          const oldIds = old.rows[0].conversationIds.map(String).sort();
          if (old.rows[0].videoId !== videoId || oldIds.join(',') !== conversationIds.slice().sort().join(',')) throw shareError('IDEMPOTENCY_CONFLICT', 'This request id was already used for a different share.');
          await client.query('COMMIT');
          return { conversationIds, alreadyShared: true };
        }
        const video = await client.query('SELECT id FROM stemma_likee_videos WHERE id=$1::uuid', [videoId]);
        if (!video.rows[0]) throw notFound();
        const member = await client.query(`SELECT id::text AS id FROM stemma_direct_chat_conversations
          WHERE id=ANY($1::bigint[]) AND (participant_a=$2 OR participant_b=$2)`, [conversationIds, subject]);
        const owned = new Set(member.rows.map(row => String(row.id)));
        if (conversationIds.some(id => !owned.has(id))) throw shareError('NOT_MEMBER', 'One or more conversations are unavailable.');
        await client.query('INSERT INTO stemma_likee_share_requests(google_subject,request_id,video_id,conversation_ids) VALUES($1,$2::uuid,$3::uuid,$4::bigint[])', [subject, requestId, videoId, conversationIds]);
        await client.query(`INSERT INTO stemma_direct_chat_messages(conversation_id,author_subject,text)
          SELECT unnest($1::bigint[]),$2,$3`, [conversationIds, subject, `Likee video\n#likee/video/${videoId}`]);
        await client.query('COMMIT');
        return { conversationIds, alreadyShared: false };
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      finally { client.release(); }
    }
  };
}

function noStore(res) { res.set({ 'Cache-Control': 'private, no-store, max-age=0', Pragma: 'no-cache', 'Referrer-Policy': 'no-referrer' }); }
function sameOriginJson(config) {
  return (req,res,next) => {
    const origin=req.get('origin'); const expected=config.appOrigin || `${req.protocol}://${req.get('host')}`;
    noStore(res);
    if (!origin || origin !== expected) return res.status(403).json({error:'This request could not be verified.'});
    if (!req.is('application/json')) return res.status(415).json({error:'A JSON request body is required.'});
    return next();
  };
}
function validId(id) { return typeof id === 'string' && UUID_RE.test(id); }
function validConversationId(id) { return typeof id === 'string' && /^[1-9]\d{0,18}$/.test(id) && BigInt(id) <= 9223372036854775807n; }
function videoDto(row, subject) {
  if (!row || !validId(row.id) || typeof row.caption !== 'string' || typeof row.nickName !== 'string') return null;
  return { id: row.id, nickName: row.nickName, username: typeof row.username === 'string' ? row.username : '', caption: row.caption, mimeType: row.mimeType, mediaUrl: `/api/likee/videos/${row.id}/media`,
    avatarUrl: row.hasAvatar ? `/api/likee/videos/${row.id}/avatar` : null, thumbnailUrl: `/api/likee/videos/${row.id}/media`,
    mine: row.ownerSubject === subject, following: Boolean(row.following), liked: Boolean(row.liked), reposted: Boolean(row.reposted), bookmarked: Boolean(row.bookmarked),
    likes: Number(row.likes) || 0, comments: Number(row.comments) || 0, reposts: Number(row.reposts) || 0, bookmarks: Number(row.bookmarks) || 0 };
}
function readEbmlVint(data, offset, end, isId = false) {
  if (offset >= end || data[offset] === 0) throw new TypeError('Malformed EBML variable integer.');
  let width = 1;
  let marker = 0x80;
  while (!(data[offset] & marker)) { width += 1; marker >>= 1; }
  if (width > (isId ? 4 : 8) || offset + width > end) throw new TypeError('Malformed EBML variable integer.');
  let value = BigInt(isId ? data[offset] : data[offset] & (marker - 1));
  for (let i = 1; i < width; i += 1) value = (value << 8n) | BigInt(data[offset + i]);
  if (!isId && value === (1n << BigInt(7 * width)) - 1n) return { width, value: null };
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError('EBML element is too large.');
  return { width, value: Number(value) };
}
function ebmlElements(data, start, end, allowUnknownSize = false) {
  const elements = [];
  let offset = start;
  while (offset < end) {
    const id = readEbmlVint(data, offset, end, true);
    const size = readEbmlVint(data, offset + id.width, end);
    const payload = offset + id.width + size.width;
    const elementEnd = size.value === null && allowUnknownSize ? end : payload + size.value;
    if (size.value === null && !allowUnknownSize || elementEnd > end || elementEnd < payload) throw new TypeError('Malformed EBML element bounds.');
    elements.push({ id: id.value, start: offset, payload, end: elementEnd });
    offset = elementEnd;
  }
  if (offset !== end) throw new TypeError('Malformed EBML element bounds.');
  return elements;
}
function ebmlUInt(data, element) {
  const size = element.end - element.payload;
  if (size < 1 || size > 8) throw new TypeError('Malformed EBML integer.');
  let value = 0n;
  for (let i = element.payload; i < element.end; i += 1) value = (value << 8n) | BigInt(data[i]);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError('EBML integer is too large.');
  return Number(value);
}
function readWebmDuration(data, maxSeconds) {
  if (data.length < 16) throw new TypeError('WebM is malformed or missing duration metadata.');
  const top = ebmlElements(data, 0, data.length, true);
  if (top.length < 2 || top[0].id !== 0x1a45dfa3 || top[1].id !== 0x18538067) throw new TypeError('WebM EBML/Segment header is missing.');
  const segment = top[1];
  const children = ebmlElements(data, segment.payload, segment.end, true);
  const info = children.filter(element => element.id === 0x1549a966);
  const tracks = children.filter(element => element.id === 0x1654ae6b);
  const clusters = children.filter(element => element.id === 0x1f43b675);
  if (info.length !== 1 || tracks.length !== 1 || !clusters.length) throw new TypeError('WebM duration or track metadata is missing.');
  const infoChildren = ebmlElements(data, info[0].payload, info[0].end);
  const scales = infoChildren.filter(element => element.id === 0x2ad7b1);
  const durations = infoChildren.filter(element => element.id === 0x4489);
  if (scales.length > 1 || durations.length !== 1) throw new TypeError('WebM duration metadata is missing or ambiguous.');
  const scale = scales.length ? ebmlUInt(data, scales[0]) : 1_000_000;
  if (scale < 1 || scale > 1_000_000_000) throw new TypeError('WebM timecode scale is invalid.');
  const durationSize = durations[0].end - durations[0].payload;
  let durationTicks;
  if (durationSize === 4) durationTicks = data.readFloatBE(durations[0].payload);
  else if (durationSize === 8) durationTicks = data.readDoubleBE(durations[0].payload);
  else throw new TypeError('WebM duration encoding is invalid.');
  const seconds = durationTicks * scale / 1_000_000_000;
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > maxSeconds) throw new RangeError(`Videos must be ${maxSeconds} seconds or shorter and have readable duration metadata.`);
  const trackEntries = [];
  for (const tracksElement of tracks) for (const entry of ebmlElements(data, tracksElement.payload, tracksElement.end).filter(element => element.id === 0xae)) {
    const fields = ebmlElements(data, entry.payload, entry.end);
    const types = fields.filter(element => element.id === 0x83);
    const numbers = fields.filter(element => element.id === 0xd7);
    if (types.length !== 1 || numbers.length !== 1) throw new TypeError('WebM track metadata is malformed.');
    trackEntries.push({ number: ebmlUInt(data, numbers[0]), type: ebmlUInt(data, types[0]) });
  }
  if (!trackEntries.some(track => track.type === 1 && track.number > 0)) throw new TypeError('WebM video track is missing.');
  const trackNumbers = new Set(trackEntries.map(track => track.number));
  let hasVideoBlock = false;
  let lastTimestamp = 0;
  for (const cluster of clusters) {
    const elements = ebmlElements(data, cluster.payload, cluster.end);
    const times = elements.filter(element => element.id === 0xe7);
    if (times.length !== 1) throw new TypeError('WebM cluster timecode is missing.');
    const baseTime = ebmlUInt(data, times[0]);
    for (const element of elements) {
      const blocks = element.id === 0xa3 ? [element] : element.id === 0xa0 ? ebmlElements(data, element.payload, element.end).filter(child => child.id === 0xa1) : [];
      for (const block of blocks) {
        const track = readEbmlVint(data, block.payload, block.end);
        const at = block.payload + track.width;
        if (track.value === null || at + 3 > block.end || block.end <= at + 3 || !trackNumbers.has(track.value)) throw new TypeError('WebM media block is malformed.');
        const relative = data.readInt16BE(at);
        const timestamp = baseTime + relative;
        if (timestamp < 0) throw new TypeError('WebM media timestamp is invalid.');
        lastTimestamp = Math.max(lastTimestamp, timestamp);
        if (trackEntries.some(entry => entry.number === track.value && entry.type === 1)) hasVideoBlock = true;
      }
    }
  }
  if (!hasVideoBlock || lastTimestamp > durationTicks) throw new TypeError('WebM duration does not cover its video samples.');
  return seconds;
}

function isPhotoSignature(mimeType, data) {
  if (mimeType === 'image/jpeg') return data.length >= 4 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff && data.at(-2) === 0xff && data.at(-1) === 0xd9;
  if (mimeType === 'image/png') return data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mimeType === 'image/gif') return data.length >= 13 && (data.toString('ascii', 0, 6) === 'GIF87a' || data.toString('ascii', 0, 6) === 'GIF89a');
  if (mimeType === 'image/webp') return data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP' && data.readUInt32LE(4) + 8 <= data.length;
  return false;
}
function validateUpload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['caption','mimeType','data'].includes(k)) ||
      typeof body.caption !== 'string' || typeof body.mimeType !== 'string' || typeof body.data !== 'string') return null;
  const caption=body.caption.trim();
  if ([...caption].length > 1000 || caption.includes('\0') || (!VIDEO_MIMES.has(body.mimeType) && !PHOTO_MIMES.has(body.mimeType))) return null;
  const encoded=body.data;
  if (encoded.length > Math.ceil(MAX_VIDEO_BYTES/3)*4 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;
  const data=Buffer.from(encoded,'base64');
  if (!data.length || data.length > MAX_VIDEO_BYTES || data.toString('base64') !== encoded) return null;
  if (PHOTO_MIMES.has(body.mimeType)) {
    if (!isPhotoSignature(body.mimeType, data)) return null;
  } else {
    try {
      if (body.mimeType === 'video/webm') readWebmDuration(data, MAX_VIDEO_SECONDS);
      else readVideoDuration(data, { maxSeconds: MAX_VIDEO_SECONDS });
    } catch { return null; }
  }
  return { caption, mimeType: body.mimeType, data };
}
function countValue(value) { const n=Number(value); return Number.isSafeInteger(n) && n >= 0 ? n : 0; }
function sendMedia(req,res,media) {
  const total=media.data.length; const range=req.get('range');
  res.set({ 'Content-Type': media.mimeType, 'Accept-Ranges':'bytes', 'Content-Length':String(total), 'X-Content-Type-Options':'nosniff' });
  if (!range) return res.status(200).send(media.data);
  const match=/^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2])) { res.set('Content-Range',`bytes */${total}`); return res.status(416).end(); }
  let start,end;
  if (!match[1]) { const suffix=Number(match[2]); if (!suffix) {res.set('Content-Range',`bytes */${total}`);return res.status(416).end();} start=Math.max(0,total-suffix);end=total-1; }
  else { start=Number(match[1]); end=match[2]?Number(match[2]):total-1; }
  if (!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>=total||start>end) {res.set('Content-Range',`bytes */${total}`);return res.status(416).end();}
  end=Math.min(end,total-1); const part=media.data.subarray(start,end+1);
  res.status(206).set({'Content-Range':`bytes ${start}-${end}/${total}`,'Content-Length':String(part.length)}).send(part);
}

export function registerLikeeApi(app,{likeeStore=null,requireGoogleSession,config}) {
  if (typeof requireGoogleSession !== 'function') throw new TypeError('Google-session middleware is required.');
  const limiter=rateLimit({windowMs:60_000,limit:60,standardHeaders:'draft-8',legacyHeaders:false,handler:(_req,res)=>{noStore(res);res.status(429).json({error:'Too many Likee requests. Please wait and try again.'});}});
  const assetLimiter=rateLimit({windowMs:60_000,limit:240,standardHeaders:'draft-8',legacyHeaders:false,handler:(_req,res)=>{noStore(res);res.status(429).json({error:'Too many Likee media requests. Please wait and try again.'});}});
  const ready=(req,res)=>{noStore(res);if(!likeeStore){res.status(503).json({error:'Likee service is unavailable.'});return false;}return true;};
  const idRoute=(req,res)=>validId(req.params.id) || (res.status(400).json({error:'Video id is invalid.'}),false);
  app.get('/api/likee/videos',requireGoogleSession,limiter,async(req,res)=>{if(!ready(req,res))return;try{const rows=await likeeStore.listVideos(req.session.stemmaUser.subject,50);return res.json({videos:rows.map(row=>videoDto(row,req.session.stemmaUser.subject)).filter(Boolean)});}catch{return res.status(503).json({error:'Likee service is unavailable.'});}});
  app.post('/api/likee/videos',requireGoogleSession,limiter,sameOriginJson(config),express.json({limit:'7.2mb',strict:true}),async(req,res)=>{if(!ready(req,res))return;const input=validateUpload(req.body);if(!input)return res.status(400).json({error:'A valid photo or video upload is required.'});try{const row=await likeeStore.createVideo(req.session.stemmaUser.subject,input);return res.status(201).json({video:{id:row.id,mediaUrl:`/api/likee/videos/${row.id}/media`}});}catch{return res.status(503).json({error:'Likee service is unavailable.'});}});
  app.get('/api/likee/videos/:id',requireGoogleSession,limiter,async(req,res)=>{if(!ready(req,res)||!idRoute(req,res))return;try{const row=await likeeStore.getVideo(req.session.stemmaUser.subject,req.params.id);if(!row)return res.status(404).json({error:'Likee video was not found.'});return res.json({video:videoDto(row,req.session.stemmaUser.subject)});}catch{return res.status(503).json({error:'Likee service is unavailable.'});}});
  app.get('/api/likee/videos/:id/media',requireGoogleSession,assetLimiter,async(req,res)=>{if(!ready(req,res)||!idRoute(req,res))return;try{const media=await likeeStore.getVideoMedia(req.params.id);if(!media)return res.status(404).json({error:'Likee video was not found.'});noStore(res);return sendMedia(req,res,media);}catch{return res.status(503).json({error:'Likee service is unavailable.'});}});
  app.get('/api/likee/videos/:id/avatar',requireGoogleSession,assetLimiter,async(req,res)=>{if(!ready(req,res)||!idRoute(req,res))return;try{const avatar=await likeeStore.getVideoAvatar(req.params.id);if(!avatar||!['image/png','image/jpeg','image/webp'].includes(avatar.mimeType))return res.status(404).json({error:'Profile photo not found.'});noStore(res);res.set({'Content-Type':avatar.mimeType,'X-Content-Type-Options':'nosniff'});return res.send(avatar.data);}catch{return res.status(503).json({error:'Likee service is unavailable.'});}});
  for(const action of ['like','repost','bookmark','follow']) app.post(`/api/likee/videos/:id/${action}`,requireGoogleSession,limiter,sameOriginJson(config),express.json({limit:'2kb',strict:true}),async(req,res)=>{if(!ready(req,res)||!idRoute(req,res))return;const body=req.body;if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==1||typeof body.active!=='boolean')return res.status(400).json({error:'An active boolean is required.'});try{await likeeStore.setAction(req.session.stemmaUser.subject,req.params.id,action,body.active);const row=await likeeStore.getVideo(req.session.stemmaUser.subject,req.params.id);return res.json({video:videoDto(row,req.session.stemmaUser.subject)});}catch(error){if(error.code==='NOT_FOUND')return res.status(404).json({error:'Likee video was not found.'});if(error.code==='SELF_FOLLOW')return res.status(400).json({error:error.message});return res.status(503).json({error:'Likee service is unavailable.'});}});
  app.get('/api/likee/videos/:id/comments',requireGoogleSession,limiter,async(req,res)=>{if(!ready(req,res)||!idRoute(req,res))return;try{if(!await likeeStore.videoExists(req.params.id))return res.status(404).json({error:'Likee video was not found.'});const rows=await likeeStore.listComments(req.params.id,50);return res.json({comments:rows.map(row=>({id:String(row.id),text:row.text,nickName:row.nickName,createdAt:new Date(row.createdAt).toISOString(),mine:row.authorSubject===req.session.stemmaUser.subject}))});}catch{return res.status(503).json({error:'Likee service is unavailable.'});}});
  app.post('/api/likee/videos/:id/comments',requireGoogleSession,limiter,sameOriginJson(config),express.json({limit:'4kb',strict:true}),async(req,res)=>{if(!ready(req,res)||!idRoute(req,res))return;const text=req.body?.text;if(!req.body||typeof req.body!=='object'||Array.isArray(req.body)||Object.keys(req.body).length!==1||typeof text!=='string'||!text.trim()||text.includes('\0')||[...text.trim()].length>1000)return res.status(400).json({error:'A non-empty comment of at most 1,000 characters is required.'});try{const row=await likeeStore.addComment(req.session.stemmaUser.subject,req.params.id,text.trim());if(!row)return res.status(404).json({error:'Likee video was not found.'});return res.status(201).json({comment:{id:String(row.id),text:row.text,mine:true,createdAt:new Date(row.createdAt).toISOString()}});}catch{return res.status(503).json({error:'Likee service is unavailable.'});}});
  app.get('/api/likee/recipients',requireGoogleSession,limiter,async(req,res)=>{if(!ready(req,res))return;try{const rows=await likeeStore.listRecipients(req.session.stemmaUser.subject);return res.json({recipients:rows.map(row=>({id:String(row.id),nickName:row.nickName,username:row.username,avatarUrl:row.hasAvatar?`/api/likee/conversations/${row.id}/avatar`:null}))});}catch{return res.status(503).json({error:'Likee service is unavailable.'});}});
  app.get('/api/likee/conversations/:id/avatar',requireGoogleSession,assetLimiter,async(req,res)=>{if(!ready(req,res))return;if(!validConversationId(req.params.id))return res.status(400).json({error:'Conversation id is invalid.'});try{const avatar=await likeeStore.getRecipientAvatar(req.session.stemmaUser.subject,req.params.id);if(!avatar||!['image/png','image/jpeg','image/webp'].includes(avatar.mimeType))return res.status(404).json({error:'Profile photo not found.'});noStore(res);res.set({'Content-Type':avatar.mimeType,'X-Content-Type-Options':'nosniff'});return res.send(avatar.data);}catch{return res.status(503).json({error:'Likee service is unavailable.'});}});
  app.post('/api/likee/videos/:id/share',requireGoogleSession,limiter,sameOriginJson(config),express.json({limit:'8kb',strict:true}),async(req,res)=>{if(!ready(req,res)||!idRoute(req,res))return;const body=req.body;if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['conversationIds','requestId'].includes(k))||!Array.isArray(body.conversationIds)||body.conversationIds.length<1||body.conversationIds.length>25||!validId(body.requestId)||body.conversationIds.some(id=>!validConversationId(id))||new Set(body.conversationIds).size!==body.conversationIds.length)return res.status(400).json({error:'A valid request id and 1–25 distinct conversation ids are required.'});try{const result=await likeeStore.shareVideo(req.session.stemmaUser.subject,req.params.id,body.conversationIds,body.requestId);return res.json({shared:result.conversationIds,alreadyShared:result.alreadyShared});}catch(error){if(error.code==='NOT_FOUND')return res.status(404).json({error:'Likee video was not found.'});if(error.code==='NOT_MEMBER')return res.status(403).json({error:'One or more conversations are unavailable.'});if(error.code==='IDEMPOTENCY_CONFLICT')return res.status(409).json({error:error.message});return res.status(503).json({error:'Likee service is unavailable.'});}});
}
