const PNG_SIGNATURE = Object.freeze([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_METADATA_CHUNKS = new Set(["caBX", "eXIf", "iCCP", "iTXt", "tEXt", "zTXt"]);
const PNG_SERVER_RENDERING_CHUNKS = new Map([
  ["cHRM", 32],
  ["gAMA", 4],
  ["pHYs", 9],
  ["sRGB", 1],
]);
const JPEG_METADATA_MARKERS = new Set([
  0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8,
  0xe9, 0xea, 0xeb, 0xec, 0xed, 0xee, 0xef, 0xfe,
]);
const SANITIZER_BYTE_LIMIT = 8 * 1024 * 1024;
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

function fail(message) {
  throw new TypeError(message);
}

export class UnsupportedCanvasPngEncodingError extends TypeError {
  constructor() {
    super("the browser returned PNG ancillary data outside the upload contract");
    this.name = "UnsupportedCanvasPngEncodingError";
  }
}

function joinedBytes(parts, byteLength) {
  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function pngChunkType(bytes, offset) {
  let result = "";
  for (let index = offset; index < offset + 4; index += 1) {
    const value = bytes[index];
    if (!((value >= 65 && value <= 90) || (value >= 97 && value <= 122))) {
      fail("canonical PNG chunk type is invalid");
    }
    result += String.fromCharCode(value);
  }
  return result;
}

function crc32(bytes, start, end) {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ bytes[index]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function stripPngMetadata(bytes, requireServerCompatiblePng) {
  if (bytes.byteLength < 45 || PNG_SIGNATURE.some((value, index) => bytes[index] !== value)) {
    fail("canonical PNG framing is invalid");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts = [bytes.subarray(0, PNG_SIGNATURE.length)];
  let byteLength = PNG_SIGNATURE.length;
  let offset = PNG_SIGNATURE.length;
  let chunks = 0;
  let stripped = false;
  let sawEnd = false;
  let sawImageData = false;
  const renderingChunks = new Set();
  while (offset < bytes.byteLength) {
    if (bytes.byteLength - offset < 12) fail("canonical PNG framing is truncated");
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    if (!Number.isSafeInteger(end) || end > bytes.byteLength) fail("canonical PNG chunk is truncated");
    const type = pngChunkType(bytes, offset + 4);
    const expectedCrc = view.getUint32(offset + 8 + length);
    if (crc32(bytes, offset + 4, offset + 8 + length) !== expectedCrc) {
      fail("canonical PNG checksum is invalid");
    }
    chunks += 1;
    if (chunks > 16_384) fail("canonical PNG contains too many chunks");
    if (type === "IEND" && (length !== 0 || end !== bytes.byteLength)) {
      fail("canonical PNG terminator is invalid");
    }
    if (PNG_METADATA_CHUNKS.has(type)) stripped = true;
    else {
      let retain = true;
      if (requireServerCompatiblePng && (type.charCodeAt(0) & 0x20) !== 0) {
        const expectedLength = PNG_SERVER_RENDERING_CHUNKS.get(type);
        const dataOffset = offset + 8;
        const incompatible = expectedLength === undefined
          || renderingChunks.has(type)
          || length !== expectedLength
          || sawImageData
          || (type === "sRGB" && bytes[dataOffset] > 3)
          || (type === "gAMA" && view.getUint32(dataOffset) === 0)
          || (type === "pHYs" && (view.getUint32(dataOffset) === 0
            || view.getUint32(dataOffset + 4) === 0 || bytes[dataOffset + 8] > 1));
        if (incompatible) throw new UnsupportedCanvasPngEncodingError();
        renderingChunks.add(type);
        // The retained Agent vision profile admits only critical PNG chunks.
        // These bounded canvas rendering hints have already been applied by
        // the browser decoder, so omit them from the canonical upload rather
        // than letting an otherwise safe iPhone canvas output fail upstream.
        stripped = true;
        retain = false;
      }
      if (retain) {
        const part = bytes.subarray(offset, end);
        parts.push(part);
        byteLength += part.byteLength;
      }
    }
    offset = end;
    if (type === "IDAT") sawImageData = true;
    if (type === "IEND") sawEnd = true;
  }
  if (!sawEnd) fail("canonical PNG is incomplete");
  return stripped ? joinedBytes(parts, byteLength) : bytes;
}

function stripJpegMetadata(bytes) {
  if (bytes.byteLength < 16 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    fail("canonical JPEG framing is invalid");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts = [bytes.subarray(0, 2)];
  let byteLength = 2;
  let offset = 2;
  let markers = 0;
  let stripped = false;
  let sawEnd = false;
  while (offset < bytes.byteLength) {
    const markerStart = offset;
    if (bytes[offset] !== 0xff) fail("canonical JPEG marker framing is invalid");
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.byteLength) fail("canonical JPEG marker is truncated");
    const marker = bytes[offset];
    offset += 1;
    markers += 1;
    if (markers > 65_536) fail("canonical JPEG contains too many markers");
    if (marker === 0xd9) {
      if (offset !== bytes.byteLength) fail("canonical JPEG terminator is invalid");
      const part = bytes.subarray(markerStart, offset);
      parts.push(part);
      byteLength += part.byteLength;
      sawEnd = true;
      break;
    }
    if (marker === 0xd8 || marker === 0x00 || marker === 0x01
        || (marker >= 0xd0 && marker <= 0xd7)) {
      fail("canonical JPEG contains an invalid standalone marker");
    }
    if (bytes.byteLength - offset < 2) fail("canonical JPEG segment is truncated");
    const length = view.getUint16(offset);
    const end = offset + length;
    if (length < 2 || end > bytes.byteLength) fail("canonical JPEG segment length is invalid");
    if (JPEG_METADATA_MARKERS.has(marker)) stripped = true;
    else {
      const part = bytes.subarray(markerStart, end);
      parts.push(part);
      byteLength += part.byteLength;
    }
    offset = end;
    if (marker === 0xda) {
      const scanStart = offset;
      while (offset < bytes.byteLength) {
        if (bytes[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        let markerOffset = offset + 1;
        while (markerOffset < bytes.byteLength && bytes[markerOffset] === 0xff) markerOffset += 1;
        if (markerOffset >= bytes.byteLength) fail("canonical JPEG scan is truncated");
        const scanMarker = bytes[markerOffset];
        if (scanMarker === 0x00 || (scanMarker >= 0xd0 && scanMarker <= 0xd7)) {
          offset = markerOffset + 1;
          continue;
        }
        break;
      }
      const scan = bytes.subarray(scanStart, offset);
      parts.push(scan);
      byteLength += scan.byteLength;
    }
  }
  if (!sawEnd) fail("canonical JPEG is incomplete");
  return stripped ? joinedBytes(parts, byteLength) : bytes;
}

export function sanitizeVisionImageBytes(bytes, mediaType, {
  requireServerCompatiblePng = false,
} = {}) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > SANITIZER_BYTE_LIMIT
      || !["image/jpeg", "image/png"].includes(mediaType)) {
    fail("canonical image bytes and media type are required");
  }
  return mediaType === "image/png"
    ? stripPngMetadata(bytes, requireServerCompatiblePng)
    : stripJpegMetadata(bytes);
}
