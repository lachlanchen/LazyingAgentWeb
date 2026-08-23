import assert from 'node:assert/strict';
import test from 'node:test';

import { createAppShellHtml, createPwaIcon } from '../src/web/pwa-assets.js';
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

function rewriteJpegDimensions(bytes, width, height) {
  const result = Buffer.from(bytes);
  let offset = 2;
  while (offset < result.byteLength) {
    while (offset < result.byteLength && result[offset] === 0xff) offset += 1;
    const marker = result[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda || offset + 2 > result.byteLength) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const length = result.readUInt16BE(offset);
    if (marker === 0xc0) {
      result.writeUInt16BE(height, offset + 3);
      result.writeUInt16BE(width, offset + 5);
      return result;
    }
    offset += length;
  }
  throw new TypeError('test JPEG has no baseline frame');
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
      const bytes = typeof outputBytes === 'function'
        ? outputBytes({ width: canvas.width, height: canvas.height, type, quality })
        : outputBytes;
      callback(new Blob([bytes], { type: outputType }));
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

test('downscales a 48 MP iPhone-shaped JPEG and keeps its oriented preview independently bounded', async () => {
  const source = rewriteJpegDimensions(JPEG_BYTES, 8064, 6048);
  assert.throws(() => inspectVisionImageBytes(source, 'image/jpeg'), /safe vision limit/u,
    'the durable canonical inspector must remain strict');
  const calls = [];
  const output = ({ width, height }) => rewriteJpegDimensions(JPEG_BYTES, width, height);
  const harness = browserHarness(output, 'image/jpeg', { width: 6048, height: 8064 }, calls);
  const result = await canonicalizeVisionImage(file(source, 'image/jpeg'), harness);

  assert.deepEqual([result.mediaType, result.width, result.height], ['image/jpeg', 3072, 4096]);
  assert.ok(result.byteLength <= BROWSER_VISION_IMAGE_LIMITS.canonicalBytes);
  const previewBytes = new Uint8Array(await result.previewBlob.arrayBuffer());
  const preview = inspectVisionImageBytes(previewBytes, result.previewBlob.type);
  assert.deepEqual(preview, { width: 384, height: 512 });
  assert.ok(result.previewBlob.size <= BROWSER_VISION_IMAGE_LIMITS.previewBytes);
  assert.deepEqual(calls.filter(([name]) => name === 'drawImage'), [
    ['drawImage', 0, 0, 3072, 4096],
    ['drawImage', 0, 0, 384, 512]
  ]);
  assert.deepEqual(calls.at(-1), ['close']);
});

test('downscales a high-resolution PNG while preserving a bounded PNG thumbnail', async () => {
  const icon = Buffer.from(createPwaIcon(192));
  const source = rewritePngDimensions(icon, 8064, 6048);
  const calls = [];
  const output = ({ width, height }) => rewritePngDimensions(icon, width, height);
  const result = await canonicalizeVisionImage(
    file(source, 'image/png'),
    browserHarness(output, 'image/png', { width: 8064, height: 6048 }, calls)
  );

  assert.deepEqual([result.mediaType, result.width, result.height], ['image/png', 4096, 3072]);
  const previewBytes = new Uint8Array(await result.previewBlob.arrayBuffer());
  assert.deepEqual(inspectVisionImageBytes(previewBytes, result.previewBlob.type), { width: 512, height: 384 });
  assert.ok(result.previewBlob.size <= BROWSER_VISION_IMAGE_LIMITS.previewBytes);
  assert.deepEqual(calls.filter(([name]) => name === 'drawImage'), [
    ['drawImage', 0, 0, 4096, 3072],
    ['drawImage', 0, 0, 512, 384]
  ]);
});

test('sniffs an iOS JPEG export with an empty MIME type and exposes extension hints in the picker', async () => {
  const calls = [];
  const result = await canonicalizeVisionImage(
    file(JPEG_BYTES, ''),
    browserHarness(JPEG_BYTES, 'image/jpeg', { width: 1, height: 1 }, calls)
  );
  assert.equal(result.mediaType, 'image/jpeg');
  assert.match(
    createAppShellHtml({ version: 'release-1234567890abcdef' }),
    /accept="image\/jpeg,image\/png,\.jpg,\.jpeg,\.png"/u
  );
});

test('retries createImageBitmap without options for Safari implementations that reject the overload', async () => {
  const calls = [];
  const harness = browserHarness(JPEG_BYTES, 'image/jpeg', { width: 1, height: 1 }, calls);
  const supportedDecode = harness.createImageBitmapImpl;
  const arities = [];
  harness.createImageBitmapImpl = async (...args) => {
    arities.push(args.length);
    if (args.length > 1) throw new TypeError('options overload unsupported');
    return supportedDecode(...args);
  };
  const result = await canonicalizeVisionImage(file(JPEG_BYTES, 'image/jpeg'), harness);
  assert.equal(result.mediaType, 'image/jpeg');
  assert.deepEqual(arities, [2, 1]);
  assert.deepEqual(calls.at(-1), ['close']);
});

test('uses and cleans up a Safari HTMLImageElement decoder when createImageBitmap is unavailable', async () => {
  const png = Buffer.from(createPwaIcon(192));
  const source = rewritePngDimensions(png, 320, 240);
  const calls = [];
  const harness = browserHarness(
    ({ width, height }) => rewritePngDimensions(png, width, height),
    'image/png',
    { width: 320, height: 240 },
    calls
  );
  const canvasDocument = harness.document;
  const image = {
    naturalWidth: 320,
    naturalHeight: 240,
    decoding: '',
    src: '',
    async decode() { calls.push(['imageDecode', this.src]); },
    removeAttribute(name) { calls.push(['removeAttribute', name]); this.src = ''; }
  };
  harness.document = {
    createElement(name) {
      if (name === 'img') return image;
      return canvasDocument.createElement(name);
    }
  };
  harness.createImageBitmapImpl = null;
  harness.createObjectUrl = () => {
    calls.push(['createObjectUrl']);
    return 'blob:safari-photo';
  };
  harness.revokeObjectUrl = (url) => calls.push(['revokeObjectUrl', url]);

  const result = await canonicalizeVisionImage(file(source, 'image/png'), harness);
  assert.deepEqual([result.width, result.height], [320, 240]);
  assert.deepEqual(calls.slice(0, 2), [
    ['createObjectUrl'],
    ['imageDecode', 'blob:safari-photo']
  ]);
  assert.deepEqual(calls.slice(-2), [
    ['removeAttribute', 'src'],
    ['revokeObjectUrl', 'blob:safari-photo']
  ]);
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
  await assert.rejects(() => canonicalizeVisionImage(file(png, 'image/gif'), {}), /JPEG or PNG image up to 24 MiB/u);

  const oversized = {
    size: BROWSER_VISION_IMAGE_LIMITS.sourceBytes + 1,
    type: 'image/png',
    async arrayBuffer() { return new ArrayBuffer(0); }
  };
  await assert.rejects(() => canonicalizeVisionImage(oversized, {}), /JPEG or PNG image up to 24 MiB/u);

  const heic = { ...file(png, 'image/heic') };
  await assert.rejects(() => canonicalizeVisionImage(heic, {}), /HEIC\/HEIF.*safety checks/u);

  const decodeBombHeader = rewritePngDimensions(png, BROWSER_VISION_IMAGE_LIMITS.sourceMaximumEdge + 1, 1);
  const decodeBombCalls = [];
  await assert.rejects(
    () => canonicalizeVisionImage(
      file(decodeBombHeader, 'image/png'),
      browserHarness(png, 'image/png', { width: 192, height: 192 }, decodeBombCalls)
    ),
    /source image dimensions exceed the safe decode limit/u
  );
  assert.deepEqual(decodeBombCalls, [], 'unsafe source geometry is rejected before browser decode');

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
