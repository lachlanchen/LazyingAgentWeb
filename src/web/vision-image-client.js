import { sanitizeVisionImageBytes } from "./vision-image-sanitizer.js";

export const BROWSER_VISION_IMAGE_LIMITS = Object.freeze({
  // Files are read and decoded one at a time. This covers current 48 MP phone
  // exports without relaxing the durable 4 MiB attachment contract.
  sourceBytes: 24 * 1024 * 1024,
  sourceMaximumEdge: 8_192,
  sourcePixels: 50 * 1024 * 1024,
  canonicalBytes: 4 * 1024 * 1024,
  maximumEdge: 4_096,
  pixels: 16 * 1024 * 1024,
  previewBytes: 512 * 1024,
  previewMaximumEdge: 512,
  previewPixels: 512 * 512,
});

const ACCEPTED_TYPES = new Set(["image/jpeg", "image/png"]);
const ACCEPTED_DECLARED_TYPES = new Set(["", "application/octet-stream", "image/jpeg", "image/jpg", "image/png"]);
const HEIF_TYPES = new Set(["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"]);
const PNG_SIGNATURE = Object.freeze([137, 80, 78, 71, 13, 10, 26, 10]);
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function fail(message) {
  throw new TypeError(message);
}

function checkedDimensions(width, height, {
  maximumEdge = BROWSER_VISION_IMAGE_LIMITS.maximumEdge,
  pixels = BROWSER_VISION_IMAGE_LIMITS.pixels,
  message = "image dimensions exceed the safe vision limit",
} = {}) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
      || width > maximumEdge || height > maximumEdge || width * height > pixels) {
    fail(message);
  }
  return Object.freeze({ width, height });
}

function pngDimensions(bytes) {
  if (bytes.byteLength < 24 || PNG_SIGNATURE.some((value, index) => bytes[index] !== value)
      || bytes[12] !== 73 || bytes[13] !== 72 || bytes[14] !== 68 || bytes[15] !== 82) {
    fail("selected file is not a valid PNG image");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Object.freeze({ width: view.getUint32(16), height: view.getUint32(20) });
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
      return Object.freeze({ width: view.getUint16(offset + 5), height: view.getUint16(offset + 3) });
    }
    offset += length;
  }
  fail("selected JPEG has no supported frame");
}

export function inspectVisionImageBytes(bytes, mediaType) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1) fail("image bytes are required");
  if (!ACCEPTED_TYPES.has(mediaType)) fail("image must be JPEG or PNG");
  const dimensions = mediaType === "image/png" ? pngDimensions(bytes) : jpegDimensions(bytes);
  return checkedDimensions(dimensions.width, dimensions.height);
}

export { sanitizeVisionImageBytes };

function canvasBlob(canvas, mediaType, quality) {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => {
        if (!blob) reject(new TypeError("the browser could not canonicalize this image"));
        else resolve(blob);
      }, mediaType, quality);
    } catch (error) { reject(error); }
  });
}

function sourceMediaType(fileType, bytes) {
  const declared = typeof fileType === "string" ? fileType.trim().toLowerCase() : "";
  if (HEIF_TYPES.has(declared)) {
    fail("HEIC/HEIF cannot be decoded with the required safety checks; share or export it as JPEG or PNG");
  }
  if (!ACCEPTED_DECLARED_TYPES.has(declared)) fail("select a JPEG or PNG image up to 24 MiB");
  if (declared === "image/jpeg" || declared === "image/jpg") return "image/jpeg";
  if (declared === "image/png") return "image/png";
  if (bytes.byteLength >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.byteLength >= PNG_SIGNATURE.length
      && PNG_SIGNATURE.every((value, index) => bytes[index] === value)) return "image/png";
  fail("selected file is not a valid JPEG or PNG image");
}

function inspectSourceVisionImageBytes(bytes, mediaType) {
  const dimensions = mediaType === "image/png" ? pngDimensions(bytes) : jpegDimensions(bytes);
  return checkedDimensions(dimensions.width, dimensions.height, {
    maximumEdge: BROWSER_VISION_IMAGE_LIMITS.sourceMaximumEdge,
    pixels: BROWSER_VISION_IMAGE_LIMITS.sourcePixels,
    message: "source image dimensions exceed the safe decode limit",
  });
}

function fittedDimensions(width, height, { maximumEdge, pixels }) {
  const scale = Math.min(1, maximumEdge / width, maximumEdge / height, Math.sqrt(pixels / (width * height)));
  return checkedDimensions(
    Math.max(1, Math.floor(width * scale)),
    Math.max(1, Math.floor(height * scale)),
    { maximumEdge, pixels },
  );
}

function renderBitmap(document, canvas, bitmap, dimensions, mediaType) {
  canvas.width = dimensions.width;
  canvas.height = dimensions.height;
  const context = canvas.getContext?.("2d", { alpha: mediaType === "image/png" });
  if (!context || typeof context.drawImage !== "function"
      || (mediaType === "image/jpeg" && typeof context.fillRect !== "function")) {
    fail("browser image canonicalization is unavailable");
  }
  if (mediaType === "image/jpeg") {
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, dimensions.width, dimensions.height);
  }
  context.drawImage(bitmap, 0, 0, dimensions.width, dimensions.height);
  return context;
}

function smallerDimensions(dimensions, encodedBytes, byteLimit, limits) {
  const scale = Math.min(0.82, Math.max(0.25, Math.sqrt(byteLimit / encodedBytes) * 0.9));
  let width = Math.max(1, Math.floor(dimensions.width * scale));
  let height = Math.max(1, Math.floor(dimensions.height * scale));
  if (width === dimensions.width && width > 1) width -= 1;
  if (height === dimensions.height && height > 1) height -= 1;
  return checkedDimensions(width, height, limits);
}

async function boundedCanvasEncoding(document, canvas, bitmap, mediaType, initialDimensions, {
  byteLimit,
  maximumEdge,
  pixels,
  errorMessage,
}) {
  let dimensions = initialDimensions;
  for (let geometryAttempt = 0; geometryAttempt < 6; geometryAttempt += 1) {
    renderBitmap(document, canvas, bitmap, dimensions, mediaType);
    const qualities = mediaType === "image/jpeg" ? [0.9, 0.76, 0.62] : [undefined];
    let lastBlob;
    for (const quality of qualities) {
      const blob = await canvasBlob(canvas, mediaType, quality);
      if (blob.type !== mediaType || blob.size < 1) fail("the browser returned an invalid canonical image");
      if (blob.size <= byteLimit) return Object.freeze({ blob, dimensions });
      lastBlob = blob;
    }
    if (geometryAttempt === 5) break;
    dimensions = smallerDimensions(dimensions, lastBlob.size, byteLimit, { maximumEdge, pixels });
  }
  fail(errorMessage);
}

async function sanitizedCanvasResult(encoded, mediaType, expectedDimensions, byteLimit, errorMessage) {
  const canvasBytes = new Uint8Array(await encoded.arrayBuffer());
  if (canvasBytes.byteLength !== encoded.size) fail("canonical image changed while it was read");
  const bytes = sanitizeVisionImageBytes(canvasBytes, mediaType);
  if (bytes.byteLength > byteLimit) fail(errorMessage);
  const dimensions = inspectVisionImageBytes(bytes, mediaType);
  if (dimensions.width !== expectedDimensions.width || dimensions.height !== expectedDimensions.height) {
    fail("canonical image dimensions changed unexpectedly");
  }
  return Object.freeze({ bytes, dimensions });
}

async function decodeVisionSource(file, {
  document,
  createImageBitmapImpl,
  createObjectUrl,
  revokeObjectUrl,
}) {
  if (typeof createImageBitmapImpl === "function") {
    try {
      const drawable = await createImageBitmapImpl(file, { imageOrientation: "from-image" });
      return Object.freeze({ drawable, release: () => drawable?.close?.() });
    } catch {
      // Older Safari exposes createImageBitmap but rejects the options overload.
      try {
        const drawable = await createImageBitmapImpl(file);
        return Object.freeze({ drawable, release: () => drawable?.close?.() });
      } catch { /* Fall through to Safari's native HTML image decoder. */ }
    }
  }
  if (typeof createObjectUrl !== "function" || typeof revokeObjectUrl !== "function") {
    fail("browser image decoding is unavailable");
  }
  let objectUrl;
  let image;
  try {
    objectUrl = createObjectUrl(file);
    if (typeof objectUrl !== "string" || objectUrl.length < 1) fail("browser image decoding is unavailable");
    image = document.createElement("img");
    if (!image || typeof image.decode !== "function") fail("browser image decoding is unavailable");
    image.decoding = "async";
    image.src = objectUrl;
    await image.decode();
    let released = false;
    return Object.freeze({
      drawable: image,
      release() {
        if (released) return;
        released = true;
        image.removeAttribute?.("src");
        revokeObjectUrl(objectUrl);
      },
    });
  } catch {
    image?.removeAttribute?.("src");
    if (typeof objectUrl === "string" && objectUrl.length > 0) {
      try { revokeObjectUrl(objectUrl); } catch { /* Best-effort cleanup after decode failure. */ }
    }
    fail("the browser could not decode this JPEG or PNG image safely");
  }
}

export async function canonicalizeVisionImage(file, {
  document = globalThis.document,
  createImageBitmapImpl = globalThis.createImageBitmap,
  createObjectUrl = globalThis.URL?.createObjectURL?.bind(globalThis.URL),
  revokeObjectUrl = globalThis.URL?.revokeObjectURL?.bind(globalThis.URL),
  makeAttachmentId,
} = {}) {
  if (!file || typeof file.arrayBuffer !== "function" || !Number.isSafeInteger(file.size)
      || file.size < 1 || file.size > BROWSER_VISION_IMAGE_LIMITS.sourceBytes) {
    fail("select a JPEG or PNG image up to 24 MiB");
  }
  const declaredType = typeof file.type === "string" ? file.type.trim().toLowerCase() : "";
  if (HEIF_TYPES.has(declaredType)) {
    fail("HEIC/HEIF cannot be decoded with the required safety checks; share or export it as JPEG or PNG");
  }
  if (!ACCEPTED_DECLARED_TYPES.has(declaredType)) fail("select a JPEG or PNG image up to 24 MiB");
  if (typeof document?.createElement !== "function" || typeof makeAttachmentId !== "function") {
    fail("browser image canonicalization is unavailable");
  }
  const source = new Uint8Array(await file.arrayBuffer());
  if (source.byteLength !== file.size) fail("selected image changed while it was read");
  const mediaType = sourceMediaType(file.type, source);
  const declared = inspectSourceVisionImageBytes(source, mediaType);
  let decodedResource;
  try {
    decodedResource = await decodeVisionSource(file, {
      document,
      createImageBitmapImpl,
      createObjectUrl,
      revokeObjectUrl,
    });
    const drawable = decodedResource.drawable;
    const decodedWidth = Number.isSafeInteger(drawable?.naturalWidth) && drawable.naturalWidth > 0
      ? drawable.naturalWidth : drawable?.width;
    const decodedHeight = Number.isSafeInteger(drawable?.naturalHeight) && drawable.naturalHeight > 0
      ? drawable.naturalHeight : drawable?.height;
    const decoded = checkedDimensions(decodedWidth, decodedHeight, {
      maximumEdge: BROWSER_VISION_IMAGE_LIMITS.sourceMaximumEdge,
      pixels: BROWSER_VISION_IMAGE_LIMITS.sourcePixels,
      message: "decoded image dimensions exceed the safe decode limit",
    });
    const sameGeometry = decoded.width === declared.width && decoded.height === declared.height;
    const metadataOrientedGeometry = decoded.width === declared.height && decoded.height === declared.width;
    if (!sameGeometry && !metadataOrientedGeometry) {
      fail("decoded image dimensions do not match its file header");
    }
    const canvas = document.createElement("canvas");
    const canonicalTarget = fittedDimensions(decoded.width, decoded.height, {
      maximumEdge: BROWSER_VISION_IMAGE_LIMITS.maximumEdge,
      pixels: BROWSER_VISION_IMAGE_LIMITS.pixels,
    });
    const canonicalEncoding = await boundedCanvasEncoding(document, canvas, drawable, mediaType, canonicalTarget, {
      byteLimit: BROWSER_VISION_IMAGE_LIMITS.canonicalBytes,
      maximumEdge: BROWSER_VISION_IMAGE_LIMITS.maximumEdge,
      pixels: BROWSER_VISION_IMAGE_LIMITS.pixels,
      errorMessage: "canonical image exceeds 4 MiB after safe downscaling",
    });
    const canonical = await sanitizedCanvasResult(
      canonicalEncoding.blob,
      mediaType,
      canonicalEncoding.dimensions,
      BROWSER_VISION_IMAGE_LIMITS.canonicalBytes,
      "canonical image exceeds 4 MiB after safe downscaling",
    );
    let preview = canonical;
    if (canonical.dimensions.width > BROWSER_VISION_IMAGE_LIMITS.previewMaximumEdge
        || canonical.dimensions.height > BROWSER_VISION_IMAGE_LIMITS.previewMaximumEdge
        || canonical.bytes.byteLength > BROWSER_VISION_IMAGE_LIMITS.previewBytes) {
      const previewTarget = fittedDimensions(decoded.width, decoded.height, {
        maximumEdge: BROWSER_VISION_IMAGE_LIMITS.previewMaximumEdge,
        pixels: BROWSER_VISION_IMAGE_LIMITS.previewPixels,
      });
      const previewEncoding = await boundedCanvasEncoding(document, canvas, drawable, mediaType, previewTarget, {
        byteLimit: BROWSER_VISION_IMAGE_LIMITS.previewBytes,
        maximumEdge: BROWSER_VISION_IMAGE_LIMITS.previewMaximumEdge,
        pixels: BROWSER_VISION_IMAGE_LIMITS.previewPixels,
        errorMessage: "the browser could not create a bounded image preview",
      });
      preview = await sanitizedCanvasResult(
        previewEncoding.blob,
        mediaType,
        previewEncoding.dimensions,
        BROWSER_VISION_IMAGE_LIMITS.previewBytes,
        "the browser could not create a bounded image preview",
      );
    }
    return Object.freeze({
      attachmentId: makeAttachmentId("image"),
      mediaType,
      byteLength: canonical.bytes.byteLength,
      width: canonical.dimensions.width,
      height: canonical.dimensions.height,
      bytes: canonical.bytes,
      previewBlob: new Blob([preview.bytes], { type: mediaType }),
    });
  } finally {
    decodedResource?.release();
  }
}
