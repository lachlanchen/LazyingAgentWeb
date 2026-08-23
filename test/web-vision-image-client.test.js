import assert from 'node:assert/strict';
import test from 'node:test';

import { createPwaIcon } from '../src/web/pwa-assets.js';
import { validateVisionAttachmentRequest } from '../src/vision-attachment.js';
import {
  BROWSER_VISION_IMAGE_LIMITS,
  canonicalizeVisionImage,
  inspectVisionImageBytes,
  sanitizeVisionImageBytes
} from '../src/web/vision-image-client.js';

const JPEG_BYTES = Buffer.from('/9j/4AAQSkZJRgABAQAAAAAAAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==', 'base64');

function crc32(bytes) {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
    table[index] = value >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function insertPngChunk(bytes, type, data) {
  const iendOffset = bytes.indexOf(Buffer.from('IEND', 'ascii')) - 4;
  return Buffer.concat([bytes.subarray(0, iendOffset), pngChunk(type, data), bytes.subarray(iendOffset)]);
}

function rewritePngDimensions(bytes, width, height) {
  const result = Buffer.from(bytes);
  result.writeUInt32BE(width, 16);
  result.writeUInt32BE(height, 20);
  result.writeUInt32BE(crc32(result.subarray(12, 29)), 29);
  return result;
}

function insertJpegSegment(bytes, marker, data) {
  const segment = Buffer.alloc(4 + data.byteLength);
  segment[0] = 0xff;
  segment[1] = marker;
  segment.writeUInt16BE(data.byteLength + 2, 2);
  Buffer.from(data).copy(segment, 4);
  return Buffer.concat([bytes.subarray(0, 2), segment, bytes.subarray(2)]);
}

function file(bytes, type) {
  return Object.freeze({
    size: bytes.byteLength,
    type,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
  });
}

function browserHarness(outputBytes, outputType, dimensions, calls) {
  const bitmap = {
    ...dimensions,
    close() { calls.push(['close']); }
  };
  const context = {
    fillStyle: '',
    fillRect(...values) { calls.push(['fillRect', ...values]); },
    drawImage(...values) { calls.push(['drawImage', ...values.slice(1)]); }
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext(kind, options) {
      calls.push(['getContext', kind, options]);
      return context;
    },
    toBlob(callback, type, quality) {
      calls.push(['toBlob', type, quality]);
      callback(new Blob([outputBytes], { type: outputType }));
    }
  };
  return {
    document: {
      createElement(name) {
        assert.equal(name, 'canvas');
        return canvas;
      }
    },
    async createImageBitmapImpl() { return bitmap; },
    makeAttachmentId(kind) {
      assert.equal(kind, 'image');
      return 'image_0000000000000001';
    },
    canvas
  };
}

test('canonicalizes a PNG through a metadata-stripping canvas and closes decoded resources', async () => {
  const source = Buffer.from(createPwaIcon(192));
  const canonical = Buffer.from(createPwaIcon(192));
  const canvasOutput = insertPngChunk(canonical, 'eXIf', Buffer.from([0x49, 0x49, 0x2a, 0x00]));
  const calls = [];
  const harness = browserHarness(canvasOutput, 'image/png', { width: 192, height: 192 }, calls);
  const result = await canonicalizeVisionImage(file(source, 'image/png'), harness);

  assert.deepEqual({
    attachmentId: result.attachmentId,
    mediaType: result.mediaType,
    byteLength: result.byteLength,
    width: result.width,
    height: result.height
  }, {
    attachmentId: 'image_0000000000000001',
    mediaType: 'image/png',
    byteLength: canonical.byteLength,
    width: 192,
    height: 192
  });
  assert.deepEqual(Buffer.from(result.bytes), canonical);
  assert.deepEqual(Buffer.from(await result.previewBlob.arrayBuffer()), canonical);
  assert.equal(result.previewBlob.type, 'image/png');
  assert.equal(harness.canvas.width, 192);
  assert.equal(harness.canvas.height, 192);
  assert.deepEqual(calls, [
    ['getContext', '2d', { alpha: true }],
    ['drawImage', 0, 0, 192, 192],
    ['toBlob', 'image/png', undefined],
    ['close']
  ]);
});

test('canonicalizes JPEG onto white and preserves a required bounded decoded geometry', async () => {
  const calls = [];
  const canvasOutput = insertJpegSegment(JPEG_BYTES, 0xe1, Buffer.from('Exif\0\0', 'latin1'));
  const harness = browserHarness(canvasOutput, 'image/jpeg', { width: 1, height: 1 }, calls);
  const result = await canonicalizeVisionImage(file(JPEG_BYTES, 'image/jpeg'), harness);
  assert.deepEqual([result.mediaType, result.width, result.height], ['image/jpeg', 1, 1]);
  assert.deepEqual(Buffer.from(result.bytes), JPEG_BYTES);
  assert.deepEqual(Buffer.from(await result.previewBlob.arrayBuffer()), JPEG_BYTES);
  assert.deepEqual(calls, [
    ['getContext', '2d', { alpha: false }],
    ['fillRect', 0, 0, 1, 1],
    ['drawImage', 0, 0, 1, 1],
    ['toBlob', 'image/jpeg', 0.9],
    ['close']
  ]);
});

test('preserves browser-applied metadata orientation while stripping the source metadata', async () => {
  const source = rewritePngDimensions(createPwaIcon(192), 320, 240);
  const canonical = rewritePngDimensions(createPwaIcon(192), 240, 320);
  const calls = [];
  const harness = browserHarness(canonical, 'image/png', { width: 240, height: 320 }, calls);
  const result = await canonicalizeVisionImage(file(source, 'image/png'), harness);
  assert.deepEqual([result.width, result.height], [240, 320]);
  assert.equal(harness.canvas.width, 240);
  assert.equal(harness.canvas.height, 320);
  assert.deepEqual(calls[1], ['drawImage', 0, 0, 240, 320]);
});

test('known Safari PNG and JPEG metadata sanitize deterministically before strict server validation', () => {
  const png = Buffer.from(createPwaIcon(192));
  const pngWithExif = insertPngChunk(png, 'eXIf', Buffer.from([0x4d, 0x4d, 0x00, 0x2a]));
  assert.deepEqual(Buffer.from(sanitizeVisionImageBytes(pngWithExif, 'image/png')), png);
  assert.deepEqual(validateVisionAttachmentRequest({
    attachmentId: 'image_0000000000000001',
    mediaType: 'image/png',
    data: pngWithExif.toString('base64')
  }).content, png);

  const jpegWithApp1 = insertJpegSegment(JPEG_BYTES, 0xe1, Buffer.from('Exif\0\0', 'latin1'));
  assert.deepEqual(Buffer.from(sanitizeVisionImageBytes(jpegWithApp1, 'image/jpeg')), JPEG_BYTES);
  assert.deepEqual(validateVisionAttachmentRequest({
    attachmentId: 'image_0000000000000002',
    mediaType: 'image/jpeg',
    data: jpegWithApp1.toString('base64')
  }).content, JPEG_BYTES);

  const invalidMetadataCrc = Buffer.from(pngWithExif);
  invalidMetadataCrc[invalidMetadataCrc.byteLength - 14] ^= 1;
  assert.throws(() => sanitizeVisionImageBytes(invalidMetadataCrc, 'image/png'), /checksum/u);
  assert.throws(() => validateVisionAttachmentRequest({
    attachmentId: 'image_0000000000000003',
    mediaType: 'image/png',
    data: invalidMetadataCrc.toString('base64')
  }), /checksum/u);
});

test('C2PA caBX metadata strips with CRC validation, idempotence, and strict server acceptance', () => {
  const png = Buffer.from(createPwaIcon(192));
  const contentAuthenticityPayload = Buffer.alloc(21_824);
  Buffer.from('synthetic-c2pa-regression', 'ascii').copy(contentAuthenticityPayload);
  const pngWithCabx = insertPngChunk(png, 'caBX', contentAuthenticityPayload);
  const sanitized = sanitizeVisionImageBytes(pngWithCabx, 'image/png');

  assert.deepEqual(Buffer.from(sanitized), png);
  assert.equal(sanitizeVisionImageBytes(sanitized, 'image/png'), sanitized, 'sanitization is idempotent after metadata removal');
  assert.deepEqual(validateVisionAttachmentRequest({
    attachmentId: 'image_0000000000000004',
    mediaType: 'image/png',
    data: pngWithCabx.toString('base64')
  }).content, png);

  const invalidCabxCrc = Buffer.from(pngWithCabx);
  const typeOffset = invalidCabxCrc.indexOf(Buffer.from('caBX', 'ascii'));
  invalidCabxCrc[typeOffset + 4 + contentAuthenticityPayload.byteLength] ^= 1;
  assert.throws(() => sanitizeVisionImageBytes(invalidCabxCrc, 'image/png'), /checksum/u);
  assert.throws(() => validateVisionAttachmentRequest({
    attachmentId: 'image_0000000000000005',
    mediaType: 'image/png',
    data: invalidCabxCrc.toString('base64')
  }), /checksum/u);
});

test('rejects unsupported, oversized, forged, changed, and over-cap canonical images', async () => {
  const png = Buffer.from(createPwaIcon(192));
  assert.throws(() => inspectVisionImageBytes(png, 'image/gif'), /JPEG or PNG/u);
  await assert.rejects(() => canonicalizeVisionImage(file(png, 'image/gif'), {}), /one JPEG or PNG/u);

  const oversized = {
    size: BROWSER_VISION_IMAGE_LIMITS.sourceBytes + 1,
    type: 'image/png',
    async arrayBuffer() { return new ArrayBuffer(0); }
  };
  await assert.rejects(() => canonicalizeVisionImage(oversized, {}), /one JPEG or PNG/u);

  const forged = Buffer.from(png);
  forged[0] = 0;
  const calls = [];
  await assert.rejects(
    () => canonicalizeVisionImage(file(forged, 'image/png'), browserHarness(png, 'image/png', { width: 192, height: 192 }, calls)),
    /valid PNG/u
  );
  assert.equal(calls.length, 0);

  const mismatchCalls = [];
  await assert.rejects(
    () => canonicalizeVisionImage(file(png, 'image/png'), browserHarness(png, 'image/png', { width: 191, height: 192 }, mismatchCalls)),
    /dimensions do not match/u
  );
  assert.deepEqual(mismatchCalls, [['close']]);

  const hugeOutput = insertPngChunk(
    png,
    'ruSt',
    new Uint8Array(BROWSER_VISION_IMAGE_LIMITS.canonicalBytes)
  );
  const hugeCalls = [];
  await assert.rejects(
    () => canonicalizeVisionImage(file(png, 'image/png'), browserHarness(hugeOutput, 'image/png', { width: 192, height: 192 }, hugeCalls)),
    /exceeds 4 MiB/u
  );
  assert.equal(hugeCalls.at(-1)[0], 'close');
});
