import assert from 'node:assert/strict';
import test from 'node:test';

import { createPwaIcon } from '../src/web/pwa-assets.js';
import {
  BROWSER_VISION_IMAGE_LIMITS,
  canonicalizeVisionImage,
  inspectVisionImageBytes
} from '../src/web/vision-image-client.js';

const JPEG_BYTES = Buffer.from('/9j/4AAQSkZJRgABAQAAAAAAAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==', 'base64');

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
  const calls = [];
  const harness = browserHarness(canonical, 'image/png', { width: 192, height: 192 }, calls);
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
  const harness = browserHarness(JPEG_BYTES, 'image/jpeg', { width: 1, height: 1 }, calls);
  const result = await canonicalizeVisionImage(file(JPEG_BYTES, 'image/jpeg'), harness);
  assert.deepEqual([result.mediaType, result.width, result.height], ['image/jpeg', 1, 1]);
  assert.deepEqual(calls, [
    ['getContext', '2d', { alpha: false }],
    ['fillRect', 0, 0, 1, 1],
    ['drawImage', 0, 0, 1, 1],
    ['toBlob', 'image/jpeg', 0.9],
    ['close']
  ]);
});

test('preserves browser-applied metadata orientation while stripping the source metadata', async () => {
  const source = Buffer.from(createPwaIcon(192));
  source.writeUInt32BE(320, 16);
  source.writeUInt32BE(240, 20);
  const canonical = Buffer.from(createPwaIcon(192));
  canonical.writeUInt32BE(240, 16);
  canonical.writeUInt32BE(320, 20);
  const calls = [];
  const harness = browserHarness(canonical, 'image/png', { width: 240, height: 320 }, calls);
  const result = await canonicalizeVisionImage(file(source, 'image/png'), harness);
  assert.deepEqual([result.width, result.height], [240, 320]);
  assert.equal(harness.canvas.width, 240);
  assert.equal(harness.canvas.height, 320);
  assert.deepEqual(calls[1], ['drawImage', 0, 0, 240, 320]);
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

  const hugeOutput = new Uint8Array(BROWSER_VISION_IMAGE_LIMITS.canonicalBytes + 1);
  const hugeCalls = [];
  await assert.rejects(
    () => canonicalizeVisionImage(file(png, 'image/png'), browserHarness(hugeOutput, 'image/png', { width: 192, height: 192 }, hugeCalls)),
    /exceeds 4 MiB/u
  );
  assert.equal(hugeCalls.at(-1)[0], 'close');
});
