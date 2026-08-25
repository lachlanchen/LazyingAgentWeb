export const WEB_RELEASE_HEADER_NAME = "x-lazying-agent-release";

const RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,95}$/u;

export function optionalWebRelease(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !RELEASE_ID.test(value)) {
    throw new TypeError("releaseId must be a portable immutable release identifier");
  }
  return value;
}

export function addWebReleaseHeader(headers, releaseId) {
  if (releaseId !== null) headers.set(WEB_RELEASE_HEADER_NAME, releaseId);
  return headers;
}

export function inspectWebReleaseResponse(response, releaseId) {
  if (releaseId === null) return Object.freeze({ kind: "unpinned", releaseId: null });
  const value = response?.headers?.get?.(WEB_RELEASE_HEADER_NAME);
  if (typeof value !== "string" || !RELEASE_ID.test(value)) {
    return Object.freeze({ kind: "invalid", releaseId: null });
  }
  return Object.freeze({
    kind: value === releaseId ? "match" : "mismatch",
    releaseId: value,
  });
}
