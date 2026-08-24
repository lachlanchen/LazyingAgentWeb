import { AgintiBrowserClient, selectDefaultMode } from "./aginti-client.js";
import { AgintiProtocolError, FAIL_CLOSED_AGENT_CAPABILITIES, validateAgentCapabilities } from "./aginti-protocol.js";
import { CloudSessionClient } from "./cloud-session-client.js";
import {
  createBrowserOpaqueId,
  DirectChatBrowserClient,
  DirectChatProtocolError,
  DirectChatTransportError,
} from "./direct-chat-client.js";
import { createRunPresentation } from "./presentation-state.js";
import {
  applyTheme,
  offerPasswordManagerSave,
  rememberWorkspaceMode,
  restoreTheme,
  restoreWorkspaceMode,
} from "./pwa-assets.js";
import { createBrowserUpdateHandoffStore } from "./pwa-update-handoff-store.js";
import {
  BROWSER_VISION_IMAGE_LIMITS,
  canonicalizeVisionImage,
  inspectVisionImageBytes,
  VisionImageInputError,
} from "./vision-image-client.js";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const UNSAFE_MESSAGE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const AUTHENTICATION_FAILURE_CODES = new Set(["authentication_required", "invalid_session"]);
const BODY_REJECTION_CODES = new Set([
  "invalid_attachment", "invalid_json", "request_aborted", "request_error", "request_too_large",
]);
const SAFE_CHAT_FAILURE_OPERATIONS = new Set([
  "local_thread", "local_run", "thread_dispatch", "snapshot", "run_dispatch", "before_run_dispatch",
]);
const UPDATE_HANDOFF_SCHEMA_VERSION = "1";
const UPDATE_HANDOFF_MAX_AGE_MS = 5 * 60 * 1_000;
const UPDATE_HANDOFF_FUTURE_SKEW_MS = 30_000;
const UPDATE_HANDOFF_METADATA_LIMIT = 160 * 1024;
const UPDATE_HANDOFF_PAYLOAD_LIMIT = BROWSER_VISION_IMAGE_LIMITS.canonicalBytes + UPDATE_HANDOFF_METADATA_LIMIT + 4;
const UPDATE_HANDOFF_DIGEST = /^[a-f0-9]{64}$/u;
const UPDATE_HANDOFF_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const UPDATE_HANDOFF_ID = /^[a-f0-9]{64}$/u;
const UPDATE_HANDOFF_KEY = /^[A-Za-z0-9_-]{43}$/u;
const DEFAULT_ATTACHMENT_MEMORY_LIMIT_BYTES = 16 * 1024 * 1024;
const DEFAULT_ATTACHMENT_DECODED_MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
const ATTACHMENT_RENDERED_PREVIEW_LIMIT = 4;
const ATTACHMENT_RESTORE_CONCURRENCY = 1;
const COMPOSER_IMAGE_COUNT_LIMIT = 4;
const COMPOSER_IMAGE_BYTES_LIMIT = 16 * 1024 * 1024;
const COMPOSER_MESSAGE_BYTES_LIMIT = 32 * 1024;
const updateHandoffEncoder = new TextEncoder();
const updateHandoffDecoder = new TextDecoder("utf-8", { fatal: true });

class LocalChatNotSentError extends Error {
  constructor(stage, cause) {
    super("The LocalLLM request stopped before its durable run was dispatched.", { cause });
    this.name = "LocalChatNotSentError";
    this.stage = stage;
  }
}

class LocalChatPreparationError extends LocalChatNotSentError {
  constructor(stage, cause) {
    super(stage, cause);
    this.name = "LocalChatPreparationError";
  }
}

function exactObject(value, allowed, required, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !allowed.includes(key)) throw new TypeError(`${label} contains an unsupported field`);
    if (!descriptors[key].enumerable || !Object.hasOwn(descriptors[key], "value")) throw new TypeError(`${label} contains an accessor`);
  }
  for (const key of required) if (!Object.hasOwn(value, key)) throw new TypeError(`${label}.${key} is required`);
  return value;
}

function sessionEnvelope(value) {
  const session = exactObject(value, ["authenticated", "username", "csrfToken"], ["authenticated"], "session");
  if (typeof session.authenticated !== "boolean") throw new TypeError("session.authenticated must be boolean");
  if (!session.authenticated) {
    if (Object.keys(session).length !== 1) throw new TypeError("signed-out session contains private state");
    return Object.freeze({ authenticated: false });
  }
  if (typeof session.username !== "string" || session.username.length < 1 || session.username.length > 128
      || /[<>\u0000-\u001f\u007f]/u.test(session.username)) throw new TypeError("session username is invalid");
  if (typeof session.csrfToken !== "string" || session.csrfToken.length < 16 || session.csrfToken.length > 1_024
      || /[\u0000-\u001f\u007f]/u.test(session.csrfToken)) throw new TypeError("session CSRF token is invalid");
  return Object.freeze({ authenticated: true, username: session.username, csrfToken: session.csrfToken });
}

function normalizedSessionUsername(value) {
  return String(value).normalize("NFC");
}

function logoutEnvelope(value) {
  const result = exactObject(value, ["signedOut", "agentCancellationPending"], ["signedOut", "agentCancellationPending"], "logout response");
  if (result.signedOut !== true || typeof result.agentCancellationPending !== "boolean") throw new TypeError("logout response is invalid");
  return Object.freeze({ signedOut: true, agentCancellationPending: result.agentCancellationPending });
}

function chatCapabilityEnvelope(value) {
  const result = exactObject(value, ["visionInput", "visionMediaTypes", "maximumImageBytes"], [
    "visionInput", "visionMediaTypes", "maximumImageBytes",
  ], "chat capabilities");
  if (typeof result.visionInput !== "boolean" || !Array.isArray(result.visionMediaTypes)
      || !Number.isSafeInteger(result.maximumImageBytes)
      || (result.visionInput
        ? result.maximumImageBytes !== 4 * 1024 * 1024
          || result.visionMediaTypes.join(",") !== "image/jpeg,image/png"
        : result.maximumImageBytes !== 0 || result.visionMediaTypes.length !== 0)) {
    throw new TypeError("chat capabilities are invalid");
  }
  return Object.freeze({
    visionInput: result.visionInput,
    visionMediaTypes: Object.freeze([...result.visionMediaTypes]),
    maximumImageBytes: result.maximumImageBytes,
  });
}

function requiredMethod(value, name, owner) {
  if (!value || typeof value[name] !== "function") throw new TypeError(`${owner} must provide ${name}()`);
}

function isUnicodeScalarText(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function boundedMessage(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 32_000
      || !isUnicodeScalarText(value) || updateHandoffEncoder.encode(value).byteLength > COMPOSER_MESSAGE_BYTES_LIMIT
      || UNSAFE_MESSAGE_CONTROL.test(value)) {
    throw new TypeError("message is invalid");
  }
  const text = value.trim();
  if (!text) throw new TypeError("message must contain non-whitespace text");
  return text;
}

function normalizedExecutionAction(value) {
  let text = String(value || "").normalize("NFKC").replace(/\s+/gu, " ").trim();
  text = text.replace(/^(?:please|kindly)[ \t]*,?[ \t]+/iu, "");
  text = text.replace(
    /^(?:can|could|would|will)\s+you\s+(?:(?:please|kindly)[ \t]*,?[ \t]+)?/iu,
    ""
  );
  text = text.replace(
    /^i(?:['’]d|\s+would)?\s+(?:like|want|need)\s+(?:you\s+)?to\s+/iu,
    ""
  );
  text = text.replace(/^let(?:['’]s|\s+us)\s+/iu, "");
  text = text.replace(/^(?:请你?|請你?|麻烦你?|麻煩你?|劳驾|勞駕)[ \t]*/u, "");
  return text;
}

function requestsExplicitPythonHandoff(value) {
  const fenceLines = value.match(/^ {0,3}(?:`{3,}|~{3,})/gmu) ?? [];
  if (fenceLines.length === 0) return null;
  const matches = [...value.matchAll(/(^|\n)```python[ \t]*\r?\n[\s\S]*?\r?\n```[ \t]*(?=\n|$)/giu)];
  if (matches.length !== 1 || fenceLines.length !== 2) return false;
  const match = matches[0];
  const outside = `${value.slice(0, match.index)}\n${value.slice(match.index + match[0].length)}`;
  const action = normalizedExecutionAction(outside);
  return /^(?:run|execute)(?:(?:\s+|:)(?:this|that|my|the|following|below|above|python|code|script|program|snippet|block|it)\b|\s*:)/iu.test(action)
    || /^(?:run|execute)\b[ \t]*(?:[,;][ \t]*)?(?:(?:and(?:[ \t]+then)?|then|to)[ \t]+)?(?:show|display|return|give|print|output|produce|create|generate|draw|render|include|plot|chart|graph|visuali[sz]e)\b/iu.test(action)
    || /^(?:run|execute)\b[ \t]*[;,][ \t]*i[ \t]+(?:need|want|would[ \t]+like)[ \t]+(?:a[ \t]+|the[ \t]+)?(?:plot|chart|graph)\b/iu.test(action)
    || /^(?:运行|運行|执行|執行)(?:一下)?(?:(?:以下|下面|上述|上面|这段|這段|这个|這個|该|該|python|代码|代碼|程式碼|脚本|腳本|程序|程式)|[ \t]*[:：])/iu.test(action);
}

function requestsAgentExecution(value) {
  const explicitPythonHandoff = requestsExplicitPythonHandoff(value);
  if (explicitPythonHandoff !== null) return explicitPythonHandoff;
  const text = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  const lower = text.toLocaleLowerCase("en-US");
  if (/^(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+)?(?:do\s+not|don['’]?t|dont|can['’]?t|cannot|not|never|no\s+need\s+to)\b/iu.test(lower)
      || /\bhow\s+(?:to|do|can|could|would|should)\b/iu.test(lower)
      || /^(?:please\s+)?(?:how\b|what(?:['’]s|\s+is)\s+the\s+(?:best\s+)?way\b)/iu.test(lower)
      || /^(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+)?(?:explain|describe|interpret|analy[sz]e|review|discuss)\b/iu.test(lower)
      || /\b(?:this|that|my|existing|attached|above|below|current|provided)\s+(?:existing\s+)?(?:plot|graph|chart)\b/iu.test(lower)
      || /\b(?:javascript|typescript|node(?:\.js)?|deno|bun|bash|shell|powershell|ruby|java|kotlin|swift|rust|golang|c\+\+|cpp|c#|csharp|\.net|php|perl|matlab|octave|julia|sql)\b/iu.test(lower)
      || /\b(?:using|with|in|run|execute)\s+(?:r|go|c)(?:\s+(?:code|script|runtime|language))?\b/iu.test(lower)) {
    return false;
  }
  const command = normalizedExecutionAction(lower);
  return /^(?:plot|graph|chart)\b/iu.test(command)
    || /^(?:run|execute)\b.{0,160}\b(?:code|script|python|plot|graph|chart)\b/iu.test(command)
    || /^(?:make|draw|create|generate|render|display|show|calculate|compute)\b.{0,160}\b(?:plot|graph|chart)\b/iu.test(command);
}

function updateHandoffDraft(value) {
  if (typeof value !== "string" || value.length > 32_000 || !isUnicodeScalarText(value)
      || UNSAFE_MESSAGE_CONTROL.test(value)) {
    throw new TypeError("update handoff draft is invalid");
  }
  return value;
}

async function updateHandoffDigest(bytes) {
  if (!(bytes instanceof Uint8Array) || typeof globalThis.crypto?.subtle?.digest !== "function") {
    throw new TypeError("browser update handoff hashing is unavailable");
  }
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function updateHandoffDigestInput(record) {
  const image = record.image === null ? null : {
    attachmentId: record.image.attachmentId,
    mediaType: record.image.mediaType,
    byteLength: record.image.byteLength,
    width: record.image.width,
    height: record.image.height,
  };
  const metadata = updateHandoffEncoder.encode(JSON.stringify({
    schemaVersion: record.schemaVersion,
    scope: record.scope,
    sourceRelease: record.sourceRelease,
    targetRelease: record.targetRelease,
    createdAt: record.createdAt,
    accountDigest: record.accountDigest,
    threadId: record.threadId,
    draft: record.draft,
    image,
  }));
  const imageBytes = record.image?.bytes ?? new Uint8Array(0);
  const payload = new Uint8Array(4 + metadata.byteLength + imageBytes.byteLength);
  new DataView(payload.buffer).setUint32(0, metadata.byteLength);
  payload.set(metadata, 4);
  payload.set(imageBytes, 4 + metadata.byteLength);
  return payload;
}

function updateHandoffImage(value) {
  if (value === null) return null;
  const image = exactObject(value, [
    "attachmentId", "mediaType", "byteLength", "width", "height", "bytes",
  ], [
    "attachmentId", "mediaType", "byteLength", "width", "height", "bytes",
  ], "update handoff image");
  if (typeof image.attachmentId !== "string" || image.attachmentId.length < 16
      || !UPDATE_HANDOFF_IDENTIFIER.test(image.attachmentId)
      || !["image/jpeg", "image/png"].includes(image.mediaType)
      || !Number.isSafeInteger(image.byteLength) || image.byteLength < 1
      || image.byteLength > BROWSER_VISION_IMAGE_LIMITS.canonicalBytes
      || !(image.bytes instanceof Uint8Array) || image.bytes.byteLength !== image.byteLength
      || !Number.isSafeInteger(image.width) || image.width < 1
      || image.width > BROWSER_VISION_IMAGE_LIMITS.maximumEdge
      || !Number.isSafeInteger(image.height) || image.height < 1
      || image.height > BROWSER_VISION_IMAGE_LIMITS.maximumEdge
      || image.width * image.height > BROWSER_VISION_IMAGE_LIMITS.pixels) {
    throw new TypeError("update handoff image is invalid");
  }
  const inspected = inspectVisionImageBytes(image.bytes, image.mediaType);
  if (inspected.width !== image.width || inspected.height !== image.height) {
    throw new TypeError("update handoff image dimensions are inconsistent");
  }
  return Object.freeze({
    attachmentId: image.attachmentId,
    mediaType: image.mediaType,
    byteLength: image.byteLength,
    width: image.width,
    height: image.height,
    bytes: image.bytes.slice(),
  });
}

async function validateUpdateHandoff(value, {
  scope,
  currentRelease,
  username,
  now,
}) {
  const record = exactObject(value, [
    "schemaVersion", "scope", "sourceRelease", "targetRelease", "createdAt", "accountDigest",
    "threadId", "draft", "image", "digest",
  ], [
    "schemaVersion", "scope", "sourceRelease", "targetRelease", "createdAt", "accountDigest",
    "threadId", "draft", "image", "digest",
  ], "update handoff");
  const instant = Number(now());
  if (record.schemaVersion !== UPDATE_HANDOFF_SCHEMA_VERSION || record.scope !== scope
      || !validAgentRelease(record.sourceRelease) || record.targetRelease !== currentRelease
      || !validAgentRelease(record.targetRelease)
      || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0
      || !Number.isSafeInteger(instant) || instant < 0
      || record.createdAt > instant + UPDATE_HANDOFF_FUTURE_SKEW_MS
      || instant - record.createdAt > UPDATE_HANDOFF_MAX_AGE_MS
      || typeof record.accountDigest !== "string" || !UPDATE_HANDOFF_DIGEST.test(record.accountDigest)
      || typeof record.digest !== "string" || !UPDATE_HANDOFF_DIGEST.test(record.digest)
      || (record.threadId !== null && (typeof record.threadId !== "string"
        || !UPDATE_HANDOFF_IDENTIFIER.test(record.threadId)))) {
    throw new TypeError("update handoff ownership is invalid");
  }
  const draft = updateHandoffDraft(record.draft);
  const image = updateHandoffImage(record.image);
  if (!draft && image === null) throw new TypeError("update handoff is empty");
  const accountDigest = await updateHandoffDigest(updateHandoffEncoder.encode(
    `lazying-agent-update-account\u0000${normalizedSessionUsername(username)}`,
  ));
  if (accountDigest !== record.accountDigest) throw new TypeError("update handoff account is invalid");
  const normalized = Object.freeze({
    schemaVersion: record.schemaVersion,
    scope: record.scope,
    sourceRelease: record.sourceRelease,
    targetRelease: record.targetRelease,
    createdAt: record.createdAt,
    accountDigest: record.accountDigest,
    threadId: record.threadId,
    draft,
    image,
  });
  if (await updateHandoffDigest(updateHandoffDigestInput(normalized)) !== record.digest) {
    throw new TypeError("update handoff digest is invalid");
  }
  return normalized;
}

function encodeUpdateHandoffPayload(record) {
  const image = record.image === null ? null : {
    attachmentId: record.image.attachmentId,
    mediaType: record.image.mediaType,
    byteLength: record.image.byteLength,
    width: record.image.width,
    height: record.image.height,
  };
  const metadata = updateHandoffEncoder.encode(JSON.stringify({
    schemaVersion: record.schemaVersion,
    scope: record.scope,
    sourceRelease: record.sourceRelease,
    targetRelease: record.targetRelease,
    createdAt: record.createdAt,
    accountDigest: record.accountDigest,
    threadId: record.threadId,
    draft: record.draft,
    image,
    digest: record.digest,
  }));
  const imageBytes = record.image?.bytes ?? new Uint8Array(0);
  if (metadata.byteLength > UPDATE_HANDOFF_METADATA_LIMIT
      || 4 + metadata.byteLength + imageBytes.byteLength > UPDATE_HANDOFF_PAYLOAD_LIMIT) {
    throw new TypeError("update handoff payload is too large");
  }
  const payload = new Uint8Array(4 + metadata.byteLength + imageBytes.byteLength);
  new DataView(payload.buffer).setUint32(0, metadata.byteLength);
  payload.set(metadata, 4);
  payload.set(imageBytes, 4 + metadata.byteLength);
  return payload;
}

function decodeUpdateHandoffPayload(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 6 || bytes.byteLength > UPDATE_HANDOFF_PAYLOAD_LIMIT) {
    throw new TypeError("update handoff payload is invalid");
  }
  const metadataLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  if (metadataLength < 2 || metadataLength > UPDATE_HANDOFF_METADATA_LIMIT
      || 4 + metadataLength > bytes.byteLength) throw new TypeError("update handoff metadata is invalid");
  const metadata = JSON.parse(updateHandoffDecoder.decode(bytes.subarray(4, 4 + metadataLength)));
  const envelope = exactObject(metadata, [
    "schemaVersion", "scope", "sourceRelease", "targetRelease", "createdAt", "accountDigest",
    "threadId", "draft", "image", "digest",
  ], [
    "schemaVersion", "scope", "sourceRelease", "targetRelease", "createdAt", "accountDigest",
    "threadId", "draft", "image", "digest",
  ], "update handoff payload");
  let image = null;
  if (envelope.image !== null) {
    const descriptor = exactObject(envelope.image, [
      "attachmentId", "mediaType", "byteLength", "width", "height",
    ], [
      "attachmentId", "mediaType", "byteLength", "width", "height",
    ], "update handoff image descriptor");
    image = { ...descriptor, bytes: bytes.slice(4 + metadataLength) };
  } else if (bytes.byteLength !== 4 + metadataLength) {
    throw new TypeError("update handoff contains unexpected binary data");
  }
  return { ...envelope, image };
}

function updateHandoffBase64Url(bytes) {
  if (typeof bytes?.toBase64 === "function") {
    return bytes.toBase64({ alphabet: "base64url", omitPadding: true });
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeUpdateHandoffKey(value) {
  if (typeof value !== "string" || !UPDATE_HANDOFF_KEY.test(value) || typeof globalThis.atob !== "function") {
    throw new TypeError("update handoff key is invalid");
  }
  const binary = globalThis.atob(`${value.replaceAll("-", "+").replaceAll("_", "/")}=`);
  if (binary.length !== 32) throw new TypeError("update handoff key is invalid");
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function createUpdateHandoffClaim() {
  if (typeof globalThis.crypto?.getRandomValues !== "function") {
    throw new TypeError("secure update handoff randomness is unavailable");
  }
  const identifierBytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const keyBytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  return Object.freeze({
    handoffId: [...identifierBytes].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    key: updateHandoffBase64Url(keyBytes),
  });
}

function updateHandoffFragment(claim) {
  return `#lazying-update-handoff=${claim.handoffId}.${claim.key}`;
}

function captureUpdateHandoffClaim(window) {
  let url;
  try { url = new URL(window?.location?.href); }
  catch { return null; }
  const match = /^#lazying-update-handoff=([a-f0-9]{64})\.([A-Za-z0-9_-]{43})$/u.exec(url.hash);
  if (!match) return null;
  try {
    window.history.replaceState(window.history.state ?? null, "", `${url.pathname}${url.search}`);
  } catch { return null; }
  return Object.freeze({ handoffId: match[1], key: match[2] });
}

function updateHandoffAdditionalData(envelope) {
  return updateHandoffEncoder.encode(JSON.stringify({
    schemaVersion: envelope.schemaVersion,
    scope: envelope.scope,
    handoffId: envelope.handoffId,
    sourceRelease: envelope.sourceRelease,
    targetRelease: envelope.targetRelease,
    createdAt: envelope.createdAt,
    expiresAt: envelope.expiresAt,
  }));
}

async function encryptUpdateHandoff(record, claim) {
  const subtle = globalThis.crypto?.subtle;
  if (typeof subtle?.importKey !== "function" || typeof subtle?.encrypt !== "function"
      || !UPDATE_HANDOFF_ID.test(claim.handoffId)) throw new TypeError("update handoff encryption is unavailable");
  const keyBytes = decodeUpdateHandoffKey(claim.key);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const envelope = Object.freeze({
    schemaVersion: UPDATE_HANDOFF_SCHEMA_VERSION,
    scope: record.scope,
    handoffId: claim.handoffId,
    sourceRelease: record.sourceRelease,
    targetRelease: record.targetRelease,
    createdAt: record.createdAt,
    expiresAt: record.createdAt + UPDATE_HANDOFF_MAX_AGE_MS,
  });
  const key = await subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await subtle.encrypt({
    name: "AES-GCM",
    iv,
    additionalData: updateHandoffAdditionalData(envelope),
    tagLength: 128,
  }, key, encodeUpdateHandoffPayload(record)));
  return Object.freeze({ ...envelope, iv, ciphertext });
}

async function decryptUpdateHandoff(value, claim, {
  scope,
  currentRelease,
  username,
  now,
}) {
  const envelope = exactObject(value, [
    "schemaVersion", "scope", "handoffId", "sourceRelease", "targetRelease", "createdAt", "expiresAt", "iv", "ciphertext",
  ], [
    "schemaVersion", "scope", "handoffId", "sourceRelease", "targetRelease", "createdAt", "expiresAt", "iv", "ciphertext",
  ], "encrypted update handoff");
  const instant = Number(now());
  if (envelope.schemaVersion !== UPDATE_HANDOFF_SCHEMA_VERSION || envelope.scope !== scope
      || envelope.handoffId !== claim.handoffId || !UPDATE_HANDOFF_ID.test(envelope.handoffId)
      || !validAgentRelease(envelope.sourceRelease) || envelope.targetRelease !== currentRelease
      || !validAgentRelease(envelope.targetRelease)
      || !Number.isSafeInteger(envelope.createdAt) || envelope.createdAt < 0
      || envelope.expiresAt !== envelope.createdAt + UPDATE_HANDOFF_MAX_AGE_MS
      || !Number.isSafeInteger(instant) || instant < 0 || instant > envelope.expiresAt
      || envelope.createdAt > instant + UPDATE_HANDOFF_FUTURE_SKEW_MS
      || !(envelope.iv instanceof Uint8Array) || envelope.iv.byteLength !== 12
      || !(envelope.ciphertext instanceof Uint8Array) || envelope.ciphertext.byteLength < 17
      || envelope.ciphertext.byteLength > UPDATE_HANDOFF_PAYLOAD_LIMIT + 16) {
    throw new TypeError("encrypted update handoff is invalid");
  }
  const subtle = globalThis.crypto?.subtle;
  if (typeof subtle?.importKey !== "function" || typeof subtle?.decrypt !== "function") {
    throw new TypeError("update handoff decryption is unavailable");
  }
  const key = await subtle.importKey("raw", decodeUpdateHandoffKey(claim.key), "AES-GCM", false, ["decrypt"]);
  const plaintext = new Uint8Array(await subtle.decrypt({
    name: "AES-GCM",
    iv: envelope.iv,
    additionalData: updateHandoffAdditionalData(envelope),
    tagLength: 128,
  }, key, envelope.ciphertext));
  const record = await validateUpdateHandoff(decodeUpdateHandoffPayload(plaintext), {
    scope,
    currentRelease,
    username,
    now,
  });
  if (record.sourceRelease !== envelope.sourceRelease || record.targetRelease !== envelope.targetRelease
      || record.createdAt !== envelope.createdAt) throw new TypeError("update handoff envelope is inconsistent");
  return record;
}

function conversationTitle(value) {
  let title = "";
  let pendingSpace = false;
  let scalars = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      pendingSpace = title.length > 0;
      continue;
    }
    const scalar = codePoint >= 0xd800 && codePoint <= 0xdfff ? "\ufffd" : character;
    if (pendingSpace && scalars < 80) {
      title += " ";
      scalars += 1;
    }
    pendingSpace = false;
    if (scalars >= 80) break;
    title += scalar;
    scalars += 1;
  }
  return title.trim();
}

function prepareLocalChat(stage, operation) {
  try { return operation(); }
  catch (error) { throw new LocalChatPreparationError(stage, error); }
}

function chatFailureCause(error) {
  return error instanceof LocalChatNotSentError && error.cause !== undefined ? error.cause : error;
}

function isChatAuthenticationRejection(error) {
  const cause = chatFailureCause(error);
  return AUTHENTICATION_FAILURE_CODES.has(cause?.code)
    || cause?.code === "csrf_rejected"
    || cause?.status === 401;
}

function isChatAuthenticationAfterAmbiguousDispatch(error) {
  const cause = chatFailureCause(error);
  return isChatAuthenticationRejection(error) || cause?.status === 403;
}

function chatFailureDiagnostic(error) {
  const cause = chatFailureCause(error);
  const operation = SAFE_CHAT_FAILURE_OPERATIONS.has(error?.stage) ? error.stage : "before_run_dispatch";
  const sourceCode = typeof cause?.code === "string" ? cause.code : "request_failed";
  const status = Number.isSafeInteger(cause?.status) ? cause.status : 0;
  if (error instanceof LocalChatPreparationError) {
    return Object.freeze({
      stage: "local_preparation",
      code: operation === "local_thread" ? "thread_ticket_invalid" : "run_ticket_invalid",
      operation,
      label: "Local preparation",
      reauthenticate: false,
    });
  }
  if (AUTHENTICATION_FAILURE_CODES.has(sourceCode) || status === 401) {
    return Object.freeze({
      stage: "authentication",
      code: sourceCode === "invalid_session" ? "invalid_session" : "authentication_required",
      operation,
      label: "Sign-in required",
      reauthenticate: true,
    });
  }
  if (sourceCode === "csrf_rejected") {
    return Object.freeze({
      stage: "csrf",
      code: "csrf_rejected",
      operation,
      label: "Security token expired",
      reauthenticate: true,
    });
  }
  if (["request_timeout", "dependency_timeout"].includes(sourceCode) || [408, 504].includes(status)) {
    return Object.freeze({
      stage: "network_timeout",
      code: sourceCode === "dependency_timeout" ? "dependency_timeout" : "request_timeout",
      operation,
      label: "Network timeout",
      reauthenticate: false,
    });
  }
  if (["conflict", "idempotency_conflict"].includes(sourceCode) || status === 409) {
    return Object.freeze({
      stage: "authoritative_conflict",
      code: sourceCode === "idempotency_conflict" ? "idempotency_conflict" : "conflict",
      operation,
      label: "Conversation changed",
      reauthenticate: false,
    });
  }
  if (BODY_REJECTION_CODES.has(sourceCode) || status === 413) {
    return Object.freeze({
      stage: "body_rejection",
      code: BODY_REJECTION_CODES.has(sourceCode) ? sourceCode : "request_too_large",
      operation,
      label: "Image upload rejected",
      reauthenticate: false,
    });
  }
  if (operation === "snapshot") {
    return Object.freeze({
      stage: "snapshot",
      code: cause instanceof DirectChatProtocolError ? "snapshot_protocol" : "snapshot_unavailable",
      operation,
      label: "Conversation refresh",
      reauthenticate: false,
    });
  }
  if (cause?.retryable === true) {
    return Object.freeze({
      stage: "network",
      code: "network_unavailable",
      operation,
      label: "Network unavailable",
      reauthenticate: false,
    });
  }
  return Object.freeze({
    stage: "authoritative_rejection",
    code: "request_rejected",
    operation,
    label: "Request rejected",
    reauthenticate: false,
  });
}

function normalizedBrowserPath(value, name, { trailingSlash = false } = {}) {
  if (typeof value !== "string" || value.length > 160 || !/^\/[A-Za-z0-9._~/-]*$/u.test(value) || value.includes("//")
      || value.split("/").some((part) => part === "." || part === "..")) {
    throw new TypeError(`${name} must be a normalized absolute path`);
  }
  if (trailingSlash) return value.endsWith("/") ? value : `${value}/`;
  return value.length > 1 ? value.replace(/\/$/u, "") : value;
}

function metaContent(document, name) {
  try {
    const node = document?.querySelector?.(`meta[name="${name}"]`);
    const value = node?.getAttribute?.("content") ?? node?.content;
    return typeof value === "string" && value ? value : undefined;
  } catch { return undefined; }
}

function validAgentRelease(value) {
  return typeof value === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._~-]{0,23}-[a-f0-9]{64}$/u.test(value);
}

function agentReleaseMessage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "releaseId,type"
      || value.type !== "LAZYING_AGENT_RELEASE" || !validAgentRelease(value.releaseId)) return null;
  return value.releaseId;
}

function safeRunStatus(value) {
  return ["starting", "running", "completed", "failed", "cancelled"].includes(value) ? value : "running";
}

function eventAwaitingRunStatus(value) {
  const status = safeRunStatus(value);
  return TERMINAL.has(status) ? "running" : status;
}

function correlatedAgentRun(value, { runId, threadId }) {
  if (!value || typeof value !== "object" || value.id !== runId || value.threadId !== threadId) {
    throw new AgintiProtocolError("Agent run ownership does not match the requested thread", {
      code: "LEDGER_OWNERSHIP_MISMATCH",
    });
  }
  return value;
}

function correlatedResumedAgentRun(value, { previousRunId, threadId }) {
  if (!value || typeof value !== "object" || value.threadId !== threadId
      || value.previousRunId !== previousRunId || value.id === previousRunId) {
    throw new AgintiProtocolError("Resumed Agent run does not extend the requested run", {
      code: "LEDGER_OWNERSHIP_MISMATCH",
    });
  }
  return value;
}

function assertTerminalAgentReplay(run, snapshot) {
  const cursor = run?.eventCursor;
  if (!TERMINAL.has(run?.status)
      || snapshot?.terminalStatus !== run.status
      || snapshot.status !== run.status
      || !cursor || typeof cursor !== "object"
      || cursor.firstSeq !== 1 || cursor.prunedThroughSeq !== 0
      || snapshot.cursor.seq !== cursor.lastSeq
      || snapshot.cursor.hash !== cursor.lastHash) {
    throw new AgintiProtocolError("Agent terminal history does not match its authoritative cursor", {
      code: "LEDGER_TERMINAL_MISMATCH",
    });
  }
  return snapshot;
}

function persistedThreadRuns(thread) {
  const result = [];
  const seen = new Set();
  const persisted = new Set(
    (Array.isArray(thread?.messages) ? thread.messages : [])
      .filter((message) => message?.role === "assistant")
      .map((message) => message.runId)
  );
  for (const message of Array.isArray(thread?.messages) ? thread.messages : []) {
    if (message?.role !== "user" && message?.role !== "assistant") continue;
    if (message.runId === thread?.lastRunId || seen.has(message.runId)) continue;
    seen.add(message.runId);
    result.push(Object.freeze({ runId: message.runId, persisted: persisted.has(message.runId) }));
  }
  // The thread's declared current run is always restored last even if a
  // hostile-but-schema-valid message ordering places it earlier in history.
  if (thread?.lastRunId) {
    result.push(Object.freeze({ runId: thread.lastRunId, persisted: persisted.has(thread.lastRunId) }));
  }
  return Object.freeze(result);
}

function loginFailureMessage(error) {
  const status = Number(error?.status ?? error?.statusCode ?? 0);
  if (status === 401 || status === 403) return "Sign-in failed. Check the account and try again.";
  if (status === 429) return "Sign-in is temporarily busy. Wait a moment and try again.";
  return "The sign-in service is unavailable. Please try again shortly.";
}

function elementMap(document) {
  if (!document || typeof document.getElementById !== "function" || typeof document.createElement !== "function") {
    throw new TypeError("browser app requires a DOM document");
  }
  const ids = [
    "login-view", "app-view", "login-form", "login-submit", "login-error", "username", "password", "remember-session",
    "signed-in-user", "logout", "new-thread", "thread-list", "workspace", "conversation-title",
    "connection-state", "mode-switch", "agent-mode", "chat-mode", "theme-picker", "offline-banner",
    "update-banner", "apply-update", "defer-update", "context-indicator", "context-indicator-text", "welcome",
    "welcome-eyebrow", "welcome-copy", "messages", "activity-panel", "run-state", "agent-plan",
    "agent-timeline", "agent-artifacts", "composer", "message-input", "send-message", "resume-run",
    "stop-run", "image-input", "add-image", "image-preview", "image-preview-thumbnail",
    "image-preview-label", "remove-image", "install-app", "toast", "sidebar", "sidebar-scrim", "open-sidebar",
  ];
  return Object.freeze(Object.fromEntries(ids.map((id) => {
    const value = document.getElementById(id);
    if (!value) throw new TypeError(`app shell is missing #${id}`);
    return [id.replaceAll("-", "_"), value];
  })));
}

function makeButton(document, label, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function statusLabel(status) {
  return status.slice(0, 1).toUpperCase() + status.slice(1).replaceAll("_", " ");
}

export function createBrowserApp({
  document = globalThis.document,
  window = globalThis.window,
  navigator = globalThis.navigator,
  sessionClient: suppliedSessionClient,
  createAgentClient: suppliedAgentClientFactory,
  createChatClient: suppliedChatClientFactory,
  renderer,
  cursorStore,
  credentialSaver = offerPasswordManagerSave,
  confirmThreadDeletion = (message) => window?.confirm?.(message) === true,
  canonicalizeImage = canonicalizeVisionImage,
  createObjectUrl = (blob) => globalThis.URL.createObjectURL(blob),
  revokeObjectUrl = (url) => globalThis.URL.revokeObjectURL(url),
  updateHandoffStore: suppliedUpdateHandoffStore,
  serviceWorkerPath,
  serviceWorkerScope,
  updateCheckIntervalMs = 15 * 60 * 1_000,
  updateDeferralMs = 60 * 60 * 1_000,
  activationTimeoutMs = 30_000,
  attachmentDecodeTimeoutMs = 15_000,
  attachmentMemoryLimitBytes = DEFAULT_ATTACHMENT_MEMORY_LIMIT_BYTES,
  attachmentDecodedMemoryLimitBytes = DEFAULT_ATTACHMENT_DECODED_MEMORY_LIMIT_BYTES,
  now = Date.now,
  maxStreamBackoffSteps = 5,
  wait = (milliseconds, signal) => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    }, { once: true });
  }),
} = {}) {
  const browserBaseUrl = window?.location?.href ?? globalThis.location?.href;
  const sessionClient = suppliedSessionClient ?? new CloudSessionClient({ baseUrl: browserBaseUrl });
  const createAgentClient = suppliedAgentClientFactory ?? ((session) => new AgintiBrowserClient({
    transportEndpoint: "/api/transport",
    baseUrl: browserBaseUrl,
    csrfToken: () => sessionClient.csrfToken?.() ?? session.csrfToken,
  }));
  const createChatClient = suppliedChatClientFactory ?? (() => new DirectChatBrowserClient({
    baseUrl: browserBaseUrl,
  }));
  requiredMethod(sessionClient, "restore", "sessionClient");
  requiredMethod(sessionClient, "login", "sessionClient");
  requiredMethod(sessionClient, "logout", "sessionClient");
  if (typeof createAgentClient !== "function" || typeof createChatClient !== "function") {
    throw new TypeError("client factories are required");
  }
  requiredMethod(renderer, "renderMarkdown", "renderer");
  requiredMethod(renderer, "renderArtifact", "renderer");
  if (cursorStore !== undefined) requiredMethod(cursorStore, "save", "cursorStore");
  if (typeof credentialSaver !== "function") throw new TypeError("credentialSaver must be a function");
  if (typeof confirmThreadDeletion !== "function") {
    throw new TypeError("confirmThreadDeletion must be a function");
  }
  if (typeof canonicalizeImage !== "function" || typeof createObjectUrl !== "function"
      || typeof revokeObjectUrl !== "function") {
    throw new TypeError("browser image handlers must be functions");
  }
  const updateHandoffStore = suppliedUpdateHandoffStore
    ?? createBrowserUpdateHandoffStore();
  for (const method of ["save", "take", "discard"]) {
    requiredMethod(updateHandoffStore, method, "updateHandoffStore");
  }
  const workerScope = normalizedBrowserPath(
    serviceWorkerScope ?? metaContent(document, "lazying-agent-base-path") ?? "/",
    "serviceWorkerScope",
    { trailingSlash: true },
  );
  const expectedWorkerPath = workerScope === "/" ? "/sw.js" : `${workerScope.slice(0, -1)}/sw.js`;
  const workerPath = normalizedBrowserPath(
    serviceWorkerPath ?? metaContent(document, "lazying-agent-service-worker") ?? expectedWorkerPath,
    "serviceWorkerPath",
  );
  if (workerPath !== expectedWorkerPath) throw new TypeError("serviceWorkerPath must be bound to serviceWorkerScope");
  const claimedUpdateHandoff = captureUpdateHandoffClaim(window);
  const declaredRelease = metaContent(document, "lazying-agent-release");
  const currentRelease = validAgentRelease(declaredRelease) ? declaredRelease : null;
  if (!Number.isSafeInteger(updateCheckIntervalMs) || updateCheckIntervalMs < 60_000 || updateCheckIntervalMs > 86_400_000) {
    throw new TypeError("updateCheckIntervalMs must be from one minute through one day");
  }
  if (!Number.isSafeInteger(updateDeferralMs) || updateDeferralMs < 60_000 || updateDeferralMs > 86_400_000) {
    throw new TypeError("updateDeferralMs must be from one minute through one day");
  }
  if (!Number.isSafeInteger(activationTimeoutMs) || activationTimeoutMs < 5_000 || activationTimeoutMs > 300_000) {
    throw new TypeError("activationTimeoutMs must be from five seconds through five minutes");
  }
  if (!Number.isSafeInteger(attachmentDecodeTimeoutMs) || attachmentDecodeTimeoutMs < 1
      || attachmentDecodeTimeoutMs > 60_000) {
    throw new TypeError("attachmentDecodeTimeoutMs must be from one millisecond through one minute");
  }
  if (!Number.isSafeInteger(attachmentMemoryLimitBytes) || attachmentMemoryLimitBytes < 1
      || attachmentMemoryLimitBytes > 32 * 1024 * 1024) {
    throw new TypeError("attachmentMemoryLimitBytes must be from one byte through 32 MiB");
  }
  if (!Number.isSafeInteger(attachmentDecodedMemoryLimitBytes) || attachmentDecodedMemoryLimitBytes < 1
      || attachmentDecodedMemoryLimitBytes > 64 * 1024 * 1024) {
    throw new TypeError("attachmentDecodedMemoryLimitBytes must be from one byte through 64 MiB");
  }
  if (typeof now !== "function") throw new TypeError("now must be a function");
  if (!Number.isSafeInteger(maxStreamBackoffSteps) || maxStreamBackoffSteps < 0 || maxStreamBackoffSteps > 20) {
    throw new TypeError("maxStreamBackoffSteps must be an integer from 0 through 20");
  }
  if (typeof wait !== "function") throw new TypeError("wait must be a function");
  const elements = elementMap(document);
  const state = {
    initialized: false,
    bound: false,
    loginReady: false,
    loginPending: false,
    logoutPending: false,
    session: Object.freeze({ authenticated: false }),
    capabilities: FAIL_CLOSED_AGENT_CAPABILITIES,
    chatCapabilities: Object.freeze({ visionInput: false, visionMediaTypes: Object.freeze([]), maximumImageBytes: 0 }),
    agent: null,
    chat: null,
    mode: "chat",
    agentThreads: [],
    chatThreads: [],
    chatThreadListEpoch: 0,
    agentThreadId: null,
    chatThreadId: null,
    chatThread: null,
    chatGeneration: null,
    chatAfterSequence: 0,
    chatOutput: "",
    chatPendingSend: null,
    chatPendingDeletion: null,
    chatFinalization: null,
    chatHistoryRestoration: null,
    chatFailureDiagnostic: null,
    authRecoveryPending: false,
    authRecoveryUsername: null,
    authRecoveryWorkflow: null,
    authRecoveryGeneration: null,
    selectedImages: Object.freeze([]),
    selectedImageUrls: Object.freeze([]),
    imagePreparing: false,
    imagePreparationAbort: null,
    imageSelectionEpoch: 0,
    imageRenderEpoch: 0,
    messageImageUrls: new Set(),
    localMessageImageUrls: new Set(),
    attachmentBlobCache: new Map(),
    attachmentBlobCacheBytes: 0,
    renderedAttachmentPreviews: new Map(),
    renderedAttachmentPreviewBytes: 0,
    attachmentRestoreObserver: undefined,
    attachmentRestoreObserved: new Map(),
    attachmentRestoreQueue: [],
    attachmentRestoreActive: 0,
    attachmentRestoreControllers: new Set(),
    runId: null,
    agentRunStatus: null,
    presentation: null,
    assistantNode: null,
    agentRunMessages: new Map(),
    agentHistoryRestoring: false,
    agentReplayValidating: false,
    agentReplayFailed: false,
    agentReplayOfferResume: true,
    agentCancelPending: false,
    agentPendingResume: null,
    streamAbort: null,
    streamKind: null,
    viewEpoch: 0,
    busy: false,
    installPrompt: null,
    updateRegistration: null,
    updateDeferredUntil: Number.NEGATIVE_INFINITY,
    updateDeferredWorker: null,
    updateDeferralTimer: null,
    updateActivationTimer: null,
    showUpdatePrompt: null,
    updateConfirmed: false,
    updateConfirmedWorker: null,
    updateOfferedWorker: null,
    updateControllerChanged: false,
    updateController: null,
    updateTargetRelease: null,
    updateKnownWorkerReleases: new WeakMap(),
    updateObservedWaitingWorkers: new WeakSet(),
    updateActiveControllerRelease: null,
    retryUpdateControllerRelease: null,
    updateReleaseQueries: new Map(),
    updateReleaseTimer: null,
    updateSafetyTimer: null,
    updatePollTimer: null,
    updateReloaded: false,
    updateHandoffConsumed: false,
    updateHandoffEpoch: 0,
    updateHandoffInFlight: false,
    updateHandoffStagingClaim: null,
    updatePreparedHandoff: null,
    updateCheckAt: Number.NEGATIVE_INFINITY,
    updateFailureAt: Number.NEGATIVE_INFINITY,
    updateCheckInFlight: false,
    updateCheckPending: false,
    updateCheckPendingOnlineTransition: false,
  };

  function showToast(message) {
    elements.toast.textContent = String(message).slice(0, 400);
    elements.toast.hidden = false;
    window?.setTimeout?.(() => { elements.toast.hidden = true; }, 4_000);
  }

  function connection(label, online = true) {
    elements.connection_state.textContent = label;
    elements.connection_state.dataset.online = online ? "true" : "false";
  }

  function clearChatFailureDiagnostic() {
    state.chatFailureDiagnostic = null;
    for (const key of ["failureStage", "failureCode", "failureOperation"]) {
      delete elements.connection_state.dataset[key];
      delete elements.workspace.dataset[key];
    }
  }

  function applyChatFailureDiagnostic(error) {
    const diagnostic = chatFailureDiagnostic(error);
    state.chatFailureDiagnostic = diagnostic;
    for (const target of [elements.connection_state, elements.workspace]) {
      target.dataset.failureStage = diagnostic.stage;
      target.dataset.failureCode = diagnostic.code;
      target.dataset.failureOperation = diagnostic.operation;
    }
    connection(`Request not sent · ${diagnostic.label}`, false);
    return diagnostic;
  }

  function loginControl({ ready, label }) {
    state.loginReady = ready === true;
    elements.login_submit.disabled = !state.loginReady;
    elements.login_submit.textContent = String(label);
    elements.login_form.setAttribute("aria-busy", state.loginReady ? "false" : "true");
  }

  function showLogin(message = "", { preservePassword = false } = {}) {
    elements.login_view.hidden = false;
    elements.app_view.hidden = true;
    elements.logout.disabled = true;
    elements.login_error.textContent = message;
    elements.login_error.hidden = !message;
    if (!preservePassword) elements.password.value = "";
  }

  function showApp() {
    elements.login_view.hidden = true;
    elements.app_view.hidden = false;
    elements.signed_in_user.textContent = state.session.username;
    elements.login_error.hidden = true;
  }

  function captureChatReadRecovery({
    threadId = state.chatThreadId ?? state.chatGeneration?.threadId ?? null,
    generationId = state.chatGeneration?.generationId ?? null,
  } = {}) {
    if (typeof threadId !== "string" || threadId.length < 1) return null;
    const generation = state.chatGeneration?.generationId === generationId ? state.chatGeneration : null;
    return Object.freeze({
      threadId,
      thread: state.chatThread?.threadId === threadId ? state.chatThread : null,
      generationId: typeof generationId === "string" && generationId.length > 0 ? generationId : null,
      generation,
      afterSequence: Number.isSafeInteger(state.chatAfterSequence) && state.chatAfterSequence >= 0
        ? state.chatAfterSequence
        : 0,
      output: typeof state.chatOutput === "string" ? state.chatOutput : "",
    });
  }

  function requireFreshAuthentication({ workflow = null, generationRecovery = null } = {}) {
    if (!state.session.authenticated) return false;
    const recoveryUsername = normalizedSessionUsername(state.session.username);
    if (state.imagePreparing) cancelImagePreparation();
    state.viewEpoch += 1;
    state.streamAbort?.abort();
    clearConversation();
    purgeAttachmentBlobCache();
    state.streamAbort = null;
    state.streamKind = null;
    state.session = Object.freeze({ authenticated: false });
    state.agent = null;
    state.chat = null;
    state.capabilities = FAIL_CLOSED_AGENT_CAPABILITIES;
    state.chatCapabilities = Object.freeze({ visionInput: false, visionMediaTypes: Object.freeze([]), maximumImageBytes: 0 });
    state.agentThreads = [];
    state.chatThreadListEpoch += 1;
    state.chatThreads = [];
    state.agentThreadId = null;
    state.chatThreadId = null;
    state.chatThread = null;
    state.chatGeneration = null;
    state.chatPendingSend = workflow;
    state.chatPendingDeletion = null;
    state.chatFinalization = null;
    state.runId = null;
    state.agentRunStatus = null;
    state.mode = "chat";
    state.authRecoveryPending = true;
    state.authRecoveryUsername = recoveryUsername;
    state.authRecoveryWorkflow = workflow;
    state.authRecoveryGeneration = generationRecovery;
    elements.resume_run.hidden = workflow === null;
    elements.logout.disabled = true;
    showLogin(generationRecovery !== null
      ? "Your session expired. Sign in again to reconnect to the server-owned generation; your draft and image are preserved."
      : "Your session expired. Sign in again; your unsent draft and image are preserved.");
    loginControl({ ready: true, label: "Sign in" });
    return true;
  }

  function recoverChatReadAuthentication(error, recovery) {
    return isChatAuthenticationRejection(error)
      && requireFreshAuthentication({ workflow: null, generationRecovery: recovery });
  }

  function renderSelectedImages() {
    const first = state.selectedImages[0];
    elements.image_preview_thumbnail.src = state.selectedImageUrls[0] ?? "";
    if (first === undefined) {
      elements.image_preview_label.textContent = "";
      elements.image_preview.hidden = true;
      return;
    }
    const bytes = state.selectedImages.reduce((total, image) => total + image.byteLength, 0);
    elements.image_preview_label.textContent = state.selectedImages.length === 1
      ? `${first.width}×${first.height} · ${Math.ceil(bytes / 1024)} KiB`
      : `${state.selectedImages.length} images · ${Math.ceil(bytes / 1024)} KiB total`;
    elements.image_preview.hidden = false;
  }

  function cancelImagePreparation() {
    state.imageSelectionEpoch += 1;
    state.imagePreparationAbort?.abort();
    state.imagePreparationAbort = null;
    state.imagePreparing = false;
    elements.image_input.value = "";
    renderSelectedImages();
  }

  function detachSelectedImage() {
    invalidatePreparedUpdateHandoff();
    cancelImagePreparation();
    const detached = state.selectedImages.length === 0 ? null : Object.freeze({
      selected: state.selectedImages,
      previewUrls: state.selectedImageUrls,
    });
    state.selectedImages = Object.freeze([]);
    state.selectedImageUrls = Object.freeze([]);
    elements.image_input.value = "";
    elements.image_preview_thumbnail.src = "";
    elements.image_preview_label.textContent = "";
    elements.image_preview.hidden = true;
    return detached;
  }

  function disposeDetachedImage(detached) {
    for (const previewUrl of detached?.previewUrls ?? []) revokeObjectUrl(previewUrl);
  }

  function clearSelectedImage() {
    disposeDetachedImage(detachSelectedImage());
  }

  function restoreDetachedImage(detached) {
    if (!detached || state.selectedImages.length !== 0 || !state.session.authenticated
        || state.mode !== "chat" || state.chatCapabilities.visionInput !== true) {
      disposeDetachedImage(detached);
      return false;
    }
    state.selectedImages = detached.selected;
    state.selectedImageUrls = detached.previewUrls;
    renderSelectedImages();
    return true;
  }

  function interactionLocked() {
    return state.busy || state.logoutPending || state.chatFinalization !== null
      || state.chatHistoryRestoration !== null
      || state.authRecoveryGeneration !== null
      || state.agentHistoryRestoring || state.agentReplayValidating || state.agentCancelPending
      || state.agentPendingResume !== null;
  }

  function updateImageControl() {
    const available = state.session.authenticated && state.mode === "chat"
      && state.chatCapabilities.visionInput === true;
    const pendingChatSend = state.mode === "chat" && state.chatPendingSend !== null;
    const pendingChatDeletion = state.mode === "chat" && state.chatPendingDeletion !== null;
    const locked = interactionLocked();
    const pendingAgentResume = state.mode === "agent" && state.agentPendingResume !== null;
    const preservingAuthenticationDraft = state.authRecoveryPending && state.selectedImages.length > 0;
    const preservingAmbiguousImage = state.chatPendingSend?.ambiguousMutation !== null
      && state.chatPendingSend?.ambiguousMutation !== undefined
      && state.selectedImages.length > 0;
    const fencedImage = preservingAuthenticationDraft || preservingAmbiguousImage;
    if (!available && !fencedImage && (state.imagePreparing || state.selectedImages.length > 0)) clearSelectedImage();
    elements.add_image.hidden = !available;
    elements.add_image.textContent = state.imagePreparing ? "Preparing images…" : "Images";
    elements.add_image.setAttribute(
      "aria-label",
      state.imagePreparing ? "Preparing images…" : "Add images",
    );
    elements.add_image.disabled = !available || locked || state.imagePreparing || pendingChatSend || pendingChatDeletion
      || state.selectedImages.length >= COMPOSER_IMAGE_COUNT_LIMIT;
    elements.remove_image.disabled = (!available && !preservingAuthenticationDraft) || locked || pendingChatSend
      || pendingChatDeletion
      || (state.selectedImages.length === 0 && !state.imagePreparing);
    elements.message_input.disabled = !state.session.authenticated || (locked && !pendingAgentResume)
      || state.imagePreparing || pendingChatSend
      || pendingChatDeletion
      || preservingAuthenticationDraft;
    elements.send_message.disabled = !state.session.authenticated || locked || state.imagePreparing || pendingChatSend
      || pendingChatDeletion
      || preservingAuthenticationDraft;
    elements.new_thread.disabled = !state.session.authenticated || locked || pendingChatSend || pendingChatDeletion
      || preservingAuthenticationDraft;
    elements.agent_mode.disabled = !state.session.authenticated || !state.capabilities.enabled || locked
      || pendingChatDeletion || preservingAuthenticationDraft;
    elements.chat_mode.disabled = !state.session.authenticated || locked || pendingChatDeletion
      || preservingAuthenticationDraft;
    elements.composer.setAttribute("aria-busy", locked || state.imagePreparing || pendingChatSend || pendingChatDeletion
      ? "true" : "false");
    elements.workspace.setAttribute("aria-busy", state.chatFinalization === null ? "false" : "true");
    for (const row of elements.thread_list.children ?? []) {
      const buttons = row.className === "thread-row" ? row.children : [row];
      for (const button of buttons) {
        button.disabled = locked || pendingChatSend || button.dataset.threadBlocked === "true"
          || (pendingChatDeletion && button.dataset.threadDeleteRetry !== "true");
      }
    }
    scheduleSafeUpdateReload();
  }

  function currentThreads() {
    return state.mode === "agent" ? state.agentThreads : state.chatThreads;
  }

  function currentThreadId() {
    return state.mode === "agent" ? state.agentThreadId : state.chatThreadId;
  }

  function setMode(mode, { restoreView = true, remember = true } = {}) {
    const agentAvailable = state.capabilities.enabled === true;
    const nextMode = mode === "agent" && agentAvailable ? "agent" : "chat";
    const changed = nextMode !== state.mode;
    if (changed && interactionLocked()) return;
    if (changed && state.mode === "chat" && state.chatPendingDeletion) {
      showToast("Confirm the pending conversation deletion before changing modes.");
      return;
    }
    if (changed && state.mode === "chat" && state.chatPendingSend) {
      showToast("Confirm the pending durable send with Resume before changing modes.");
      return;
    }
    if (changed) {
      state.viewEpoch += 1;
      state.streamAbort?.abort();
    }
    state.mode = nextMode;
    if (remember && state.session.authenticated) rememberWorkspaceMode(state.mode);
    elements.workspace.dataset.mode = state.mode;
    elements.mode_switch.hidden = !agentAvailable;
    elements.agent_mode.setAttribute("aria-pressed", state.mode === "agent" ? "true" : "false");
    elements.chat_mode.setAttribute("aria-pressed", state.mode === "chat" ? "true" : "false");
    elements.activity_panel.hidden = state.mode !== "agent";
    const sendLabel = state.mode === "agent" ? "Run Agent" : "Send Chat";
    elements.send_message.textContent = sendLabel;
    elements.send_message.setAttribute("aria-label", sendLabel);
    elements.welcome_eyebrow.textContent = state.mode === "agent" ? "AgInTi Agent" : "Direct LocalLLM chat";
    elements.welcome_copy.textContent = state.mode === "agent"
      ? "AgInTi owns planning, tools, context, compaction, runs, and artifacts."
      : "Durable server-owned conversations with LocalLLM, without Agent tools or browser-owned history.";
    elements.message_input.placeholder = state.mode === "agent" ? "Ask AgInTi Agent" : "Message LocalLLM";
    updateImageControl();
    renderThreads();
    if (changed && restoreView && state.session.authenticated) void restoreModeView({ autoOpen: true });
  }

  function resetAttachmentRestorations({ deferQueued = false } = {}) {
    state.attachmentRestoreObserver?.disconnect?.();
    state.attachmentRestoreObserver = undefined;
    state.attachmentRestoreObserved.clear();
    const queued = deferQueued ? [...state.attachmentRestoreQueue] : [];
    state.attachmentRestoreQueue.length = 0;
    for (const controller of state.attachmentRestoreControllers) controller.abort();
    for (const job of queued) deferAttachmentRestorationJob(job);
  }

  function purgeAttachmentBlobCache() {
    for (const key of [...state.attachmentBlobCache.keys()]) forgetAttachmentBlob(key);
  }

  function purgeAttachmentBlobCacheForThread(threadId) {
    for (const [key, entry] of [...state.attachmentBlobCache.entries()]) {
      if (entry.threadId === threadId) forgetAttachmentBlob(key);
    }
  }

  function deferAttachmentRestorationJob(job) {
    job.image.src = "";
    job.image.hidden = true;
    job.image.alt = "Attached image preview not loaded";
    job.image.dataset.previewState = "deferred";
    job.status.textContent = "Load attached image preview again";
    job.status.hidden = false;
    job.status.disabled = false;
    job.article.dataset.attachmentState = "deferred";
    job.started = false;
  }

  function deferRenderedAttachmentPreview(entry) {
    deferAttachmentRestorationJob(entry.job);
  }

  function forgetRenderedAttachmentPreview(key, { defer = true, expectedUrl } = {}) {
    const entry = state.renderedAttachmentPreviews.get(key);
    if (entry === undefined || (expectedUrl !== undefined && entry.url !== expectedUrl)) return false;
    state.renderedAttachmentPreviews.delete(key);
    state.renderedAttachmentPreviewBytes -= entry.decodedBytes;
    if (state.messageImageUrls.delete(entry.url)) revokeObjectUrl(entry.url);
    if (defer) deferRenderedAttachmentPreview(entry);
    return true;
  }

  function installRenderedAttachmentPreview(key, { url, image, article, status, job, attachment }) {
    const decodedBytes = attachment.width * attachment.height * 4;
    if (!Number.isSafeInteger(decodedBytes) || decodedBytes < 1
        || decodedBytes > attachmentDecodedMemoryLimitBytes) return false;
    forgetRenderedAttachmentPreview(key);
    while (state.renderedAttachmentPreviews.size >= ATTACHMENT_RENDERED_PREVIEW_LIMIT
        || state.renderedAttachmentPreviewBytes + decodedBytes > attachmentDecodedMemoryLimitBytes) {
      const oldestKey = state.renderedAttachmentPreviews.keys().next().value;
      if (oldestKey === undefined) break;
      forgetRenderedAttachmentPreview(oldestKey);
    }
    state.renderedAttachmentPreviews.set(key, {
      url, image, article, status, job, decodedBytes,
    });
    state.renderedAttachmentPreviewBytes += decodedBytes;
    state.messageImageUrls.add(url);
    return true;
  }

  function revokeRenderedAttachmentUrls() {
    for (const key of [...state.renderedAttachmentPreviews.keys()]) {
      forgetRenderedAttachmentPreview(key, { defer: false });
    }
    for (const url of state.messageImageUrls) revokeObjectUrl(url);
    state.messageImageUrls.clear();
    state.localMessageImageUrls.clear();
  }

  function purgeAttachmentMemory() {
    resetAttachmentRestorations();
    state.imageRenderEpoch += 1;
    revokeRenderedAttachmentUrls();
    purgeAttachmentBlobCache();
  }

  function attachmentBlobCacheKey(threadId, attachment) {
    return JSON.stringify([threadId, attachment.attachmentId, attachment.sha256]);
  }

  function cachedAttachmentBlob(key, threadId, attachment) {
    const entry = state.attachmentBlobCache.get(key);
    if (entry === undefined) return null;
    if (entry.threadId !== threadId || entry.mediaType !== attachment.mediaType || entry.byteLength !== attachment.byteLength
        || entry.width !== attachment.width || entry.height !== attachment.height) {
      forgetAttachmentBlob(key);
      return null;
    }
    state.attachmentBlobCache.delete(key);
    state.attachmentBlobCache.set(key, entry);
    return entry.blob;
  }

  function forgetAttachmentBlob(key) {
    const entry = state.attachmentBlobCache.get(key);
    if (entry === undefined) return;
    state.attachmentBlobCache.delete(key);
    state.attachmentBlobCacheBytes -= entry.byteLength;
    forgetRenderedAttachmentPreview(key);
  }

  function rememberAttachmentBlob(key, threadId, blob, attachment) {
    if (!(blob instanceof Blob) || blob.size < 1 || blob.size > attachmentMemoryLimitBytes) return false;
    forgetAttachmentBlob(key);
    while (state.attachmentBlobCacheBytes + blob.size > attachmentMemoryLimitBytes) {
      const oldestKey = state.attachmentBlobCache.keys().next().value;
      if (oldestKey === undefined) break;
      forgetAttachmentBlob(oldestKey);
    }
    state.attachmentBlobCache.set(key, Object.freeze({
      threadId,
      blob,
      byteLength: blob.size,
      mediaType: attachment.mediaType,
      width: attachment.width,
      height: attachment.height,
    }));
    state.attachmentBlobCacheBytes += blob.size;
    return true;
  }

  function drainAttachmentRestorations() {
    while (state.attachmentRestoreActive < ATTACHMENT_RESTORE_CONCURRENCY
        && state.attachmentRestoreQueue.length > 0) {
      const job = state.attachmentRestoreQueue.shift();
      const controller = new AbortController();
      state.attachmentRestoreActive += 1;
      state.attachmentRestoreControllers.add(controller);
      void Promise.resolve()
        .then(() => job.restore(controller.signal))
        .catch(() => { /* restoreMessageAttachment owns its visible failure state. */ })
        .finally(() => {
          state.attachmentRestoreControllers.delete(controller);
          state.attachmentRestoreActive -= 1;
          if (job.image.dataset.previewState === "loading") deferAttachmentRestorationJob(job);
          drainAttachmentRestorations();
        });
    }
  }

  function startAttachmentRestoration(job) {
    if (job.started || state.chatPendingSend !== null) return;
    job.started = true;
    state.attachmentRestoreObserver?.unobserve?.(job.observedTarget);
    state.attachmentRestoreObserved.delete(job.observedTarget);
    job.image.dataset.previewState = "loading";
    job.article.dataset.attachmentState = "loading";
    job.status.textContent = "Loading attached image…";
    job.status.disabled = true;
    state.attachmentRestoreQueue.push(job);
    drainAttachmentRestorations();
  }

  function attachmentObserver() {
    if (state.attachmentRestoreObserver !== undefined) return state.attachmentRestoreObserver;
    const Observer = window?.IntersectionObserver;
    if (typeof Observer !== "function") {
      state.attachmentRestoreObserver = null;
      return null;
    }
    try {
      state.attachmentRestoreObserver = new Observer((entries) => {
        for (const entry of entries ?? []) {
          if (entry?.isIntersecting !== true && !(Number(entry?.intersectionRatio) > 0)) continue;
          const job = state.attachmentRestoreObserved.get(entry.target);
          if (job) startAttachmentRestoration(job);
        }
      }, { root: null, rootMargin: "480px 0px", threshold: 0.01 });
    } catch {
      state.attachmentRestoreObserver = null;
    }
    return state.attachmentRestoreObserver;
  }

  function scheduleAttachmentRestoration(job, { observe = true } = {}) {
    job.status.addEventListener("click", () => startAttachmentRestoration(job));
    if (!observe) return;
    const observer = attachmentObserver();
    if (observer === null) {
      startAttachmentRestoration(job);
      return;
    }
    state.attachmentRestoreObserved.set(job.observedTarget, job);
    try { observer.observe(job.observedTarget); }
    catch { startAttachmentRestoration(job); }
  }

  function clearConversation() {
    resetAttachmentRestorations();
    state.imageRenderEpoch += 1;
    revokeRenderedAttachmentUrls();
    elements.messages.replaceChildren();
    elements.agent_plan.replaceChildren();
    elements.agent_timeline.replaceChildren();
    elements.agent_artifacts.replaceChildren();
    elements.agent_artifacts.hidden = true;
    elements.context_indicator.hidden = true;
    elements.welcome.hidden = false;
    elements.run_state.textContent = "Idle";
    elements.workspace.dataset.status = "idle";
    elements.stop_run.hidden = true;
    elements.resume_run.hidden = true;
    state.presentation = null;
    state.assistantNode = null;
    state.agentRunMessages.clear();
    state.agentHistoryRestoring = false;
    state.agentReplayValidating = false;
    state.agentReplayOfferResume = true;
    state.agentCancelPending = false;
  }

  function fenceAttachmentRestorationsForSend() {
    state.imageRenderEpoch += 1;
    resetAttachmentRestorations({ deferQueued: true });
  }

  function restoredImageIsCurrent({ chat, expectedEpoch, expectedImageEpoch }) {
    return state.chat === chat && state.viewEpoch === expectedEpoch
      && state.imageRenderEpoch === expectedImageEpoch;
  }

  function waitForImageDecode(image, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    let readiness;
    if (typeof image.decode === "function") readiness = Promise.resolve().then(() => image.decode());
    else if (image.complete === true) {
      readiness = Number(image.naturalWidth) > 0
        ? Promise.resolve()
        : Promise.reject(new TypeError("restored image did not decode"));
    } else {
      readiness = new Promise((resolve, reject) => {
        image.addEventListener("load", resolve, { once: true });
        image.addEventListener("error", () => reject(new TypeError("restored image did not load")), { once: true });
      });
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (handler, value) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        signal?.removeEventListener?.("abort", aborted);
        handler(value);
      };
      const aborted = () => finish(reject, signal.reason ?? new DOMException("aborted", "AbortError"));
      const timer = globalThis.setTimeout(() => {
        finish(reject, new TypeError("restored image decode timed out"));
      }, attachmentDecodeTimeoutMs);
      signal?.addEventListener?.("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
      readiness.then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error),
      );
    });
  }

  async function restoreMessageAttachment({
    article, image, status, job, threadId, attachment,
    readyAlt = "Attached image",
    expectedEpoch = state.viewEpoch,
    expectedImageEpoch = state.imageRenderEpoch,
    chat = state.chat,
    signal,
  }) {
    const current = () => restoredImageIsCurrent({ chat, expectedEpoch, expectedImageEpoch });
    const cacheKey = attachmentBlobCacheKey(threadId, attachment);
    const unavailable = () => {
      image.src = "";
      image.hidden = true;
      image.alt = "Attached image preview unavailable";
      image.dataset.previewState = "unavailable";
      status.textContent = "Attached image preview unavailable";
      status.hidden = false;
      status.disabled = true;
      article.dataset.attachmentState = "unavailable";
    };
    let url = null;
    try {
      if (!current()) return "stale";
      let blob = cachedAttachmentBlob(cacheKey, threadId, attachment);
      if (blob === null) {
        const { bytes, descriptor } = await chat.getAttachment({ threadId, attachment, signal });
        if (!current()) return "stale";
        if (!(bytes instanceof Uint8Array) || bytes.byteLength !== attachment.byteLength
            || descriptor.attachmentId !== attachment.attachmentId
            || descriptor.mediaType !== attachment.mediaType
            || descriptor.byteLength !== attachment.byteLength
            || descriptor.width !== attachment.width || descriptor.height !== attachment.height
            || descriptor.sha256 !== attachment.sha256) {
          throw new DirectChatProtocolError("Direct Chat attachment verification result is inconsistent");
        }
        blob = new Blob([bytes], { type: descriptor.mediaType });
        if (!rememberAttachmentBlob(cacheKey, threadId, blob, attachment)) {
          throw new TypeError("attached image exceeds the compressed preview memory limit");
        }
      }
      if (!current()) return "stale";
      url = createObjectUrl(blob);
      if (!installRenderedAttachmentPreview(cacheKey, {
        url, image, article, status, job, attachment,
      })) {
        revokeObjectUrl(url);
        url = null;
        throw new TypeError("attached image exceeds the decoded preview memory limit");
      }
      // Viewport admission and the one-at-a-time restoration queue already
      // provide the lazy-loading bound. Chrome can indefinitely defer decode()
      // for a hidden loading="lazy" image, especially in iOS-sized PWA views,
      // so make the admitted private Blob eager before waiting for its decode.
      image.loading = "eager";
      image.src = url;
      await waitForImageDecode(image, signal);
      if (!current()) {
        forgetRenderedAttachmentPreview(cacheKey, { defer: false, expectedUrl: url });
        return "stale";
      }
      image.alt = readyAlt;
      image.hidden = false;
      image.dataset.previewState = "ready";
      status.hidden = true;
      status.disabled = true;
      article.dataset.attachmentState = "ready";
      return "ready";
    } catch (error) {
      if (url !== null) forgetRenderedAttachmentPreview(cacheKey, { defer: false, expectedUrl: url });
      if (!current()) return "stale";
      if (recoverChatReadAuthentication(error, captureChatReadRecovery({ threadId }))) return "stale";
      forgetAttachmentBlob(cacheKey);
      unavailable();
      return "unavailable";
    }
  }

  function messageNode(role, content, {
    runId, attachment, attachments, threadId, localAttachment, localAttachments, attachmentReadyTasks,
  } = {}) {
    const article = document.createElement("article");
    article.className = "message";
    article.dataset.role = role;
    if (runId) article.dataset.runId = runId;
    const localImages = localAttachments ?? (localAttachment === undefined ? [] : [localAttachment]);
    const storedImages = attachments ?? (attachment === undefined ? [] : [attachment]);
    const displayImages = localImages.length > 0 ? localImages : storedImages;
    if (role === "user" && displayImages.length > 0
        && (localImages.length > 0 || (threadId && state.chat))) {
      const gallery = displayImages.length > 1 ? document.createElement("div") : null;
      if (gallery !== null) {
        gallery.className = "message-attachments";
        article.appendChild(gallery);
      }
      for (const [index, displayedAttachment] of displayImages.entries()) {
        const imageParent = gallery === null ? article : document.createElement("div");
        if (gallery !== null) {
          imageParent.className = "message-attachment-item";
          gallery.appendChild(imageParent);
        }
        const image = document.createElement("img");
        image.className = "message-attachment";
        const readyAlt = displayImages.length === 1 ? "Attached image" : `Attached image ${index + 1}`;
        image.alt = readyAlt;
        image.loading = "lazy";
        image.decoding = "async";
        imageParent.appendChild(image);
        if (localImages.length > 0) {
          const previewBlob = displayedAttachment.previewBlob instanceof Blob
            ? displayedAttachment.previewBlob
            : new Blob([displayedAttachment.bytes], { type: displayedAttachment.mediaType });
          const url = createObjectUrl(previewBlob);
          state.messageImageUrls.add(url);
          state.localMessageImageUrls.add(url);
          image.src = url;
          image.dataset.previewState = "local";
          article.dataset.attachmentState = "local";
        } else {
          image.hidden = true;
          image.alt = "Attached image preview not loaded";
          image.dataset.previewState = "deferred";
          article.dataset.attachmentState = "deferred";
          const status = document.createElement("button");
          status.type = "button";
          status.className = "message-attachment-status muted";
          status.textContent = "Load attached image preview";
          status.setAttribute("aria-label", "Load attached image preview");
          imageParent.appendChild(status);
          const restorationOwner = Object.freeze({
            expectedEpoch: state.viewEpoch,
            chat: state.chat,
          });
          const job = {
            article,
            observedTarget: imageParent,
            image,
            status,
            started: false,
            restore: (signal) => restoreMessageAttachment({
              article,
              image,
              status,
              job,
              threadId,
              attachment: displayedAttachment,
              readyAlt,
              signal,
              expectedImageEpoch: state.imageRenderEpoch,
              ...restorationOwner,
            }),
          };
          const restoration = (options) => scheduleAttachmentRestoration(job, options);
          if (Array.isArray(attachmentReadyTasks)) attachmentReadyTasks.push(restoration);
          else void restoration();
        }
      }
    }
    const body = document.createElement("div");
    body.className = "message-content";
    renderer.renderMarkdown(body, content);
    article.appendChild(body);
    if (role === "assistant" && runId && state.mode === "agent") {
      const artifacts = document.createElement("div");
      artifacts.className = "message-artifacts";
      artifacts.hidden = true;
      article.appendChild(artifacts);
      state.agentRunMessages.set(runId, Object.freeze({ body, artifacts, persistedContent: content }));
    }
    elements.messages.appendChild(article);
    elements.welcome.hidden = true;
    return body;
  }

  function renderThreads() {
    elements.thread_list.replaceChildren();
    const mode = state.mode;
    const selected = currentThreadId();
    const pendingDeletion = mode === "chat" ? state.chatPendingDeletion : null;
    currentThreads().forEach((thread) => {
      const threadId = mode === "agent" ? thread.id : thread.threadId;
      const title = thread.title || "New conversation";
      const open = makeButton(document, title, () => { void openThread(threadId, { mode }); });
      open.className = "thread-open";
      open.disabled = interactionLocked() || (mode === "chat"
        && (state.chatPendingSend !== null || pendingDeletion !== null));
      open.dataset.threadId = threadId;
      open.dataset.mode = mode;
      open.setAttribute("aria-current", threadId === selected ? "true" : "false");
      if (mode === "agent") {
        elements.thread_list.appendChild(open);
        return;
      }
      const row = document.createElement("div");
      row.className = "thread-row";
      row.dataset.threadId = threadId;
      row.dataset.mode = "chat";
      const retryingDeletion = pendingDeletion?.threadId === threadId
        && pendingDeletion.session === state.session && pendingDeletion.chat === state.chat;
      const remove = makeButton(document, retryingDeletion ? "Retry" : "Delete", () => {
        void deleteChatThread(threadId);
      });
      remove.className = "thread-delete";
      remove.setAttribute("aria-label", `${retryingDeletion ? "Retry deleting" : "Delete"} ${title}`);
      remove.setAttribute("title", `${retryingDeletion ? "Retry deleting" : "Delete"} ${title}`);
      remove.dataset.threadDeleteRetry = retryingDeletion ? "true" : "false";
      remove.dataset.threadBlocked = thread.currentGenerationId !== null
        || (pendingDeletion !== null && !retryingDeletion) ? "true" : "false";
      remove.disabled = interactionLocked() || state.chatPendingSend !== null
        || thread.currentGenerationId !== null || (pendingDeletion !== null && !retryingDeletion);
      row.appendChild(open);
      row.appendChild(remove);
      elements.thread_list.appendChild(row);
    });
  }

  function focusThreadDeleteControl(threadId) {
    const row = [...(elements.thread_list.children ?? [])]
      .find((entry) => entry.dataset?.threadId === threadId);
    row?.children?.[1]?.focus?.();
  }

  function focusAfterThreadDeletion(previousIndex) {
    const rows = [...(elements.thread_list.children ?? [])];
    if (rows.length === 0) {
      elements.new_thread.focus?.();
      return;
    }
    const row = rows[Math.min(Math.max(previousIndex, 0), rows.length - 1)];
    const open = row.className === "thread-row" ? row.children?.[0] : row;
    open?.focus?.();
  }

  function focusSoon(operation) {
    Promise.resolve().then(operation);
  }

  async function loadAgentThreads() {
    if (!state.capabilities.enabled) {
      state.agentThreads = [];
      if (state.mode === "agent") renderThreads();
      return;
    }
    const session = state.session;
    const agent = state.agent;
    const response = await agent.listThreads({ limit: 100, before: "" });
    if (state.session !== session || state.agent !== agent) return;
    state.agentThreads = [...response.threads];
    if (state.mode === "agent") renderThreads();
  }

  async function loadChatThreads({ prefetched = null } = {}) {
    const session = state.session;
    const chat = state.chat;
    const listEpoch = ++state.chatThreadListEpoch;
    let response;
    if (prefetched?.session === session && prefetched.chat === chat) {
      const result = await prefetched.result;
      if (!result.succeeded) throw result.error;
      response = result.response;
    } else {
      response = await chat.listThreads({ limit: 100 });
    }
    if (state.session !== session || state.chat !== chat || state.chatThreadListEpoch !== listEpoch) return;
    state.chatThreads = [...response.threads];
    if (state.mode === "chat") renderThreads();
  }

  function renderAgentArtifacts(target, artifacts) {
    target.replaceChildren();
    target.hidden = artifacts.length === 0;
    artifacts.forEach((artifact) => {
      const section = document.createElement("section");
      section.className = "artifact";
      const heading = document.createElement("h3");
      heading.textContent = artifact.title;
      section.appendChild(heading);
      const body = document.createElement("div");
      renderer.renderArtifact(body, artifact);
      section.appendChild(body);
      target.appendChild(section);
    });
  }

  function resetAgentRunPresentation(runId) {
    const runMessage = state.agentRunMessages.get(runId);
    if (!runMessage) return;
    renderer.renderMarkdown(runMessage.body, runMessage.persistedContent);
    runMessage.artifacts.replaceChildren();
    runMessage.artifacts.hidden = true;
  }

  function renderPresentation(snapshot) {
    const releaseCancellationFence = snapshot.terminalStatus !== null && state.agentCancelPending;
    if (releaseCancellationFence) state.agentCancelPending = false;
    const projectedStatus = safeRunStatus(snapshot.status);
    const visibleStatus = state.agentReplayValidating && TERMINAL.has(projectedStatus)
      ? "running"
      : projectedStatus;
    state.agentRunStatus = visibleStatus;
    elements.workspace.dataset.status = visibleStatus;
    elements.run_state.textContent = statusLabel(visibleStatus);
    let runMessage = state.agentRunMessages.get(snapshot.runId);
    if (!runMessage) {
      messageNode("assistant", "", { runId: snapshot.runId });
      runMessage = state.agentRunMessages.get(snapshot.runId);
    }
    if (!runMessage) throw new TypeError("Agent assistant message presentation is unavailable");
    state.assistantNode = runMessage.body;
    renderer.renderMarkdown(runMessage.body, snapshot.output);
    renderAgentArtifacts(runMessage.artifacts, snapshot.artifacts);
    elements.agent_plan.replaceChildren();
    snapshot.plan.forEach((step) => {
      const item = document.createElement("li");
      item.dataset.status = step.status;
      item.textContent = `${step.label} — ${statusLabel(step.status)}`;
      elements.agent_plan.appendChild(item);
    });
    elements.agent_timeline.replaceChildren();
    snapshot.tools.forEach((tool) => {
      const item = document.createElement("li");
      item.dataset.status = tool.state;
      item.textContent = `${tool.label}: ${tool.summary}`;
      elements.agent_timeline.appendChild(item);
    });
    elements.context_indicator.hidden = snapshot.compaction === null;
    if (snapshot.compaction) {
      elements.context_indicator_text.textContent = `${snapshot.compaction.compactedMessages} earlier messages were compacted by AgInTi (${snapshot.compaction.tokensBefore} → ${snapshot.compaction.tokensAfter} tokens).`;
    }
    elements.agent_artifacts.replaceChildren();
    elements.agent_artifacts.hidden = true;
    const isTerminal = TERMINAL.has(visibleStatus);
    elements.stop_run.hidden = isTerminal || state.agentCancelPending || !state.capabilities.actions.cancel;
    elements.resume_run.hidden = state.agentReplayValidating
      || state.agentReplayFailed
      || !state.agentReplayOfferResume
      || !state.capabilities.actions.resume
      || (visibleStatus !== "failed" && visibleStatus !== "cancelled");
    if (releaseCancellationFence) updateImageControl();
  }

  function renderAgentFailure(runId, value) {
    const runMessage = state.agentRunMessages.get(runId);
    if (!runMessage) return;
    const candidate = typeof value === "string" && value.length <= 600
      && isUnicodeScalarText(value) && !UNSAFE_MESSAGE_CONTROL.test(value)
      ? value.trim()
      : "";
    const message = document.createElement("p");
    message.className = "agent-run-failure";
    message.textContent = candidate || "Agent execution failed. Resume this run to try again.";
    runMessage.body.replaceChildren(message);
  }

  async function streamAgentRun(run, {
    cursor,
    expectedRunId = run?.id,
    expectedThreadId = run?.threadId,
    replayTerminal = false,
    offerResume = true,
    cancelPending = false,
  } = {}) {
    correlatedAgentRun(run, { runId: expectedRunId, threadId: expectedThreadId });
    if (replayTerminal && cursor !== undefined) throw new TypeError("terminal Agent replay must start from cursor zero");
    state.agentReplayValidating = replayTerminal;
    state.agentReplayFailed = false;
    state.agentReplayOfferResume = offerResume;
    state.agentCancelPending = cancelPending;
    state.runId = run.id;
    // RPC response statuses can help project progress, but terminal authority
    // belongs only to a verified hash-chained terminal event.
    const initialStatus = replayTerminal ? "running" : eventAwaitingRunStatus(run.status);
    state.agentRunStatus = initialStatus;
    const agent = state.agent;
    const streamEpoch = state.viewEpoch;
    const presentation = createRunPresentation({ runId: run.id, threadId: run.threadId, cursor });
    state.presentation = presentation;
    state.assistantNode = state.agentRunMessages.get(run.id)?.body ?? null;
    state.streamAbort?.abort();
    const controller = new AbortController();
    state.streamAbort = controller;
    state.streamKind = "agent";
    const ownsStream = () => !controller.signal.aborted
      && state.streamAbort === controller
      && state.presentation === presentation
      && state.agent === agent
      && state.viewEpoch === streamEpoch;
    elements.workspace.dataset.status = initialStatus;
    elements.run_state.textContent = replayTerminal ? "Restoring" : cancelPending ? "Cancelling" : statusLabel(initialStatus);
    elements.stop_run.hidden = replayTerminal || cancelPending || !state.capabilities.actions.cancel;
    elements.resume_run.hidden = true;
    if (replayTerminal) connection("Restoring verified Agent history", false);
    let recoveries = 0;
    try {
      while (ownsStream()) {
        let failure = null;
        try {
          for await (const { event } of agent.streamRunEvents({
            runId: run.id,
            threadId: run.threadId,
            cursor: presentation.snapshot().cursor,
            maxReconnects: 0,
            signal: controller.signal,
            onCursor: cursorStore && !replayTerminal && !cancelPending
              ? async (next) => cursorStore.save({ runId: run.id, threadId: run.threadId, cursor: next })
              : undefined,
          })) {
            if (!ownsStream()) return;
            renderPresentation(presentation.apply(event));
          }
        } catch (error) {
          if (!ownsStream()) return;
          failure = error;
        }
        if (!ownsStream()) return;
        const snapshot = presentation.snapshot();
        if (replayTerminal) {
          if (failure) throw failure;
          assertTerminalAgentReplay(run, snapshot);
          state.agentReplayValidating = false;
          renderPresentation(snapshot);
          if (snapshot.status === "failed") renderAgentFailure(run.id, run.error?.message);
          connection("Connected");
          return;
        }
        if (snapshot.terminalStatus !== null) {
          if (snapshot.status === "failed") {
            let failureMessage = "";
            try {
              const response = await agent.runStatus(run.id, { signal: controller.signal });
              if (!ownsStream()) return;
              const finalRun = correlatedAgentRun(response.run, { runId: run.id, threadId: run.threadId });
              assertTerminalAgentReplay(finalRun, snapshot);
              failureMessage = finalRun.error?.message || "";
            } catch {
              // The verified terminal event still proves failure. Error detail
              // is optional presentation data and falls back to fixed text.
            }
            renderAgentFailure(run.id, failureMessage);
          }
          connection("Connected");
          return;
        }
        if (failure instanceof AgintiProtocolError || (failure && failure.retryable !== true)) throw failure;
        let authoritativeRun = null;
        try {
          const response = await agent.runStatus(run.id, { signal: controller.signal });
          if (!ownsStream()) return;
          authoritativeRun = correlatedAgentRun(response.run, { runId: run.id, threadId: run.threadId });
        } catch (error) {
          if (!ownsStream()) return;
          if (error instanceof AgintiProtocolError || error?.retryable === false) throw error;
        }
        recoveries += 1;
        connection(authoritativeRun && TERMINAL.has(authoritativeRun.status)
          ? "Waiting for verified Agent completion"
          : "Reconnecting to AgInTi", false);
        const backoffStep = Math.min(recoveries - 1, maxStreamBackoffSteps);
        await wait(Math.min(4_000, 250 * (2 ** backoffStep)), controller.signal);
      }
    } catch (error) {
      if (!ownsStream()) return;
      if (replayTerminal) {
        state.agentReplayValidating = false;
        state.agentReplayFailed = true;
        state.agentReplayOfferResume = false;
        resetAgentRunPresentation(run.id);
        elements.agent_plan.replaceChildren();
        elements.agent_timeline.replaceChildren();
        elements.resume_run.hidden = true;
        connection("Agent history unavailable", false);
        throw error;
      }
      if (cancelPending) {
        state.agentCancelPending = false;
        state.agentReplayFailed = true;
        state.agentReplayOfferResume = false;
        resetAgentRunPresentation(run.id);
        elements.agent_plan.replaceChildren();
        elements.agent_timeline.replaceChildren();
        elements.stop_run.hidden = true;
        elements.resume_run.hidden = true;
        updateImageControl();
        connection("Agent cancellation history unavailable", false);
        showToast("Verified cancellation history could not be restored safely. Reopen this conversation to retry; no run was resumed.");
        return;
      }
      elements.resume_run.hidden = state.agentCancelPending || !state.capabilities.actions.resume;
      connection(state.agentCancelPending ? "Confirming Agent cancellation" : "Agent stream interrupted", false);
      showToast(state.agentCancelPending
        ? "Cancellation is being confirmed. Its verified history will reconnect automatically."
        : "The Agent run is still owned by AgInTi. Resume reconnects without restarting it.");
    } finally {
      if (state.streamAbort === controller) {
        state.streamAbort = null;
        state.streamKind = null;
        elements.stop_run.hidden = true;
      }
    }
  }

  async function openAgentThread(threadId, { expectedEpoch = state.viewEpoch } = {}) {
    if (!state.capabilities.enabled || state.mode !== "agent" || state.viewEpoch !== expectedEpoch) return;
    const session = state.session;
    const agent = state.agent;
    const current = () => state.session === session
      && state.agent === agent
      && state.mode === "agent"
      && state.viewEpoch === expectedEpoch;
    state.agentHistoryRestoring = true;
    updateImageControl();
    try {
      const { thread } = await agent.getThread(threadId);
      if (!current()) return;
      if (thread.id !== threadId) {
        throw new AgintiProtocolError("Agent thread ownership does not match the requested thread", {
          code: "LEDGER_OWNERSHIP_MISMATCH",
        });
      }
      clearConversation();
      state.agentHistoryRestoring = true;
      state.agentThreadId = thread.id;
      state.runId = null;
      state.agentRunStatus = null;
      elements.conversation_title.textContent = thread.title;
      const runs = persistedThreadRuns(thread);
      const missingAssistantRuns = new Set(
        runs.filter((requested) => !requested.persisted).map((requested) => requested.runId)
      );
      thread.messages.forEach((message, index) => {
        messageNode(message.role, message.content, { runId: message.runId });
        const next = thread.messages[index + 1];
        if (missingAssistantRuns.has(message.runId) && next?.runId !== message.runId) {
          // Failed, cancelled, and live runs do not necessarily have a
          // persisted assistant message. Reserve their chronological position
          // before replay so an older run cannot be appended after a resumed
          // successor's stored answer and artifacts.
          messageNode("assistant", "", { runId: message.runId });
          missingAssistantRuns.delete(message.runId);
        }
      });
      renderThreads();
      if (thread.authority.lastCompaction) {
        elements.context_indicator.hidden = false;
        elements.context_indicator_text.textContent = `${thread.authority.lastCompaction.compactedMessages} earlier messages were compacted by AgInTi.`;
      }
      for (const requested of runs) {
        const requestedRunId = requested.runId;
        const { run } = await agent.runStatus(requestedRunId);
        if (!current()) return;
        correlatedAgentRun(run, { runId: requestedRunId, threadId: thread.id });
        const terminal = TERMINAL.has(run.status);
        if (!terminal && (requested.persisted || requestedRunId !== thread.lastRunId)) {
          throw new AgintiProtocolError("A persisted Agent assistant run is not terminal", {
            code: "LEDGER_TERMINAL_MISMATCH",
          });
        }
        // Once every historical run is restored, the current live run resumes
        // its normal cancel/reconnect controls rather than staying read-only.
        if (!terminal) state.agentHistoryRestoring = false;
        await streamAgentRun(run, {
          expectedRunId: requestedRunId,
          expectedThreadId: thread.id,
          replayTerminal: terminal,
          offerResume: requestedRunId === thread.lastRunId,
        });
        if (!current()) return;
      }
      if (thread.lastRunId === null) state.runId = null;
      state.agentReplayFailed = false;
    } catch {
      if (!current()) return;
      state.agentReplayValidating = false;
      state.agentReplayFailed = true;
      state.agentReplayOfferResume = false;
      elements.resume_run.hidden = true;
      showToast("Verified Agent history could not be restored safely. Reopen this conversation to retry; no run was resumed.");
    } finally {
      if (current()) {
        state.agentHistoryRestoring = false;
        updateImageControl();
      }
    }
  }

  async function exactMutation(dispatch, retry, { onAmbiguous = () => {}, onConfirmed = () => {} } = {}) {
    try {
      const result = await dispatch();
      onConfirmed();
      return result;
    }
    catch (error) {
      if (error?.retryable !== true) throw error;
      onAmbiguous(error);
      connection("Retrying the same durable request", false);
      await wait(250);
      const result = await retry();
      onConfirmed();
      return result;
    }
  }

  function isAuthoritativeChatRejection(error) {
    return error instanceof DirectChatTransportError
      && error.retryable === false
      && Number.isSafeInteger(error.status)
      && error.status >= 400
      && error.status < 499;
  }

  function releaseRejectedChatWorkflow(workflow, error) {
    const composer = workflow.lockedComposer ?? workflow.recoveryComposer;
    if (composer !== null && composer !== undefined) {
      if (!elements.message_input.value || elements.message_input.value === workflow.text
          || elements.message_input.value === composer.draft) {
        elements.message_input.value = composer.draft;
      }
      if (composer.images.length > 0 && state.selectedImages.length === 0) {
        try {
          restoreDetachedImage(Object.freeze({
            selected: composer.images,
            previewUrls: Object.freeze(composer.images.map((image) => createObjectUrl(image.previewBlob))),
          }));
        } catch { /* The exact text remains recoverable even if a local preview cannot be recreated. */ }
      }
    }
    workflow.lockedComposer = null;
    workflow.recoveryComposer = null;
    if (state.chatPendingSend === workflow) state.chatPendingSend = null;
    elements.resume_run.hidden = true;
    renderThreads();
    updateImageControl();
    const diagnostic = applyChatFailureDiagnostic(new LocalChatNotSentError(
      workflow.failureStage ?? "before_run_dispatch",
      error,
    ));
    showToast(composer?.images?.length > 0
      ? "The image message was rejected before it ran. Its prompt and images are ready to edit or retry."
      : "The message was rejected before it ran. Its prompt is ready to edit or retry.");
    if (diagnostic.reauthenticate) requireFreshAuthentication();
  }

  async function fetchChatSnapshot(threadId, signal, {
    expectedEpoch = state.viewEpoch,
    threadHint = null,
  } = {}) {
    const owner = Object.freeze({ session: state.session, chat: state.chat, expectedEpoch });
    const hintedRevision = threadHint?.threadId === threadId
      && Number.isSafeInteger(threadHint.revision) && threadHint.revision > 0
      ? threadHint.revision
      : 0;
    const ensureOwner = () => {
      if (state.session !== owner.session || state.chat !== owner.chat || !state.session.authenticated
          || state.mode !== "chat" || state.viewEpoch !== owner.expectedEpoch) {
        throw new DirectChatTransportError("Direct Chat snapshot ownership changed.", {
          code: "browser_state_changed",
          status: 499,
          retryable: false,
        });
      }
      if (signal?.aborted) throw signal.reason ?? new DOMException("request aborted", "AbortError");
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        ensureOwner();
        const [beforeResponse, prefetchedFirstPage] = await Promise.all([
          owner.chat.getThread(threadId, { signal }),
          hintedRevision > 0
            ? owner.chat.listMessages({
              threadId,
              afterRevision: 0,
              limit: Math.min(200, hintedRevision),
              signal,
            })
            : null,
        ]);
        const { thread: before } = beforeResponse;
        ensureOwner();
        const messages = [];
        let afterRevision = 0;
        let previousHash = null;
        let inconsistent = false;
        let firstPage = prefetchedFirstPage;
        while (afterRevision < before.revision) {
          const remaining = before.revision - afterRevision;
          const response = firstPage ?? await owner.chat.listMessages({
              threadId,
              afterRevision,
              limit: Math.min(200, remaining),
              signal,
            });
          firstPage = null;
          ensureOwner();
          if (response.messages.length < 1 || response.messages.length > remaining) {
            inconsistent = true;
            break;
          }
          for (const message of response.messages) {
            if (message.previousHash !== previousHash) {
              inconsistent = true;
              break;
            }
            messages.push(message);
            afterRevision = message.revision;
            previousHash = message.messageHash;
          }
          if (inconsistent) break;
        }
        const { thread: after } = await owner.chat.getThread(threadId, { signal });
        ensureOwner();
        const stable = before.revision === after.revision
          && before.ledgerHash === after.ledgerHash
          && before.currentGenerationId === after.currentGenerationId;
        const complete = messages.length === after.revision
          && (after.revision === 0 ? after.ledgerHash === null : previousHash === after.ledgerHash);
        if (!inconsistent && stable && complete) return Object.freeze({ thread: after, messages: Object.freeze(messages) });
      } catch (error) {
        if (error?.retryable !== true || attempt >= 2) throw error;
        ensureOwner();
        await wait(250 * (2 ** attempt), signal);
        ensureOwner();
        continue;
      }
      if (attempt < 2) {
        ensureOwner();
        await wait(250 * (2 ** attempt), signal);
        ensureOwner();
      }
    }
    throw new DirectChatProtocolError("Direct Chat changed while its authoritative snapshot was being read");
  }

  function chatFinalizationIsCurrent(finalization) {
    return state.chatFinalization === finalization
      && state.session === finalization.session
      && state.chat === finalization.chat
      && state.session.authenticated
      && state.mode === "chat"
      && state.chatThreadId === finalization.threadId
      && state.viewEpoch === finalization.expectedEpoch;
  }

  function markChatFinalizing(finalization) {
    if (!chatFinalizationIsCurrent(finalization)) return false;
    elements.workspace.dataset.status = "finalizing";
    elements.run_state.textContent = "Finalizing";
    elements.stop_run.hidden = true;
    elements.resume_run.hidden = true;
    connection("Finalizing response…");
    updateImageControl();
    renderThreads();
    return true;
  }

  function beginChatFinalization({ threadId, generationId = null, expectedEpoch = state.viewEpoch }) {
    const finalization = Object.freeze({
      session: state.session,
      chat: state.chat,
      threadId,
      generationId,
      expectedEpoch,
    });
    state.chatFinalization = finalization;
    markChatFinalizing(finalization);
    return finalization;
  }

  function abandonChatFinalization(finalization) {
    if (state.chatFinalization !== finalization) return false;
    state.chatFinalization = null;
    updateImageControl();
    renderThreads();
    return true;
  }

  function completeChatFinalization(finalization) {
    if (!chatFinalizationIsCurrent(finalization)) return false;
    state.chatFinalization = null;
    elements.workspace.dataset.status = "completed";
    elements.run_state.textContent = "Completed";
    elements.stop_run.hidden = true;
    elements.resume_run.hidden = true;
    connection("Connected");
    updateImageControl();
    renderThreads();
    return true;
  }

  function pauseChatFinalization(finalization) {
    if (!chatFinalizationIsCurrent(finalization)) return false;
    elements.workspace.dataset.status = "finalizing";
    elements.run_state.textContent = "Finalizing";
    elements.stop_run.hidden = true;
    elements.resume_run.hidden = false;
    connection("Finalizing · reconnect needed", false);
    updateImageControl();
    renderThreads();
    showToast("LocalLLM finished generating, but the authoritative final view is not ready yet. Resume completes it without rerunning the prompt.");
    return true;
  }

  async function renderChatSnapshot(snapshot, {
    expectedEpoch = state.viewEpoch,
    finalization: suppliedFinalization = null,
    restoreAttachments = true,
  } = {}) {
    clearConversation();
    state.chatThread = snapshot.thread;
    state.chatThreadId = snapshot.thread.threadId;
    elements.conversation_title.textContent = snapshot.thread.title || "New conversation";
    const last = snapshot.messages.at(-1);
    const completed = last?.role === "assistant";
    const finalization = suppliedFinalization ?? (completed
      ? beginChatFinalization({
        threadId: snapshot.thread.threadId,
        generationId: last.generationId,
        expectedEpoch,
      })
      : null);
    const ownsFinalization = finalization !== null && suppliedFinalization === null;
    if (finalization !== null) markChatFinalizing(finalization);
    const attachmentReadyTasks = [];
    snapshot.messages.forEach((message) => messageNode(message.role, message.content, {
      runId: message.generationId ?? undefined,
      attachment: message.attachment,
      attachments: message.attachments,
      threadId: snapshot.thread.threadId,
      attachmentReadyTasks,
    }));
    // Attachment previews are cosmetic. Register them only after the
    // authoritative conversation is usable; viewport observation then admits
    // at most one verified original at a time on memory-constrained clients.
    if (restoreAttachments) {
      void attachmentReadyTasks.reduce(
        (previous, restoreAttachment) => previous.then(restoreAttachment),
        Promise.resolve(),
      );
    } else {
      for (const restoreAttachment of attachmentReadyTasks) restoreAttachment({ observe: false });
    }
    if (state.mode !== "chat" || state.viewEpoch !== expectedEpoch
        || state.chatThreadId !== snapshot.thread.threadId) {
      if (ownsFinalization) abandonChatFinalization(finalization);
      return false;
    }
    if (ownsFinalization) completeChatFinalization(finalization);
    else if (!completed && suppliedFinalization === null) {
      elements.workspace.dataset.status = "idle";
      elements.run_state.textContent = "Idle";
    }
    clearChatFailureDiagnostic();
    renderThreads();
    return true;
  }

  async function refreshChatThread(threadId, signal, {
    expectedEpoch = state.viewEpoch,
    finalization = null,
    threadHint = null,
    refreshThreadList = true,
  } = {}) {
    const session = state.session;
    const chat = state.chat;
    const snapshot = await fetchChatSnapshot(threadId, signal, { expectedEpoch, threadHint });
    if (state.session !== session || state.chat !== chat) return snapshot;
    state.chatThread = snapshot.thread;
    state.chatThreadId = snapshot.thread.threadId;
    if (state.mode === "chat" && state.viewEpoch === expectedEpoch) {
      await renderChatSnapshot(snapshot, { expectedEpoch, finalization });
    }
    if (refreshThreadList) {
      void loadChatThreads().catch(() => { /* The open authoritative thread remains usable. */ });
    }
    return snapshot;
  }

  async function finalizeChatGeneration(finalization, signal) {
    if (!markChatFinalizing(finalization)) return false;
    try {
      const snapshot = await refreshChatThread(finalization.threadId, signal, {
        expectedEpoch: finalization.expectedEpoch,
        finalization,
      });
      if (!chatFinalizationIsCurrent(finalization)) return false;
      const assistant = snapshot.messages.at(-1);
      if (assistant?.role !== "assistant" || assistant.generationId !== finalization.generationId) {
        throw new DirectChatProtocolError("Direct Chat finalization did not include the completed assistant message");
      }
      state.chatThread = snapshot.thread;
    } catch (error) {
      if (recoverChatReadAuthentication(error, captureChatReadRecovery({
        threadId: finalization.threadId,
        generationId: finalization.generationId,
      }))) return false;
      pauseChatFinalization(finalization);
      return false;
    }
    return completeChatFinalization(finalization);
  }

  async function finishChatGeneration(generation, controller, expectedEpoch = state.viewEpoch) {
    state.chatGeneration = generation;
    const presenting = state.mode === "chat" && state.viewEpoch === expectedEpoch;
    if (presenting && state.chatThreadId === generation.threadId) {
      if (generation.status === "completed") {
        const finalization = beginChatFinalization({
          threadId: generation.threadId,
          generationId: generation.generationId,
          expectedEpoch,
        });
        await finalizeChatGeneration(finalization, controller.signal);
        return;
      }
      try {
        await refreshChatThread(generation.threadId, controller.signal, { expectedEpoch });
      } catch (error) {
        if (recoverChatReadAuthentication(error, captureChatReadRecovery({
          threadId: generation.threadId,
          generationId: generation.generationId,
        }))) return;
        // The terminal generation remains authoritative. A later send performs
        // another full pre-send snapshot render before appending local UI.
      }
    }
    if (presenting) {
      elements.workspace.dataset.status = generation.status;
      elements.run_state.textContent = statusLabel(generation.status);
      elements.resume_run.hidden = true;
    }
    if (presenting) connection("Connected");
  }

  async function streamChatGeneration(generation, { afterSequence = 0, output = "" } = {}) {
    const expectedEpoch = state.viewEpoch;
    const continuing = state.chatGeneration?.generationId === generation.generationId;
    state.chatGeneration = generation;
    state.chatAfterSequence = continuing ? Math.max(state.chatAfterSequence, afterSequence) : afterSequence;
    state.chatOutput = continuing ? state.chatOutput : output;
    if (!continuing || !state.assistantNode) {
      state.assistantNode = messageNode("assistant", state.chatOutput, { runId: generation.generationId });
    }
    state.streamAbort?.abort();
    const controller = new AbortController();
    state.streamAbort = controller;
    state.streamKind = "chat";
    elements.stop_run.hidden = false;
    elements.resume_run.hidden = true;
    elements.workspace.dataset.status = "running";
    const hasOutput = state.chatOutput.length > 0;
    elements.run_state.textContent = hasOutput ? "Generating" : "Warming LocalLLM";
    if (!hasOutput) connection("Warming LocalLLM…");
    let recoveries = 0;
    try {
      while (!controller.signal.aborted) {
        let failure;
        try {
          for await (const event of state.chat.streamRunEvents({
            threadId: generation.threadId,
            generationId: generation.generationId,
            afterSequence: state.chatAfterSequence,
            maxReconnects: 0,
            signal: controller.signal,
            onCursor: async (cursor) => { state.chatAfterSequence = cursor.afterSequence; },
          })) {
            if (event.type === "delta") {
              elements.run_state.textContent = "Generating";
              connection("Connected");
              state.chatOutput += event.delta.content;
              renderer.renderMarkdown(state.assistantNode, state.chatOutput);
            } else {
              await finishChatGeneration(event.generation, controller, expectedEpoch);
              return;
            }
          }
        } catch (error) {
          if (controller.signal.aborted) return;
          failure = error;
        }
        if (failure instanceof DirectChatProtocolError || failure?.retryable !== true) throw failure;
        let authoritative;
        try {
          authoritative = (await state.chat.getRunStatus({
            threadId: generation.threadId,
            generationId: generation.generationId,
            signal: controller.signal,
          })).generation;
        } catch (error) {
          if (controller.signal.aborted) return;
          if (error instanceof DirectChatProtocolError || error?.retryable === false) throw error;
        }
        if (authoritative?.terminal) {
          await finishChatGeneration(authoritative, controller, expectedEpoch);
          return;
        }
        recoveries += 1;
        connection("Reconnecting to LocalLLM", false);
        const backoffStep = Math.min(recoveries - 1, maxStreamBackoffSteps);
        await wait(Math.min(4_000, 250 * (2 ** backoffStep)), controller.signal);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      if (recoverChatReadAuthentication(error, captureChatReadRecovery({
        threadId: generation.threadId,
        generationId: generation.generationId,
      }))) return;
      elements.resume_run.hidden = false;
      connection("Chat stream interrupted", false);
      showToast("The generation is still server-owned. Resume reconnects without dispatching it again.");
      throw error;
    } finally {
      if (state.streamAbort === controller) {
        state.streamAbort = null;
        state.streamKind = null;
        elements.stop_run.hidden = true;
      }
    }
  }

  async function openChatThread(threadId, {
    backgroundStream = false,
    threadHint = null,
    refreshThreadList = true,
  } = {}) {
    const expectedEpoch = state.viewEpoch;
    const restoration = Object.freeze({ threadId, expectedEpoch, chat: state.chat });
    state.chatHistoryRestoration = restoration;
    updateImageControl();
    renderThreads();
    let generationId = null;
    try {
      const snapshot = await refreshChatThread(threadId, undefined, {
        expectedEpoch,
        threadHint,
        refreshThreadList,
      });
      if (state.mode !== "chat" || state.viewEpoch !== expectedEpoch) return;
      generationId = snapshot.thread.currentGenerationId;
      if (!generationId) {
        state.chatGeneration = null;
        state.chatAfterSequence = 0;
        state.chatOutput = "";
        return;
      }
      const { generation } = await state.chat.getRunStatus({ threadId, generationId });
      if (state.mode !== "chat" || state.viewEpoch !== expectedEpoch) return;
      state.chatGeneration = generation;
      state.chatAfterSequence = 0;
      state.chatOutput = "";
      if (generation.terminal) {
        elements.workspace.dataset.status = generation.status;
        elements.run_state.textContent = statusLabel(generation.status);
        return;
      }
      const stream = streamChatGeneration(generation);
      if (backgroundStream) {
        void stream.catch(() => {});
        return;
      }
      await stream;
    } catch (error) {
      if (state.chatHistoryRestoration !== restoration
          || state.chat !== restoration.chat
          || !state.session.authenticated
          || state.mode !== "chat"
          || state.viewEpoch !== expectedEpoch) return;
      if (recoverChatReadAuthentication(error, captureChatReadRecovery({ threadId, generationId }))) return;
      throw error;
    } finally {
      if (state.chatHistoryRestoration === restoration) {
        state.chatHistoryRestoration = null;
        updateImageControl();
        renderThreads();
      }
    }
  }

  async function reconnectRecoveredChat(recovery) {
    const expectedEpoch = state.viewEpoch;
    const snapshot = await refreshChatThread(recovery.threadId, undefined, { expectedEpoch });
    if (!state.session.authenticated || state.mode !== "chat" || state.viewEpoch !== expectedEpoch) return;
    const generationId = recovery.generationId ?? snapshot.thread.currentGenerationId;
    if (generationId === null) {
      state.chatGeneration = null;
      return;
    }
    const { generation } = await state.chat.getRunStatus({
      threadId: recovery.threadId,
      generationId,
    });
    if (!state.session.authenticated || state.mode !== "chat" || state.viewEpoch !== expectedEpoch) return;
    state.chatGeneration = generation;
    if (generation.terminal) {
      const finalAssistant = snapshot.messages.at(-1);
      if (generation.status === "completed"
          && (finalAssistant?.role !== "assistant" || finalAssistant.generationId !== generation.generationId)) {
        await finishChatGeneration(generation, new AbortController(), expectedEpoch);
        return;
      }
      elements.workspace.dataset.status = generation.status;
      elements.run_state.textContent = statusLabel(generation.status);
      elements.resume_run.hidden = true;
      connection("Connected");
      return;
    }
    await streamChatGeneration(generation, {
      afterSequence: recovery.generationId === generation.generationId ? recovery.afterSequence : 0,
      output: recovery.generationId === generation.generationId ? recovery.output : "",
    });
  }

  function currentThreadDeletion(pending) {
    return pending !== null && pending !== undefined
      && pending.session === state.session && pending.chat === state.chat
      && state.session.authenticated && state.mode === "chat";
  }

  function deletionAlreadyAbsent(error) {
    return error instanceof DirectChatTransportError && error.status === 404;
  }

  function definitiveDeletionRejection(error) {
    return error instanceof DirectChatTransportError && error.retryable === false
      && Number.isSafeInteger(error.status) && error.status >= 400 && error.status < 500
      && error.status !== 404;
  }

  function finishLocalThreadDeletion(pending, authoritativeThreads = null) {
    if (!currentThreadDeletion(pending)) return false;
    const threadId = pending.threadId;
    const previousIndex = state.chatThreads.findIndex((item) => item.threadId === threadId);
    state.chatThreadListEpoch += 1;
    state.chatThreads = authoritativeThreads === null
      ? state.chatThreads.filter((item) => item.threadId !== threadId)
      : [...authoritativeThreads];
    if (state.chatPendingDeletion === pending) state.chatPendingDeletion = null;
    purgeAttachmentBlobCacheForThread(threadId);
    if (state.chatThreadId === threadId) {
      state.viewEpoch += 1;
      state.streamAbort?.abort();
      state.streamAbort = null;
      state.streamKind = null;
      state.chatThreadId = null;
      state.chatThread = null;
      state.chatGeneration = null;
      state.chatAfterSequence = 0;
      state.chatOutput = "";
      clearChatFailureDiagnostic();
      clearConversation();
      elements.conversation_title.textContent = "New conversation";
    }
    connection("Connected");
    renderThreads();
    focusSoon(() => focusAfterThreadDeletion(previousIndex));
    showToast("Conversation deleted.");
    return true;
  }

  async function reconcileThreadDeletion(pending) {
    let response;
    try {
      response = await pending.chat.listThreads({ limit: 100 });
    } catch (error) {
      if (!currentThreadDeletion(pending)) return false;
      if (isChatAuthenticationAfterAmbiguousDispatch(error)) {
        if (state.chatPendingDeletion === pending) state.chatPendingDeletion = null;
        requireFreshAuthentication();
        return false;
      }
      renderThreads();
      focusSoon(() => focusThreadDeleteControl(pending.threadId));
      connection("Deletion confirmation paused", false);
      showToast("The deletion response is still uncertain. Retry reuses the exact same request.");
      return false;
    }
    if (!currentThreadDeletion(pending)) return false;
    const threads = [...response.threads];
    const authoritative = threads.find((item) => item.threadId === pending.threadId);
    if (authoritative === undefined) return finishLocalThreadDeletion(pending, threads);
    state.chatThreadListEpoch += 1;
    state.chatThreads = threads;
    if (authoritative.revision !== pending.revision || authoritative.ledgerHash !== pending.ledgerHash
        || authoritative.currentGenerationId !== null) {
      if (state.chatPendingDeletion === pending) state.chatPendingDeletion = null;
      renderThreads();
      focusSoon(() => focusThreadDeleteControl(pending.threadId));
      connection("Connected");
      showToast("Deletion stopped because this conversation changed or started new work.");
      return false;
    }
    // The read may have overtaken an earlier disconnected delete request. Keep
    // the exact ticket until either absence or a changed cursor is authoritative.
    renderThreads();
    focusSoon(() => focusThreadDeleteControl(pending.threadId));
    connection("Deletion confirmation paused", false);
    showToast("The deletion response is still uncertain. Retry reuses the exact same request.");
    return false;
  }

  async function deleteChatThread(threadId) {
    if (interactionLocked() || !state.session.authenticated || state.mode !== "chat"
        || state.chatPendingSend !== null) return false;
    let retained = state.chatPendingDeletion;
    if (retained !== null && (!currentThreadDeletion(retained) || retained.threadId !== threadId)) {
      if (!currentThreadDeletion(retained)) {
        state.chatPendingDeletion = null;
        retained = null;
      }
      else {
        showToast("Confirm the pending conversation deletion before deleting another conversation.");
        focusSoon(() => focusThreadDeleteControl(retained.threadId));
        return false;
      }
    }
    const thread = state.chatThreads.find((item) => item.threadId === threadId);
    if (!thread) {
      return retained !== null && retained.threadId === threadId
        ? finishLocalThreadDeletion(retained, state.chatThreads)
        : false;
    }
    if (thread.currentGenerationId !== null
        || (state.chatThreadId === threadId && state.chatGeneration
          && !TERMINAL.has(state.chatGeneration.status))) {
      showToast("Stop or resolve this LocalLLM response before deleting its conversation.");
      return false;
    }

    const session = state.session;
    const chat = state.chat;
    state.busy = true;
    updateImageControl();
    try {
      let pending = retained;
      if (pending === null) {
        let confirmed = false;
        try {
          confirmed = await confirmThreadDeletion(
            `Delete “${thread.title || "New conversation"}” and all of its saved messages and images? This cannot be undone.`,
          ) === true;
        } catch {
          confirmed = false;
        }
        if (!confirmed || state.session !== session || state.chat !== chat
            || !state.session.authenticated || state.mode !== "chat"
            || state.chatPendingSend !== null) return false;
        const current = state.chatThreads.find((item) => item.threadId === threadId);
        if (!current || current.revision !== thread.revision || current.ledgerHash !== thread.ledgerHash
            || current.currentGenerationId !== null) {
          showToast("This conversation changed before deletion. Reopen it and try again.");
          return false;
        }
        const ticket = chat.prepareThreadDeletion({
          threadId,
          expectedRevision: thread.revision,
          expectedHash: thread.ledgerHash,
        });
        pending = Object.freeze({
          session,
          chat,
          threadId,
          revision: thread.revision,
          ledgerHash: thread.ledgerHash,
          ticket,
        });
        state.chatPendingDeletion = pending;
      }

      let result = null;
      let ambiguous = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          result = await (attempt === 0 && retained === null
            ? pending.chat.deleteThread(pending.ticket)
            : pending.chat.retryDeleteThread(pending.ticket));
          ambiguous = null;
          break;
        } catch (error) {
          if (!currentThreadDeletion(pending)) return false;
          if (deletionAlreadyAbsent(error)) return finishLocalThreadDeletion(pending);
          if (definitiveDeletionRejection(error)) throw error;
          ambiguous = error;
          if (attempt === 0) {
            connection("Retrying the same durable deletion", false);
            await wait(250);
          }
        }
      }
      if (result !== null) {
        if (!currentThreadDeletion(pending) || result.deleted !== true || result.threadId !== threadId) return false;
        return finishLocalThreadDeletion(pending);
      }
      if (ambiguous !== null) return await reconcileThreadDeletion(pending);
      return false;
    } catch (error) {
      const pending = state.chatPendingDeletion;
      if (pending !== null && currentThreadDeletion(pending)) state.chatPendingDeletion = null;
      if (isChatAuthenticationAfterAmbiguousDispatch(error)) {
        requireFreshAuthentication();
      } else if (error instanceof DirectChatTransportError && error.status === 409) {
        if (retained !== null) {
          renderThreads();
          focusSoon(() => focusThreadDeleteControl(threadId));
        }
        showToast("Deletion stopped because this conversation changed or still has unresolved work.");
      } else {
        if (retained !== null) {
          renderThreads();
          focusSoon(() => focusThreadDeleteControl(threadId));
        }
        showToast("Conversation deletion was rejected before it could be confirmed.");
      }
      return false;
    } finally {
      state.busy = false;
      updateImageControl();
    }
  }

  async function openThread(threadId, { mode = state.mode } = {}) {
    if (interactionLocked() || mode !== state.mode) return;
    if (mode === "chat" && state.chatPendingDeletion) {
      showToast("Retry the pending conversation deletion before opening another conversation.");
      return;
    }
    if (mode === "chat" && state.chatPendingSend) {
      showToast("Confirm the pending durable send with Resume before opening another conversation.");
      return;
    }
    state.busy = true;
    updateImageControl();
    renderThreads();
    state.viewEpoch += 1;
    state.streamAbort?.abort();
    try {
      if (mode === "agent") await openAgentThread(threadId);
      else {
        const threadHint = state.chatThreads.find((thread) => thread.threadId === threadId) ?? null;
        await openChatThread(threadId, { backgroundStream: true, threadHint });
      }
    } catch {
      showToast(mode === "agent"
        ? "This AgInTi thread could not be opened safely."
        : "This LocalLLM conversation could not be restored safely.");
    } finally {
      state.busy = false;
      updateImageControl();
      renderThreads();
    }
  }

  async function restoreModeView({ autoOpen = false, prefetchedChatThreads = null } = {}) {
    const mode = state.mode;
    const epoch = ++state.viewEpoch;
    const preferred = mode === "agent" ? state.agentThreadId : state.chatThreadId;
    state.streamAbort?.abort();
    clearConversation();
    elements.conversation_title.textContent = "New conversation";
    if (mode === "agent") {
      state.agentHistoryRestoring = true;
      state.agentThreadId = null;
      state.runId = null;
      state.agentRunStatus = null;
      updateImageControl();
    }
    try {
      if (mode === "agent") await loadAgentThreads();
      else await loadChatThreads({ prefetched: prefetchedChatThreads });
      if (epoch !== state.viewEpoch || mode !== state.mode) return;
      const available = currentThreads();
      const selected = available.find((thread) => (mode === "agent" ? thread.id : thread.threadId) === preferred) ?? available[0];
      if (!autoOpen || !selected) return;
      const threadId = mode === "agent" ? selected.id : selected.threadId;
      if (mode === "agent") await openAgentThread(threadId);
      else await openChatThread(threadId, {
        backgroundStream: true,
        threadHint: selected,
        refreshThreadList: false,
      });
    } finally {
      if (mode === "agent" && epoch === state.viewEpoch && mode === state.mode) {
        state.agentHistoryRestoring = false;
        updateImageControl();
      }
    }
  }

  async function sendAgent(text) {
    const session = state.session;
    const agent = state.agent;
    const current = () => state.session === session && state.agent === agent && state.session.authenticated;
    let threadId = state.agentThreadId;
    if (!threadId) {
      const { thread } = await agent.createThread({ title: conversationTitle(text) });
      if (!current()) return;
      state.agentThreadId = thread.id;
      threadId = thread.id;
      state.agentThreads.unshift(thread);
      elements.conversation_title.textContent = thread.title;
      renderThreads();
    }
    messageNode("user", text);
    const { run } = await agent.startRun(threadId, text);
    if (!current()) return;
    correlatedAgentRun(run, { runId: run?.id, threadId });
    await streamAgentRun(run, { expectedThreadId: threadId });
  }

  function workflowAttachmentFields(attachments) {
    if (!Array.isArray(attachments) || attachments.length === 0) return {};
    return attachments.length === 1
      ? { attachment: attachments[0] }
      : { attachments };
  }

  async function exactRunMutation(chat, workflow, dispatch, retry) {
    try {
      const result = await dispatch();
      if (workflow.ambiguousMutation === "run_dispatch") workflow.ambiguousMutation = null;
      return result;
    } catch (error) {
      if (error?.retryable !== true) throw error;
      workflow.ambiguousMutation = "run_dispatch";
      const hasImages = workflow.runTicket?.attachment !== undefined
        || workflow.runTicket?.attachments !== undefined;
      if (hasImages) {
        connection("Confirming the accepted image upload", false);
        try {
          const authoritative = await chat.getRunStatus({
            threadId: workflow.runTicket.threadId,
            generationId: workflow.runTicket.generationId,
          });
          workflow.ambiguousMutation = null;
          return authoritative;
        } catch (probeError) {
          const definitelyAbsent = probeError instanceof DirectChatTransportError
            && probeError.retryable === false && probeError.status === 404;
          if (!definitelyAbsent) {
            if (isChatAuthenticationAfterAmbiguousDispatch(probeError)) throw probeError;
            throw error;
          }
        }
      }
      connection("Retrying the same durable request", false);
      await wait(250);
      const result = await retry();
      workflow.ambiguousMutation = null;
      return result;
    }
  }

  async function continueChatSend(workflow) {
    const session = state.session;
    const chat = state.chat;
    const ensureCurrentSession = () => {
      if (state.session !== session || state.chat !== chat || !state.session.authenticated) {
        throw new TypeError("the authenticated browser session changed");
      }
    };
    let thread = state.chatThread;
    if (!workflow.threadTicket && !state.chatThreadId) {
      workflow.threadTicket = prepareLocalChat(
        "local_thread",
        () => chat.prepareThread({ title: conversationTitle(workflow.text) }),
      );
    }
    if (workflow.threadTicket && !workflow.runTicket) {
      workflow.runTicket = prepareLocalChat(
        "local_run",
        () => chat.prepareRun({
          threadId: workflow.threadTicket.threadId,
          content: workflow.text,
          expectedRevision: 0,
          expectedHash: null,
          ...workflowAttachmentFields(workflow.attachments),
        }),
      );
    }
    if (workflow.threadTicket && !workflow.thread) {
      workflow.failureStage = "thread_dispatch";
      const firstDispatch = workflow.threadDispatched
        ? () => chat.retryCreateThread(workflow.threadTicket)
        : () => chat.createThread(workflow.threadTicket);
      workflow.threadDispatched = true;
      const created = await exactMutation(
        firstDispatch,
        () => chat.retryCreateThread(workflow.threadTicket),
        {
          onAmbiguous() { workflow.ambiguousMutation = "thread_dispatch"; },
          onConfirmed() {
            if (workflow.ambiguousMutation === "thread_dispatch") workflow.ambiguousMutation = null;
          },
        },
      );
      ensureCurrentSession();
      thread = created.thread;
      workflow.thread = thread;
      state.chatThreadId = thread.threadId;
      state.chatThread = thread;
      state.chatThreadListEpoch += 1;
      state.chatThreads = [thread, ...state.chatThreads.filter((item) => item.threadId !== thread.threadId)];
      elements.conversation_title.textContent = thread.title || "New conversation";
      renderThreads();
    }
    thread = workflow.thread ?? thread;
    let started;
    if (workflow.runTicket && workflow.runDispatched) {
      started = await exactRunMutation(
        chat,
        workflow,
        () => chat.retryRun(workflow.runTicket),
        () => chat.retryRun(workflow.runTicket),
      );
      ensureCurrentSession();
    } else {
      if (!workflow.runTicket) {
        const threadId = thread?.threadId === state.chatThreadId ? thread.threadId : state.chatThreadId;
        if (!threadId) throw new TypeError("the Direct Chat thread is unavailable");
        workflow.failureStage = "snapshot";
        const snapshot = await fetchChatSnapshot(threadId);
        ensureCurrentSession();
        if (state.localMessageImageUrls.size > 0
            && !await renderChatSnapshot(snapshot, {
              expectedEpoch: state.viewEpoch,
              restoreAttachments: false,
            })) {
          throw new DirectChatTransportError("Direct Chat snapshot ownership changed.", {
            code: "browser_state_changed",
            status: 499,
            retryable: false,
          });
        }
        thread = snapshot.thread;
        workflow.thread = thread;
        state.chatThread = thread;
        if (thread.currentGenerationId) throw new TypeError("the conversation already has a generation in progress");
        workflow.runTicket = prepareLocalChat(
          "local_run",
          () => chat.prepareRun({
            threadId: thread.threadId,
            content: workflow.text,
            expectedRevision: thread.revision,
            expectedHash: thread.ledgerHash,
            ...workflowAttachmentFields(workflow.attachments),
          }),
        );
      }
      workflow.failureStage = "run_dispatch";
      workflow.runDispatched = true;
      started = await exactRunMutation(
        chat,
        workflow,
        () => chat.startRun(workflow.runTicket),
        () => chat.retryRun(workflow.runTicket),
      );
      ensureCurrentSession();
    }
    const acceptedGeneration = started.generation;
    // startRun() also returns its immutable request for callers that need an
    // audit receipt. Do not keep that request (and its image bytes) in this
    // long-lived async frame while LocalLLM is generating.
    started = null;
    workflow.runTicket = null;
    workflow.attachments = Object.freeze([]);
    if (workflow.lockedComposer !== null) {
      if (elements.message_input.value === workflow.lockedComposer.draft) elements.message_input.value = "";
      if (workflow.lockedComposer.images.length > 0
          && state.selectedImages === workflow.lockedComposer.images) {
        clearSelectedImage();
      }
      workflow.lockedComposer = null;
    }
    workflow.recoveryComposer = null;
    state.chatPendingSend = null;
    clearChatFailureDiagnostic();
    renderThreads();
    state.chatGeneration = acceptedGeneration;
    state.chatAfterSequence = 0;
    state.chatOutput = "";
    if (state.mode === "chat" && state.chatThreadId === acceptedGeneration.threadId) {
      messageNode("user", workflow.text, {
        runId: acceptedGeneration.generationId,
        ...(workflow.localPreviews.length === 0 ? {} : { localAttachments: workflow.localPreviews }),
      });
    }
    // The server now owns this exact turn. Release the canonical byte set and
    // its pre-serialized retry body before waiting on LocalLLM output; only
    // the bounded visible Blob previews remain in the conversation DOM.
    workflow.localPreviews = Object.freeze([]);
    const onAccepted = workflow.onAccepted;
    workflow.onAccepted = null;
    try { onAccepted?.(); } catch { /* Acceptance must not be undone by local cleanup. */ }
    if (acceptedGeneration.terminal) await finishChatGeneration(acceptedGeneration, new AbortController());
    else await streamChatGeneration(acceptedGeneration);
  }

  async function sendChat(text, attachments = Object.freeze([]), {
    localPreviews = Object.freeze([]), onAccepted = null,
  } = {}) {
    if (state.chatPendingSend) throw new TypeError("a durable chat request is already pending");
    if (state.chatGeneration?.status === "in_progress") throw new TypeError("the current generation must finish or be cancelled first");
    const workflow = {
      text,
      attachments,
      localPreviews,
      threadTicket: null,
      threadDispatched: false,
      thread: null,
      runTicket: null,
      runDispatched: false,
      lockedComposer: null,
      recoveryComposer: null,
      failureStage: "before_run_dispatch",
      ambiguousMutation: null,
      onAccepted,
    };
    // The workflow is the only owner until server acceptance. Clear the
    // parameter bindings because this frame stays alive for the full stream.
    attachments = Object.freeze([]);
    localPreviews = Object.freeze([]);
    onAccepted = null;
    state.chatPendingSend = workflow;
    renderThreads();
    try { await continueChatSend(workflow); }
    catch (error) {
      const authenticationAfterAmbiguousDispatch = workflow.ambiguousMutation !== null
        && isChatAuthenticationAfterAmbiguousDispatch(error);
      if (authenticationAfterAmbiguousDispatch) {
        elements.resume_run.hidden = false;
        renderThreads();
        throw error;
      }
      const authoritativeRejection = isAuthoritativeChatRejection(error);
      const notSent = error instanceof LocalChatNotSentError || authoritativeRejection
        || (!workflow.runDispatched && (!workflow.threadDispatched || workflow.thread !== null));
      if (notSent) {
        if (state.chatPendingSend === workflow) state.chatPendingSend = null;
        elements.resume_run.hidden = true;
      } else {
        elements.resume_run.hidden = false;
      }
      renderThreads();
      throw notSent && !(error instanceof LocalChatNotSentError)
        ? new LocalChatNotSentError(workflow.failureStage, error)
        : error;
    }
  }

  async function selectImage() {
    if (interactionLocked() || !state.session.authenticated || state.mode !== "chat"
        || state.chatCapabilities.visionInput !== true || state.chatPendingSend !== null
        || state.chatPendingDeletion !== null || state.logoutPending) return;
    const files = elements.image_input.files;
    if (!files || files.length < 1) {
      elements.image_input.value = "";
      updateImageControl();
      return;
    }
    const selectedFiles = Array.from(files);
    if (state.selectedImages.length + selectedFiles.length > COMPOSER_IMAGE_COUNT_LIMIT) {
      elements.image_input.value = "";
      showToast(`Choose up to ${COMPOSER_IMAGE_COUNT_LIMIT} JPEG, PNG, HEIC, or HEIF still images per message.`);
      updateImageControl();
      return;
    }
    const selectionEpoch = state.imageSelectionEpoch;
    const PreparationAbortController = window?.AbortController ?? globalThis.AbortController;
    const preparationController = typeof PreparationAbortController === "function"
      ? new PreparationAbortController()
      : null;
    state.imagePreparationAbort = preparationController;
    state.imagePreparing = true;
    updateImageControl();
    const prepared = [];
    const previewUrls = [];
    try {
      for (const file of selectedFiles) {
        prepared.push(await canonicalizeImage(file, {
          document,
          makeAttachmentId: createBrowserOpaqueId,
          signal: preparationController?.signal,
          timeoutMs: attachmentDecodeTimeoutMs,
        }));
      }
      if (selectionEpoch !== state.imageSelectionEpoch || !state.imagePreparing
          || !state.session.authenticated || state.mode !== "chat"
          || state.chatCapabilities.visionInput !== true || state.logoutPending) return;
      const combined = [...state.selectedImages, ...prepared];
      const totalBytes = combined.reduce((total, image) => total + image.byteLength, 0);
      if (totalBytes > COMPOSER_IMAGE_BYTES_LIMIT
          || new Set(combined.map((image) => image.attachmentId)).size !== combined.length) {
        throw new TypeError("selected images exceed the aggregate limit");
      }
      for (const selected of prepared) previewUrls.push(createObjectUrl(selected.previewBlob));
      invalidatePreparedUpdateHandoff();
      state.selectedImages = Object.freeze(combined);
      state.selectedImageUrls = Object.freeze([...state.selectedImageUrls, ...previewUrls]);
      previewUrls.length = 0;
      renderSelectedImages();
    } catch (error) {
      if (selectionEpoch === state.imageSelectionEpoch && state.imagePreparing) {
        const actionableHeifFailure = error instanceof VisionImageInputError
          && error.code === "heif_decode_unavailable";
        const timedOut = error instanceof VisionImageInputError
          && error.code === "image_preparation_timeout";
        showToast(actionableHeifFailure || timedOut
          ? error.message
          : "Those images could not be prepared safely. Use up to four JPEG, PNG, HEIC, or HEIF still photos, each up to 24 MiB; the app will downscale them for sending.");
      }
    } finally {
      for (const previewUrl of previewUrls) revokeObjectUrl(previewUrl);
      elements.image_input.value = "";
      if (selectionEpoch === state.imageSelectionEpoch) {
        state.imagePreparing = false;
        if (state.imagePreparationAbort === preparationController) state.imagePreparationAbort = null;
      }
      updateImageControl();
    }
  }

  async function submitMessage(event) {
    event?.preventDefault?.();
    if (interactionLocked() || !state.session.authenticated) return;
    if (state.mode === "chat" && state.chatPendingDeletion) {
      showToast("Retry the pending conversation deletion before sending another message.");
      return;
    }
    if (state.mode === "agent" && (state.agentHistoryRestoring || state.agentReplayFailed)) {
      showToast(state.agentHistoryRestoring
        ? "Wait for verified Agent history to finish restoring before creating more work."
        : "Reopen this conversation before creating more Agent work; its verified history is not available yet.");
      return;
    }
    if (state.mode === "chat" && state.chatPendingSend) {
      showToast("The previous durable send is awaiting confirmation. Use Resume; this draft and its images were not changed.");
      return;
    }
    if (state.imagePreparing) {
      cancelImagePreparation();
      updateImageControl();
      return;
    }
    clearChatFailureDiagnostic();
    const draft = elements.message_input.value;
    let text;
    try { text = boundedMessage(draft); }
    catch { return; }
    if (state.mode === "chat" && state.capabilities.enabled === true && !state.agentReplayFailed
        && state.selectedImages.length === 0 && requestsAgentExecution(text)) {
      setMode("agent", { restoreView: false, remember: false });
      if (state.mode === "agent") {
        newConversation();
        showToast("Handed to Agent to run code and show the result here.");
      }
    }
    const submissionSession = state.session;
    const submissionMode = state.mode;
    const submissionChat = state.chat;
    if (state.mode === "chat") fenceAttachmentRestorationsForSend();
    let detachedImage = state.mode === "chat" ? detachSelectedImage() : null;
    let selected = detachedImage?.selected ?? Object.freeze([]);
    let attachments = Object.freeze(selected.map((image) => Object.freeze({
      attachmentId: image.attachmentId,
      mediaType: image.mediaType,
      byteLength: image.byteLength,
      width: image.width,
      height: image.height,
      bytes: image.bytes,
    })));
    let localPreviews = Object.freeze(selected.map((image) => {
      const previewBlob = image.previewBlob instanceof Blob
        ? image.previewBlob
        : new Blob([image.bytes], { type: image.mediaType });
      return Object.freeze({ mediaType: previewBlob.type || image.mediaType, previewBlob });
    }));
    elements.message_input.value = "";
    state.busy = true;
    elements.send_message.disabled = true;
    updateImageControl();
    try {
      if (state.mode === "agent" && state.capabilities.enabled) await sendAgent(text);
      else await sendChat(text, attachments, {
        localPreviews,
        onAccepted() {
          disposeDetachedImage(detachedImage);
          detachedImage = null;
          selected = Object.freeze([]);
          attachments = Object.freeze([]);
          localPreviews = Object.freeze([]);
        },
      });
    } catch (error) {
      const sameOwner = state.session === submissionSession
        && state.session.authenticated
        && state.mode === submissionMode
        && (submissionMode !== "chat" || state.chat === submissionChat);
      if (!sameOwner) return;
      if (state.mode === "chat" && state.chatPendingSend) {
        state.chatPendingSend.recoveryComposer = Object.freeze({ draft, images: selected });
      }
      const ambiguousAuthenticationWorkflow = state.mode === "chat"
        && state.chatPendingSend?.ambiguousMutation !== null
        && state.chatPendingSend?.ambiguousMutation !== undefined
        && isChatAuthenticationAfterAmbiguousDispatch(error)
        ? state.chatPendingSend
        : null;
      if (ambiguousAuthenticationWorkflow !== null) {
        elements.message_input.value = draft;
        const imageRestored = restoreDetachedImage(detachedImage);
        detachedImage = null;
        ambiguousAuthenticationWorkflow.lockedComposer = Object.freeze({
          draft,
          images: imageRestored ? selected : Object.freeze([]),
        });
        const diagnostic = applyChatFailureDiagnostic(new LocalChatNotSentError(
          ambiguousAuthenticationWorkflow.ambiguousMutation,
          error,
        ));
        connection(`Send confirmation paused · ${diagnostic.label}`, false);
        showToast(imageRestored
          ? "Sign in again. This exact image send may already exist; Resume confirms it without creating a duplicate."
          : "Sign in again. This exact send may already exist; Resume confirms it without creating a duplicate.");
        requireFreshAuthentication({ workflow: ambiguousAuthenticationWorkflow });
      } else if (state.mode === "chat" && error instanceof LocalChatNotSentError) {
        elements.message_input.value = draft;
        const imageRestored = restoreDetachedImage(detachedImage);
        detachedImage = null;
        const diagnostic = applyChatFailureDiagnostic(error);
        showToast(imageRestored
          ? `This image message was not sent. Your prompt and ${selected.length === 1 ? "image" : "images"} are still ready; edit or retry them.`
          : "This message was not sent. Your prompt is still in the composer; edit it and try again.");
        if (diagnostic.reauthenticate) requireFreshAuthentication();
      } else if (state.mode === "chat" && state.chatPendingSend && !state.chatPendingSend.runDispatched) {
        elements.message_input.value = draft;
        const imageRestored = restoreDetachedImage(detachedImage);
        detachedImage = null;
        state.chatPendingSend.lockedComposer = Object.freeze({
          draft,
          images: imageRestored ? selected : Object.freeze([]),
        });
        connection("Thread confirmation pending", false);
        showToast(imageRestored
          ? `The thread may already exist. Your prompt and ${selected.length === 1 ? "image" : "images"} remain visible and locked; Resume confirms the exact send.`
          : "The thread may already exist. Your prompt remains visible and locked; Resume confirms the exact send.");
      } else {
        if (state.mode === "agent") {
          connection("Request interrupted", false);
          showToast("AgInTi did not accept or complete this request. Existing server work was not replaced.");
        } else if (state.chatPendingSend) {
          connection("Send confirmation pending", false);
          showToast("The durable send is awaiting confirmation. Resume reuses it without dispatching a duplicate.");
        } else if (state.chatGeneration?.status === "in_progress") {
          connection("Generation connection paused", false);
          showToast("The LocalLLM generation remains server-owned. Resume reconnects to it without restarting.");
        } else {
          connection("Chat unavailable", false);
          showToast("This chat request could not be completed or safely retried.");
        }
      }
    } finally {
      disposeDetachedImage(detachedImage);
      state.busy = false;
      updateImageControl();
      renderThreads();
    }
  }

  async function authenticated(session, {
    preserveLoginInput = false,
    clearPasswordOnAuthenticated = false,
  } = {}) {
    const recoveringAuthenticationDraft = state.authRecoveryPending;
    const recoveryUsername = state.authRecoveryUsername;
    const recoveryWorkflow = state.authRecoveryWorkflow;
    const recoveryGeneration = state.authRecoveryGeneration;
    state.chatPendingDeletion = null;
    purgeAttachmentBlobCache();
    state.session = sessionEnvelope(session);
    if (!state.session.authenticated) { showLogin("", { preservePassword: preserveLoginInput }); return; }
    const discardedCrossAccountDraft = recoveringAuthenticationDraft
      && normalizedSessionUsername(state.session.username) !== recoveryUsername;
    if (discardedCrossAccountDraft) {
      elements.message_input.value = "";
      clearSelectedImage();
      if (recoveryWorkflow !== null) {
        recoveryWorkflow.text = "";
        recoveryWorkflow.attachments = Object.freeze([]);
        recoveryWorkflow.localPreviews = Object.freeze([]);
        recoveryWorkflow.threadTicket = null;
        recoveryWorkflow.runTicket = null;
        recoveryWorkflow.lockedComposer = null;
        recoveryWorkflow.recoveryComposer = null;
        recoveryWorkflow.ambiguousMutation = null;
      }
      state.authRecoveryPending = false;
      state.authRecoveryUsername = null;
      state.authRecoveryWorkflow = null;
      state.authRecoveryGeneration = null;
    }
    const sameAccountRecoveryWorkflow = discardedCrossAccountDraft ? null : recoveryWorkflow;
    const sameAccountRecoveryGeneration = discardedCrossAccountDraft ? null : recoveryGeneration;
    const authenticatedSession = state.session;
    if (clearPasswordOnAuthenticated) elements.password.value = "";
    elements.logout.disabled = true;
    try {
      state.viewEpoch += 1;
      state.streamAbort?.abort();
      state.agentThreads = [];
      state.chatThreadListEpoch += 1;
      state.chatThreads = [];
      state.agentThreadId = null;
      state.chatThreadId = sameAccountRecoveryGeneration?.threadId ?? null;
      state.chatThread = sameAccountRecoveryGeneration?.thread ?? null;
      state.chatGeneration = sameAccountRecoveryGeneration?.generation ?? null;
      state.chatAfterSequence = sameAccountRecoveryGeneration?.afterSequence ?? 0;
      state.chatOutput = sameAccountRecoveryGeneration?.output ?? "";
      state.chatPendingSend = sameAccountRecoveryWorkflow;
      state.chatPendingDeletion = null;
      state.chatFinalization = null;
      state.runId = null;
      state.agentRunStatus = null;
      state.agentPendingResume = null;
      state.agentReplayFailed = false;
      clearConversation();
      state.agent = createAgentClient(state.session);
      state.chat = createChatClient(state.session);
      requiredMethod(state.agent, "capabilities", "agent client");
      requiredMethod(state.agent, "listThreads", "agent client");
      requiredMethod(state.agent, "streamRunEvents", "agent client");
      for (const method of [
        "capabilities", "prepareThread", "createThread", "retryCreateThread", "listThreads", "getThread",
        "prepareThreadDeletion", "deleteThread", "retryDeleteThread", "listMessages", "getAttachment",
        "prepareRun", "startRun", "retryRun", "getRunStatus", "streamRunEvents", "prepareCancellation", "cancelRun",
      ]) requiredMethod(state.chat, method, "chat client");
      const authenticatedChat = state.chat;
      const startupChatThreads = Object.freeze({
        session: authenticatedSession,
        chat: authenticatedChat,
        result: Promise.resolve()
          .then(() => authenticatedChat.listThreads({ limit: 100 }))
          .then(
            (response) => Object.freeze({ succeeded: true, response }),
            (error) => Object.freeze({ succeeded: false, error }),
          ),
      });
      const readChatCapability = async () => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            const value = chatCapabilityEnvelope(await authenticatedChat.capabilities());
            return { succeeded: true, value };
          } catch {
            if (attempt < 2) await wait(250 * (2 ** attempt));
          }
        }
        return {
          succeeded: false,
          value: Object.freeze({ visionInput: false, visionMediaTypes: Object.freeze([]), maximumImageBytes: 0 }),
        };
      };
      const [rawAgentCapability, chatCapabilityProbe] = await Promise.all([
        Promise.resolve().then(() => state.agent.capabilities()).catch(() => FAIL_CLOSED_AGENT_CAPABILITIES),
        readChatCapability(),
      ]);
      let capability;
      try { capability = validateAgentCapabilities(rawAgentCapability); }
      catch { capability = FAIL_CLOSED_AGENT_CAPABILITIES; }
      const chatCapabilityVerified = chatCapabilityProbe.succeeded;
      const chatCapability = chatCapabilityProbe.value;
      if (state.session !== authenticatedSession || !state.session.authenticated) return;
      state.capabilities = capability;
      state.chatCapabilities = chatCapability;
      const updateHandoff = sameAccountRecoveryWorkflow === null && sameAccountRecoveryGeneration === null
        ? await consumeUpdateHandoff()
        : null;
      if (state.session !== authenticatedSession || !state.session.authenticated) return;
      if (updateHandoff !== null) state.chatThreadId = updateHandoff.threadId;
      if (sameAccountRecoveryWorkflow?.thread) {
        state.chatThread = sameAccountRecoveryWorkflow.thread;
        state.chatThreadId = sameAccountRecoveryWorkflow.thread.threadId;
      }
      showApp();
      const forcedChatMode = updateHandoff !== null
        || (recoveringAuthenticationDraft && !discardedCrossAccountDraft);
      setMode(forcedChatMode
        ? "chat"
        : restoreWorkspaceMode() ?? selectDefaultMode(capability), {
        restoreView: false,
        remember: false,
      });
      const recoveryImageNeedsUserAction = recoveringAuthenticationDraft && !discardedCrossAccountDraft
        && state.selectedImages.length > 0 && chatCapability.visionInput !== true
        && sameAccountRecoveryWorkflow === null;
      state.authRecoveryPending = recoveryImageNeedsUserAction;
      state.authRecoveryUsername = recoveryImageNeedsUserAction
        ? normalizedSessionUsername(state.session.username)
        : null;
      state.authRecoveryWorkflow = null;
      state.authRecoveryGeneration = sameAccountRecoveryGeneration;
      clearChatFailureDiagnostic();
      updateImageControl();
      const restoredUpdateHandoff = restoreUpdateHandoff(updateHandoff);
      if (updateHandoff !== null && !restoredUpdateHandoff) {
        showToast("The saved update draft could not be restored safely and was discarded.");
      }
      if (sameAccountRecoveryWorkflow !== null) {
        connection("Signed in · exact send ready to confirm");
      } else if (sameAccountRecoveryGeneration !== null) {
        connection("Signed in · reconnecting to LocalLLM", false);
      } else if (recoveryImageNeedsUserAction) {
        connection(chatCapabilityVerified
          ? "Signed in · image sending unavailable"
          : "Signed in · image capability unavailable", false);
      } else {
        connection(restoredUpdateHandoff
          ? "Updated · unsent draft ready"
          : recoveringAuthenticationDraft && !discardedCrossAccountDraft
          ? "Signed in · unsent draft ready"
          : "Connected");
      }
      if (discardedCrossAccountDraft) {
        showToast("The previous account’s unsent draft and image were cleared before switching accounts.");
      } else if (recoveryImageNeedsUserAction) {
        showToast(chatCapabilityVerified
          ? "Image sending is unavailable. Your staged image remains visible; remove it to continue without the image."
          : "Image capability could not be confirmed. Your staged image remains visible and unsent; remove it only to continue without the image.");
      }
      try {
        await restoreModeView({
          autoOpen: updateHandoff === null
            && sameAccountRecoveryWorkflow === null && sameAccountRecoveryGeneration === null,
          prefetchedChatThreads: startupChatThreads,
        });
        if (restoredUpdateHandoff && updateHandoff.threadId !== null) {
          const target = state.chatThreads.find((thread) => thread.threadId === updateHandoff.threadId);
          if (target) {
            await openChatThread(target.threadId, {
              backgroundStream: true,
              threadHint: target,
              refreshThreadList: false,
            });
          }
          else state.chatThreadId = null;
        }
      }
      catch (error) {
        if (state.mode === "chat" && isChatAuthenticationRejection(error)
            && requireFreshAuthentication({
              workflow: sameAccountRecoveryWorkflow,
              generationRecovery: sameAccountRecoveryGeneration,
            })) return;
        if (state.mode === "agent") state.agentThreads = [];
        else {
          state.chatThreadListEpoch += 1;
          state.chatThreads = [];
        }
        renderThreads();
        connection(state.mode === "agent" ? "Agent unavailable" : "Chat unavailable", false);
      }
      if (sameAccountRecoveryWorkflow !== null && state.session === authenticatedSession) {
        state.chatPendingSend = sameAccountRecoveryWorkflow;
        if (sameAccountRecoveryWorkflow.thread !== null) {
          state.chatThread = sameAccountRecoveryWorkflow.thread;
          state.chatThreadId = sameAccountRecoveryWorkflow.thread.threadId;
          elements.conversation_title.textContent = sameAccountRecoveryWorkflow.thread.title || "New conversation";
        }
        elements.resume_run.hidden = false;
        connection("Signed in · exact send ready to confirm");
        updateImageControl();
        renderThreads();
      } else if (sameAccountRecoveryGeneration !== null
          && state.session === authenticatedSession && state.session.authenticated) {
        try {
          await reconnectRecoveredChat(sameAccountRecoveryGeneration);
          if (state.session === authenticatedSession && state.session.authenticated) {
            state.authRecoveryGeneration = null;
            updateImageControl();
            renderThreads();
          }
        } catch (error) {
          if (recoverChatReadAuthentication(error, sameAccountRecoveryGeneration)) return;
          state.chatThreadId = sameAccountRecoveryGeneration.threadId;
          state.chatThread = sameAccountRecoveryGeneration.thread;
          state.chatGeneration = sameAccountRecoveryGeneration.generation;
          state.authRecoveryGeneration = sameAccountRecoveryGeneration;
          if (sameAccountRecoveryGeneration.thread !== null) {
            elements.conversation_title.textContent = sameAccountRecoveryGeneration.thread.title || "New conversation";
          }
          elements.resume_run.hidden = false;
          connection("Generation connection paused", false);
          showToast("The server-owned generation could not reconnect yet. Resume retries only authenticated reads.");
        }
      }
    } finally {
      if (state.session === authenticatedSession && state.session.authenticated
          && !state.loginPending && !state.logoutPending && !elements.app_view.hidden) {
        elements.logout.disabled = false;
      }
    }
  }

  async function login(event) {
    event?.preventDefault?.();
    if (!state.loginReady || state.loginPending) return;
    const username = elements.username.value;
    const password = elements.password.value;
    const remember = elements.remember_session.checked === true;
    state.loginPending = true;
    elements.logout.disabled = true;
    loginControl({ ready: false, label: "Signing in…" });
    elements.login_error.hidden = true;
    try {
      const session = await sessionClient.login({ username, password, remember });
      const validatedSession = sessionEnvelope(session);
      if (validatedSession.authenticated && remember) {
        try {
          const saving = credentialSaver(elements.login_form, navigator);
          void Promise.resolve(saving).catch(() => {});
        } catch { /* Password manager is optional. */ }
      }
      elements.password.value = "";
      await authenticated(validatedSession);
    } catch (error) {
      showLogin(loginFailureMessage(error));
    } finally {
      elements.password.value = "";
      state.loginPending = false;
      if (!elements.login_view.hidden) loginControl({ ready: true, label: "Sign in" });
      else if (state.session.authenticated && !state.logoutPending) elements.logout.disabled = false;
    }
  }

  async function logout() {
    if (state.loginPending || state.logoutPending || elements.logout.disabled) return;
    state.logoutPending = true;
    if (state.imagePreparing) cancelImagePreparation();
    elements.logout.disabled = true;
    elements.resume_run.disabled = true;
    updateImageControl();
    let result;
    try { result = logoutEnvelope(await sessionClient.logout()); }
    catch {
      state.logoutPending = false;
      elements.resume_run.disabled = false;
      updateImageControl();
      if (state.session.authenticated && !elements.app_view.hidden) elements.logout.disabled = false;
      showToast("Sign-out could not be confirmed. Please retry.");
      return;
    }
    state.viewEpoch += 1;
    state.streamAbort?.abort();
    state.imageSelectionEpoch += 1;
    state.imagePreparing = false;
    elements.message_input.value = "";
    state.session = Object.freeze({ authenticated: false });
    state.authRecoveryPending = false;
    state.authRecoveryUsername = null;
    state.authRecoveryWorkflow = null;
    state.authRecoveryGeneration = null;
    clearChatFailureDiagnostic();
    state.agent = null;
    state.chat = null;
    state.capabilities = FAIL_CLOSED_AGENT_CAPABILITIES;
    state.agentThreads = [];
    state.chatThreadListEpoch += 1;
    state.chatThreads = [];
    state.agentThreadId = null;
    state.chatThreadId = null;
    state.chatThread = null;
    state.chatGeneration = null;
    state.chatPendingSend = null;
    state.chatPendingDeletion = null;
    state.chatFinalization = null;
    state.chatCapabilities = Object.freeze({ visionInput: false, visionMediaTypes: Object.freeze([]), maximumImageBytes: 0 });
    clearSelectedImage();
    updateImageControl();
    state.runId = null;
    state.agentRunStatus = null;
    state.agentPendingResume = null;
    state.agentReplayFailed = false;
    clearConversation();
    purgeAttachmentBlobCache();
    showLogin();
    loginControl({ ready: true, label: "Sign in" });
    state.logoutPending = false;
    elements.resume_run.disabled = false;
    if (result.agentCancellationPending) showToast("Signed out. AgInTi cancellation is still being confirmed server-side.");
  }

  async function stop() {
    if (state.mode === "agent" && (state.agentHistoryRestoring || state.agentReplayFailed || state.agentCancelPending)) {
      showToast(state.agentHistoryRestoring
        ? "Wait for the read-only Agent history restoration to finish."
        : state.agentCancelPending
          ? "AgInTi cancellation is already awaiting its verified terminal event."
          : "Reopen this conversation to retry its read-only Agent history restoration.");
      return;
    }
    if (state.mode === "agent" && state.runId
        && !TERMINAL.has(state.agentRunStatus)
        && state.capabilities.actions.cancel) {
      const runId = state.runId;
      const threadId = state.agentThreadId;
      const agent = state.agent;
      const presentation = state.presentation;
      const epoch = state.viewEpoch;
      const current = () => state.mode === "agent"
        && state.agent === agent
        && state.viewEpoch === epoch
        && state.runId === runId
        && state.agentThreadId === threadId
        && state.presentation === presentation;
      // Fence a second Stop and every Agent mutation/navigation before the
      // cancellation RPC is dispatched, not after its response arrives.
      state.agentCancelPending = true;
      elements.stop_run.hidden = true;
      elements.resume_run.hidden = true;
      elements.run_state.textContent = "Cancelling";
      connection("Confirming Agent cancellation", false);
      updateImageControl();
      let cancellationRun;
      try {
        const { run } = await agent.cancelRun(runId);
        cancellationRun = correlatedAgentRun(run, { runId, threadId });
      } catch {
        if (current() && !TERMINAL.has(state.agentRunStatus)) {
          state.agentCancelPending = false;
          elements.stop_run.hidden = !state.capabilities.actions.cancel;
          updateImageControl();
          showToast("AgInTi cancellation could not be confirmed.");
        }
        return;
      }
      if (!current()) return;
      // A cancellation acknowledgement is not a terminal ledger event. Keep
      // consuming from cursor zero until run.cancelled is verified. Restarting
      // the read-only ledger stream closes the race where the former iterator
      // ended while the cancellation RPC was in flight.
      if (!TERMINAL.has(state.agentRunStatus)) {
        connection("Waiting for verified Agent cancellation", false);
        state.streamAbort?.abort();
        void streamAgentRun(cancellationRun, {
          expectedRunId: runId,
          expectedThreadId: threadId,
          cancelPending: true,
          offerResume: false,
        }).catch(() => {});
      }
      return;
    }
    if (state.mode === "chat" && state.chatGeneration?.status === "in_progress") {
      const prepared = state.chat.prepareCancellation({
        threadId: state.chatGeneration.threadId,
        generationId: state.chatGeneration.generationId,
      });
      try {
        const result = await exactMutation(
          () => state.chat.cancelRun(prepared),
          () => state.chat.cancelRun(prepared),
        );
        state.chatGeneration = result.generation;
      } catch {
        showToast("LocalLLM cancellation could not be confirmed. The generation remains server-owned.");
        return;
      }
      state.streamAbort?.abort();
      try { await refreshChatThread(state.chatGeneration.threadId); } catch { /* Cancellation itself was confirmed. */ }
      elements.workspace.dataset.status = "cancelled";
      elements.run_state.textContent = "Cancelled";
      elements.resume_run.hidden = true;
      return;
    }
    state.streamAbort?.abort();
  }

  async function resume() {
    if (state.busy || state.logoutPending) return;
    if (state.mode === "agent" && (state.agentHistoryRestoring || state.agentReplayFailed || state.agentCancelPending)) {
      elements.resume_run.hidden = true;
      showToast(state.agentHistoryRestoring
        ? "Wait for the read-only Agent history restoration to finish; no run was resumed."
        : state.agentCancelPending
          ? "Wait for AgInTi's verified cancellation event; no run was resumed."
          : "Reopen this conversation to retry its read-only Agent history restoration; no run was resumed.");
      return;
    }
    if (state.mode === "agent" && state.runId
        && (!state.agentReplayOfferResume || state.agentRunStatus === "completed")) {
      elements.resume_run.hidden = true;
      showToast("This verified Agent run is not resumable.");
      return;
    }
    state.busy = true;
    elements.resume_run.disabled = true;
    updateImageControl();
    let ownsAgentResume = null;
    try {
      if (state.mode === "chat") {
        if (state.authRecoveryGeneration) {
          const recovery = state.authRecoveryGeneration;
          await reconnectRecoveredChat(recovery);
          if (state.session.authenticated && state.authRecoveryGeneration === recovery) {
            state.authRecoveryGeneration = null;
          }
        } else if (state.chatFinalization) {
          const finalization = state.chatFinalization;
          const controller = new AbortController();
          state.streamAbort?.abort();
          state.streamAbort = controller;
          state.streamKind = "chat-finalization";
          try { await finalizeChatGeneration(finalization, controller.signal); }
          finally {
            if (state.streamAbort === controller) {
              state.streamAbort = null;
              state.streamKind = null;
            }
          }
        } else if (state.chatPendingSend) await continueChatSend(state.chatPendingSend);
        else if (state.chatGeneration?.status === "in_progress") await streamChatGeneration(state.chatGeneration, {
          afterSequence: state.chatAfterSequence,
          output: state.chatOutput,
        });
      } else if (state.runId && state.capabilities.enabled && state.capabilities.actions.resume) {
        const requestedRunId = state.runId;
        const requestedThreadId = state.agentThreadId;
        const requestedSession = state.session;
        const requestedAgent = state.agent;
        const requestedEpoch = state.viewEpoch;
        let resumeTicket = state.agentPendingResume;
        if (resumeTicket === null) {
          let draft = null;
          let text;
          if (state.agentRunStatus === "failed" || state.agentRunStatus === "cancelled") {
            const candidate = elements.message_input.value;
            if (candidate !== "") {
              try {
                draft = candidate;
                text = boundedMessage(candidate);
              } catch {
                showToast("The corrected Agent prompt is invalid or too large. Edit it before resuming; no run was resumed.");
                return;
              }
            }
          }
          resumeTicket = Object.freeze({
            session: requestedSession,
            agent: requestedAgent,
            runId: requestedRunId,
            threadId: requestedThreadId,
            epoch: requestedEpoch,
            draft,
            text,
            idempotency: createBrowserOpaqueId("agent_resume"),
          });
          state.agentPendingResume = resumeTicket;
          updateImageControl();
        } else if (resumeTicket.session !== requestedSession
            || resumeTicket.agent !== requestedAgent
            || resumeTicket.runId !== requestedRunId
            || resumeTicket.threadId !== requestedThreadId
            || resumeTicket.epoch !== requestedEpoch) {
          state.agentPendingResume = null;
          showToast("The pending Agent resume no longer owns this view. Reopen the conversation before resuming.");
          return;
        }
        ownsAgentResume = () => state.session === requestedSession
          && state.session.authenticated
          && state.agent === requestedAgent
          && state.mode === "agent"
          && state.viewEpoch === requestedEpoch
          && state.agentThreadId === requestedThreadId
          && state.runId === requestedRunId;
        const response = await requestedAgent.resumeRun(
          requestedRunId,
          resumeTicket.text,
          { idempotency: resumeTicket.idempotency },
        );
        if (!ownsAgentResume() || state.agentPendingResume !== resumeTicket) return;
        const { run } = response;
        const resumedRun = correlatedResumedAgentRun(run, {
          previousRunId: requestedRunId,
          threadId: requestedThreadId,
        });
        if (state.agentPendingResume === resumeTicket) state.agentPendingResume = null;
        if (resumeTicket.text !== undefined) {
          if (elements.message_input.value === resumeTicket.draft) elements.message_input.value = "";
          messageNode("user", resumeTicket.text, { runId: resumedRun.id });
        }
        await streamAgentRun(resumedRun, {
          expectedRunId: resumedRun.id,
          expectedThreadId: requestedThreadId,
        });
      }
    } catch (error) {
      if (ownsAgentResume !== null && !ownsAgentResume()) return;
      if (state.agentPendingResume !== null && error?.retryable === false
          && Number.isSafeInteger(error?.status) && error.status >= 400 && error.status < 499
          && error?.code !== "AGINTI_ABORTED") {
        state.agentPendingResume = null;
      }
      const authenticatedReadRecovery = state.mode === "chat" ? state.authRecoveryGeneration : null;
      const ambiguousAuthenticationWorkflow = state.mode === "chat"
        && state.chatPendingSend?.ambiguousMutation !== null
        && state.chatPendingSend?.ambiguousMutation !== undefined
        && isChatAuthenticationAfterAmbiguousDispatch(error)
        ? state.chatPendingSend
        : null;
      if (authenticatedReadRecovery !== null
          && recoverChatReadAuthentication(error, authenticatedReadRecovery)) {
        /* The exact server-owned read descriptor remains available after same-account sign-in. */
      } else if (ambiguousAuthenticationWorkflow !== null) {
        const diagnostic = applyChatFailureDiagnostic(new LocalChatNotSentError(
          ambiguousAuthenticationWorkflow.ambiguousMutation,
          error,
        ));
        connection(`Send confirmation paused · ${diagnostic.label}`, false);
        showToast("Sign in again, then Resume the same exact send. No new request was created.");
        requireFreshAuthentication({ workflow: ambiguousAuthenticationWorkflow });
      } else if (state.mode === "chat" && state.chatPendingSend && isAuthoritativeChatRejection(error)) {
        releaseRejectedChatWorkflow(state.chatPendingSend, error);
      } else {
        showToast(state.mode === "chat"
          ? "The durable LocalLLM request could not reconnect yet."
          : "AgInTi could not resume this run.");
      }
    } finally {
      state.busy = false;
      elements.resume_run.disabled = false;
      updateImageControl();
      renderThreads();
    }
  }

  function newConversation() {
    if (interactionLocked()) return;
    if (state.mode === "agent" && state.agentReplayFailed) {
      showToast("Reopen an Agent conversation and restore its verified history before creating new work.");
      return;
    }
    if (state.mode === "chat" && state.chatPendingSend) {
      showToast("This durable request has an uncertain response. Use Resume before starting another conversation.");
      return;
    }
    if (state.mode === "chat" && state.chatPendingDeletion) {
      showToast("Retry the pending conversation deletion before starting another conversation.");
      return;
    }
    state.viewEpoch += 1;
    state.streamAbort?.abort();
    if (state.mode === "agent") {
      state.agentThreadId = null;
      state.runId = null;
      state.agentRunStatus = null;
      state.agentPendingResume = null;
    } else {
      state.chatThreadId = null;
      state.chatThread = null;
      state.chatGeneration = null;
      state.chatPendingSend = null;
      state.chatFinalization = null;
      state.chatAfterSequence = 0;
      state.chatOutput = "";
    }
    clearSelectedImage();
    clearChatFailureDiagnostic();
    updateImageControl();
    elements.conversation_title.textContent = "New conversation";
    clearConversation();
    renderThreads();
  }

  function updateHasUnsafeActivity() {
    return state.loginPending || state.logoutPending || state.busy || state.chatFinalization !== null
      || state.chatHistoryRestoration !== null
      || state.imagePreparing || state.chatPendingSend !== null || state.chatPendingDeletion !== null
      || state.authRecoveryGeneration !== null
      || state.agentHistoryRestoring || state.agentReplayValidating || state.agentReplayFailed || state.agentCancelPending
      || state.agentPendingResume !== null
      || (state.chatGeneration && !TERMINAL.has(state.chatGeneration.status))
      || (state.runId && !TERMINAL.has(state.agentRunStatus)) || state.streamAbort !== null;
  }

  function updateComposerWork() {
    return Object.freeze({
      draft: String(elements.message_input.value ?? ""),
      images: state.selectedImages,
    });
  }

  function invalidatePreparedUpdateHandoff() {
    state.updateHandoffEpoch += 1;
    const claim = state.updatePreparedHandoff?.claim ?? state.updateHandoffStagingClaim;
    state.updatePreparedHandoff = null;
    if (claim) void updateHandoffStore.discard(workerScope, claim.handoffId).catch(() => {});
  }

  function updateHandoffMatchesComposer(targetRelease = state.updateTargetRelease) {
    const prepared = state.updatePreparedHandoff;
    const work = updateComposerWork();
    return prepared !== null && prepared.targetRelease === targetRelease
      && prepared.session === state.session && prepared.threadId === state.chatThreadId
      && prepared.draft === work.draft && prepared.images === work.images;
  }

  function updateHandoffEligible(targetRelease) {
    const work = updateComposerWork();
    return !updateHasUnsafeActivity() && state.session.authenticated && state.mode === "chat"
      && !state.authRecoveryPending && validAgentRelease(currentRelease) && validAgentRelease(targetRelease)
      && work.images.length <= 1
      && (work.draft.length > 0 || work.images.length > 0)
      && (work.images.length === 0 || state.chatCapabilities.visionInput === true)
      && (state.chatThreadId === null || UPDATE_HANDOFF_IDENTIFIER.test(state.chatThreadId));
  }

  async function prepareUpdateHandoff(targetRelease) {
    if (state.updatePreparedHandoff !== null && !updateHandoffMatchesComposer(targetRelease)) {
      invalidatePreparedUpdateHandoff();
    }
    if (state.updateHandoffInFlight || !updateHandoffEligible(targetRelease)) return false;
    state.updateHandoffInFlight = true;
    let claim = null;
    elements.apply_update.disabled = true;
    elements.defer_update.disabled = true;
    const epoch = state.updateHandoffEpoch;
    const session = state.session;
    const threadId = state.chatThreadId;
    const { draft, images: selectedImages } = updateComposerWork();
    const selectedImage = selectedImages[0] ?? null;
    try {
      claim = createUpdateHandoffClaim();
      state.updateHandoffStagingClaim = claim;
      const instant = Number(now());
      if (!Number.isSafeInteger(instant) || instant < 0) throw new TypeError("update handoff time is invalid");
      const image = selectedImage === null ? null : updateHandoffImage({
        attachmentId: selectedImage.attachmentId,
        mediaType: selectedImage.mediaType,
        byteLength: selectedImage.byteLength,
        width: selectedImage.width,
        height: selectedImage.height,
        bytes: selectedImage.bytes,
      });
      const accountDigest = await updateHandoffDigest(updateHandoffEncoder.encode(
        `lazying-agent-update-account\u0000${normalizedSessionUsername(session.username)}`,
      ));
      const unsigned = Object.freeze({
        schemaVersion: UPDATE_HANDOFF_SCHEMA_VERSION,
        scope: workerScope,
        sourceRelease: currentRelease,
        targetRelease,
        createdAt: instant,
        accountDigest,
        threadId,
        draft: updateHandoffDraft(draft),
        image,
      });
      const record = Object.freeze({
        ...unsigned,
        digest: await updateHandoffDigest(updateHandoffDigestInput(unsigned)),
      });
      await updateHandoffStore.save(await encryptUpdateHandoff(record, claim));
      if (epoch !== state.updateHandoffEpoch || state.session !== session
          || state.chatThreadId !== threadId || !updateHandoffEligible(targetRelease)
          || elements.message_input.value !== draft || state.selectedImages !== selectedImages) {
        await updateHandoffStore.discard(workerScope, claim.handoffId).catch(() => {});
        return false;
      }
      state.updatePreparedHandoff = Object.freeze({
        targetRelease,
        session,
        threadId,
        draft,
        images: selectedImages,
        claim,
      });
      return true;
    } catch {
      if (claim) await updateHandoffStore.discard(workerScope, claim.handoffId).catch(() => {});
      state.updatePreparedHandoff = null;
      showToast("The update is ready, but this draft and image could not be protected. This page stayed open; retry safely.");
      return false;
    } finally {
      state.updateHandoffInFlight = false;
      state.updateHandoffStagingClaim = null;
      if (!state.updateConfirmed && !state.updateReloaded) {
        elements.apply_update.disabled = false;
        elements.defer_update.disabled = false;
      }
      scheduleSafeUpdateReload();
    }
  }

  async function consumeUpdateHandoff() {
    if (state.updateHandoffConsumed || claimedUpdateHandoff === null
        || !state.session.authenticated || !validAgentRelease(currentRelease)) return null;
    state.updateHandoffConsumed = true;
    let value;
    try { value = await updateHandoffStore.take(workerScope, claimedUpdateHandoff.handoffId); }
    catch {
      showToast("The saved update draft could not be read safely and was not restored.");
      return null;
    }
    if (value === null || value === undefined) {
      showToast("The saved update draft was no longer available and was not restored.");
      return null;
    }
    try {
      return await decryptUpdateHandoff(value, claimedUpdateHandoff, {
        scope: workerScope,
        currentRelease,
        username: state.session.username,
        now,
      });
    } catch {
      showToast("A saved update draft failed its safety checks and was discarded.");
      return null;
    }
  }

  function restoreUpdateHandoff(record) {
    if (record === null || !state.session.authenticated || state.mode !== "chat"
        || state.chatPendingSend !== null || elements.message_input.value || state.selectedImages.length > 0) return false;
    let detached = null;
    try {
      if (record.image !== null) {
        if (state.chatCapabilities.visionInput !== true) return false;
        const previewBlob = new Blob([record.image.bytes], { type: record.image.mediaType });
        const selected = Object.freeze({ ...record.image, previewBlob });
        detached = Object.freeze({
          selected: Object.freeze([selected]),
          previewUrls: Object.freeze([createObjectUrl(previewBlob)]),
        });
        if (!restoreDetachedImage(detached)) return false;
        detached = null;
      }
      elements.message_input.value = record.draft;
      updateImageControl();
      showToast(record.image === null
        ? "Updated app loaded. Your unsent prompt was restored; review it before sending."
        : "Updated app loaded. Your unsent prompt and image were restored; review them before sending.");
      return true;
    } catch {
      disposeDetachedImage(detached);
      return false;
    }
  }

  function updateReloadSafe(targetRelease = state.updateTargetRelease) {
    if (state.updateHandoffInFlight || updateHasUnsafeActivity()) return false;
    if (!state.session.authenticated && String(elements.password.value ?? "").length > 0) return false;
    const work = updateComposerWork();
    return (work.draft.length === 0 && work.images.length === 0)
      || (updateHandoffEligible(targetRelease) && updateHandoffMatchesComposer(targetRelease));
  }

  function clearUpdateReloadTimers() {
    for (const key of ["updateReleaseTimer", "updateSafetyTimer"]) {
      if (state[key] !== null) window?.clearTimeout?.(state[key]);
      state[key] = null;
    }
  }

  function reloadForActiveUpdate() {
    if (!state.updateControllerChanged || state.updateReloaded || !updateReloadSafe(state.updateTargetRelease)) return false;
    if (!validAgentRelease(state.updateTargetRelease)) return false;
    state.updateReloaded = true;
    clearUpdateReloadTimers();
    const releaseId = state.updateTargetRelease;
    const target = new URL(workerScope, window.location.href);
    target.search = `?v=${encodeURIComponent(releaseId)}`;
    target.hash = state.updatePreparedHandoff === null
      ? ""
      : updateHandoffFragment(state.updatePreparedHandoff.claim);
    purgeAttachmentMemory();
    if (typeof window?.location?.replace === "function") window.location.replace(target.href);
    else if (window?.location) window.location.href = target.href;
    return true;
  }

  function waitingUpdateCanActivateAutomatically() {
    const worker = state.updateRegistration?.waiting;
    if (!worker || worker !== state.updateOfferedWorker || state.updateConfirmed) return false;
    if (worker === state.updateDeferredWorker && Number(now()) < state.updateDeferredUntil) return false;
    const releaseId = state.updateKnownWorkerReleases.get(worker);
    if (!validAgentRelease(releaseId)) return false;
    if (validAgentRelease(state.updateActiveControllerRelease)
        && state.updateActiveControllerRelease === releaseId) return false;
    if (state.updateObservedWaitingWorkers.has(worker)) return true;
    return releaseId === currentRelease
      && validAgentRelease(state.updateActiveControllerRelease)
      && state.updateActiveControllerRelease !== currentRelease;
  }

  function scheduleSafeUpdateReload() {
    if (state.updateReloaded || state.updateSafetyTimer !== null) return;
    if (state.updateControllerChanged) {
      if (!validAgentRelease(state.updateTargetRelease)) return;
      if (reloadForActiveUpdate()) return;
    } else if (waitingUpdateCanActivateAutomatically()) {
      const releaseId = state.updateKnownWorkerReleases.get(state.updateRegistration?.waiting);
      if (updateReloadSafe(releaseId)) {
        void activateWaitingUpdate({ announceUnsafe: false });
        return;
      }
    } else return;
    state.updateSafetyTimer = window?.setTimeout?.(() => {
      state.updateSafetyTimer = null;
      scheduleSafeUpdateReload();
    }, 1_000) ?? null;
  }

  async function activateWaitingUpdate({ announceUnsafe = true } = {}) {
    if (state.updateControllerChanged) {
      if (!validAgentRelease(state.updateTargetRelease)) {
        elements.update_banner.hidden = false;
        elements.apply_update.disabled = true;
        void state.retryUpdateControllerRelease?.({ announceFailure: announceUnsafe });
        return false;
      }
      if (!updateReloadSafe(state.updateTargetRelease)) {
        if (announceUnsafe && updateHandoffEligible(state.updateTargetRelease)) {
          if (await prepareUpdateHandoff(state.updateTargetRelease)) {
            return await activateWaitingUpdate({ announceUnsafe });
          }
          return false;
        }
        elements.update_banner.hidden = false;
        if (announceUnsafe && !state.updateHandoffInFlight) {
          showToast("Finish the current draft or response before reloading the updated app.");
        }
        scheduleSafeUpdateReload();
        return false;
      }
      return reloadForActiveUpdate();
    }
    const worker = state.updateRegistration?.waiting;
    if (!worker || worker !== state.updateOfferedWorker || state.updateConfirmed) return false;
    const targetRelease = state.updateKnownWorkerReleases.get(worker);
    if (!updateReloadSafe(targetRelease)) {
      if (announceUnsafe && updateHandoffEligible(targetRelease)) {
        if (await prepareUpdateHandoff(targetRelease)) return await activateWaitingUpdate({ announceUnsafe });
        return false;
      }
      elements.update_banner.hidden = false;
      if (announceUnsafe && !state.updateHandoffInFlight) {
        showToast("Finish the current draft or response before activating the update.");
      }
      scheduleSafeUpdateReload();
      return false;
    }
    state.updateConfirmed = true;
    state.updateConfirmedWorker = worker;
    state.updateDeferredUntil = Number.NEGATIVE_INFINITY;
    state.updateDeferredWorker = null;
    elements.apply_update.disabled = true;
    elements.defer_update.disabled = true;
    try {
      worker.postMessage({ type: "SKIP_WAITING" });
    } catch {
      state.updateConfirmed = false;
      state.updateConfirmedWorker = null;
      invalidatePreparedUpdateHandoff();
      elements.apply_update.disabled = false;
      elements.defer_update.disabled = false;
      elements.update_banner.hidden = false;
      showToast("The update could not be activated. You can retry safely.");
      return false;
    }
    if (state.updateActivationTimer !== null) window?.clearTimeout?.(state.updateActivationTimer);
    state.updateActivationTimer = window?.setTimeout?.(() => {
      if (state.updateControllerChanged || state.updateReloaded) return;
      state.updateConfirmed = false;
      state.updateConfirmedWorker = null;
      state.updateActivationTimer = null;
      invalidatePreparedUpdateHandoff();
      elements.apply_update.disabled = false;
      elements.defer_update.disabled = false;
      elements.update_banner.hidden = state.updateRegistration?.waiting !== state.updateOfferedWorker;
      showToast("The update is still waiting. You can retry or choose Later.");
    }, activationTimeoutMs) ?? null;
    return true;
  }

  function bind() {
    if (state.bound) return;
    state.bound = true;
    elements.login_form.addEventListener("submit", (event) => { void login(event); });
    elements.composer.addEventListener("submit", (event) => { void submitMessage(event); });
    elements.add_image.addEventListener("click", () => elements.image_input.click?.());
    elements.image_input.addEventListener("change", () => { void selectImage(); });
    elements.remove_image.addEventListener("click", () => {
      if (interactionLocked() || state.chatPendingSend) return;
      clearSelectedImage();
      if (state.authRecoveryPending && state.session.authenticated) {
        state.authRecoveryPending = false;
        state.authRecoveryUsername = null;
        state.authRecoveryWorkflow = null;
        connection("Connected");
      }
      updateImageControl();
    });
    elements.logout.addEventListener("click", () => { void logout(); });
    elements.new_thread.addEventListener("click", newConversation);
    elements.stop_run.addEventListener("click", () => { void stop(); });
    elements.resume_run.addEventListener("click", () => { void resume(); });
    elements.agent_mode.addEventListener("click", () => setMode("agent"));
    elements.chat_mode.addEventListener("click", () => setMode("chat"));
    elements.theme_picker.addEventListener("change", () => applyTheme(elements.theme_picker.value, { document }));
    elements.open_sidebar.addEventListener("click", () => { elements.sidebar.dataset.open = "true"; elements.sidebar_scrim.hidden = false; });
    elements.sidebar_scrim.addEventListener("click", () => { elements.sidebar.dataset.open = "false"; elements.sidebar_scrim.hidden = true; });
    elements.apply_update.addEventListener("click", () => { void activateWaitingUpdate(); });
    elements.defer_update.addEventListener("click", () => {
      const worker = state.updateRegistration?.waiting;
      if (!worker || worker !== state.updateOfferedWorker || state.updateConfirmed) return;
      state.updateDeferredWorker = worker;
      state.updateDeferredUntil = Number(now()) + updateDeferralMs;
      elements.update_banner.hidden = true;
      if (state.updateSafetyTimer !== null) window?.clearTimeout?.(state.updateSafetyTimer);
      state.updateSafetyTimer = null;
      if (state.updateDeferralTimer !== null) window?.clearTimeout?.(state.updateDeferralTimer);
      state.updateDeferralTimer = window?.setTimeout?.(() => {
        state.updateDeferralTimer = null;
        state.updateDeferredUntil = Number.NEGATIVE_INFINITY;
        state.showUpdatePrompt?.();
      }, updateDeferralMs) ?? null;
    });
    elements.install_app.addEventListener("click", async () => {
      if (!state.installPrompt) return;
      await state.installPrompt.prompt();
      state.installPrompt = null;
      elements.install_app.hidden = true;
    });
    window?.addEventListener?.("online", () => { elements.offline_banner.hidden = true; connection("Connected"); });
    window?.addEventListener?.("offline", () => { elements.offline_banner.hidden = false; connection("Offline", false); });
    window?.addEventListener?.("pagehide", (event) => {
      if (event?.persisted !== true) purgeAttachmentMemory();
    });
    window?.addEventListener?.("beforeinstallprompt", (event) => {
      event.preventDefault?.();
      state.installPrompt = event;
      elements.install_app.hidden = false;
    });
    for (const input of [elements.username, elements.password, elements.message_input]) {
      input.addEventListener("input", () => {
        if (input === elements.message_input) invalidatePreparedUpdateHandoff();
        if (state.updateSafetyTimer !== null) window?.clearTimeout?.(state.updateSafetyTimer);
        state.updateSafetyTimer = null;
        scheduleSafeUpdateReload();
      });
    }
  }

  async function registerPwa() {
    if (!navigator?.serviceWorker?.register || window?.location?.protocol !== "https:" || currentRelease === null) return;
    try {
      let observedController = navigator.serviceWorker.controller ?? null;
      const controlledAtStartup = observedController !== null;
      let hadController = observedController !== null;
      state.updateController = observedController;
      const queryWorkerRelease = (worker) => {
        const known = state.updateKnownWorkerReleases.get(worker);
        if (known) return Promise.resolve(known);
        const pending = state.updateReleaseQueries.get(worker);
        if (pending) return pending.promise;

        let settle;
        const promise = new Promise((resolve) => { settle = resolve; });
        let timer = null;
        let replyPort = null;
        const query = {
          promise,
          finish(releaseId) {
            if (state.updateReleaseQueries.get(worker) !== query) return;
            state.updateReleaseQueries.delete(worker);
            if (timer !== null) window?.clearTimeout?.(timer);
            try { replyPort?.close?.(); } catch { /* A transferred channel is optional. */ }
            const accepted = validAgentRelease(releaseId) ? releaseId : null;
            if (accepted !== null) state.updateKnownWorkerReleases.set(worker, accepted);
            settle(accepted);
          },
        };
        state.updateReleaseQueries.set(worker, query);
        timer = window?.setTimeout?.(() => query.finish(null), 1_000) ?? null;
        try {
          const Channel = window?.MessageChannel ?? globalThis.MessageChannel;
          const channel = typeof Channel === "function" ? new Channel() : null;
          if (channel?.port1 && channel?.port2) {
            replyPort = channel.port1;
            const receive = (event) => query.finish(agentReleaseMessage(event?.data));
            if (typeof replyPort.addEventListener === "function") replyPort.addEventListener("message", receive, { once: true });
            else replyPort.onmessage = receive;
            replyPort.start?.();
            worker.postMessage({ type: "GET_LAZYING_AGENT_RELEASE" }, [channel.port2]);
          } else {
            worker.postMessage({ type: "GET_LAZYING_AGENT_RELEASE" });
          }
        } catch {
          query.finish(null);
        }
        return promise;
      };
      const queryActiveUpdateRelease = async ({ announceFailure = false } = {}) => {
        const controller = state.updateController;
        if (!state.updateControllerChanged || controller === null || state.updateReloaded) return false;
        const releaseId = await queryWorkerRelease(controller);
        if (state.updateController !== controller || !state.updateControllerChanged || state.updateReloaded) return false;
        if (!validAgentRelease(releaseId)) {
          state.updateTargetRelease = null;
          elements.update_banner.hidden = false;
          elements.apply_update.disabled = false;
          elements.defer_update.disabled = false;
          if (announceFailure) showToast("The updated app version could not be verified yet. Retry keeps this page open safely.");
          return false;
        }
        state.updateActiveControllerRelease = releaseId;
        state.updateTargetRelease = releaseId;
        elements.apply_update.disabled = false;
        elements.defer_update.disabled = false;
        if (state.updateSafetyTimer !== null) window?.clearTimeout?.(state.updateSafetyTimer);
        state.updateSafetyTimer = null;
        scheduleSafeUpdateReload();
        return true;
      };
      state.retryUpdateControllerRelease = queryActiveUpdateRelease;
      navigator.serviceWorker.addEventListener?.("message", (event) => {
        const releaseId = agentReleaseMessage(event?.data);
        if (releaseId === null) return;
        state.updateReleaseQueries.get(event.source)?.finish(releaseId);
        if (event.source !== state.updateController) return;
        state.updateActiveControllerRelease = releaseId;
        if (!state.updateControllerChanged) {
          state.showUpdatePrompt?.();
          return;
        }
        state.updateTargetRelease = releaseId;
        if (state.updateReleaseTimer !== null) window?.clearTimeout?.(state.updateReleaseTimer);
        state.updateReleaseTimer = null;
        if (state.updateSafetyTimer !== null) window?.clearTimeout?.(state.updateSafetyTimer);
        state.updateSafetyTimer = null;
        scheduleSafeUpdateReload();
      });
      navigator.serviceWorker.addEventListener?.("controllerchange", () => {
        const nextController = navigator.serviceWorker.controller ?? null;
        if (nextController === observedController) return;
        observedController = nextController;
        state.updateController = nextController;
        state.updateActiveControllerRelease = null;
        state.updateTargetRelease = null;
        clearUpdateReloadTimers();
        if (!hadController) {
          hadController = nextController !== null;
          return;
        }
        if (nextController === null || state.updateReloaded) return;
        state.updateControllerChanged = true;
        if (state.imagePreparing) {
          cancelImagePreparation();
          updateImageControl();
        }
        if (state.updateActivationTimer !== null) window?.clearTimeout?.(state.updateActivationTimer);
        state.updateActivationTimer = null;
        state.updateConfirmed = false;
        state.updateConfirmedWorker = null;
        state.updateOfferedWorker = null;
        elements.apply_update.disabled = false;
        elements.defer_update.disabled = false;
        elements.update_banner.hidden = false;
        void queryActiveUpdateRelease();
      });
      const registration = await navigator.serviceWorker.register(workerPath, { scope: workerScope, updateViaCache: "none" });
      const offerWaitingWorker = (waiting, releaseId) => {
        if (registration.waiting !== waiting) return;
        const activeControllerIsCurrentPage = releaseId === currentRelease
          && state.updateActiveControllerRelease === currentRelease;
        const noIncumbentWorker = observedController === null && registration.active == null;
        const currentPageReplacesActiveController = releaseId === currentRelease
          && validAgentRelease(state.updateActiveControllerRelease)
          && state.updateActiveControllerRelease !== currentRelease;
        if (releaseId === currentRelease
            && !currentPageReplacesActiveController
            && (activeControllerIsCurrentPage || noIncumbentWorker)) {
          if (state.updateOfferedWorker === waiting) state.updateOfferedWorker = null;
          if (state.updateDeferredWorker === waiting) {
            state.updateDeferredWorker = null;
            state.updateDeferredUntil = Number.NEGATIVE_INFINITY;
          }
          elements.update_banner.hidden = true;
          return;
        }
        if (state.updateConfirmed && waiting === state.updateConfirmedWorker) return;
        if (waiting !== state.updateConfirmedWorker) {
          state.updateConfirmed = false;
          state.updateConfirmedWorker = null;
          elements.apply_update.disabled = false;
          elements.defer_update.disabled = false;
        }
        const sameDeferredWorker = waiting === state.updateDeferredWorker;
        if (sameDeferredWorker && Number(now()) < state.updateDeferredUntil) return;
        state.updateDeferredWorker = null;
        state.updateDeferredUntil = Number.NEGATIVE_INFINITY;
        state.updateRegistration = registration;
        state.updateOfferedWorker = waiting;
        elements.update_banner.hidden = false;
        scheduleSafeUpdateReload();
      };
      const ready = () => {
        const waiting = registration.waiting;
        if (!waiting) {
          if (!state.updateControllerChanged) elements.update_banner.hidden = true;
          state.updateOfferedWorker = null;
          return;
        }
        state.updateRegistration = registration;
        const known = state.updateKnownWorkerReleases.get(waiting);
        if (known) {
          offerWaitingWorker(waiting, known);
          return;
        }
        if (state.updateOfferedWorker !== waiting) elements.update_banner.hidden = true;
        void queryWorkerRelease(waiting).then((releaseId) => offerWaitingWorker(waiting, releaseId));
      };
      state.showUpdatePrompt = ready;
      if (observedController !== null) {
        void queryWorkerRelease(observedController).then((releaseId) => {
          if (state.updateController !== observedController) return;
          state.updateActiveControllerRelease = releaseId;
          ready();
        });
      }
      ready();
      registration.addEventListener?.("updatefound", () => {
        const installing = registration.installing;
        installing?.addEventListener?.("statechange", () => {
          if (registration.waiting === installing) state.updateObservedWaitingWorkers.add(installing);
          ready();
        });
      });
      const checkForUpdate = async ({ force = false, onlineTransition = false } = {}) => {
        const instant = Number(now());
        if (!Number.isFinite(instant)) return false;
        const eligible = force || !(document?.visibilityState === "hidden" || navigator?.onLine === false
          || instant - state.updateCheckAt < updateCheckIntervalMs
          || (!onlineTransition && instant - state.updateFailureAt < 60_000));
        if (state.updateCheckInFlight) {
          if (eligible) {
            state.updateCheckPending = true;
            state.updateCheckPendingOnlineTransition ||= onlineTransition;
          }
          return false;
        }
        if (!eligible) return false;
        state.updateCheckInFlight = true;
        try {
          await registration.update?.();
          state.updateCheckAt = instant;
          state.updateFailureAt = Number.NEGATIVE_INFINITY;
          ready();
        } catch {
          state.updateFailureAt = instant;
          /* The installed shell remains available offline. */
        }
        finally {
          state.updateCheckInFlight = false;
          if (state.updateCheckPending) {
            const pendingOnlineTransition = state.updateCheckPendingOnlineTransition;
            state.updateCheckPending = false;
            state.updateCheckPendingOnlineTransition = false;
            void checkForUpdate({ onlineTransition: pendingOnlineTransition });
          }
        }
        return true;
      };
      const scheduleUpdateCheck = () => {
        if (state.updatePollTimer !== null) return;
        state.updatePollTimer = window?.setTimeout?.(async () => {
          state.updatePollTimer = null;
          await checkForUpdate();
          scheduleUpdateCheck();
        }, updateCheckIntervalMs) ?? null;
      };
      document?.addEventListener?.("visibilitychange", () => { void checkForUpdate(); });
      window?.addEventListener?.("online", () => { void checkForUpdate({ onlineTransition: true }); });
      if (controlledAtStartup) void checkForUpdate({ force: true });
      scheduleUpdateCheck();
    } catch { /* PWA installation is optional; chat remains usable. */ }
  }

  function schedulePwaRegistration() {
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      void registerPwa();
    };
    if (navigator?.serviceWorker?.controller !== null
        && navigator?.serviceWorker?.controller !== undefined) {
      start();
      return;
    }
    if (typeof window?.requestIdleCallback === "function") {
      try {
        window.requestIdleCallback(start, { timeout: 1_000 });
        return;
      } catch { /* The zero-delay fallback still runs after hydration. */ }
    }
    void Promise.resolve().then(start);
  }

  async function initialize() {
    if (state.initialized) return;
    state.initialized = true;
    bind();
    const theme = restoreTheme({ document });
    elements.theme_picker.value = theme;
    elements.offline_banner.hidden = navigator?.onLine !== false;
    try {
      await authenticated(await sessionClient.restore(), {
        preserveLoginInput: true,
        clearPasswordOnAuthenticated: true,
      });
    }
    catch {
      showLogin("The session could not be restored safely.", { preservePassword: true });
      connection("Signed out", false);
    }
    finally {
      if (!state.session.authenticated || !elements.login_view.hidden) {
        loginControl({ ready: true, label: "Sign in" });
      }
    }
    schedulePwaRegistration();
  }

  return Object.freeze({
    initialize,
    submitMessage,
    login,
    logout,
    stop,
    resume,
    openThread,
    deleteChatThread,
    setMode,
  });
}
