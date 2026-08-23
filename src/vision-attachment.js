import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';

import { ValidationError } from './errors.js';
import { assertExactKeys, assertIdentifier } from './validation.js';
import { sanitizeVisionImageBytes } from './web/vision-image-sanitizer.js';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const PNG_METADATA_CHUNKS = new Set(['caBX', 'eXIf', 'iCCP', 'iTXt', 'tEXt', 'zTXt']);
const PNG_RENDERING_CHUNKS = new Map([
  ['cHRM', 32],
  ['gAMA', 4],
  ['pHYs', 9],
  ['sRGB', 1]
]);
const JPEG_METADATA_MARKERS = new Set([
  0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8,
  0xe9, 0xea, 0xeb, 0xec, 0xed, 0xee, 0xef, 0xfe
]);
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf
]);
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export const VISION_ATTACHMENT_LIMITS = Object.freeze({
  bytes: 4 * 1024 * 1024,
  encodedBytes: Math.ceil((4 * 1024 * 1024) / 3) * 4,
  maximumEdge: 4_096,
  pixels: 16 * 1024 * 1024,
  attachmentsPerThread: 32,
  bytesPerThread: 64 * 1024 * 1024,
  bytesPerAccount: 256 * 1024 * 1024
});

export const VISION_MODEL_ALIAS = 'localllm-vision';

function invalid(message) {
  throw new ValidationError(message);
}

function boundedBase64(value) {
  let padding = 0;
  if (value.endsWith('=')) padding = value.endsWith('==') ? 2 : 1;
  const contentLength = value.length - padding;
  if ((padding === 0 && contentLength % 4 !== 0)
      || (padding === 1 && contentLength % 4 !== 3)
      || (padding === 2 && contentLength % 4 !== 2)) return false;
  for (let index = 0; index < contentLength; index += 1) {
    const code = value.charCodeAt(index);
    if (!((code >= 65 && code <= 90) || (code >= 97 && code <= 122)
        || (code >= 48 && code <= 57) || code === 43 || code === 47)) return false;
  }
  return true;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function inspectPng(bytes) {
  if (bytes.byteLength < 45 || !bytes.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)) {
    invalid('attachment data is not a valid PNG image.');
  }
  let offset = PNG_SIGNATURE.byteLength;
  let width = null;
  let height = null;
  let sawIdat = false;
  let idatEnded = false;
  let sawIend = false;
  let sawPalette = false;
  let bitDepth = null;
  let colorType = null;
  const idatChunks = [];
  const renderingChunks = new Set();
  let chunks = 0;
  while (offset < bytes.byteLength) {
    if (bytes.byteLength - offset < 12) invalid('attachment PNG framing is truncated.');
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (!Number.isSafeInteger(end) || end > bytes.byteLength) invalid('attachment PNG chunk is truncated.');
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    const type = typeBytes.toString('ascii');
    if (!/^[A-Za-z]{4}$/u.test(type)) invalid('attachment PNG chunk type is invalid.');
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = bytes.readUInt32BE(offset + 8 + length);
    if (crc32(Buffer.concat([typeBytes, data])) !== expectedCrc) {
      invalid('attachment PNG checksum is invalid.');
    }
    chunks += 1;
    if (chunks > 16_384) invalid('attachment PNG contains too many chunks.');
    if (chunks === 1) {
      if (type !== 'IHDR' || length !== 13) invalid('attachment PNG header is invalid.');
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      const validDepths = new Map([
        [0, new Set([1, 2, 4, 8])],
        [2, new Set([8])],
        [3, new Set([1, 2, 4, 8])],
        [4, new Set([8])],
        [6, new Set([8])]
      ]);
      if (!validDepths.get(colorType)?.has(bitDepth)
          || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) {
        invalid('attachment PNG must be a canonical non-interlaced image.');
      }
    } else if (type === 'IHDR') {
      invalid('attachment PNG contains a repeated header.');
    }
    if (PNG_METADATA_CHUNKS.has(type)) invalid('attachment PNG still contains metadata.');
    if ((type.charCodeAt(0) & 0x20) !== 0) {
      const expectedLength = PNG_RENDERING_CHUNKS.get(type);
      if (expectedLength === undefined || renderingChunks.has(type)
          || length !== expectedLength || sawIdat) {
        invalid('attachment PNG contains unsupported ancillary data.');
      }
      if ((type === 'sRGB' && data[0] > 3)
          || (type === 'gAMA' && data.readUInt32BE(0) === 0)
          || (type === 'pHYs' && (data.readUInt32BE(0) === 0
            || data.readUInt32BE(4) === 0 || data[8] > 1))) {
        invalid('attachment PNG rendering data is invalid.');
      }
      renderingChunks.add(type);
    }
    if (type === 'PLTE') {
      if (sawPalette || sawIdat || length < 3 || length > 768 || length % 3 !== 0
          || colorType === 0 || colorType === 4
          || (colorType === 3 && length / 3 > 2 ** bitDepth)) {
        invalid('attachment PNG palette is invalid.');
      }
      sawPalette = true;
    }
    if (type === 'IDAT') {
      if (idatEnded || (colorType === 3 && !sawPalette)) {
        invalid('attachment PNG image data order is invalid.');
      }
      sawIdat = true;
      idatChunks.push(data);
    } else if (sawIdat && type !== 'IEND') {
      idatEnded = true;
    }
    if ((type.charCodeAt(0) & 0x20) === 0
        && !['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(type)) {
      invalid('attachment PNG contains an unsupported critical chunk.');
    }
    if (type === 'IEND') {
      if (length !== 0 || !sawIdat || end !== bytes.byteLength) {
        invalid('attachment PNG terminator is invalid.');
      }
      sawIend = true;
    }
    offset = end;
  }
  if (!sawIend || width === null || height === null) invalid('attachment PNG is incomplete.');
  validateDimensions(width, height);
  const samplesPerPixel = new Map([[0, 1], [2, 3], [3, 1], [4, 2], [6, 4]]).get(colorType);
  const rowBytes = Math.ceil((width * samplesPerPixel * bitDepth) / 8);
  const expectedInflatedBytes = (rowBytes + 1) * height;
  const compressed = Buffer.concat(idatChunks);
  let pixels;
  let compressedBytesRead;
  try {
    const inflated = inflateSync(compressed, { maxOutputLength: expectedInflatedBytes, info: true });
    pixels = inflated.buffer;
    compressedBytesRead = inflated.engine?.bytesWritten;
  } catch (error) {
    invalid(`attachment PNG image data is invalid: ${error?.code ?? 'decode failed'}.`);
  }
  if (compressedBytesRead !== compressed.byteLength) invalid('attachment PNG image data contains trailing bytes.');
  if (pixels.byteLength !== expectedInflatedBytes) invalid('attachment PNG decoded size is invalid.');
  for (let row = 0; row < height; row += 1) {
    if (pixels[row * (rowBytes + 1)] > 4) invalid('attachment PNG scanline filter is invalid.');
  }
  return { width, height };
}

function inspectJpeg(bytes) {
  if (bytes.byteLength < 16 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    invalid('attachment data is not a valid JPEG image.');
  }
  let offset = 2;
  let width = null;
  let height = null;
  let sawScan = false;
  let sawEnd = false;
  let sawJfif = false;
  let markers = 0;
  while (offset < bytes.byteLength) {
    if (bytes[offset] !== 0xff) invalid('attachment JPEG marker framing is invalid.');
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.byteLength) invalid('attachment JPEG marker is truncated.');
    const marker = bytes[offset];
    offset += 1;
    markers += 1;
    if (markers > 65_536) invalid('attachment JPEG contains too many markers.');
    if (marker === 0xd9) {
      if (!sawScan || offset !== bytes.byteLength) invalid('attachment JPEG terminator is invalid.');
      sawEnd = true;
      break;
    }
    if (marker === 0xd8 || marker === 0x00 || marker === 0x01
        || (marker >= 0xd0 && marker <= 0xd7)) {
      invalid('attachment JPEG contains an invalid standalone marker.');
    }
    if (bytes.byteLength - offset < 2) invalid('attachment JPEG segment is truncated.');
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.byteLength) invalid('attachment JPEG segment length is invalid.');
    const dataStart = offset + 2;
    const dataEnd = offset + length;
    if (JPEG_METADATA_MARKERS.has(marker)) invalid('attachment JPEG still contains metadata.');
    if (marker === 0xe0) {
      const data = bytes.subarray(dataStart, dataEnd);
      if (sawJfif || length !== 16 || data.subarray(0, 5).toString('ascii') !== 'JFIF\0'
          || data[5] !== 1 || data[6] > 2 || data[7] > 2
          || data[12] !== 0 || data[13] !== 0) {
        invalid('attachment JPEG application metadata is not canonical JFIF.');
      }
      sawJfif = true;
    }
    if (JPEG_SOF_MARKERS.has(marker)) {
      const components = bytes[dataStart + 5];
      if (width !== null || length < 11 || bytes[dataStart] !== 8
          || !Number.isSafeInteger(components) || components < 1 || components > 4
          || length !== 8 + (3 * components)) {
        invalid('attachment JPEG frame header is invalid.');
      }
      height = bytes.readUInt16BE(dataStart + 1);
      width = bytes.readUInt16BE(dataStart + 3);
    }
    offset = dataEnd;
    if (marker === 0xda) {
      const scanComponents = bytes[dataStart];
      if (width === null || !Number.isSafeInteger(scanComponents)
          || scanComponents < 1 || scanComponents > 4
          || length !== 6 + (2 * scanComponents)) {
        invalid('attachment JPEG scan header is invalid.');
      }
      sawScan = true;
      while (offset < bytes.byteLength) {
        if (bytes[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        let markerOffset = offset + 1;
        while (markerOffset < bytes.byteLength && bytes[markerOffset] === 0xff) markerOffset += 1;
        if (markerOffset >= bytes.byteLength) invalid('attachment JPEG scan is truncated.');
        const scanMarker = bytes[markerOffset];
        if (scanMarker === 0x00 || (scanMarker >= 0xd0 && scanMarker <= 0xd7)) {
          offset = markerOffset + 1;
          continue;
        }
        break;
      }
    }
  }
  if (!sawEnd || width === null || height === null) invalid('attachment JPEG is incomplete.');
  return { width, height };
}

function validateDimensions(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
      || width > VISION_ATTACHMENT_LIMITS.maximumEdge
      || height > VISION_ATTACHMENT_LIMITS.maximumEdge
      || width * height > VISION_ATTACHMENT_LIMITS.pixels) {
    invalid('attachment image dimensions exceed the safe vision limit.');
  }
  return { width, height };
}

function inspectBytes(mediaType, content) {
  if (!Buffer.isBuffer(content) || content.byteLength < 1
      || content.byteLength > VISION_ATTACHMENT_LIMITS.bytes) {
    invalid('attachment image bytes exceed the safe vision limit.');
  }
  const dimensions = mediaType === 'image/png' ? inspectPng(content) : inspectJpeg(content);
  return validateDimensions(dimensions.width, dimensions.height);
}

function descriptorFrom({ attachmentId, mediaType, byteLength, width, height, contentSha256 }) {
  return Object.freeze({
    attachmentId,
    mediaType,
    byteLength,
    width,
    height,
    sha256: contentSha256
  });
}

export function validateVisionAttachmentRequest(value) {
  assertExactKeys(
    value,
    { required: ['attachmentId', 'mediaType', 'data'] },
    'vision attachment'
  );
  const attachmentId = assertIdentifier(value.attachmentId, 'attachmentId');
  if (!['image/jpeg', 'image/png'].includes(value.mediaType)) {
    invalid('attachment mediaType must be image/jpeg or image/png.');
  }
  if (typeof value.data !== 'string' || value.data.length < 4
      || value.data.length > VISION_ATTACHMENT_LIMITS.encodedBytes
      || value.data.length % 4 !== 0 || !boundedBase64(value.data)) {
    invalid('attachment data must be canonical bounded base64.');
  }
  const submitted = Buffer.from(value.data, 'base64');
  if (submitted.toString('base64') !== value.data) invalid('attachment data must be canonical bounded base64.');
  let content;
  try {
    content = Buffer.from(sanitizeVisionImageBytes(submitted, value.mediaType));
  } catch (error) {
    invalid(`attachment image framing or metadata is invalid: ${error?.message ?? 'sanitization failed'}.`);
  }
  const { width, height } = inspectBytes(value.mediaType, content);
  const contentSha256 = createHash('sha256').update(content).digest('hex');
  return Object.freeze({
    attachmentId,
    mediaType: value.mediaType,
    byteLength: content.byteLength,
    width,
    height,
    contentSha256,
    content
  });
}

export function validateStoredVisionAttachment(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('stored vision attachment must be an object.');
  }
  const attachmentId = assertIdentifier(value.attachmentId, 'attachment.attachmentId');
  if (!['image/jpeg', 'image/png'].includes(value.mediaType)) {
    invalid('stored attachment media type is invalid.');
  }
  const content = value.content instanceof Uint8Array ? Buffer.from(value.content) : null;
  const { width, height } = inspectBytes(value.mediaType, content);
  const contentSha256 = createHash('sha256').update(content).digest('hex');
  if (value.byteLength !== content.byteLength || value.width !== width || value.height !== height
      || typeof value.contentSha256 !== 'string' || !SHA256_PATTERN.test(value.contentSha256)
      || value.contentSha256 !== contentSha256) {
    invalid('stored attachment descriptor does not match its private bytes.');
  }
  return Object.freeze({
    ...value,
    attachmentId,
    mediaType: value.mediaType,
    byteLength: content.byteLength,
    width,
    height,
    contentSha256,
    content,
    descriptor: descriptorFrom({ attachmentId, mediaType: value.mediaType, byteLength: content.byteLength, width, height, contentSha256 })
  });
}

export function visionAttachmentDescriptor(value) {
  return descriptorFrom(value);
}
