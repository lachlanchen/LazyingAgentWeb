export const FILE_ARTIFACT_MIME_EXTENSIONS = Object.freeze({
  "text/plain": Object.freeze(["txt", "log"]),
  "application/x-tex": Object.freeze(["tex"]),
  "text/x-tex": Object.freeze(["tex"]),
  "text/markdown": Object.freeze(["md", "markdown"]),
  "text/csv": Object.freeze(["csv"]),
  "application/json": Object.freeze(["json"]),
  "application/xml": Object.freeze(["xml"]),
  "text/html": Object.freeze(["html", "htm"]),
  "text/css": Object.freeze(["css"]),
  "text/javascript": Object.freeze(["js", "mjs", "cjs"]),
  "application/typescript": Object.freeze(["ts", "tsx"]),
  "text/x-python": Object.freeze(["py"]),
  "application/x-sh": Object.freeze(["sh"]),
  "image/svg+xml": Object.freeze(["svg"]),
  "image/png": Object.freeze(["png"]),
  "image/jpeg": Object.freeze(["jpg", "jpeg"]),
  "image/webp": Object.freeze(["webp"]),
  "image/gif": Object.freeze(["gif"]),
  "application/pdf": Object.freeze(["pdf"]),
  "application/zip": Object.freeze(["zip"]),
  "application/gzip": Object.freeze(["gz"]),
  "application/octet-stream": Object.freeze(["bin", "dat"]),
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": Object.freeze(["docx"]),
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": Object.freeze(["xlsx"]),
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": Object.freeze(["pptx"]),
});

export const FILE_ARTIFACT_ACTIVE_MIMES = Object.freeze([
  "application/xml",
  "text/html",
  "text/css",
  "text/javascript",
  "application/typescript",
  "image/svg+xml",
]);

const ACTIVE_MIMES = new Set(FILE_ARTIFACT_ACTIVE_MIMES);

export function fileArtifactMimeIsSupported(mime) {
  return typeof mime === "string" && Object.hasOwn(FILE_ARTIFACT_MIME_EXTENSIONS, mime);
}

export function fileArtifactExtensionMatches(mime, filename) {
  if (!fileArtifactMimeIsSupported(mime) || typeof filename !== "string") return false;
  const offset = filename.lastIndexOf(".");
  if (offset < 1 || offset === filename.length - 1) return false;
  return FILE_ARTIFACT_MIME_EXTENSIONS[mime].includes(filename.slice(offset + 1).toLowerCase());
}

export function fileArtifactMustDownload(mime) {
  return ACTIVE_MIMES.has(mime);
}
