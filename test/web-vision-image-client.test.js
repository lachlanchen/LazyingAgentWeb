import assert from 'node:assert/strict';
import test from 'node:test';

import { createAppShellHtml, createPwaIcon } from '../src/web/pwa-assets.js';
import { validateVisionAttachmentRequest } from '../src/vision-attachment.js';
import {
  BROWSER_VISION_IMAGE_LIMITS,
  canonicalizeVisionImage,
  classifyVisionImageSource,
  inspectVisionImageBytes,
  sanitizeVisionImageBytes,
  VisionImageInputError,
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

function file(bytes, type, name = 'selected-image') {
  return Object.freeze({
    name,
    size: bytes.byteLength,
    type,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
  });
}

function isoFileType({
  major = 'heic',
  compatible = ['mif1', 'heic'],
  tail = Buffer.from('synthetic-native-decoder-payload', 'ascii'),
  sizeOverride,
} = {}) {
  const payload = Buffer.concat([
    Buffer.from(major, 'ascii'),
    Buffer.alloc(4),
    ...compatible.map((brand) => Buffer.from(brand, 'ascii')),
  ]);
  const box = Buffer.alloc(8 + payload.byteLength);
  box.writeUInt32BE(sizeOverride ?? box.byteLength, 0);
  box.write('ftyp', 4, 'ascii');
  payload.copy(box, 8);
  return Buffer.concat([box, tail]);
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

test('sniffs an iOS JPEG export with an empty MIME type and exposes all safe source hints in the picker', async () => {
  const calls = [];
  const result = await canonicalizeVisionImage(
    file(JPEG_BYTES, ''),
    browserHarness(JPEG_BYTES, 'image/jpeg', { width: 1, height: 1 }, calls)
  );
  assert.equal(result.mediaType, 'image/jpeg');
  assert.match(
    createAppShellHtml({ version: 'release-1234567890abcdef' }),
    /accept="image\/jpeg,image\/png,image\/heic,image\/heif,\.jpg,\.jpeg,\.png,\.heic,\.heif"/u
  );
});

test('classifies bounded HEIC/HEIF ftyp bytes and rejects AVIF, sequences, conflicts, and malformed boxes', () => {
  for (const brand of ['heic', 'heix', 'heim', 'heis']) {
    assert.deepEqual(classifyVisionImageSource(isoFileType({ major: brand, compatible: [] })), {
      sourceKind: 'heif',
      decodeMediaType: 'image/heic',
      canonicalMediaType: 'image/jpeg'
    });
  }
  for (const brand of ['mif1', 'mif2']) {
    assert.deepEqual(classifyVisionImageSource(isoFileType({ major: brand, compatible: [] })), {
      sourceKind: 'heif',
      decodeMediaType: 'image/heif',
      canonicalMediaType: 'image/jpeg'
    });
  }
  for (const brand of ['avif', 'avis', 'MA1A', 'MA1B']) {
    assert.throws(
      () => classifyVisionImageSource(isoFileType({ major: brand, compatible: ['mif1'] })),
      (error) => error instanceof VisionImageInputError && error.code === 'unsupported_avif'
    );
  }
  for (const brand of ['hevc', 'hevx', 'hevm', 'hevs', 'msf1']) {
    assert.throws(
      () => classifyVisionImageSource(isoFileType({ major: brand, compatible: [] })),
      (error) => error instanceof VisionImageInputError && error.code === 'unsupported_heif_sequence'
    );
  }
  for (const compatible of [['mif1', 'avif'], ['mif1', 'hevc']]) {
    assert.throws(
      () => classifyVisionImageSource(isoFileType({ compatible })),
      (error) => error instanceof VisionImageInputError && error.code === 'conflicting_image_brands'
    );
  }

  const malformed = [];
  const truncated = Buffer.alloc(12);
  truncated.writeUInt32BE(12, 0);
  truncated.write('ftyp', 4, 'ascii');
  malformed.push(truncated);
  const nonAligned = Buffer.alloc(18);
  nonAligned.writeUInt32BE(18, 0);
  nonAligned.write('ftyp', 4, 'ascii');
  nonAligned.write('heic', 8, 'ascii');
  malformed.push(nonAligned);
  malformed.push(isoFileType({ sizeOverride: 4_097, tail: Buffer.alloc(4_100) }));
  malformed.push(isoFileType({ sizeOverride: 2_048, tail: Buffer.alloc(8) }));
  malformed.push(isoFileType({ sizeOverride: 0 }));
  for (const bytes of malformed) {
    assert.throws(
      () => classifyVisionImageSource(bytes),
      (error) => error instanceof VisionImageInputError && error.code === 'malformed_heif'
    );
  }
});

test('treats source bytes as authoritative over empty, uppercase, and dishonest file hints', async () => {
  const heic = isoFileType({
    tail: Buffer.from('private-source-heic-irot-metadata-must-not-cross-the-wire', 'ascii')
  });
  const canonicalJpeg = rewriteJpegDimensions(JPEG_BYTES, 240, 320);
  const heicCalls = [];
  const heicHarness = browserHarness(
    canonicalJpeg,
    'image/jpeg',
    { width: 240, height: 320 },
    heicCalls
  );
  const decoderInputs = [];
  heicHarness.createImageBitmapImpl = async (blob, options) => {
    decoderInputs.push({ type: blob.type, options, bytes: Buffer.from(await blob.arrayBuffer()) });
    return {
      width: 240,
      height: 320,
      close() { heicCalls.push(['close']); }
    };
  };
  const converted = await canonicalizeVisionImage(file(heic, '', 'IPHONE-PHOTO.HEIC'), heicHarness);
  assert.equal(decoderInputs.length, 1);
  assert.equal(decoderInputs[0].type, 'image/heic');
  assert.deepEqual(decoderInputs[0].options, { imageOrientation: 'from-image' });
  assert.deepEqual(decoderInputs[0].bytes, heic);
  assert.deepEqual([converted.mediaType, converted.width, converted.height], ['image/jpeg', 240, 320]);
  assert.deepEqual(Buffer.from(converted.bytes), canonicalJpeg);
  assert.equal(Buffer.from(converted.bytes).includes(Buffer.from('private-source-heic', 'ascii')), false);
  assert.deepEqual(validateVisionAttachmentRequest({
    attachmentId: converted.attachmentId,
    mediaType: converted.mediaType,
    data: Buffer.from(converted.bytes).toString('base64')
  }).content, canonicalJpeg);
  assert.deepEqual(heicCalls.filter(([name]) => name === 'drawImage'), [
    ['drawImage', 0, 0, 240, 320]
  ], 'the canvas uses the native decoder\'s already-oriented surface');

  const png = Buffer.from(createPwaIcon(192));
  const pngCalls = [];
  const disguisedPng = await canonicalizeVisionImage(
    file(png, 'IMAGE/HEIC', 'MISLEADING.HEIC'),
    browserHarness(png, 'image/png', { width: 192, height: 192 }, pngCalls)
  );
  assert.equal(disguisedPng.mediaType, 'image/png');
  assert.deepEqual(Buffer.from(disguisedPng.bytes), png);
});

test('fails corrupted or natively unsupported HEIC with an actionable conversion path', async () => {
  const source = isoFileType({ tail: Buffer.from('corrupt-hevc-payload', 'ascii') });
  const harness = browserHarness(JPEG_BYTES, 'image/jpeg', { width: 1, height: 1 }, []);
  let decodeAttempts = 0;
  harness.createImageBitmapImpl = async () => {
    decodeAttempts += 1;
    throw new TypeError('native decoder rejected bytes');
  };
  harness.createObjectUrl = null;
  harness.revokeObjectUrl = null;
  await assert.rejects(
    () => canonicalizeVisionImage(file(source, 'image/heic', 'corrupt.heic'), harness),
    (error) => error instanceof VisionImageInputError
      && error.code === 'heif_decode_unavailable'
      && /Photos.*export\/share.*JPEG or PNG/u.test(error.message)
  );
  assert.equal(decodeAttempts, 2, 'both feature-detected createImageBitmap overloads are attempted');
});

test('bounds HEIC decoded pixels and releases late native decodes after abort or timeout', async () => {
  const source = isoFileType();
  const overLimitCalls = [];
  await assert.rejects(
    () => canonicalizeVisionImage(
      file(source, 'image/heic'),
      browserHarness(JPEG_BYTES, 'image/jpeg', {
        width: BROWSER_VISION_IMAGE_LIMITS.sourceMaximumEdge + 1,
        height: 1
      }, overLimitCalls)
    ),
    /decoded image dimensions exceed the safe decode limit/u
  );
  assert.deepEqual(overLimitCalls, [['close']]);

  for (const mode of ['abort', 'timeout']) {
    const pending = Promise.withResolvers();
    const started = Promise.withResolvers();
    const calls = [];
    const harness = browserHarness(JPEG_BYTES, 'image/jpeg', { width: 1, height: 1 }, calls);
    harness.createImageBitmapImpl = () => {
      started.resolve();
      return pending.promise;
    };
    harness.createObjectUrl = null;
    harness.revokeObjectUrl = null;
    const controller = new AbortController();
    const preparation = canonicalizeVisionImage(file(source, 'image/heic'), {
      ...harness,
      signal: controller.signal,
      timeoutMs: mode === 'abort' ? 1_000 : 5
    });
    await started.promise;
    if (mode === 'abort') controller.abort();
    await assert.rejects(
      () => preparation,
      (error) => error instanceof VisionImageInputError
        && error.code === (mode === 'abort' ? 'image_preparation_aborted' : 'image_preparation_timeout')
    );
    pending.resolve({ width: 1, height: 1, close() { calls.push(['lateClose']); } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, [['lateClose']]);
  }
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

test('canonicalizes HEIC through the feature-detected HTMLImageElement fallback', async () => {
  const source = isoFileType();
  const calls = [];
  const harness = browserHarness(JPEG_BYTES, 'image/jpeg', { width: 1, height: 1 }, calls);
  const canvasDocument = harness.document;
  const image = {
    naturalWidth: 1,
    naturalHeight: 1,
    decoding: '',
    src: '',
    async decode() { calls.push(['heicImageDecode', this.src]); },
    removeAttribute(name) { calls.push(['removeAttribute', name]); this.src = ''; }
  };
  harness.document = {
    createElement(name) {
      if (name === 'img') return image;
      return canvasDocument.createElement(name);
    }
  };
  harness.createImageBitmapImpl = null;
  harness.createObjectUrl = (blob) => {
    calls.push(['createHeicObjectUrl', blob.type]);
    return 'blob:native-heic-photo';
  };
  harness.revokeObjectUrl = (url) => calls.push(['revokeObjectUrl', url]);

  const result = await canonicalizeVisionImage(file(source, '', 'PHOTO.HEIC'), harness);
  assert.deepEqual([result.mediaType, result.width, result.height], ['image/jpeg', 1, 1]);
  assert.deepEqual(calls.slice(0, 2), [
    ['createHeicObjectUrl', 'image/heic'],
    ['heicImageDecode', 'blob:native-heic-photo']
  ]);
  assert.deepEqual(calls.slice(-2), [
    ['removeAttribute', 'src'],
    ['revokeObjectUrl', 'blob:native-heic-photo']
  ]);
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

  const oversized = {
    size: BROWSER_VISION_IMAGE_LIMITS.sourceBytes + 1,
    type: 'image/png',
    async arrayBuffer() { return new ArrayBuffer(0); }
  };
  await assert.rejects(
    () => canonicalizeVisionImage(oversized, {}),
    /JPEG, PNG, HEIC, or HEIF still image up to 24 MiB/u
  );

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
    /not a supported JPEG, PNG, HEIC, or HEIF/u
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
