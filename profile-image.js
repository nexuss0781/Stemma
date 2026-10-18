const MAX_BYTES = 1024 * 1024;
const MAX_DIMENSION = 2048;
const MAX_PIXELS = 4_194_304;
const ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

function validDimensions(width, height) {
  return Number.isInteger(width) && Number.isInteger(height) && width >= 1 && height >= 1 &&
    width <= MAX_DIMENSION && height <= MAX_DIMENSION && width * height <= MAX_PIXELS;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(buffer, start, end) {
  let crc = 0xffffffff;
  for (let i = start; i < end; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function readPng(buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(signature)) return null;
  let offset = 8;
  let width;
  let height;
  let seenIdat = false;
  let endedIdat = false;
  let idatBytes = 0;
  let seenPalette = false;
  let colorType;
  let seenIend = false;
  let chunkCount = 0;
  while (offset + 12 <= buffer.length) {
    if (++chunkCount > 4096) return null;
    const length = buffer.readUInt32BE(offset);
    if (length > MAX_BYTES || offset + 12 + length > buffer.length) return null;
    const typeOffset = offset + 4;
    const type = buffer.toString('ascii', typeOffset, typeOffset + 4);
    if (!/^[A-Za-z]{4}$/.test(type)) return null;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const expectedCrc = buffer.readUInt32BE(dataEnd);
    if (crc32(buffer, typeOffset, dataEnd) !== expectedCrc) return null;
    if (chunkCount === 1) {
      if (type !== 'IHDR' || length !== 13) return null;
      width = buffer.readUInt32BE(dataStart);
      height = buffer.readUInt32BE(dataStart + 4);
      const bitDepth = buffer[dataStart + 8];
      colorType = buffer[dataStart + 9];
      if (!validDimensions(width, height) || ![0, 2, 3, 4, 6].includes(colorType) ||
          !({ 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }[colorType]).includes(bitDepth) ||
          buffer[dataStart + 10] !== 0 || buffer[dataStart + 11] !== 0 || buffer[dataStart + 12] !== 0) return null;
    } else if (type === 'IHDR') return null;
    if (['acTL', 'fcTL', 'fdAT'].includes(type)) return null;
    if (type === 'PLTE') {
      if (seenPalette || seenIdat || length < 3 || length > 768 || length % 3 !== 0 || colorType === 0 || colorType === 4) return null;
      seenPalette = true;
    } else if (/^[A-Z]/.test(type) && !['IHDR', 'IDAT', 'IEND'].includes(type)) {
      return null;
    }
    if (type === 'IDAT') {
      if (endedIdat || (colorType === 3 && !seenPalette)) return null;
      seenIdat = true;
      idatBytes += length;
    } else if (seenIdat && type !== 'IEND') endedIdat = true;
    if (type === 'IEND') {
      if (length !== 0 || !seenIdat || idatBytes === 0 || dataEnd + 4 !== buffer.length) return null;
      seenIend = true;
      break;
    }
    offset = dataEnd + 4;
  }
  return seenIend && width && height ? { width, height } : null;
}

function readJpeg(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  let width;
  let height;
  let sawScan = false;
  const sofMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  while (offset < buffer.length) {
    if (buffer[offset++] !== 0xff) return null;
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) return null;
    const marker = buffer[offset++];
    if (marker === 0xd9) return sawScan && validDimensions(width, height) && offset === buffer.length ? { width, height } : null;
    if (marker === 0xd8 || marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) return null;
    if (offset + 2 > buffer.length) return null;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) return null;
    const data = offset + 2;
    if (sofMarkers.has(marker)) {
      if (length < 8 || width !== undefined) return null;
      height = buffer.readUInt16BE(data + 1);
      width = buffer.readUInt16BE(data + 3);
      const components = buffer[data + 5];
      if (components < 1 || components > 4 || length !== 8 + 3 * components || !validDimensions(width, height)) return null;
    }
    if (marker === 0xda) {
      if (!validDimensions(width, height) || length < 6) return null;
      sawScan = true;
      offset += length;
      while (offset < buffer.length) {
        if (buffer[offset++] !== 0xff) continue;
        if (offset >= buffer.length) return null;
        let next = buffer[offset++];
        while (next === 0xff && offset < buffer.length) next = buffer[offset++];
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) continue;
        if (next === 0xd9) return offset === buffer.length ? { width, height } : null;
        // Multi-scan JPEGs are supported by returning to marker parsing.
        offset -= 2;
        break;
      }
      if (offset >= buffer.length) return null;
    } else {
      offset += length;
    }
  }
  return null;
}

function readWebp(buffer) {
  if (buffer.length < 20 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') return null;
  const riffSize = buffer.readUInt32LE(4);
  if (riffSize + 8 !== buffer.length) return null;
  let offset = 12;
  let dimensions = null;
  let chunks = 0;
  let imagePayload = false;
  let seenExtendedHeader = false;
  while (offset + 8 <= buffer.length) {
    if (++chunks > 256) return null;
    const type = buffer.toString('ascii', offset, offset + 4);
    const length = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const paddedEnd = dataEnd + (length & 1);
    if (dataEnd > buffer.length || paddedEnd > buffer.length) return null;
    if ((length & 1) && buffer[dataEnd] !== 0) return null;
    if (type === 'ANIM' || type === 'ANMF') return null;
    if (type === 'VP8X') {
      if (length !== 10 || dimensions || offset !== 12) return null;
      seenExtendedHeader = true;
      const flags = buffer[dataStart];
      if (flags & 0x02) return null; // Animation feature flag.
      const width = 1 + buffer.readUIntLE(dataStart + 4, 3);
      const height = 1 + buffer.readUIntLE(dataStart + 7, 3);
      dimensions = validDimensions(width, height) ? { width, height } : null;
      if (!dimensions) return null;
    } else if (type === 'VP8 ') {
      if (imagePayload || length < 10 || buffer[dataStart + 3] !== 0x9d || buffer[dataStart + 4] !== 0x01 || buffer[dataStart + 5] !== 0x2a) return null;
      const width = buffer.readUInt16LE(dataStart + 6) & 0x3fff;
      const height = buffer.readUInt16LE(dataStart + 8) & 0x3fff;
      if (!validDimensions(width, height) || (dimensions && (dimensions.width !== width || dimensions.height !== height))) return null;
      dimensions ??= { width, height };
      imagePayload = true;
    } else if (type === 'VP8L') {
      if (imagePayload || length < 5 || buffer[dataStart] !== 0x2f) return null;
      const b1 = buffer[dataStart + 1]; const b2 = buffer[dataStart + 2];
      const b3 = buffer[dataStart + 3]; const b4 = buffer[dataStart + 4];
      const width = 1 + b1 + ((b2 & 0x3f) << 8);
      const height = 1 + (b2 >> 6) + (b3 << 2) + ((b4 & 0x0f) << 10);
      if (!validDimensions(width, height) || (dimensions && (dimensions.width !== width || dimensions.height !== height)) || (b4 & 0xe0)) return null;
      dimensions ??= { width, height };
      imagePayload = true;
    }
    offset = paddedEnd;
  }
  return offset === buffer.length && dimensions && imagePayload && (!seenExtendedHeader || chunks > 1) ? dimensions : null;
}

export function validateProfileImage(buffer, mime) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 1 || buffer.length > MAX_BYTES || typeof mime !== 'string') return null;
  const mimeType = mime.toLowerCase();
  if (!ALLOWED_MIME_TYPES.has(mimeType)) return null;
  let dimensions;
  if (mimeType === 'image/png') dimensions = readPng(buffer);
  else if (mimeType === 'image/jpeg') dimensions = readJpeg(buffer);
  else dimensions = readWebp(buffer);
  if (!dimensions) return null;
  return { data: Buffer.from(buffer), mimeType, width: dimensions.width, height: dimensions.height };
}
