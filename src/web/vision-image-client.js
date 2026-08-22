export const BROWSER_VISION_IMAGE_LIMITS = Object.freeze({
  sourceBytes: 8 * 1024 * 1024,
  canonicalBytes: 4 * 1024 * 1024,
  maximumEdge: 4_096,
  pixels: 16 * 1024 * 1024,
});

const ACCEPTED_TYPES = new Set(["image/jpeg", "image/png"]);
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function fail(message) {
  throw new TypeError(message);
}

function checkedDimensions(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
      || width > BROWSER_VISION_IMAGE_LIMITS.maximumEdge
      || height > BROWSER_VISION_IMAGE_LIMITS.maximumEdge
      || width * height > BROWSER_VISION_IMAGE_LIMITS.pixels) {
    fail("image dimensions exceed the safe vision limit");
  }
  return Object.freeze({ width, height });
}

function pngDimensions(bytes) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.byteLength < 24 || signature.some((value, index) => bytes[index] !== value)
      || bytes[12] !== 73 || bytes[13] !== 72 || bytes[14] !== 68 || bytes[15] !== 82) {
    fail("selected file is not a valid PNG image");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return checkedDimensions(view.getUint32(16), view.getUint32(20));
}

function jpegDimensions(bytes) {
  if (bytes.byteLength < 16 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    fail("selected file is not a valid JPEG image");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  let markers = 0;
  while (offset < bytes.byteLength) {
    if (bytes[offset] !== 0xff) fail("selected JPEG framing is invalid");
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.byteLength) break;
    const marker = bytes[offset];
    offset += 1;
    markers += 1;
    if (markers > 65_536 || marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.byteLength) break;
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > bytes.byteLength) break;
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (length < 8 || bytes[offset + 2] !== 8) fail("selected JPEG frame is invalid");
      return checkedDimensions(view.getUint16(offset + 3), view.getUint16(offset + 5));
    }
    offset += length;
  }
  fail("selected JPEG has no supported frame");
}

export function inspectVisionImageBytes(bytes, mediaType) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1) fail("image bytes are required");
  if (!ACCEPTED_TYPES.has(mediaType)) fail("image must be JPEG or PNG");
  return mediaType === "image/png" ? pngDimensions(bytes) : jpegDimensions(bytes);
}

function canvasBlob(canvas, mediaType) {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => {
        if (!blob) reject(new TypeError("the browser could not canonicalize this image"));
        else resolve(blob);
      }, mediaType, mediaType === "image/jpeg" ? 0.9 : undefined);
    } catch (error) { reject(error); }
  });
}

export async function canonicalizeVisionImage(file, {
  document = globalThis.document,
  createImageBitmapImpl = globalThis.createImageBitmap,
  makeAttachmentId,
} = {}) {
  if (!file || typeof file.arrayBuffer !== "function" || !Number.isSafeInteger(file.size)
      || file.size < 1 || file.size > BROWSER_VISION_IMAGE_LIMITS.sourceBytes
      || !ACCEPTED_TYPES.has(file.type)) {
    fail("select one JPEG or PNG image up to 8 MiB");
  }
  if (typeof createImageBitmapImpl !== "function" || typeof document?.createElement !== "function"
      || typeof makeAttachmentId !== "function") {
    fail("browser image canonicalization is unavailable");
  }
  const source = new Uint8Array(await file.arrayBuffer());
  if (source.byteLength !== file.size) fail("selected image changed while it was read");
  const declared = inspectVisionImageBytes(source, file.type);
  let bitmap;
  try {
    bitmap = await createImageBitmapImpl(file);
    const decoded = checkedDimensions(bitmap?.width, bitmap?.height);
    const sameGeometry = decoded.width === declared.width && decoded.height === declared.height;
    const metadataOrientedGeometry = decoded.width === declared.height && decoded.height === declared.width;
    if (!sameGeometry && !metadataOrientedGeometry) {
      fail("decoded image dimensions do not match its file header");
    }
    const canvas = document.createElement("canvas");
    canvas.width = decoded.width;
    canvas.height = decoded.height;
    const context = canvas.getContext?.("2d", { alpha: file.type === "image/png" });
    if (!context || typeof context.drawImage !== "function") fail("browser image canonicalization is unavailable");
    if (file.type === "image/jpeg") {
      context.fillStyle = "#ffffff";
      context.fillRect?.(0, 0, decoded.width, decoded.height);
    }
    context.drawImage(bitmap, 0, 0, decoded.width, decoded.height);
    const blob = await canvasBlob(canvas, file.type);
    if (blob.type !== file.type || blob.size < 1 || blob.size > BROWSER_VISION_IMAGE_LIMITS.canonicalBytes) {
      fail("canonical image exceeds 4 MiB; choose a smaller image");
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.byteLength !== blob.size) fail("canonical image changed while it was read");
    const canonical = inspectVisionImageBytes(bytes, blob.type);
    if (canonical.width !== decoded.width || canonical.height !== decoded.height) {
      fail("canonical image dimensions changed unexpectedly");
    }
    return Object.freeze({
      attachmentId: makeAttachmentId("image"),
      mediaType: blob.type,
      byteLength: bytes.byteLength,
      width: canonical.width,
      height: canonical.height,
      bytes,
      previewBlob: blob,
    });
  } finally {
    bitmap?.close?.();
  }
}
