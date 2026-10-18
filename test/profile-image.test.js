import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateProfileImage } from '../profile-image.js';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  return table;
})();
function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const typeBytes = Buffer.from(type);
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, crc]);
}
function png(width = 1, height = 1, extras = []) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header),
    ...extras, pngChunk('IDAT', Buffer.from([0x78, 0x9c, 0x63, 0, 0, 0, 2, 0, 1])), pngChunk('IEND', Buffer.alloc(0))
  ]);
}
function jpeg(width = 1, height = 1) {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x01, 0x01, 0x11, 0x00]);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, sos, Buffer.from([0x01, 0xff, 0xd9])]);
}
function webp(width = 1, height = 1) {
  const vp8x = Buffer.alloc(10);
  vp8x.writeUIntLE(width - 1, 4, 3); vp8x.writeUIntLE(height - 1, 7, 3);
  const vp8Header = Buffer.from([0, 0, 0, 0x9d, 0x01, 0x2a, width & 255, width >> 8, height & 255, height >> 8]);
  const chunks = Buffer.concat([
    Buffer.from('VP8X'), Buffer.from([10, 0, 0, 0]), vp8x,
    Buffer.from('VP8 '), Buffer.from([10, 0, 0, 0]), vp8Header
  ]);
  const riff = Buffer.alloc(12); riff.write('RIFF', 0); riff.write('WEBP', 8); riff.writeUInt32LE(4 + chunks.length, 4);
  return Buffer.concat([riff, chunks]);
}

test('validates bounded static PNG, JPEG, and WebP and returns canonical metadata', () => {
  for (const [buffer, mimeType] of [[png(32, 24), 'image/png'], [jpeg(32, 24), 'image/jpeg'], [webp(32, 24), 'image/webp']]) {
    const image = validateProfileImage(buffer, mimeType);
    assert.deepEqual({ mimeType: image?.mimeType, width: image?.width, height: image?.height }, { mimeType, width: 32, height: 24 });
    assert.deepEqual(image.data, buffer);
    assert.notEqual(image.data, buffer);
  }
});

test('rejects mismatched, truncated, corrupted, animated, and invalid-dimension images', () => {
  assert.equal(validateProfileImage(Buffer.from('<svg/>'), 'image/png'), null);
  assert.equal(validateProfileImage(png(), 'image/jpeg'), null);
  assert.equal(validateProfileImage(png().subarray(0, -4), 'image/png'), null);
  const corrupt = png(); corrupt[29] ^= 1;
  assert.equal(validateProfileImage(corrupt, 'image/png'), null);
  assert.equal(validateProfileImage(png(2049, 1), 'image/png'), null);
  assert.equal(validateProfileImage(png(2048, 2048), 'image/png')?.width, 2048); // Pixel total is capped at 4,194,304.
  assert.equal(validateProfileImage(png(2049, 2048), 'image/png'), null);
  assert.equal(validateProfileImage(png(1, 1, [pngChunk('acTL', Buffer.alloc(8))]), 'image/png'), null);
  assert.equal(validateProfileImage(Buffer.alloc(0), 'image/png'), null);
  assert.equal(validateProfileImage(Buffer.alloc(1024 * 1024 + 1), 'image/png'), null);
  assert.equal(validateProfileImage(webp(2049, 1), 'image/webp'), null);
  const animatedWebp = webp();
  animatedWebp[20] = 0x02;
  assert.equal(validateProfileImage(animatedWebp, 'image/webp'), null);
});
