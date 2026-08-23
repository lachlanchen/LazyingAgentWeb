import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import test from 'node:test';

import { ValidationError } from '../src/errors.js';
import {
  VISION_ATTACHMENT_LIMITS,
  validateStoredVisionAttachment,
  validateVisionAttachmentRequest,
  validateVisionAttachmentsRequest,
  visionAttachmentDescriptor
} from '../src/vision-attachment.js';
import { createPwaIcon } from '../src/web/pwa-assets.js';

const ATTACHMENT_ID = 'image_0000000000000001';
const JPEG_BASE64 = '/9j/4AAQSkZJRgABAQAAAAAAAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
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

function pngRequest(bytes = Buffer.from(createPwaIcon(192))) {
  return {
    attachmentId: ATTACHMENT_ID,
    mediaType: 'image/png',
    data: Buffer.from(bytes).toString('base64')
  };
}

function appendInsideFirstIdat(bytes, trailing) {
  const typeOffset = bytes.indexOf(Buffer.from('IDAT', 'ascii'));
  const lengthOffset = typeOffset - 4;
  const dataLength = bytes.readUInt32BE(lengthOffset);
  const dataStart = typeOffset + 4;
  const chunkEnd = dataStart + dataLength + 4;
  return Buffer.concat([
    bytes.subarray(0, lengthOffset),
    pngChunk('IDAT', Buffer.concat([bytes.subarray(dataStart, dataStart + dataLength), trailing])),
    bytes.subarray(chunkEnd)
  ]);
}

test('accepts one canonical PNG or JPEG and returns a private byte record plus public descriptor', () => {
  const png = validateVisionAttachmentRequest(pngRequest());
  assert.equal(png.mediaType, 'image/png');
  assert.equal(png.width, 192);
  assert.equal(png.height, 192);
  assert.equal(png.byteLength, png.content.byteLength);
  assert.equal(png.contentSha256, createHash('sha256').update(png.content).digest('hex'));
  assert.deepEqual(visionAttachmentDescriptor(png), {
    attachmentId: ATTACHMENT_ID,
    mediaType: 'image/png',
    byteLength: png.byteLength,
    width: 192,
    height: 192,
    sha256: png.contentSha256
  });

  const jpeg = validateVisionAttachmentRequest({
    attachmentId: 'image_0000000000000002',
    mediaType: 'image/jpeg',
    data: JPEG_BASE64
  });
  assert.deepEqual([jpeg.width, jpeg.height, jpeg.byteLength], [1, 1, 160]);
});

test('accepts at most four unique canonical images in stable request order', () => {
  const attachments = [1, 2, 3, 4].map((serial) => ({
    ...pngRequest(),
    attachmentId: `image_000000000000000${serial}`
  }));
  const checked = validateVisionAttachmentsRequest(attachments);
  assert.deepEqual(checked.map((attachment) => attachment.attachmentId), attachments.map((attachment) => attachment.attachmentId));
  assert.equal(Object.isFrozen(checked), true);
  assert.throws(() => validateVisionAttachmentsRequest([...attachments, attachments[0]]), /between 1 and 4/u);
  assert.throws(() => validateVisionAttachmentsRequest([attachments[0], attachments[0]]), /unique/u);
  assert.throws(() => validateVisionAttachmentsRequest([]), /between 1 and 4/u);
});

test('rejects noncanonical base64, media mismatch, corruption, unknown data, and unsafe dimensions', () => {
  const png = Buffer.from(createPwaIcon(192));
  const invalidRequests = [
    { ...pngRequest(), extra: true },
    { ...pngRequest(), data: `${png.toString('base64')}\n` },
    { ...pngRequest(), data: 'A===' },
    { ...pngRequest(), mediaType: 'image/gif' },
    { ...pngRequest(), mediaType: 'image/jpeg' }
  ];
  for (const request of invalidRequests) {
    assert.throws(() => validateVisionAttachmentRequest(request), ValidationError);
  }

  const firstIdat = png.indexOf(Buffer.from('IDAT', 'ascii'));
  const corrupted = Buffer.from(png);
  corrupted[firstIdat + 4] ^= 1;
  assert.throws(() => validateVisionAttachmentRequest(pngRequest(corrupted)), /checksum/u);

  const iendOffset = png.indexOf(Buffer.from('IEND', 'ascii')) - 4;
  const withMetadata = Buffer.concat([
    png.subarray(0, iendOffset),
    pngChunk('tEXt', Buffer.from('author\0private value', 'latin1')),
    png.subarray(iendOffset)
  ]);
  const sanitizedMetadata = validateVisionAttachmentRequest(pngRequest(withMetadata));
  assert.deepEqual(sanitizedMetadata.content, png);
  assert.equal(sanitizedMetadata.byteLength, png.byteLength);

  const withUnknownAncillaryData = Buffer.concat([
    png.subarray(0, iendOffset),
    pngChunk('ruSt', Buffer.from('hidden private value', 'utf8')),
    png.subarray(iendOffset)
  ]);
  assert.throws(
    () => validateVisionAttachmentRequest(pngRequest(withUnknownAncillaryData)),
    /ancillary/u
  );

  const jpeg = Buffer.from(JPEG_BASE64, 'base64');
  const jpegWithExif = Buffer.concat([
    jpeg.subarray(0, 2),
    Buffer.from([0xff, 0xe1, 0x00, 0x04, 0x00, 0x00]),
    jpeg.subarray(2)
  ]);
  assert.deepEqual(validateVisionAttachmentRequest({
    attachmentId: ATTACHMENT_ID,
    mediaType: 'image/jpeg',
    data: jpegWithExif.toString('base64')
  }).content, jpeg);

  const jpegWithApp3 = Buffer.concat([
    jpeg.subarray(0, 2),
    Buffer.from([0xff, 0xe3, 0x00, 0x04, 0x00, 0x00]),
    jpeg.subarray(2)
  ]);
  assert.deepEqual(validateVisionAttachmentRequest({
    attachmentId: ATTACHMENT_ID,
    mediaType: 'image/jpeg',
    data: jpegWithApp3.toString('base64')
  }).content, jpeg);

  const corruptedMetadata = Buffer.from(withMetadata);
  corruptedMetadata[iendOffset + 12] ^= 1;
  assert.throws(() => validateVisionAttachmentRequest(pngRequest(corruptedMetadata)), /checksum/u);

  const unsafeDimensions = Buffer.from(png);
  unsafeDimensions.writeUInt32BE(VISION_ATTACHMENT_LIMITS.maximumEdge + 1, 16);
  const ihdrTypeAndData = unsafeDimensions.subarray(12, 29);
  unsafeDimensions.writeUInt32BE(crc32(ihdrTypeAndData), 29);
  assert.throws(() => validateVisionAttachmentRequest(pngRequest(unsafeDimensions)), /dimensions/u);
});

test('revalidates durable bytes and refuses a descriptor or digest mismatch', () => {
  const checked = validateVisionAttachmentRequest(pngRequest());
  const stored = {
    accountId: 'account-one',
    threadId: 'thread-one',
    messageId: 'message-one',
    createdAt: '2026-08-22T00:00:00.000Z',
    ...checked
  };
  assert.equal(validateStoredVisionAttachment(stored).contentSha256, checked.contentSha256);
  assert.throws(
    () => validateStoredVisionAttachment({ ...stored, contentSha256: '0'.repeat(64) }),
    /descriptor/u
  );
  const corrupted = Buffer.from(stored.content);
  corrupted[corrupted.byteLength - 20] ^= 1;
  assert.throws(() => validateStoredVisionAttachment({ ...stored, content: corrupted }), ValidationError);
});

test('rejects CRC-valid trailing bytes and a concatenated zlib stream inside IDAT', () => {
  const png = Buffer.from(createPwaIcon(192));
  const withTrailingPayload = appendInsideFirstIdat(png, Buffer.from('non-pixel-payload', 'ascii'));
  assert.throws(
    () => validateVisionAttachmentRequest(pngRequest(withTrailingPayload)),
    /trailing bytes/u
  );

  const withSecondStream = appendInsideFirstIdat(png, deflateSync(Buffer.from('second-zlib-stream', 'ascii')));
  assert.throws(
    () => validateVisionAttachmentRequest(pngRequest(withSecondStream)),
    /trailing bytes/u
  );
});
