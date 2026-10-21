import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { validateAttachmentBody, MAX_ATTACHMENT_BYTES } from './attachments-api.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MAX_DESCRIPTION_LENGTH = 1000;
const MAX_FEED_STORIES = 200;
const MAX_ACTIVE_PER_OWNER = 20;
const CLEANUP_BATCH = 50;
const MAX_VIDEO_SECONDS = 50;
const VIDEO_TYPES = new Set(['video/mp4', 'video/quicktime']);
const EXTENSION_BY_MIME = Object.freeze({
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/quicktime': 'mov'
});
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function invalidBmff(message = 'Video file is malformed or unsupported.') { throw new TypeError(message); }

function readBoxes(data, start, end) {
  const boxes = [];
  let offset = start;
  while (offset < end) {
    if (end - offset < 8) invalidBmff();
    const size32 = data.readUInt32BE(offset);
    const type = data.toString('latin1', offset + 4, offset + 8);
    let headerSize = 8;
    let size;
    if (size32 === 1) {
      if (end - offset < 16) invalidBmff();
      const large = data.readBigUInt64BE(offset + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) invalidBmff();
      size = Number(large);
      headerSize = 16;
    } else if (size32 === 0) {
      // Extending to EOF is ambiguous in nested boxes; reject it for bounded parsing.
      invalidBmff();
    } else size = size32;
    if (type === 'uuid') headerSize += 16;
    if (size < headerSize || offset + size > end) invalidBmff();
    boxes.push({ type, start: offset, end: offset + size, payload: offset + headerSize, size, headerSize });
    offset += size;
  }
  if (offset !== end) invalidBmff();
  return boxes;
}

function childBoxes(data, box) { return readBoxes(data, box.payload, box.end); }
function oneBox(boxes, type, required = true) {
  const found = boxes.filter(box => box.type === type);
  if (found.length > 1 || (required && found.length !== 1)) invalidBmff();
  return found[0] ?? null;
}
function readHeaderTiming(data, box, kind, allowUnknown = false) {
  if (box.size < box.headerSize + 20) invalidBmff();
  const version = data[box.payload];
  if (version !== 0 && version !== 1) invalidBmff();
  const timescaleOffset = box.payload + (version === 1 ? 20 : 12);
  const durationOffset = timescaleOffset + 4;
  const needed = version === 1 ? 32 : 20;
  if (box.end - box.payload < needed) invalidBmff();
  const timescale = data.readUInt32BE(timescaleOffset);
  const duration = version === 1 ? data.readBigUInt64BE(durationOffset) : BigInt(data.readUInt32BE(durationOffset));
  if (timescale < 1 || timescale > 1_000_000) invalidBmff(`Video has unknown ${kind} timescale.`);
  const unknown = duration === 0n || duration === (version === 1 ? 0xffffffffffffffffn : 0xffffffffn);
  if (unknown && !allowUnknown) invalidBmff(`Video has unknown ${kind} duration metadata.`);
  if (unknown) return { seconds: null, timescale, duration };
  const seconds = Number(duration) / timescale;
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 24 * 60 * 60) invalidBmff();
  return { seconds, timescale, duration };
}
function uintDuration(data, box, kind) { return readHeaderTiming(data, box, kind); }

function validateVisualDescriptions(data, description) {
  if (description.end - description.payload < 8 || data[description.payload] !== 0) invalidBmff();
  const count = data.readUInt32BE(description.payload + 4);
  if (count < 1 || count > 64) invalidBmff();
  const entries = readBoxes(data, description.payload + 8, description.end);
  if (entries.length !== count) invalidBmff();
  const codecs = new Map([
    ['avc1', ['avcC', 7, 1]], ['avc3', ['avcC', 7, 1]], ['hvc1', ['hvcC', 23, 1]], ['hev1', ['hvcC', 23, 1]],
    ['av01', ['av1C', 4, 0x81]], ['vp09', ['vpcC', 8, 1]], ['mp4v', ['esds', 4, 0]]
  ]);
  for (const entry of entries) {
    const configuration = codecs.get(entry.type);
    if (!configuration || entry.end - entry.payload < 78) invalidBmff('Video codec is not supported.');
    const width = data.readUInt16BE(entry.payload + 24);
    const height = data.readUInt16BE(entry.payload + 26);
    if (!width || !height || width > 8192 || height > 8192) invalidBmff();
    const configBoxes = readBoxes(data, entry.payload + 78, entry.end);
    const config = configBoxes.find(box => box.type === configuration[0]);
    if (!config || config.end - config.payload < configuration[1] || data[config.payload] !== configuration[2]) invalidBmff('Video codec configuration is missing or malformed.');
  }
  return entries;
}

function parseStts(data, box) {
  if (!box || box.end - box.payload < 8) invalidBmff();
  const version = data[box.payload];
  if (version !== 0) invalidBmff();
  const entries = data.readUInt32BE(box.payload + 4);
  if (entries < 1 || entries > 1_000_000 || box.end - box.payload !== 8 + entries * 8) invalidBmff();
  let sampleCount = 0n;
  let tickCount = 0n;
  let offset = box.payload + 8;
  for (let i = 0; i < entries; i += 1) {
    const count = data.readUInt32BE(offset);
    const delta = data.readUInt32BE(offset + 4);
    if (!count || !delta) invalidBmff();
    sampleCount += BigInt(count);
    tickCount += BigInt(count) * BigInt(delta);
    if (sampleCount > 10_000_000n || tickCount > 86_400_000_000n) invalidBmff();
    offset += 8;
  }
  if (!sampleCount || !tickCount) invalidBmff();
  return { sampleCount, tickCount };
}

function validateSampleTable(data, stbl, sttsCount, videoTrack, mediaData) {
  const description = oneBox(childBoxes(data, stbl), 'stsd');
  if (description.end - description.payload < 8 || data[description.payload] !== 0) invalidBmff();
  const descriptionCount = data.readUInt32BE(description.payload + 4);
  if (descriptionCount < 1 || descriptionCount > 64) invalidBmff();
  const sampleDescriptions = videoTrack ? validateVisualDescriptions(data, description) : readBoxes(data, description.payload + 8, description.end);
  if (sampleDescriptions.length !== descriptionCount) invalidBmff();

  const sizeBox = oneBox(childBoxes(data, stbl), 'stsz');
  if (sizeBox.end - sizeBox.payload < 12 || data[sizeBox.payload] !== 0) invalidBmff();
  const fixedSize = data.readUInt32BE(sizeBox.payload + 4);
  const sampleCount = data.readUInt32BE(sizeBox.payload + 8);
  if (sampleCount < 1 || BigInt(sampleCount) !== sttsCount || sampleCount > 10_000_000) invalidBmff('Sample count metadata is inconsistent.');
  if (fixedSize) {
    if (sizeBox.end - sizeBox.payload !== 12) invalidBmff();
  } else {
    if (sizeBox.end - sizeBox.payload !== 12 + sampleCount * 4) invalidBmff();
    for (let index = 0; index < sampleCount; index += 1) {
      if (!data.readUInt32BE(sizeBox.payload + 12 + index * 4)) invalidBmff();
    }
  }

  const stsc = oneBox(childBoxes(data, stbl), 'stsc');
  if (stsc.end - stsc.payload < 8 || data[stsc.payload] !== 0) invalidBmff();
  const mapCount = data.readUInt32BE(stsc.payload + 4);
  if (mapCount < 1 || mapCount > 1_000_000 || stsc.end - stsc.payload !== 8 + mapCount * 12) invalidBmff();
  const maps = [];
  let offset = stsc.payload + 8;
  for (let index = 0; index < mapCount; index += 1) {
    const firstChunk = data.readUInt32BE(offset);
    const perChunk = data.readUInt32BE(offset + 4);
    const descriptionIndex = data.readUInt32BE(offset + 8);
    if (!firstChunk || !perChunk || descriptionIndex < 1 || descriptionIndex > descriptionCount ||
        (index === 0 && firstChunk !== 1) || (index > 0 && firstChunk <= maps.at(-1).firstChunk)) invalidBmff();
    maps.push({ firstChunk, perChunk });
    offset += 12;
  }
  const offsetBoxes = childBoxes(data, stbl);
  const chunkOffset32 = oneBox(offsetBoxes, 'stco', false);
  const chunkOffset64 = oneBox(offsetBoxes, 'co64', false);
  if (Boolean(chunkOffset32) === Boolean(chunkOffset64)) invalidBmff();
  const chunkOffsetsBox = chunkOffset32 ?? chunkOffset64;
  const wideOffsets = chunkOffsetsBox.type === 'co64';
  const width = wideOffsets ? 8 : 4;
  if (chunkOffsetsBox.end - chunkOffsetsBox.payload < 8 || data[chunkOffsetsBox.payload] !== 0) invalidBmff();
  const chunkCount = data.readUInt32BE(chunkOffsetsBox.payload + 4);
  if (chunkCount < 1 || chunkCount > 1_000_000 || chunkOffsetsBox.end - chunkOffsetsBox.payload !== 8 + chunkCount * width || maps.at(-1).firstChunk > chunkCount) invalidBmff();
  let mappedSamples = 0n;
  for (let index = 0; index < maps.length; index += 1) {
    const nextChunk = index + 1 < maps.length ? maps[index + 1].firstChunk : chunkCount + 1;
    mappedSamples += BigInt(nextChunk - maps[index].firstChunk) * BigInt(maps[index].perChunk);
  }
  if (mappedSamples !== BigInt(sampleCount)) invalidBmff('Sample-to-chunk metadata is inconsistent.');

  let sampleIndex = 0;
  for (let chunk = 0; chunk < chunkCount; chunk += 1) {
    let mapping = maps[0];
    for (let index = 1; index < maps.length && maps[index].firstChunk <= chunk + 1; index += 1) mapping = maps[index];
    let byteLength = 0;
    for (let sample = 0; sample < mapping.perChunk; sample += 1) {
      const sampleSize = fixedSize || data.readUInt32BE(sizeBox.payload + 12 + sampleIndex * 4);
      byteLength += sampleSize;
      sampleIndex += 1;
      if (byteLength > data.length) invalidBmff();
    }
    const rawOffset = wideOffsets ? data.readBigUInt64BE(chunkOffsetsBox.payload + 8 + chunk * width) : BigInt(data.readUInt32BE(chunkOffsetsBox.payload + 8 + chunk * width));
    if (rawOffset > BigInt(Number.MAX_SAFE_INTEGER)) invalidBmff();
    const chunkOffset = Number(rawOffset);
    if (!mediaData.some(box => chunkOffset >= box.payload && chunkOffset + byteLength <= box.end)) invalidBmff('Chunk offsets do not point to media data.');
  }
}

function trackIdFromTkhd(data, tkhd) {
  if (tkhd.end - tkhd.payload < 20) invalidBmff();
  const version = data[tkhd.payload];
  const offset = tkhd.payload + (version === 1 ? 20 : version === 0 ? 12 : -1);
  if (offset < tkhd.payload || offset + 4 > tkhd.end) invalidBmff();
  const id = data.readUInt32BE(offset);
  if (!id) invalidBmff();
  return id;
}

function durationFromTkhd(data, tkhd) {
  const version = data[tkhd.payload];
  const offset = tkhd.payload + (version === 1 ? 28 : version === 0 ? 20 : -1);
  const bytes = version === 1 ? 8 : 4;
  if (offset < tkhd.payload) invalidBmff();
  if (offset === tkhd.end) return null;
  if (offset + bytes > tkhd.end) invalidBmff();
  const duration = version === 1 ? data.readBigUInt64BE(offset) : BigInt(data.readUInt32BE(offset));
  const unknown = duration === 0n || duration === (version === 1 ? 0xffffffffffffffffn : 0xffffffffn);
  return unknown ? null : duration;
}

function decodeTimeFromTfdt(data, tfdt) {
  const version = data[tfdt.payload];
  if (version === 0 && tfdt.end - tfdt.payload === 8) return BigInt(data.readUInt32BE(tfdt.payload + 4));
  if (version === 1 && tfdt.end - tfdt.payload === 12) return data.readBigUInt64BE(tfdt.payload + 4);
  invalidBmff('Fragment decode timestamp is malformed.');
}

function parseTfhd(data, tfhd, moof) {
  if (tfhd.end - tfhd.payload < 8 || data[tfhd.payload] !== 0) invalidBmff();
  const flags = data.readUIntBE(tfhd.payload + 1, 3);
  if (flags & 0x010000) invalidBmff('Empty fragmented tracks are not supported.');
  const trackId = data.readUInt32BE(tfhd.payload + 4);
  if (!trackId) invalidBmff();
  let offset = tfhd.payload + 8;
  let baseDataOffset = null;
  let defaultDuration = null;
  let defaultSize = null;
  if (flags & 0x000001) {
    if (offset + 8 > tfhd.end) invalidBmff();
    const value = data.readBigUInt64BE(offset);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) invalidBmff();
    baseDataOffset = Number(value); offset += 8;
  }
  for (const [flag, field] of [[0x000002, 'description'], [0x000008, 'duration'], [0x000010, 'size'], [0x000020, 'sampleFlags']]) {
    if (!(flags & flag)) continue;
    if (offset + 4 > tfhd.end) invalidBmff();
    const value = data.readUInt32BE(offset); offset += 4;
    if (field === 'duration') defaultDuration = value;
    if (field === 'size') defaultSize = value;
  }
  if (offset !== tfhd.end || (baseDataOffset === null && !(flags & 0x020000))) invalidBmff('Fragment data base offset is unknown.');
  return { trackId, baseDataOffset: baseDataOffset ?? moof.start, defaultDuration, defaultSize };
}

function parseTrun(data, trun, defaults, baseDecodeTime, timescale, mediaData) {
  if (trun.end - trun.payload < 8) invalidBmff();
  const version = data[trun.payload];
  if (version !== 0 && version !== 1) invalidBmff();
  const flags = data.readUIntBE(trun.payload + 1, 3);
  const count = data.readUInt32BE(trun.payload + 4);
  if (!count || count > 10_000_000 || !(flags & 0x000001)) invalidBmff('Fragment sample count or data offset is unknown.');
  let offset = trun.payload + 8;
  const signedDataOffset = data.readInt32BE(offset); offset += 4;
  if (flags & 0x000004) { if (offset + 4 > trun.end) invalidBmff(); offset += 4; }
  const runStart = defaults.baseDataOffset + signedDataOffset;
  let durationTicks = 0n;
  let byteLength = 0;
  for (let index = 0; index < count; index += 1) {
    let duration = defaults.defaultDuration;
    let size = defaults.defaultSize;
    if (flags & 0x000100) { if (offset + 4 > trun.end) invalidBmff(); duration = data.readUInt32BE(offset); offset += 4; }
    if (flags & 0x000200) { if (offset + 4 > trun.end) invalidBmff(); size = data.readUInt32BE(offset); offset += 4; }
    if (flags & 0x000400) { if (offset + 4 > trun.end) invalidBmff(); offset += 4; }
    if (flags & 0x000800) { if (offset + 4 > trun.end) invalidBmff(); offset += 4; }
    if (!duration || !size) invalidBmff('Fragment sample duration or size is unknown.');
    durationTicks += BigInt(duration);
    byteLength += size;
    if (durationTicks > BigInt(timescale) * 86_400n || byteLength > data.length) invalidBmff();
  }
  if (offset !== trun.end || runStart < 0 || !mediaData.some(box => runStart >= box.payload && runStart + byteLength <= box.end)) invalidBmff('Fragment sample data is malformed or outside media data.');
  return { durationTicks, count, endDecodeTime: baseDecodeTime + durationTicks };
}

function fragmentedDuration(data, top, moovChildren, mediaData, maxSeconds) {
  const moov = top.find(box => box.type === 'moov');
  const mvhd = readHeaderTiming(data, oneBox(moovChildren, 'mvhd'), 'movie', true);
  const movieExt = oneBox(moovChildren, 'mvex');
  const trexDefaults = new Map();
  for (const trex of childBoxes(data, movieExt).filter(box => box.type === 'trex')) {
    if (trex.end - trex.payload !== 24 || data[trex.payload] !== 0) invalidBmff();
    const id = data.readUInt32BE(trex.payload + 4);
    const duration = data.readUInt32BE(trex.payload + 12);
    const size = data.readUInt32BE(trex.payload + 16);
    if (!id || trexDefaults.has(id)) invalidBmff();
    trexDefaults.set(id, { duration, size });
  }
  const tracks = new Map();
  const trackBoxes = moovChildren.filter(box => box.type === 'trak');
  if (!trackBoxes.length || trackBoxes.length > 32) invalidBmff();
  for (const trak of trackBoxes) {
    const trakChildren = childBoxes(data, trak);
    const tkhd = oneBox(trakChildren, 'tkhd');
    const id = trackIdFromTkhd(data, tkhd);
    const tkhdDuration = durationFromTkhd(data, tkhd);
    if (tracks.has(id)) invalidBmff();
    const mdia = oneBox(trakChildren, 'mdia');
    const mediaChildren = childBoxes(data, mdia);
    const timing = readHeaderTiming(data, oneBox(mediaChildren, 'mdhd'), 'track', true);
    const hdlr = oneBox(mediaChildren, 'hdlr');
    if (hdlr.end - hdlr.payload < 12 || data[hdlr.payload] !== 0) invalidBmff();
    const handler = data.toString('ascii', hdlr.payload + 8, hdlr.payload + 12);
    if (!['vide', 'soun'].includes(handler)) invalidBmff('Video contains an unknown media track.');
    const minf = oneBox(childBoxes(data, mdia), 'minf');
    const stbl = oneBox(childBoxes(data, minf), 'stbl');
    const stsd = oneBox(childBoxes(data, stbl), 'stsd');
    const descriptions = handler === 'vide' ? validateVisualDescriptions(data, stsd) : null;
    const trex = trexDefaults.get(id);
    if (!trex) invalidBmff('Fragment track defaults are missing.');
    tracks.set(id, { id, handler, timing, tkhdDuration, trex, descriptions, fragments: [] });
  }
  const moofs = top.filter(box => box.type === 'moof');
  if (!moofs.length || !trexDefaults.size) invalidBmff();
  let allSamples = 0;
  for (const moof of moofs) {
    const trafs = childBoxes(data, moof).filter(box => box.type === 'traf');
    if (!trafs.length) invalidBmff();
    for (const traf of trafs) {
      const children = childBoxes(data, traf);
      const tfhd = parseTfhd(data, oneBox(children, 'tfhd'), moof);
      const track = tracks.get(tfhd.trackId);
      if (!track) invalidBmff('Fragment references an unknown track.');
      const tfdt = decodeTimeFromTfdt(data, oneBox(children, 'tfdt'));
      const defaultDuration = tfhd.defaultDuration || track.trex.duration;
      const defaultSize = tfhd.defaultSize || track.trex.size;
      let decodeTime = tfdt;
      const truns = children.filter(box => box.type === 'trun');
      if (!truns.length) invalidBmff();
      for (const trun of truns) {
        const run = parseTrun(data, trun, { ...tfhd, defaultDuration, defaultSize }, decodeTime, track.timing.timescale, mediaData);
        allSamples += run.count;
        if (allSamples > 10_000_000) invalidBmff();
        decodeTime = run.endDecodeTime;
      }
      track.fragments.push({ start: tfdt, end: decodeTime });
    }
  }
  let hasVideo = false;
  const durations = [];
  const trackList = [...tracks.values()];
  const recorderHeaderDurations = trackList.map(track => track.tkhdDuration === null ? null : Number(track.tkhdDuration) / mvhd.timescale);
  const longRecorderHeaderConvention = mvhd.seconds === null && trackList.length === 2 &&
    trackList.some(track => track.handler === 'vide') && trackList.some(track => track.handler === 'soun') &&
    trackList.every((track, index) => track.tkhdDuration !== null && track.timing.duration === track.tkhdDuration &&
      track.timing.seconds !== null && track.timing.seconds <= maxSeconds &&
      recorderHeaderDurations[index] <= maxSeconds) &&
    Math.abs(recorderHeaderDurations[0] - recorderHeaderDurations[1]) <= 0.1;
  for (const track of trackList) {
    if (!track.fragments.length) invalidBmff('Track has no media samples.');
    const fragments = track.fragments.sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
    for (let i = 1; i < fragments.length; i += 1) if (fragments[i].start < fragments[i - 1].end) invalidBmff('Fragment decode times overlap.');
    const trackTicks = fragments.at(-1).end - fragments[0].start;
    if (trackTicks <= 0n) invalidBmff();
    const seconds = Number(trackTicks) / track.timing.timescale;
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 24 * 60 * 60) invalidBmff();
    const recorderHeaderConvention = track.tkhdDuration !== null && track.timing.duration === track.tkhdDuration &&
      Math.abs(Number(track.tkhdDuration) / mvhd.timescale - seconds) <= 0.05;
    if (track.timing.seconds !== null && Math.abs(track.timing.seconds - seconds) > 1 &&
        !recorderHeaderConvention && !longRecorderHeaderConvention) invalidBmff('Track and fragment duration metadata is inconsistent.');
    durations.push(seconds);
    if (track.handler === 'vide') hasVideo = true;
  }
  if (!hasVideo || !allSamples) invalidBmff('A video track is required.');
  const maximum = Math.max(...durations);
  if (mvhd.seconds !== null && Math.abs(mvhd.seconds - maximum) > 1) invalidBmff('Movie and fragment duration metadata is inconsistent.');
  if (maximum > maxSeconds) throw new RangeError(`Videos must be ${maxSeconds} seconds or shorter.`);
  return maximum;
}

/** Parse ISO-BMFF MP4/MOV timing, optionally enforcing a caller-specific cap. */
export function readVideoDuration(data, { maxSeconds = MAX_VIDEO_SECONDS } = {}) {
  if (!Number.isFinite(maxSeconds) || maxSeconds <= 0) throw new TypeError('A positive maximum video duration is required.');
  if (!Buffer.isBuffer(data) || data.length < 32 || data.toString('ascii', 4, 8) !== 'ftyp') invalidBmff();
  const top = readBoxes(data, 0, data.length);
  const ftyp = oneBox(top, 'ftyp');
  const moov = oneBox(top, 'moov');
  const mediaData = top.filter(box => box.type === 'mdat');
  if (!mediaData.length) invalidBmff('Media-less video is not supported.');
  if (ftyp.size < ftyp.headerSize + 8) invalidBmff();
  const moovChildren = childBoxes(data, moov);
  const hasMoof = top.some(box => box.type === 'moof');
  const hasMovieExtends = moovChildren.some(box => box.type === 'mvex');
  if (hasMoof || hasMovieExtends) return fragmentedDuration(data, top, moovChildren, mediaData, maxSeconds);
  const movieHeader = oneBox(moovChildren, 'mvhd');
  const movieDuration = uintDuration(data, movieHeader, 'movie').seconds;
  const tracks = moovChildren.filter(box => box.type === 'trak');
  if (!tracks.length || tracks.length > 32) invalidBmff();
  let hasVideo = false;
  const trackDurations = [];
  const trackMeta = [];
  for (const track of tracks) {
    const mdia = oneBox(childBoxes(data, track), 'mdia');
    const mediaChildren = childBoxes(data, mdia);
    const hdlr = oneBox(mediaChildren, 'hdlr');
    if (hdlr.end - hdlr.payload < 12 || data[hdlr.payload] !== 0) invalidBmff();
    const handler = data.toString('ascii', hdlr.payload + 8, hdlr.payload + 12);
    if (handler === 'vide') hasVideo = true;
    if (!['vide', 'soun', 'hint', 'meta', 'subt', 'text', 'sbtl', 'clcp'].includes(handler)) invalidBmff('Video contains an unknown media track.');
    const mdhd = uintDuration(data, oneBox(mediaChildren, 'mdhd'), 'track');
    const minf = oneBox(mediaChildren, 'minf');
    const stbl = oneBox(childBoxes(data, minf), 'stbl');
    const stblChildren = childBoxes(data, stbl);
    const stts = parseStts(data, oneBox(stblChildren, 'stts'));
    validateSampleTable(data, stbl, stts.sampleCount, handler === 'vide', mediaData);
    const sampleSeconds = Number(stts.tickCount) / mdhd.timescale;
    if (!Number.isFinite(sampleSeconds) || sampleSeconds <= 0 || sampleSeconds > 24 * 60 * 60) invalidBmff();
    // Without edit lists, mdhd and decode-time sums must describe the same timeline.
    if (Math.abs(sampleSeconds - mdhd.seconds) > 1) invalidBmff('Video track duration metadata is inconsistent.');
    trackDurations.push(mdhd.seconds, sampleSeconds);
    trackMeta.push({ handler, sampleCount: stts.sampleCount });
  }
  if (!hasVideo || !trackMeta.some(track => track.handler === 'vide' && track.sampleCount > 0n)) invalidBmff('A video track is required.');
  const maximum = Math.max(movieDuration, ...trackDurations);
  const maximumTrack = Math.max(...trackDurations);
  if (Math.abs(movieDuration - maximumTrack) > 1) invalidBmff('Movie and track duration metadata is inconsistent.');
  if (maximum > maxSeconds) throw new RangeError(`Videos must be ${maxSeconds} seconds or shorter.`);
  return maximum;
}

export function validateStoryBody(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.some(key => !['name', 'mimeType', 'data', 'description'].includes(key)) ||
      !['name', 'mimeType', 'data'].every(key => Object.hasOwn(value, key)) ||
      keys.length < 3 || keys.length > 4) return null;
  const description = value.description === undefined ? '' : value.description;
  if (typeof description !== 'string' || [...description].length > MAX_DESCRIPTION_LENGTH || description.includes('\0')) return null;
  const attachment = validateAttachmentBody({ name: value.name, mimeType: value.mimeType, data: value.data });
  if (!attachment || !Object.hasOwn(EXTENSION_BY_MIME, attachment.mimeType)) return null;
  if (VIDEO_TYPES.has(attachment.mimeType)) {
    try { readVideoDuration(attachment.data); } catch { return null; }
  }
  return { ...attachment, description: description.trim() };
}

function iso(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function storyDto(row, subject) {
  if (!row || typeof row.id !== 'string' || typeof row.mimeType !== 'string') return null;
  const createdAt = iso(row.createdAt);
  const expiresAt = iso(row.expiresAt);
  if (!createdAt || !expiresAt) return null;
  const id = row.id.toLowerCase();
  return {
    id,
    url: `/api/pulse/stories/${id}/media`,
    mimeType: row.mimeType,
    description: typeof row.description === 'string' ? row.description : '',
    createdAt,
    expiresAt,
    mine: row.ownerSubject === subject,
    owner: {
      nickName: typeof row.nickName === 'string' ? row.nickName : '',
      username: typeof row.username === 'string' ? row.username : '',
      avatarUrl: row.hasAvatar ? `/api/pulse/stories/${id}/avatar` : null
    }
  };
}

const STORY_SELECT = `s.id::text AS id, s.mime_type AS "mimeType", s.description,
  s.created_at AS "createdAt", s.expires_at AS "expiresAt", s.google_subject AS "ownerSubject",
  COALESCE(p.nick_name, '') AS "nickName", COALESCE(p.username, '') AS username,
  COALESCE(p.profile_image IS NOT NULL, false) AS "hasAvatar"`;

export function createStoryStore(pool) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new TypeError('A PostgreSQL pool is required.');
  return {
    async migrate() {
      await pool.query(await fs.readFile(path.join(ROOT, 'migrations', '013_pulse_stories.sql'), 'utf8'));
    },
    async cleanupExpired(limit = CLEANUP_BATCH) {
      const boundedLimit = Math.min(CLEANUP_BATCH, Math.max(1, Number.isInteger(limit) ? limit : CLEANUP_BATCH));
      const result = await pool.query(
        `WITH expired AS (
           SELECT id FROM stemma_pulse_stories
           WHERE expires_at <= statement_timestamp()
           ORDER BY expires_at, created_at, id
           FOR UPDATE SKIP LOCKED
           LIMIT $1
         ) DELETE FROM stemma_pulse_stories s USING expired e WHERE s.id = e.id`, [boundedLimit]);
      return result.rowCount ?? 0;
    },
    async listStories(subject) {
      await this.cleanupExpired();
      const result = await pool.query(
        `WITH clock AS (SELECT statement_timestamp() AS at),
         stories AS (
           SELECT ${STORY_SELECT}, clock.at AS "serverNow"
           FROM stemma_pulse_stories s CROSS JOIN clock
           LEFT JOIN stemma_student_profiles p ON p.google_subject = s.google_subject
           WHERE s.expires_at > clock.at
           ORDER BY s.created_at DESC, s.id DESC LIMIT $1
         )
         SELECT clock.at AS "serverNow", COALESCE(json_agg(json_build_object(
           'id', stories.id, 'mimeType', stories."mimeType", 'description', stories.description,
           'createdAt', stories."createdAt", 'expiresAt', stories."expiresAt", 'ownerSubject', stories."ownerSubject",
           'nickName', stories."nickName", 'username', stories.username, 'hasAvatar', stories."hasAvatar"
         ) ORDER BY stories."createdAt" DESC, stories.id DESC) FILTER (WHERE stories.id IS NOT NULL), '[]'::json) AS stories
         FROM clock LEFT JOIN stories ON true GROUP BY clock.at`, [MAX_FEED_STORIES]);
      const record = result.rows[0] ?? {};
      return { serverNow: record.serverNow, stories: (record.stories ?? []).map(row => storyDto(row, subject)).filter(Boolean) };
    },
    async createStory(subject, attachment) {
      const client = await pool.connect();
      const id = crypto.randomUUID();
      try {
        await client.query('BEGIN');
        // Serialize per-user uploads so concurrent requests cannot exceed active quota.
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [subject]);
        await client.query(
          `WITH expired AS (
             SELECT id FROM stemma_pulse_stories WHERE expires_at <= statement_timestamp()
             ORDER BY expires_at, created_at, id FOR UPDATE SKIP LOCKED LIMIT $1
           ) DELETE FROM stemma_pulse_stories s USING expired e WHERE s.id = e.id`, [CLEANUP_BATCH]);
        const count = await client.query(
          'SELECT count(*)::int AS count FROM stemma_pulse_stories WHERE google_subject=$1 AND expires_at > statement_timestamp()', [subject]);
        if (count.rows[0]?.count >= MAX_ACTIVE_PER_OWNER) {
          const error = new Error('An account may have at most 20 active stories.');
          error.code = 'STORY_QUOTA';
          throw error;
        }
        const inserted = await client.query(
          `INSERT INTO stemma_pulse_stories (id, google_subject, mime_type, description, data, byte_size)
           VALUES ($1::uuid, $2, $3, $4, $5, $6)
           RETURNING id::text AS id, mime_type AS "mimeType", description, created_at AS "createdAt", expires_at AS "expiresAt", google_subject AS "ownerSubject"`,
          [id, subject, attachment.mimeType, attachment.description, attachment.data, attachment.size]);
        const result = await client.query(
          `SELECT ${STORY_SELECT} FROM stemma_pulse_stories s
           LEFT JOIN stemma_student_profiles p ON p.google_subject=s.google_subject
           WHERE s.id=$1::uuid AND s.expires_at > statement_timestamp()`, [id]);
        await client.query('COMMIT');
        return storyDto(result.rows[0] ?? inserted.rows[0], subject);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally { client.release(); }
    },
    async deleteStory(subject, id) {
      const result = await pool.query(
        'DELETE FROM stemma_pulse_stories WHERE id=$1::uuid AND google_subject=$2 RETURNING id', [id, subject]);
      return (result.rowCount ?? 0) > 0;
    },
    async getStoryMedia(id) {
      const result = await pool.query(
        `SELECT id::text AS id, mime_type AS "mimeType", byte_size AS size, data
         FROM stemma_pulse_stories WHERE id=$1::uuid AND expires_at > statement_timestamp() LIMIT 1`, [id]);
      const row = result.rows[0];
      return row ? { ...row, data: Buffer.from(row.data), size: Number(row.size) } : null;
    },
    async getStoryAvatar(id) {
      const result = await pool.query(
        `SELECT p.profile_image AS data, p.profile_image_mime AS "mimeType"
         FROM stemma_pulse_stories s JOIN stemma_student_profiles p ON p.google_subject=s.google_subject
         WHERE s.id=$1::uuid AND s.expires_at > statement_timestamp() AND p.profile_image IS NOT NULL LIMIT 1`, [id]);
      const row = result.rows[0];
      return row ? { ...row, data: Buffer.from(row.data) } : null;
    }
  };
}

function setPrivateNoStore(res) {
  res.set({ 'Cache-Control': 'private, no-store, max-age=0', Pragma: 'no-cache', 'Referrer-Policy': 'no-referrer' });
}
function sameOriginJson(config) {
  return (req, res, next) => {
    const expected = config.appOrigin || `${req.protocol}://${req.get('host')}`;
    if (!req.get('origin') || req.get('origin') !== expected) {
      setPrivateNoStore(res);
      return res.status(403).json({ error: 'This request could not be verified.' });
    }
    if (!req.is('application/json')) {
      setPrivateNoStore(res);
      return res.status(415).json({ error: 'A JSON request body is required.' });
    }
    return next();
  };
}
function sameOriginMutation(config) {
  return (req, res, next) => {
    const expected = config.appOrigin || `${req.protocol}://${req.get('host')}`;
    if (!req.get('origin') || req.get('origin') !== expected) {
      setPrivateNoStore(res);
      return res.status(403).json({ error: 'This request could not be verified.' });
    }
    return next();
  };
}
function safeFileHeaders(res, mimeType, filename) {
  res.set({
    'Cache-Control': 'private, no-store, max-age=0', Pragma: 'no-cache', 'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff', 'Content-Type': mimeType,
    'Content-Disposition': `inline; filename="${filename}"`, 'Accept-Ranges': 'bytes'
  });
}
function sendMedia(req, res, media, filename) {
  safeFileHeaders(res, media.mimeType, filename);
  const data = media.data;
  const rangeHeader = req.get('range');
  if (!rangeHeader) return res.status(200).set('Content-Length', String(data.length)).send(data);
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match || (!match[1] && !match[2])) {
    res.set('Content-Range', `bytes */${data.length}`);
    return res.status(416).end();
  }
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) {
      res.set('Content-Range', `bytes */${data.length}`);
      return res.status(416).end();
    }
    start = Math.max(0, data.length - suffix); end = data.length - 1;
  } else {
    start = Number(match[1]); end = match[2] ? Number(match[2]) : data.length - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= data.length || end < start) {
      res.set('Content-Range', `bytes */${data.length}`);
      return res.status(416).end();
    }
    end = Math.min(end, data.length - 1);
  }
  const chunk = data.subarray(start, end + 1);
  res.set({ 'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Content-Length': String(chunk.length) });
  return res.status(206).send(chunk);
}

export function registerStoriesApi(app, { storyStore = null, requireGoogleSession, config }) {
  if (typeof requireGoogleSession !== 'function') throw new TypeError('Google-session middleware is required.');
  const limiterOptions = { windowMs: 60_000, standardHeaders: 'draft-8', legacyHeaders: false,
    keyGenerator: req => req.session.stemmaUser.subject,
    handler: (_req, res) => { setPrivateNoStore(res); res.status(429).json({ error: 'Too many story requests. Please wait and try again.' }); } };
  const limiter = rateLimit({ ...limiterOptions, limit: 40 });
  const readLimiter = rateLimit({ ...limiterOptions, limit: 2000,
    handler: (_req, res) => { setPrivateNoStore(res); res.status(429).json({ error: 'Too many story requests. Please wait and try again.' }); } });
  const serviceUnavailable = (_req, res) => res.status(503).json({ error: 'Stories service is unavailable.' });
  app.get('/api/pulse/stories', requireGoogleSession, readLimiter, async (req, res) => {
    setPrivateNoStore(res);
    if (!storyStore) return serviceUnavailable(req, res);
    try {
      const result = await storyStore.listStories(req.session.stemmaUser.subject);
      const serverNow = iso(result?.serverNow);
      if (!serverNow) return serviceUnavailable(req, res);
      return res.json({ stories: Array.isArray(result.stories) ? result.stories : [], serverNow });
    } catch { return serviceUnavailable(req, res); }
  });
  app.post('/api/pulse/stories', requireGoogleSession, limiter, sameOriginJson(config), express.json({ limit: '7mb', strict: true }), async (req, res) => {
    setPrivateNoStore(res);
    if (!storyStore) return serviceUnavailable(req, res);
    const attachment = validateStoryBody(req.body);
    if (!attachment) return res.status(400).json({ error: 'Story must contain a safe image or supported video, optional description up to 1000 characters, and no more than 5 MiB of data. Videos must include a valid video track of 50 seconds or less.' });
    try {
      const story = await storyStore.createStory(req.session.stemmaUser.subject, attachment);
      if (!story) return serviceUnavailable(req, res);
      return res.status(201).json({ story });
    } catch (error) {
      if (error?.code === 'STORY_QUOTA') return res.status(429).json({ error: error.message });
      return serviceUnavailable(req, res);
    }
  });
  app.delete('/api/pulse/stories/:id', requireGoogleSession, limiter, sameOriginMutation(config), async (req, res) => {
    setPrivateNoStore(res);
    if (!storyStore) return serviceUnavailable(req, res);
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Story not found.' });
    try {
      if (!await storyStore.deleteStory(req.session.stemmaUser.subject, req.params.id)) return res.status(404).json({ error: 'Story not found.' });
      return res.status(204).end();
    } catch { return serviceUnavailable(req, res); }
  });
  app.get('/api/pulse/stories/:id/media', requireGoogleSession, readLimiter, async (req, res) => {
    setPrivateNoStore(res);
    if (!storyStore) return serviceUnavailable(req, res);
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Story not found.' });
    try {
      const media = await storyStore.getStoryMedia(req.params.id);
      if (!media) return res.status(404).json({ error: 'Story not found.' });
      return sendMedia(req, res, media, `story.${EXTENSION_BY_MIME[media.mimeType] || 'bin'}`);
    } catch { return serviceUnavailable(req, res); }
  });
  app.get('/api/pulse/stories/:id/avatar', requireGoogleSession, readLimiter, async (req, res) => {
    setPrivateNoStore(res);
    if (!storyStore) return serviceUnavailable(req, res);
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Avatar not found.' });
    try {
      const avatar = await storyStore.getStoryAvatar(req.params.id);
      if (!avatar || !['image/jpeg', 'image/png', 'image/webp'].includes(avatar.mimeType)) return res.status(404).json({ error: 'Avatar not found.' });
      safeFileHeaders(res, avatar.mimeType, 'avatar');
      return res.status(200).set('Content-Length', String(avatar.data.length)).send(avatar.data);
    } catch { return serviceUnavailable(req, res); }
  });
}

export const STORY_LIMITS = Object.freeze({ maxAttachmentBytes: MAX_ATTACHMENT_BYTES, maxDescriptionLength: MAX_DESCRIPTION_LENGTH,
  maxVideoSeconds: MAX_VIDEO_SECONDS, maxActivePerOwner: MAX_ACTIVE_PER_OWNER, maxFeedStories: MAX_FEED_STORIES });
