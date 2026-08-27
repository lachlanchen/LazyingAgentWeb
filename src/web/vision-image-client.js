import {
  sanitizeVisionImageBytes,
  UnsupportedCanvasPngEncodingError,
} from "./vision-image-sanitizer.js";

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
const PNG_SIGNATURE = Object.freeze([137, 80, 78, 71, 13, 10, 26, 10]);
const ISO_FTYP_BYTES = Object.freeze([0x66, 0x74, 0x79, 0x70]);
const ISO_FTYP_MAXIMUM_BYTES = 4_096;
const ISO_FTYP_MAXIMUM_BRANDS = 128;
const HEIF_STILL_BRANDS = new Set(["heic", "heix", "heim", "heis", "mif1", "mif2"]);
const HEVC_STILL_BRANDS = new Set(["heic", "heix", "heim", "heis"]);
const HEIF_SEQUENCE_BRANDS = new Set(["hevc", "hevx", "hevm", "hevs", "msf1"]);
const AVIF_BRANDS = new Set(["avif", "avis", "MA1A", "MA1B"]);
const DEFAULT_PREPARATION_TIMEOUT_MS = 15_000;
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

export class VisionImageInputError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = "VisionImageInputError";
    this.code = code;
  }
}

function fail(message, code = "invalid_image") {
  throw new VisionImageInputError(code, message);
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

function canvasBlob(canvas, mediaType, quality, operation) {
  return operation.race(new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => {
        if (!blob) reject(new TypeError("the browser could not canonicalize this image"));
        else resolve(blob);
      }, mediaType, quality);
    } catch (error) { reject(error); }
  }));
}

function hasSignature(bytes, signature, offset = 0) {
  return bytes.byteLength >= offset + signature.length
    && signature.every((value, index) => bytes[offset + index] === value);
}

function isoBrand(bytes, offset) {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

function inspectIsoFileType(bytes) {
  if (bytes.byteLength < 16) fail("selected HEIC/HEIF file type box is truncated", "malformed_heif");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const shortSize = view.getUint32(0);
  let headerBytes = 8;
  let boxBytes = shortSize;
  if (shortSize === 1) {
    if (bytes.byteLength < 24 || typeof view.getBigUint64 !== "function") {
      fail("selected HEIC/HEIF file type box is malformed", "malformed_heif");
    }
    const largeSize = view.getBigUint64(8);
    if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) {
      fail("selected HEIC/HEIF file type box is too large", "malformed_heif");
    }
    headerBytes = 16;
    boxBytes = Number(largeSize);
  } else if (shortSize === 0) {
    fail("selected HEIC/HEIF file type box has an unbounded size", "malformed_heif");
  }
  const fixedPayloadBytes = 8;
  if (!Number.isSafeInteger(boxBytes) || boxBytes < headerBytes + fixedPayloadBytes
      || boxBytes > ISO_FTYP_MAXIMUM_BYTES || boxBytes > bytes.byteLength
      || (boxBytes - headerBytes - fixedPayloadBytes) % 4 !== 0) {
    fail("selected HEIC/HEIF file type box is malformed", "malformed_heif");
  }
  const compatibleBrandCount = (boxBytes - headerBytes - fixedPayloadBytes) / 4;
  if (compatibleBrandCount > ISO_FTYP_MAXIMUM_BRANDS) {
    fail("selected HEIC/HEIF file declares too many compatibility brands", "malformed_heif");
  }
  const brands = new Set([isoBrand(bytes, headerBytes)]);
  for (let offset = headerBytes + fixedPayloadBytes; offset < boxBytes; offset += 4) {
    brands.add(isoBrand(bytes, offset));
  }
  const hasHevcStill = [...HEVC_STILL_BRANDS].some((brand) => brands.has(brand));
  const hasStill = [...HEIF_STILL_BRANDS].some((brand) => brands.has(brand));
  const hasSequence = [...HEIF_SEQUENCE_BRANDS].some((brand) => brands.has(brand));
  const hasAvif = [...AVIF_BRANDS].some((brand) => brands.has(brand));
  if (Number(hasHevcStill) + Number(hasSequence) + Number(hasAvif) > 1) {
    fail("selected ISO media file has conflicting still-image brands", "conflicting_image_brands");
  }
  if (hasAvif) fail("AVIF input is not supported; choose HEIC, HEIF, JPEG, or PNG", "unsupported_avif");
  if (hasSequence) {
    fail("HEIC/HEIF image sequences are not supported; export one still image as HEIC, JPEG, or PNG", "unsupported_heif_sequence");
  }
  if (!hasStill) fail("selected ISO media file is not a supported HEIC/HEIF still image", "unsupported_image_type");
  return Object.freeze({
    sourceKind: "heif",
    decodeMediaType: hasHevcStill ? "image/heic" : "image/heif",
    canonicalMediaType: "image/jpeg",
  });
}

export function classifyVisionImageSource(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1) fail("image bytes are required");
  if (bytes.byteLength >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return Object.freeze({
      sourceKind: "jpeg",
      decodeMediaType: "image/jpeg",
      canonicalMediaType: "image/jpeg",
    });
  }
  if (hasSignature(bytes, PNG_SIGNATURE)) {
    return Object.freeze({
      sourceKind: "png",
      decodeMediaType: "image/png",
      canonicalMediaType: "image/png",
    });
  }
  if (hasSignature(bytes, ISO_FTYP_BYTES, 4)) return inspectIsoFileType(bytes);
  fail("selected file bytes are not a supported JPEG, PNG, HEIC, or HEIF still image", "unsupported_image_type");
}

function inspectSourceVisionImageBytes(bytes, mediaType) {
  const dimensions = mediaType === "image/png" ? pngDimensions(bytes) : jpegDimensions(bytes);
  return checkedDimensions(dimensions.width, dimensions.height, {
    maximumEdge: BROWSER_VISION_IMAGE_LIMITS.sourceMaximumEdge,
    pixels: BROWSER_VISION_IMAGE_LIMITS.sourcePixels,
    message: "source image dimensions exceed the safe decode limit",
  });
}

function createBoundedOperation({
  signal,
  timeoutMs,
  setTimeoutImpl,
  clearTimeoutImpl,
}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000
      || typeof setTimeoutImpl !== "function" || typeof clearTimeoutImpl !== "function") {
    fail("image preparation timing limits are invalid", "invalid_image_limits");
  }
  if (signal !== undefined && signal !== null
      && (typeof signal.aborted !== "boolean" || typeof signal.addEventListener !== "function"
        || typeof signal.removeEventListener !== "function")) {
    fail("image preparation cancellation signal is invalid", "invalid_image_limits");
  }
  let reason = null;
  let finished = false;
  const cancellationWaiters = new Set();
  const cancel = (error) => {
    if (finished || reason !== null) return;
    reason = error;
    for (const waiter of cancellationWaiters) waiter(error);
    cancellationWaiters.clear();
  };
  const externalAbort = () => cancel(new VisionImageInputError(
    "image_preparation_aborted",
    "Image preparation was cancelled before any photo was sent.",
  ));
  signal?.addEventListener("abort", externalAbort, { once: true });
  if (signal?.aborted) externalAbort();
  const timer = setTimeoutImpl(() => cancel(new VisionImageInputError(
    "image_preparation_timeout",
    "Image preparation timed out before any photo was sent. Try a smaller photo or export it as JPEG.",
  )), timeoutMs);
  return Object.freeze({
    get cancelled() { return reason !== null; },
    get reason() { return reason; },
    throwIfCancelled() {
      if (reason !== null) throw reason;
    },
    race(value, { lateResolve } = {}) {
      if (reason !== null) return Promise.reject(reason);
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (handler, result) => {
          if (settled) return;
          settled = true;
          cancellationWaiters.delete(onCancel);
          handler(result);
        };
        const onCancel = (error) => finish(reject, error);
        cancellationWaiters.add(onCancel);
        Promise.resolve(value).then(
          (result) => {
            if (settled) {
              try { lateResolve?.(result); } catch { /* Late resource cleanup is best effort. */ }
              return;
            }
            finish(resolve, result);
          },
          (error) => finish(reject, error),
        );
      });
    },
    finish() {
      if (finished) return;
      finished = true;
      clearTimeoutImpl(timer);
      signal?.removeEventListener("abort", externalAbort);
      cancellationWaiters.clear();
    },
  });
}

function normalizedDecodeBlob(file, bytes, mediaType, BlobImpl) {
  if (typeof BlobImpl !== "function") fail("browser image decoding is unavailable", "decode_unavailable");
  const declaredType = typeof file.type === "string" ? file.type.trim().toLowerCase() : "";
  if (file instanceof BlobImpl && declaredType === mediaType) return file;
  try { return new BlobImpl([bytes], { type: mediaType }); }
  catch { fail("browser image decoding is unavailable", "decode_unavailable"); }
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
}, operation) {
  let dimensions = initialDimensions;
  for (let geometryAttempt = 0; geometryAttempt < 6; geometryAttempt += 1) {
    operation.throwIfCancelled();
    renderBitmap(document, canvas, bitmap, dimensions, mediaType);
    const qualities = mediaType === "image/jpeg" ? [0.9, 0.76, 0.62] : [undefined];
    let lastBlob;
    for (const quality of qualities) {
      const blob = await canvasBlob(canvas, mediaType, quality, operation);
      if (blob.type !== mediaType || blob.size < 1) fail("the browser returned an invalid canonical image");
      if (blob.size <= byteLimit) return Object.freeze({ blob, dimensions });
      lastBlob = blob;
    }
    if (geometryAttempt === 5) break;
    dimensions = smallerDimensions(dimensions, lastBlob.size, byteLimit, { maximumEdge, pixels });
  }
  fail(errorMessage);
}

async function sanitizedCanvasResult(encoded, mediaType, expectedDimensions, byteLimit, errorMessage, operation, {
  requireServerCompatiblePng = false,
} = {}) {
  const canvasBytes = new Uint8Array(await operation.race(encoded.arrayBuffer()));
  if (canvasBytes.byteLength !== encoded.size) fail("canonical image changed while it was read");
  const bytes = sanitizeVisionImageBytes(canvasBytes, mediaType, { requireServerCompatiblePng });
  if (bytes.byteLength > byteLimit) fail(errorMessage);
  const dimensions = inspectVisionImageBytes(bytes, mediaType);
  if (dimensions.width !== expectedDimensions.width || dimensions.height !== expectedDimensions.height) {
    fail("canonical image dimensions changed unexpectedly");
  }
  return Object.freeze({ bytes, dimensions });
}

async function decodeVisionSource(sourceBlob, sourceKind, {
  document,
  createImageBitmapImpl,
  createObjectUrl,
  revokeObjectUrl,
  operation,
}) {
  const closeDrawable = (drawable) => {
    try { drawable?.close?.(); } catch { /* Native decoder resource cleanup is best effort. */ }
  };
  if (typeof createImageBitmapImpl === "function") {
    try {
      const drawable = await operation.race(
        createImageBitmapImpl(sourceBlob, { imageOrientation: "from-image" }),
        { lateResolve: closeDrawable },
      );
      return Object.freeze({ drawable, release: () => closeDrawable(drawable) });
    } catch (error) {
      if (operation.cancelled) throw operation.reason ?? error;
      // Older Safari exposes createImageBitmap but rejects the options overload.
      try {
        const drawable = await operation.race(
          createImageBitmapImpl(sourceBlob),
          { lateResolve: closeDrawable },
        );
        return Object.freeze({ drawable, release: () => closeDrawable(drawable) });
      } catch (fallbackError) {
        if (operation.cancelled) throw operation.reason ?? fallbackError;
        // Fall through to the native HTML image decoder.
      }
    }
  }
  if (typeof createObjectUrl !== "function" || typeof revokeObjectUrl !== "function") {
    if (sourceKind === "heif") {
      fail(
        "This browser cannot decode this HEIC/HEIF photo natively. Choose it again from Photos, or export/share it as JPEG or PNG and retry.",
        "heif_decode_unavailable",
      );
    }
    fail("browser image decoding is unavailable", "decode_unavailable");
  }
  let objectUrl;
  let image;
  try {
    operation.throwIfCancelled();
    objectUrl = createObjectUrl(sourceBlob);
    if (typeof objectUrl !== "string" || objectUrl.length < 1) fail("browser image decoding is unavailable");
    image = document.createElement("img");
    if (!image || typeof image.decode !== "function") fail("browser image decoding is unavailable");
    image.decoding = "async";
    image.src = objectUrl;
    await operation.race(Promise.resolve().then(() => image.decode()));
    let released = false;
    return Object.freeze({
      drawable: image,
      release() {
        if (released) return;
        released = true;
        image.removeAttribute?.("src");
        try { revokeObjectUrl(objectUrl); } catch { /* Native decoder resource cleanup is best effort. */ }
      },
    });
  } catch (error) {
    image?.removeAttribute?.("src");
    if (typeof objectUrl === "string" && objectUrl.length > 0) {
      try { revokeObjectUrl(objectUrl); } catch { /* Best-effort cleanup after decode failure. */ }
    }
    if (operation.cancelled) throw operation.reason ?? error;
    if (sourceKind === "heif") {
      fail(
        "This browser could not decode this HEIC/HEIF photo. Choose it again from Photos, or export/share it as JPEG or PNG and retry.",
        "heif_decode_unavailable",
      );
    }
    fail("the browser could not decode this JPEG or PNG image safely", "decode_failed");
  }
}

export async function canonicalizeVisionImage(file, {
  document = globalThis.document,
  createImageBitmapImpl = globalThis.createImageBitmap,
  createObjectUrl = globalThis.URL?.createObjectURL?.bind(globalThis.URL),
  revokeObjectUrl = globalThis.URL?.revokeObjectURL?.bind(globalThis.URL),
  BlobImpl = globalThis.Blob,
  makeAttachmentId,
  signal,
  timeoutMs = DEFAULT_PREPARATION_TIMEOUT_MS,
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout,
} = {}) {
  if (!file || typeof file.arrayBuffer !== "function" || !Number.isSafeInteger(file.size)
      || file.size < 1 || file.size > BROWSER_VISION_IMAGE_LIMITS.sourceBytes) {
    fail("select a JPEG, PNG, HEIC, or HEIF still image up to 24 MiB");
  }
  if (typeof document?.createElement !== "function" || typeof makeAttachmentId !== "function") {
    fail("browser image canonicalization is unavailable");
  }
  const operation = createBoundedOperation({ signal, timeoutMs, setTimeoutImpl, clearTimeoutImpl });
  try {
    const source = new Uint8Array(await operation.race(file.arrayBuffer()));
    if (source.byteLength !== file.size) fail("selected image changed while it was read");
    const classification = classifyVisionImageSource(source);
    const declared = classification.sourceKind === "heif"
      ? null
      : inspectSourceVisionImageBytes(source, classification.decodeMediaType);
    const decodeBlob = normalizedDecodeBlob(file, source, classification.decodeMediaType, BlobImpl);
    let decodedResource;
    try {
      decodedResource = await decodeVisionSource(decodeBlob, classification.sourceKind, {
        document,
        createImageBitmapImpl,
        createObjectUrl,
        revokeObjectUrl,
        operation,
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
      if (declared !== null) {
        const sameGeometry = decoded.width === declared.width && decoded.height === declared.height;
        const metadataOrientedGeometry = decoded.width === declared.height && decoded.height === declared.width;
        if (!sameGeometry && !metadataOrientedGeometry) {
          fail("decoded image dimensions do not match its file header");
        }
      }
      const canvas = document.createElement("canvas");
      let mediaType = classification.canonicalMediaType;
      const canonicalTarget = fittedDimensions(decoded.width, decoded.height, {
        maximumEdge: BROWSER_VISION_IMAGE_LIMITS.maximumEdge,
        pixels: BROWSER_VISION_IMAGE_LIMITS.pixels,
      });
      let canonicalEncoding = await boundedCanvasEncoding(document, canvas, drawable, mediaType, canonicalTarget, {
        byteLimit: BROWSER_VISION_IMAGE_LIMITS.canonicalBytes,
        maximumEdge: BROWSER_VISION_IMAGE_LIMITS.maximumEdge,
        pixels: BROWSER_VISION_IMAGE_LIMITS.pixels,
        errorMessage: "canonical image exceeds 4 MiB after safe downscaling",
      }, operation);
      let canonical;
      try {
        canonical = await sanitizedCanvasResult(
          canonicalEncoding.blob,
          mediaType,
          canonicalEncoding.dimensions,
          BROWSER_VISION_IMAGE_LIMITS.canonicalBytes,
          "canonical image exceeds 4 MiB after safe downscaling",
          operation,
          { requireServerCompatiblePng: true },
        );
      } catch (error) {
        if (!(error instanceof UnsupportedCanvasPngEncodingError) || mediaType !== "image/png") throw error;
        operation.throwIfCancelled();
        // Unknown ancillary chunks can change PNG rendering (for example transparency),
        // so preserve the decoded pixels through the already-bounded JPEG path instead of stripping them.
        mediaType = "image/jpeg";
        canonicalEncoding = await boundedCanvasEncoding(
          document,
          canvas,
          drawable,
          mediaType,
          canonicalEncoding.dimensions,
          {
            byteLimit: BROWSER_VISION_IMAGE_LIMITS.canonicalBytes,
            maximumEdge: BROWSER_VISION_IMAGE_LIMITS.maximumEdge,
            pixels: BROWSER_VISION_IMAGE_LIMITS.pixels,
            errorMessage: "canonical image exceeds 4 MiB after safe downscaling",
          },
          operation,
        );
        canonical = await sanitizedCanvasResult(
          canonicalEncoding.blob,
          mediaType,
          canonicalEncoding.dimensions,
          BROWSER_VISION_IMAGE_LIMITS.canonicalBytes,
          "canonical image exceeds 4 MiB after safe downscaling",
          operation,
        );
      }
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
        }, operation);
        preview = await sanitizedCanvasResult(
          previewEncoding.blob,
          mediaType,
          previewEncoding.dimensions,
          BROWSER_VISION_IMAGE_LIMITS.previewBytes,
          "the browser could not create a bounded image preview",
          operation,
        );
      }
      operation.throwIfCancelled();
      return Object.freeze({
        attachmentId: makeAttachmentId("image"),
        mediaType,
        byteLength: canonical.bytes.byteLength,
        width: canonical.dimensions.width,
        height: canonical.dimensions.height,
        bytes: canonical.bytes,
        previewBlob: new BlobImpl([preview.bytes], { type: mediaType }),
      });
    } finally {
      decodedResource?.release();
    }
  } finally {
    operation.finish();
  }
}
