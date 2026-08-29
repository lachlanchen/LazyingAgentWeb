import {
  CLOUD_CSRF_HEADER_NAME,
  CloudBrowserProtocolError,
  CloudBrowserTransportError,
  readCloudCsrfCookie,
} from "./cloud-session-client.js";
import {
  addWebReleaseHeader,
  inspectWebReleaseResponse,
  optionalWebRelease,
} from "./web-release.js";

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const JSON_RESPONSE_LIMIT = 512 * 1024;
const ERROR_RESPONSE_LIMIT = 16 * 1024;
const STREAM_RESPONSE_LIMIT = 256 * 1024;
const VISION_IMAGE_LIMIT = 4 * 1024 * 1024;
const VISION_IMAGE_COUNT_LIMIT = 4;
const VISION_IMAGE_TOTAL_LIMIT = 16 * 1024 * 1024;
const VISION_BASE64_LIMIT = Math.ceil(VISION_IMAGE_LIMIT / 3) * 4;
const SSE_BLOCK_LIMIT = 32 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const VISION_MUTATION_TIMEOUT_MS = 270_000;
const DEFAULT_STREAM_TIMEOUT_MS = 45_000;
const ROLLOUT_IN_PROGRESS_CODE = "rollout_in_progress";
const ROLLOUT_RETRY_DEFAULT_SECONDS = 1;
const ROLLOUT_RETRY_MAXIMUM_SECONDS = 5;
const PREPARED_RUN_BODIES = new WeakMap();
const PREPARED_RUN_ATTACHMENTS = new WeakSet();
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._~-]{16,160}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const MODEL_ALIAS = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const ERROR_CODE = /^[a-z][a-z0-9_]{0,79}$/u;
const CSRF_TOKEN = /^[A-Za-z0-9_-]{32,128}$/u;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const GENERATION_STATUSES = new Set(["in_progress", ...TERMINAL_STATUSES]);
const FAILURE_CODES = new Set([
  "provider_unavailable",
  "timeout",
  "internal_error",
  "response_limit",
  "content_rejected",
]);
const UNSAFE_MESSAGE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const encoder = new TextEncoder();

export const DIRECT_CHAT_ROUTES = Object.freeze({
  capabilities: "/api/chat/capabilities",
  threadsList: "/api/chat/threads/list",
  threadsCreate: "/api/chat/threads/create",
  threadsGet: "/api/chat/threads/get",
  threadsDelete: "/api/chat/threads/delete",
  messagesList: "/api/chat/messages/list",
  attachmentsGet: "/api/chat/attachments/get",
  runsStart: "/api/chat/runs/start",
  runsStatus: "/api/chat/runs/status",
  runsEvents: "/api/chat/runs/events",
  runsCancel: "/api/chat/runs/cancel",
});

export class DirectChatProtocolError extends CloudBrowserProtocolError {
  constructor(message, options) {
    super(message, options);
    this.name = "DirectChatProtocolError";
  }
}

export class DirectChatTransportError extends CloudBrowserTransportError {
  constructor(message, options) {
    super(message, options);
    this.name = "DirectChatTransportError";
  }
}

function exactObject(value, allowed, required, label, { input = false } = {}) {
  const fail = (message) => {
    if (input) throw new TypeError(message);
    throw new DirectChatProtocolError(message);
  };
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${label} must be a plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !allowed.includes(key)) fail(`${label} contains an unsupported field`);
    if (!descriptors[key].enumerable || !Object.hasOwn(descriptors[key], "value")) fail(`${label} contains an accessor`);
  }
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`${label}.${key} is required`);
  return value;
}

function exactDenseArrayValues(value, label, { minimum, maximum }) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
      || value.length < minimum || value.length > maximum) {
    throw new TypeError(`${label} is invalid`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const values = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${label} must be dense data`);
    }
    values.push(descriptor.value);
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length) {
      throw new TypeError(`${label} contains an unsupported property`);
    }
  }
  return values;
}

function utf8Length(value) {
  return encoder.encode(value).byteLength;
}

function unicodeScalar(value, label, { minimum = 0, maximum, controls = true, input = false } = {}) {
  const fail = (message) => {
    if (input) throw new TypeError(message);
    throw new DirectChatProtocolError(message);
  };
  if (typeof value !== "string") fail(`${label} must be a string`);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail(`${label} contains invalid Unicode`);
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail(`${label} contains invalid Unicode`);
    }
  }
  const bytes = utf8Length(value);
  if (bytes < minimum || bytes > maximum || value.includes("\u0000")
      || (!controls && /[\u0001-\u001f\u007f]/u.test(value))) {
    fail(`${label} is invalid`);
  }
  return value;
}

function integer(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER, input = false } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    if (input) throw new TypeError(`${label} is invalid`);
    throw new DirectChatProtocolError(`${label} is invalid`);
  }
  return value;
}

function identifier(value, label, { input = false, opaque = false } = {}) {
  if (typeof value !== "string" || !IDENTIFIER.test(value) || (opaque && value.length < 16)) {
    if (input) throw new TypeError(`${label} is invalid`);
    throw new DirectChatProtocolError(`${label} is invalid`);
  }
  return value;
}

function idempotencyKey(value, { input = false } = {}) {
  if (typeof value !== "string" || !IDEMPOTENCY_KEY.test(value)) {
    if (input) throw new TypeError("idempotencyKey is invalid");
    throw new DirectChatProtocolError("idempotencyKey is invalid");
  }
  return value;
}

function hash(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !HASH.test(value)) throw new DirectChatProtocolError(`${label} is invalid`);
  return value;
}

function timestamp(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string") throw new DirectChatProtocolError(`${label} is invalid`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new DirectChatProtocolError(`${label} is invalid`);
  }
  return value;
}

function normalizedBaseOrigin(value) {
  const base = value ?? globalThis.location?.href;
  if (typeof base !== "string") throw new TypeError("baseUrl is required outside a browser");
  const parsed = new URL(base);
  if (!/^https?:$/u.test(parsed.protocol) || parsed.username || parsed.password || parsed.origin === "null") {
    throw new TypeError("baseUrl must be an HTTP(S) URL without credentials");
  }
  return parsed.origin;
}

function cookieReader(source) {
  if (source === undefined) return () => globalThis.document?.cookie ?? "";
  if (typeof source === "function") return source;
  if (typeof source === "string") return () => source;
  throw new TypeError("cookieSource must be a function or string");
}

export function createBrowserOpaqueId(kind = "id") {
  if (typeof kind !== "string" || !/^[a-z][a-z0-9_-]{0,15}$/u.test(kind)) {
    throw new TypeError("opaque identifier kind is invalid");
  }
  let random;
  if (typeof globalThis.crypto?.randomUUID === "function") random = globalThis.crypto.randomUUID();
  else if (typeof globalThis.crypto?.getRandomValues === "function") {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(24));
    random = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  } else {
    throw new TypeError("secure randomness is unavailable");
  }
  return `${kind}_${random}`;
}

function generated(factory, kind, { idempotency = false } = {}) {
  const value = factory(kind);
  return idempotency ? idempotencyKey(value, { input: true }) : identifier(value, kind, { input: true, opaque: true });
}

function responseThread(value, expectedThreadId) {
  const thread = exactObject(value, [
    "threadId", "title", "modelAlias", "revision", "ledgerHash", "messageCount", "ledgerBytes",
    "currentGenerationId", "createdAt", "updatedAt",
  ], [
    "threadId", "title", "modelAlias", "revision", "ledgerHash", "messageCount", "ledgerBytes",
    "currentGenerationId", "createdAt", "updatedAt",
  ], "thread");
  const threadId = identifier(thread.threadId, "thread.threadId");
  if (expectedThreadId !== undefined && threadId !== expectedThreadId) {
    throw new DirectChatProtocolError("thread response ownership does not match the request");
  }
  const revision = integer(thread.revision, "thread.revision", { maximum: 2_000 });
  const ledgerHash = hash(thread.ledgerHash, "thread.ledgerHash", { nullable: revision === 0 });
  if ((revision === 0 && ledgerHash !== null) || (revision > 0 && ledgerHash === null)) {
    throw new DirectChatProtocolError("thread ledger cursor is inconsistent");
  }
  const messageCount = integer(thread.messageCount, "thread.messageCount", { maximum: 2_000 });
  if (messageCount !== revision) throw new DirectChatProtocolError("thread message count is inconsistent");
  const createdAt = timestamp(thread.createdAt, "thread.createdAt");
  const updatedAt = timestamp(thread.updatedAt, "thread.updatedAt");
  if (updatedAt < createdAt) throw new DirectChatProtocolError("thread timestamps are inconsistent");
  if (typeof thread.modelAlias !== "string" || !MODEL_ALIAS.test(thread.modelAlias)) {
    throw new DirectChatProtocolError("thread.modelAlias is invalid");
  }
  const currentGenerationId = thread.currentGenerationId === null
    ? null
    : identifier(thread.currentGenerationId, "thread.currentGenerationId");
  return Object.freeze({
    threadId,
    title: unicodeScalar(thread.title, "thread.title", { maximum: 512, controls: false }),
    modelAlias: thread.modelAlias,
    revision,
    ledgerHash,
    messageCount,
    ledgerBytes: integer(thread.ledgerBytes, "thread.ledgerBytes", { maximum: 8 * 1024 * 1024 }),
    currentGenerationId,
    createdAt,
    updatedAt,
  });
}

function responseMessage(value, expectedThreadId) {
  const message = exactObject(value, [
    "threadId", "messageId", "revision", "role", "content", "contentBytes", "previousHash",
    "messageHash", "generationId", "createdAt", "attachment", "attachments",
  ], [
    "threadId", "messageId", "revision", "role", "content", "contentBytes", "previousHash",
    "messageHash", "generationId", "createdAt",
  ], "message");
  const threadId = identifier(message.threadId, "message.threadId");
  if (threadId !== expectedThreadId) throw new DirectChatProtocolError("message belongs to an unexpected thread");
  const revision = integer(message.revision, "message.revision", { minimum: 1, maximum: 2_000 });
  if (!["user", "assistant"].includes(message.role)) throw new DirectChatProtocolError("message.role is invalid");
  const content = unicodeScalar(message.content, "message.content", { minimum: 1, maximum: 64 * 1024 });
  if (integer(message.contentBytes, "message.contentBytes", { minimum: 1, maximum: 64 * 1024 }) !== utf8Length(content)) {
    throw new DirectChatProtocolError("message.contentBytes is inconsistent");
  }
  const previousHash = hash(message.previousHash, "message.previousHash", { nullable: revision === 1 });
  if ((revision === 1 && previousHash !== null) || (revision > 1 && previousHash === null)) {
    throw new DirectChatProtocolError("message.previousHash is inconsistent");
  }
  const generationId = message.generationId === null
    ? null
    : identifier(message.generationId, "message.generationId");
  if ((message.role === "user" && generationId !== null) || (message.role === "assistant" && generationId === null)) {
    throw new DirectChatProtocolError("message generation ownership is inconsistent");
  }
  if (message.attachment !== undefined && message.attachments !== undefined) {
    throw new DirectChatProtocolError("message attachment shape is ambiguous");
  }
  const rawAttachments = message.attachments ?? (message.attachment === undefined ? [] : [message.attachment]);
  if (!Array.isArray(rawAttachments) || rawAttachments.length > VISION_IMAGE_COUNT_LIMIT
      || (message.attachments !== undefined && rawAttachments.length < 2)) {
    throw new DirectChatProtocolError("message attachment list is invalid");
  }
  const attachments = [];
  const attachmentIds = new Set();
  let attachmentBytes = 0;
  for (const rawAttachment of rawAttachments) {
    const descriptor = exactObject(rawAttachment, [
      "attachmentId", "mediaType", "byteLength", "width", "height", "sha256",
    ], [
      "attachmentId", "mediaType", "byteLength", "width", "height", "sha256",
    ], "message.attachment");
    if (!['image/jpeg', 'image/png'].includes(descriptor.mediaType)
        || typeof descriptor.sha256 !== "string" || !HASH.test(descriptor.sha256)) {
      throw new DirectChatProtocolError("message attachment descriptor is invalid");
    }
    const attachment = Object.freeze({
      attachmentId: identifier(descriptor.attachmentId, "message.attachment.attachmentId"),
      mediaType: descriptor.mediaType,
      byteLength: integer(descriptor.byteLength, "message.attachment.byteLength", { minimum: 1, maximum: VISION_IMAGE_LIMIT }),
      width: integer(descriptor.width, "message.attachment.width", { minimum: 1, maximum: 4_096 }),
      height: integer(descriptor.height, "message.attachment.height", { minimum: 1, maximum: 4_096 }),
      sha256: descriptor.sha256,
    });
    if (attachment.width * attachment.height > 16 * 1024 * 1024 || message.role !== "user") {
      throw new DirectChatProtocolError("message attachment descriptor is invalid");
    }
    if (attachmentIds.has(attachment.attachmentId)) {
      throw new DirectChatProtocolError("message attachment identifiers are not unique");
    }
    attachmentIds.add(attachment.attachmentId);
    attachmentBytes += attachment.byteLength;
    if (attachmentBytes > VISION_IMAGE_TOTAL_LIMIT) {
      throw new DirectChatProtocolError("message attachments exceed the aggregate limit");
    }
    attachments.push(attachment);
  }
  return Object.freeze({
    threadId,
    messageId: identifier(message.messageId, "message.messageId"),
    revision,
    role: message.role,
    content,
    contentBytes: message.contentBytes,
    previousHash,
    messageHash: hash(message.messageHash, "message.messageHash"),
    generationId,
    createdAt: timestamp(message.createdAt, "message.createdAt"),
    ...(attachments.length === 0 ? {} : (attachments.length === 1
      ? { attachment: attachments[0] }
      : { attachments: Object.freeze(attachments) })),
  });
}

function requestAttachment(value) {
  // Canonical browser attachments are frozen below after their generated
  // base64 has passed this exact validator once. Reusing that same object in
  // runTicket() must not rescan several megabytes of image text on an iPhone;
  // cloned or caller-supplied objects still take the full fail-closed path.
  if (PREPARED_RUN_ATTACHMENTS.has(value)) return value;
  const attachment = exactObject(value, ["attachmentId", "mediaType", "data"], [
    "attachmentId", "mediaType", "data",
  ], "prepared run attachment", { input: true });
  if (!['image/jpeg', 'image/png'].includes(attachment.mediaType)
      || typeof attachment.data !== "string" || attachment.data.length < 4
      || attachment.data.length > VISION_BASE64_LIMIT || attachment.data.length % 4 !== 0
      || !boundedBase64(attachment.data)) {
    throw new TypeError("prepared run attachment is invalid");
  }
  return Object.freeze({
    attachmentId: identifier(attachment.attachmentId, "attachmentId", { input: true, opaque: true }),
    mediaType: attachment.mediaType,
    data: attachment.data,
  });
}

function boundedBase64(value) {
  let padding = 0;
  if (value.endsWith("=")) padding = value.endsWith("==") ? 2 : 1;
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

function decodedBase64Length(value) {
  return (value.length / 4) * 3 - (value.endsWith("==") ? 2 : (value.endsWith("=") ? 1 : 0));
}

function bytesToBase64(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > VISION_IMAGE_LIMIT) {
    throw new TypeError("attachment bytes are invalid");
  }
  if (typeof bytes.toBase64 === "function") {
    const encoded = bytes.toBase64();
    if (typeof encoded !== "string" || encoded.length !== Math.ceil(bytes.byteLength / 3) * 4
        || !boundedBase64(encoded)) {
      throw new TypeError("native attachment base64 encoding is invalid");
    }
    return encoded;
  }
  // Keep both the temporary binary string and every spread call small. A
  // single multi-megabyte binary join materially increases peak memory in a
  // mobile PWA before JSON serialization makes the required wire copy.
  const encoded = [];
  const encodingChunkBytes = 12 * 1024; // Divisible by three, so only the final chunk is padded.
  const spreadChunkBytes = 1024;
  for (let offset = 0; offset < bytes.byteLength; offset += encodingChunkBytes) {
    const end = Math.min(offset + encodingChunkBytes, bytes.byteLength);
    let binary = "";
    for (let cursor = offset; cursor < end; cursor += spreadChunkBytes) {
      binary += String.fromCharCode(...bytes.subarray(cursor, Math.min(cursor + spreadChunkBytes, end)));
    }
    encoded.push(btoa(binary));
  }
  return encoded.join("");
}

async function sha256Bytes(bytes) {
  if (typeof globalThis.crypto?.subtle?.digest !== "function") {
    throw new DirectChatProtocolError("secure attachment verification is unavailable");
  }
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalAttachment(value) {
  const attachment = exactObject(value, [
    "attachmentId", "mediaType", "byteLength", "width", "height", "bytes",
  ], [
    "attachmentId", "mediaType", "byteLength", "width", "height", "bytes",
  ], "canonical image attachment", { input: true });
  if (!['image/jpeg', 'image/png'].includes(attachment.mediaType)
      || !(attachment.bytes instanceof Uint8Array)
      || attachment.byteLength !== attachment.bytes.byteLength
      || !Number.isSafeInteger(attachment.width) || attachment.width < 1 || attachment.width > 4_096
      || !Number.isSafeInteger(attachment.height) || attachment.height < 1 || attachment.height > 4_096
      || attachment.width * attachment.height > 16 * 1024 * 1024) {
    throw new TypeError("canonical image attachment is invalid");
  }
  const prepared = requestAttachment({
    attachmentId: attachment.attachmentId,
    mediaType: attachment.mediaType,
    data: bytesToBase64(attachment.bytes),
  });
  PREPARED_RUN_ATTACHMENTS.add(prepared);
  return prepared;
}

function canonicalAttachments(value) {
  const values = exactDenseArrayValues(value, "canonical image attachments", {
    minimum: 2,
    maximum: VISION_IMAGE_COUNT_LIMIT,
  });
  const attachments = [];
  const identifiers = new Set();
  let totalBytes = 0;
  for (const raw of values) {
    const attachment = canonicalAttachment(raw);
    if (identifiers.has(attachment.attachmentId)) {
      throw new TypeError("canonical image attachment identifiers must be unique");
    }
    identifiers.add(attachment.attachmentId);
    totalBytes += decodedBase64Length(attachment.data);
    if (totalBytes > VISION_IMAGE_TOTAL_LIMIT) {
      throw new TypeError("canonical image attachments exceed the aggregate limit");
    }
    attachments.push(attachment);
  }
  return Object.freeze(attachments);
}

function responseGeneration(value, expected = {}) {
  const generation = exactObject(value, [
    "threadId", "generationId", "assistantMessageId", "status", "terminal", "modelAlias",
    "sourceRevision", "sourceHash", "deltaCount", "deltaBytes", "lastDeltaHash", "finalRevision",
    "finalHash", "failureCode", "deltasPruned", "startedAt", "updatedAt", "terminalAt", "prunedAt",
  ], [
    "threadId", "generationId", "assistantMessageId", "status", "terminal", "modelAlias",
    "sourceRevision", "sourceHash", "deltaCount", "deltaBytes", "lastDeltaHash", "finalRevision",
    "finalHash", "failureCode", "deltasPruned", "startedAt", "updatedAt", "terminalAt", "prunedAt",
  ], "generation");
  const threadId = identifier(generation.threadId, "generation.threadId");
  const generationId = identifier(generation.generationId, "generation.generationId");
  if ((expected.threadId !== undefined && threadId !== expected.threadId)
      || (expected.generationId !== undefined && generationId !== expected.generationId)) {
    throw new DirectChatProtocolError("generation ownership does not match the request");
  }
  if (!GENERATION_STATUSES.has(generation.status)) throw new DirectChatProtocolError("generation.status is invalid");
  const terminal = TERMINAL_STATUSES.has(generation.status);
  if (generation.terminal !== terminal) throw new DirectChatProtocolError("generation terminal flag is inconsistent");
  if (typeof generation.modelAlias !== "string" || !MODEL_ALIAS.test(generation.modelAlias)) {
    throw new DirectChatProtocolError("generation.modelAlias is invalid");
  }
  const sourceRevision = integer(generation.sourceRevision, "generation.sourceRevision", { minimum: 1, maximum: 2_000 });
  const deltaCount = integer(generation.deltaCount, "generation.deltaCount", { maximum: 8_192 });
  const deltaBytes = integer(generation.deltaBytes, "generation.deltaBytes", { maximum: 64 * 1024 });
  const lastDeltaHash = hash(generation.lastDeltaHash, "generation.lastDeltaHash", { nullable: deltaCount === 0 });
  if ((deltaCount === 0 && (deltaBytes !== 0 || lastDeltaHash !== null))
      || (deltaCount > 0 && (deltaBytes < 1 || lastDeltaHash === null))) {
    throw new DirectChatProtocolError("generation delta cursor is inconsistent");
  }
  const startedAt = timestamp(generation.startedAt, "generation.startedAt");
  const updatedAt = timestamp(generation.updatedAt, "generation.updatedAt");
  if (updatedAt < startedAt) throw new DirectChatProtocolError("generation timestamps are inconsistent");
  const finalRevision = generation.finalRevision === null
    ? null
    : integer(generation.finalRevision, "generation.finalRevision", { minimum: 1, maximum: 2_000 });
  const finalHash = hash(generation.finalHash, "generation.finalHash", { nullable: true });
  const terminalAt = timestamp(generation.terminalAt, "generation.terminalAt", { nullable: true });
  if (generation.status === "completed") {
    if (deltaCount < 1 || finalRevision !== sourceRevision + 1 || finalHash === null
        || generation.failureCode !== null || terminalAt === null) {
      throw new DirectChatProtocolError("completed generation is inconsistent");
    }
  } else if (generation.status === "in_progress") {
    if (finalRevision !== null || finalHash !== null || generation.failureCode !== null || terminalAt !== null) {
      throw new DirectChatProtocolError("in-progress generation is inconsistent");
    }
  } else {
    if (finalRevision !== null || finalHash !== null || terminalAt === null) {
      throw new DirectChatProtocolError("terminal generation is inconsistent");
    }
    if (generation.status === "failed" && !FAILURE_CODES.has(generation.failureCode)) {
      throw new DirectChatProtocolError("generation.failureCode is invalid");
    }
    if (generation.status === "cancelled" && generation.failureCode !== null) {
      throw new DirectChatProtocolError("cancelled generation has a failure code");
    }
  }
  if (typeof generation.deltasPruned !== "boolean") throw new DirectChatProtocolError("generation.deltasPruned is invalid");
  const prunedAt = timestamp(generation.prunedAt, "generation.prunedAt", { nullable: true });
  if (generation.deltasPruned !== (prunedAt !== null) || (generation.deltasPruned && generation.status !== "completed")) {
    throw new DirectChatProtocolError("generation pruning state is inconsistent");
  }
  return Object.freeze({
    threadId,
    generationId,
    assistantMessageId: identifier(generation.assistantMessageId, "generation.assistantMessageId"),
    status: generation.status,
    terminal,
    modelAlias: generation.modelAlias,
    sourceRevision,
    sourceHash: hash(generation.sourceHash, "generation.sourceHash"),
    deltaCount,
    deltaBytes,
    lastDeltaHash,
    finalRevision,
    finalHash,
    failureCode: generation.failureCode,
    deltasPruned: generation.deltasPruned,
    startedAt,
    updatedAt,
    terminalAt,
    prunedAt,
  });
}

function responseDelta(value, expected, afterSequence) {
  const delta = exactObject(value, [
    "threadId", "generationId", "sequence", "content", "contentBytes", "previousHash", "deltaHash", "createdAt",
  ], [
    "threadId", "generationId", "sequence", "content", "contentBytes", "previousHash", "deltaHash", "createdAt",
  ], "delta");
  if (identifier(delta.threadId, "delta.threadId") !== expected.threadId
      || identifier(delta.generationId, "delta.generationId") !== expected.generationId) {
    throw new DirectChatProtocolError("delta ownership does not match the request");
  }
  const sequence = integer(delta.sequence, "delta.sequence", { minimum: 1, maximum: 8_192 });
  if (sequence !== afterSequence + 1) throw new DirectChatProtocolError("delta sequence is not contiguous");
  const content = unicodeScalar(delta.content, "delta.content", { minimum: 1, maximum: 16 * 1024 });
  if (integer(delta.contentBytes, "delta.contentBytes", { minimum: 1, maximum: 16 * 1024 }) !== utf8Length(content)) {
    throw new DirectChatProtocolError("delta.contentBytes is inconsistent");
  }
  const previousHash = hash(delta.previousHash, "delta.previousHash", { nullable: sequence === 1 });
  if ((sequence === 1 && previousHash !== null) || (sequence > 1 && previousHash === null)) {
    throw new DirectChatProtocolError("delta.previousHash is inconsistent");
  }
  return Object.freeze({
    threadId: delta.threadId,
    generationId: delta.generationId,
    sequence,
    content,
    contentBytes: delta.contentBytes,
    previousHash,
    deltaHash: hash(delta.deltaHash, "delta.deltaHash"),
    createdAt: timestamp(delta.createdAt, "delta.createdAt"),
  });
}

function threadTicket(value) {
  const request = exactObject(value, ["threadId", "title", "idempotencyKey"], ["threadId", "title", "idempotencyKey"], "prepared thread", { input: true });
  return Object.freeze({
    threadId: identifier(request.threadId, "threadId", { input: true, opaque: true }),
    title: unicodeScalar(request.title, "title", { maximum: 512, controls: false, input: true }),
    idempotencyKey: idempotencyKey(request.idempotencyKey, { input: true }),
  });
}

function threadDeletionTicket(value) {
  const request = exactObject(value, [
    "threadId", "expectedRevision", "expectedHash", "idempotencyKey",
  ], [
    "threadId", "expectedRevision", "expectedHash", "idempotencyKey",
  ], "prepared thread deletion", { input: true });
  const expectedRevision = integer(request.expectedRevision, "expectedRevision", {
    maximum: 2_000,
    input: true,
  });
  if ((expectedRevision === 0 && request.expectedHash !== null)
      || (expectedRevision > 0 && (typeof request.expectedHash !== "string" || !HASH.test(request.expectedHash)))) {
    throw new TypeError("expectedHash is inconsistent with expectedRevision");
  }
  return Object.freeze({
    threadId: identifier(request.threadId, "threadId", { input: true }),
    expectedRevision,
    expectedHash: request.expectedHash,
    idempotencyKey: idempotencyKey(request.idempotencyKey, { input: true }),
  });
}

function runTicket(value) {
  const request = exactObject(value, [
    "threadId", "messageId", "generationId", "assistantMessageId", "content",
    "expectedRevision", "expectedHash", "idempotencyKey", "attachment", "attachments",
  ], [
    "threadId", "messageId", "generationId", "assistantMessageId", "content",
    "expectedRevision", "expectedHash", "idempotencyKey",
  ], "prepared run", { input: true });
  const expectedRevision = integer(request.expectedRevision, "expectedRevision", { maximum: 2_000, input: true });
  if ((expectedRevision === 0 && request.expectedHash !== null)
      || (expectedRevision > 0 && (typeof request.expectedHash !== "string" || !HASH.test(request.expectedHash)))) {
    throw new TypeError("expectedHash is inconsistent with expectedRevision");
  }
  const content = unicodeScalar(request.content, "content", {
    minimum: 1,
    maximum: 64 * 1024,
    controls: true,
    input: true,
  }).trim();
  if (!content || UNSAFE_MESSAGE_CONTROL.test(content)) {
    throw new TypeError("content is invalid");
  }
  if (request.attachment !== undefined && request.attachments !== undefined) {
    throw new TypeError("prepared run attachment shape is ambiguous");
  }
  const encodedAttachments = request.attachments === undefined
    ? undefined
    : exactDenseArrayValues(request.attachments, "prepared run attachments", {
      minimum: 2,
      maximum: VISION_IMAGE_COUNT_LIMIT,
    }).map(requestAttachment);
  const result = {
    threadId: identifier(request.threadId, "threadId", { input: true }),
    messageId: identifier(request.messageId, "messageId", { input: true, opaque: true }),
    generationId: identifier(request.generationId, "generationId", { input: true, opaque: true }),
    assistantMessageId: identifier(request.assistantMessageId, "assistantMessageId", { input: true, opaque: true }),
    content,
    expectedRevision,
    expectedHash: request.expectedHash,
    idempotencyKey: idempotencyKey(request.idempotencyKey, { input: true }),
    ...(request.attachment === undefined ? {} : { attachment: requestAttachment(request.attachment) }),
    ...(encodedAttachments === undefined ? {} : {
      attachments: Object.freeze(encodedAttachments),
    }),
  };
  if (result.attachments !== undefined) {
    if (new Set(result.attachments.map((attachment) => attachment.attachmentId)).size !== result.attachments.length) {
      throw new TypeError("prepared run attachments are invalid");
    }
    if (result.attachments.reduce((total, attachment) => total + decodedBase64Length(attachment.data), 0)
        > VISION_IMAGE_TOTAL_LIMIT) {
      throw new TypeError("prepared run attachments exceed the aggregate limit");
    }
  }
  if (new Set([result.messageId, result.generationId, result.assistantMessageId]).size !== 3) {
    throw new TypeError("prepared run identifiers must be distinct");
  }
  return Object.freeze(result);
}

function serializedRunBody(ticket) {
  const { idempotencyKey: _idempotencyKey, ...body } = ticket;
  const serialized = JSON.stringify(body);
  if (typeof serialized !== "string" || serialized.length > 24 * 1024 * 1024) {
    throw new TypeError("prepared run body exceeds the browser request limit");
  }
  return serialized;
}

function cancellationTicket(value) {
  const request = exactObject(value, ["threadId", "generationId", "idempotencyKey"], ["threadId", "generationId", "idempotencyKey"], "prepared cancellation", { input: true });
  return Object.freeze({
    threadId: identifier(request.threadId, "threadId", { input: true }),
    generationId: identifier(request.generationId, "generationId", { input: true }),
    idempotencyKey: idempotencyKey(request.idempotencyKey, { input: true }),
  });
}

function timeoutSignal(signal, timeoutMs) {
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError("signal must be an AbortSignal");
  const controller = new AbortController();
  const forward = () => controller.abort(signal.reason ?? new DOMException("request aborted", "AbortError"));
  if (signal?.aborted) forward();
  else signal?.addEventListener("abort", forward, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException("request timed out", "TimeoutError")), timeoutMs);
  return Object.freeze({
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forward);
    },
  });
}

function mediaType(response) {
  return String(response.headers?.get?.("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
}

function rolloutRetryAfterMs(response) {
  const value = response.headers?.get?.("retry-after");
  const seconds = typeof value === "string" && /^\d+$/u.test(value)
    ? Number(value)
    : ROLLOUT_RETRY_DEFAULT_SECONDS;
  const bounded = Number.isSafeInteger(seconds)
    ? Math.min(ROLLOUT_RETRY_MAXIMUM_SECONDS, Math.max(1, seconds))
    : ROLLOUT_RETRY_DEFAULT_SECONDS;
  return bounded * 1_000;
}

function requireResponse(value) {
  if (value === null || typeof value !== "object" || !Number.isSafeInteger(value.status)
      || value.status < 100 || value.status > 599 || typeof value.headers?.get !== "function") {
    throw new DirectChatProtocolError("Direct Chat transport returned an invalid response");
  }
  return value;
}

function requireNoStore(response) {
  const directives = String(response.headers?.get?.("cache-control") ?? "")
    .toLowerCase().split(",").map((value) => value.trim());
  if (!directives.includes("no-store")) throw new DirectChatProtocolError("Direct Chat response is missing its no-store policy");
}

function detachReader(reader) {
  // A browser is allowed to defer settlement of the underlying source's
  // cancel algorithm. Terminal generation authority has already arrived on
  // the stream, so transport teardown must never keep the composer busy.
  try {
    const cancellation = reader.cancel();
    if (cancellation && typeof cancellation.catch === "function") {
      void cancellation.catch(() => { /* The delivery transport is already detaching. */ });
    }
  } catch { /* The delivery transport is already detaching. */ }
  try { reader.releaseLock?.(); } catch { /* Cancellation still owns the reader. */ }
}

function responseMatchesRoute(response, endpoint) {
  if (response?.redirected === true || response?.type === "opaqueredirect") return false;
  if (typeof response?.url !== "string" || response.url === "") return true;
  try { return new URL(response.url).href === endpoint; }
  catch { return false; }
}

async function readBoundedText(response, maximum) {
  const advertised = response.headers?.get?.("content-length");
  if (advertised !== null && advertised !== undefined
      && (!/^\d+$/u.test(advertised) || Number(advertised) > maximum)) {
    throw new DirectChatProtocolError("Direct Chat response exceeded its size limit");
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    const result = await response.text();
    if (utf8Length(result) > maximum) throw new DirectChatProtocolError("Direct Chat response exceeded its size limit");
    return result;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let result = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new DirectChatProtocolError("Direct Chat response returned a non-byte chunk");
      size += value.byteLength;
      if (size > maximum) throw new DirectChatProtocolError("Direct Chat response exceeded its size limit");
      result += decoder.decode(value, { stream: true });
    }
    result += decoder.decode();
    return result;
  } catch (error) {
    if (error instanceof DirectChatProtocolError) throw error;
    throw new DirectChatProtocolError("Direct Chat response is not valid UTF-8");
  } finally {
    reader.releaseLock?.();
  }
}

async function readBoundedBytes(response, maximum) {
  const advertised = response.headers?.get?.("content-length");
  if (advertised !== null && advertised !== undefined
      && (!/^\d+$/u.test(advertised) || Number(advertised) < 1 || Number(advertised) > maximum)) {
    throw new DirectChatProtocolError("Direct Chat attachment exceeded its size limit");
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength < 1 || bytes.byteLength > maximum) {
      throw new DirectChatProtocolError("Direct Chat attachment exceeded its size limit");
    }
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      if (!(value instanceof Uint8Array)) throw new DirectChatProtocolError("Direct Chat attachment returned a non-byte chunk");
      size += value.byteLength;
      if (size > maximum) throw new DirectChatProtocolError("Direct Chat attachment exceeded its size limit");
      chunks.push(value);
    }
    if (size < 1) throw new DirectChatProtocolError("Direct Chat attachment is empty");
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    if (!completed) detachReader(reader);
    else reader.releaseLock?.();
  }
}

async function responseFailure(response) {
  let code = "request_failed";
  if (mediaType(response) === "application/json") {
    try {
      const parsed = JSON.parse(await readBoundedText(response, ERROR_RESPONSE_LIMIT));
      const envelope = exactObject(parsed, ["error"], ["error"], "error response");
      const error = exactObject(envelope.error, ["code", "message"], ["code", "message"], "error");
      unicodeScalar(error.message, "error.message", { minimum: 1, maximum: 512, controls: false });
      if (typeof error.code === "string" && ERROR_CODE.test(error.code)) code = error.code;
    } catch { code = "request_failed"; }
  }
  const status = Number.isSafeInteger(response?.status) ? response.status : 503;
  return new DirectChatTransportError("Direct Chat request was not accepted.", {
    code,
    status,
    retryable: ["request_aborted", "request_error"].includes(code)
      || [408, 425, 429].includes(status) || status >= 500,
    ...(status === 503 && code === ROLLOUT_IN_PROGRESS_CODE
      ? { retryAfterMs: rolloutRetryAfterMs(response) }
      : {}),
  });
}

function transportFailure(error, signal) {
  if (error instanceof DirectChatProtocolError || error instanceof DirectChatTransportError) return error;
  const reason = signal?.aborted ? signal.reason : error;
  if (reason?.name === "AbortError" || reason?.name === "TimeoutError") {
    return new DirectChatTransportError("Direct Chat request was interrupted.", {
      code: reason.name === "TimeoutError" ? "request_timeout" : "request_aborted",
      status: reason.name === "TimeoutError" ? 504 : 499,
      retryable: reason.name === "TimeoutError",
    });
  }
  return new DirectChatTransportError("Direct Chat service is unavailable.");
}

function requestHeaders(csrf, idempotency, releaseId) {
  const headers = addWebReleaseHeader(new Headers({
    accept: "application/json",
    "content-type": JSON_CONTENT_TYPE,
    [CLOUD_CSRF_HEADER_NAME]: csrf,
  }), releaseId);
  if (idempotency !== undefined) headers.set("idempotency-key", idempotency);
  return headers;
}

function csrfProvider(value) {
  if (value === undefined) return () => undefined;
  if (typeof value === "function") return value;
  if (typeof value === "string") return () => value;
  throw new TypeError("csrfToken must be a function or string");
}

function requirePinnedRelease(response, releaseId) {
  const proof = inspectWebReleaseResponse(response, releaseId);
  if (proof.kind === "unpinned" || proof.kind === "match") return;
  if (proof.kind === "mismatch") {
    throw new DirectChatTransportError("Direct Chat requires the current browser app release.", {
      code: "client_release_mismatch",
      status: 409,
      retryable: false,
      serverRelease: proof.releaseId,
    });
  }
  throw new DirectChatProtocolError("Direct Chat response is missing its release identity");
}

function parseSseBlock(block) {
  if (!block || block.split("\n").every((line) => line === "" || line.startsWith(":"))) return null;
  const fields = Object.create(null);
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const match = /^(id|event|data): ?([^\n]*)$/u.exec(line);
    if (!match || Object.hasOwn(fields, match[1]) || match[2].includes("\u0000")) {
      throw new DirectChatProtocolError("Direct Chat event stream contains an unsupported or repeated field");
    }
    fields[match[1]] = match[2];
  }
  if (!Object.hasOwn(fields, "event") || !Object.hasOwn(fields, "data")) {
    throw new DirectChatProtocolError("Direct Chat event stream block is incomplete");
  }
  let value;
  try { value = JSON.parse(fields.data); }
  catch { throw new DirectChatProtocolError("Direct Chat event stream data is not valid JSON"); }
  return Object.freeze({ id: fields.id, event: fields.event, value });
}

async function* sseBlocks(response) {
  if (!response.body || typeof response.body.getReader !== "function") {
    throw new DirectChatProtocolError("Direct Chat event stream body is unavailable");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let bytes = 0;
  let pendingCarriageReturn = false;
  let completed = false;
  const normalize = (text, flush = false) => {
    let result = "";
    for (const character of text) {
      if (pendingCarriageReturn) {
        result += "\n";
        pendingCarriageReturn = false;
        if (character === "\n") continue;
      }
      if (character === "\r") pendingCarriageReturn = true;
      else result += character;
    }
    if (flush && pendingCarriageReturn) {
      result += "\n";
      pendingCarriageReturn = false;
    }
    return result;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        buffer += normalize(decoder.decode(), true);
        break;
      }
      if (!(value instanceof Uint8Array)) throw new DirectChatProtocolError("Direct Chat stream returned a non-byte chunk");
      bytes += value.byteLength;
      if (bytes > STREAM_RESPONSE_LIMIT) throw new DirectChatProtocolError("Direct Chat stream exceeded its size limit");
      buffer += normalize(decoder.decode(value, { stream: true }));
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, boundary);
        if (utf8Length(block) > SSE_BLOCK_LIMIT) throw new DirectChatProtocolError("Direct Chat SSE block exceeded its size limit");
        buffer = buffer.slice(boundary + 2);
        const parsed = parseSseBlock(block);
        if (parsed) yield parsed;
      }
      if (utf8Length(buffer) > SSE_BLOCK_LIMIT) throw new DirectChatProtocolError("Direct Chat SSE block exceeded its size limit");
    }
    if (buffer.trim() !== "") throw new DirectChatProtocolError("Direct Chat event stream ended with an incomplete block");
  } catch (error) {
    if (error instanceof DirectChatProtocolError || error?.name === "AbortError" || error?.name === "TimeoutError") throw error;
    throw new DirectChatTransportError("Direct Chat event delivery was interrupted.");
  } finally {
    if (!completed) detachReader(reader);
    else reader.releaseLock?.();
  }
}

function eventRequest(value) {
  const request = exactObject(value, [
    "threadId", "generationId", "afterSequence", "signal", "onCursor", "maxReconnects",
  ], ["threadId", "generationId"], "run events request", { input: true });
  const result = {
    threadId: identifier(request.threadId, "threadId", { input: true }),
    generationId: identifier(request.generationId, "generationId", { input: true }),
    afterSequence: integer(request.afterSequence ?? 0, "afterSequence", { maximum: 8_192, input: true }),
    signal: request.signal,
    onCursor: request.onCursor,
    maxReconnects: integer(request.maxReconnects ?? 20, "maxReconnects", { maximum: 100, input: true }),
  };
  if (result.signal !== undefined && !(result.signal instanceof AbortSignal)) throw new TypeError("signal must be an AbortSignal");
  if (result.onCursor !== undefined && typeof result.onCursor !== "function") throw new TypeError("onCursor must be a function");
  return result;
}

export class DirectChatBrowserClient {
  constructor(options = {}) {
    const config = exactObject(options, [
      "baseUrl", "fetchImpl", "cookieSource", "csrfToken", "releaseId", "makeOpaqueId", "timeoutMs", "streamTimeoutMs", "wait",
    ], [], "Direct Chat client options", { input: true });
    const baseUrl = config.baseUrl;
    const fetchImpl = config.fetchImpl ?? globalThis.fetch;
    const cookieSource = config.cookieSource;
    const makeOpaqueId = config.makeOpaqueId ?? createBrowserOpaqueId;
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const streamTimeoutMs = config.streamTimeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS;
    const wait = config.wait ?? ((milliseconds, signal) => new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, milliseconds);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException("request aborted", "AbortError"));
      }, { once: true });
    }));
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
    if (typeof makeOpaqueId !== "function") throw new TypeError("makeOpaqueId must be a function");
    if (typeof wait !== "function") throw new TypeError("wait must be a function");
    for (const [name, value] of [["timeoutMs", timeoutMs], ["streamTimeoutMs", streamTimeoutMs]]) {
      if (!Number.isSafeInteger(value) || value < 1_000 || value > 120_000) throw new TypeError(`${name} is invalid`);
    }
    this.baseOrigin = normalizedBaseOrigin(baseUrl);
    this.fetch = fetchImpl === globalThis.fetch ? fetchImpl.bind(globalThis) : fetchImpl;
    this.readCookie = cookieReader(cookieSource);
    this.readRetainedCsrf = csrfProvider(config.csrfToken);
    this.releaseId = optionalWebRelease(config.releaseId);
    this.makeOpaqueId = makeOpaqueId;
    this.timeoutMs = timeoutMs;
    this.streamTimeoutMs = streamTimeoutMs;
    this.wait = wait;
  }

  #csrf() {
    const cookie = readCloudCsrfCookie(this.readCookie);
    const retained = this.readRetainedCsrf();
    if (retained !== undefined && (typeof retained !== "string" || !CSRF_TOKEN.test(retained))) {
      throw new TypeError("CSRF token is invalid");
    }
    if (cookie !== undefined && retained !== undefined && cookie !== retained) {
      throw new DirectChatTransportError("Direct Chat request was not accepted.", {
        code: "authentication_required",
        status: 401,
        retryable: false,
      });
    }
    const token = cookie ?? retained;
    if (token === undefined) {
      throw new DirectChatTransportError("Direct Chat request was not accepted.", {
        code: "authentication_required",
        status: 401,
        retryable: false,
      });
    }
    return token;
  }

  async #post(route, body, {
    signal, idempotency, expectedStatus = 200, timeoutMs = this.timeoutMs, serializedBody,
  } = {}) {
    const endpoint = `${this.baseOrigin}${route}`;
    // Serialization is a local pre-dispatch operation. Keep allocation errors
    // outside the transport ambiguity boundary so the PWA can truthfully keep
    // the draft as not sent.
    const requestBody = serializedBody ?? JSON.stringify(body);
    const deadline = timeoutSignal(signal, timeoutMs);
    try {
      const response = requireResponse(await this.fetch(endpoint, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "same-origin",
        headers: requestHeaders(this.#csrf(), idempotency, this.releaseId),
        body: requestBody,
        signal: deadline.signal,
      }));
      if (!responseMatchesRoute(response, endpoint)) throw new DirectChatProtocolError("Direct Chat response came from an unexpected URL");
      requirePinnedRelease(response, this.releaseId);
      requireNoStore(response);
      if (response.status !== expectedStatus) throw await responseFailure(response);
      if (mediaType(response) !== "application/json") throw new DirectChatProtocolError("Direct Chat response content type is invalid");
      let value;
      try { value = JSON.parse(await readBoundedText(response, JSON_RESPONSE_LIMIT)); }
      catch (error) {
        if (error instanceof DirectChatProtocolError) throw error;
        throw new DirectChatProtocolError("Direct Chat response is not valid JSON");
      }
      return value;
    } catch (error) {
      throw transportFailure(error, deadline.signal);
    } finally {
      deadline.dispose();
    }
  }

  async #postAttachment(body, expected, { signal } = {}) {
    const endpoint = `${this.baseOrigin}${DIRECT_CHAT_ROUTES.attachmentsGet}`;
    const deadline = timeoutSignal(signal, this.timeoutMs);
    try {
      const response = requireResponse(await this.fetch(endpoint, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "same-origin",
        headers: requestHeaders(this.#csrf(), undefined, this.releaseId),
        body: JSON.stringify(body),
        signal: deadline.signal,
      }));
      if (!responseMatchesRoute(response, endpoint)) throw new DirectChatProtocolError("Direct Chat attachment came from an unexpected URL");
      requirePinnedRelease(response, this.releaseId);
      requireNoStore(response);
      if (response.status !== 200) throw await responseFailure(response);
      if (mediaType(response) !== expected.mediaType) throw new DirectChatProtocolError("Direct Chat attachment content type is invalid");
      const bytes = await readBoundedBytes(response, VISION_IMAGE_LIMIT);
      if (bytes.byteLength !== expected.byteLength) throw new DirectChatProtocolError("Direct Chat attachment size is inconsistent");
      return bytes;
    } catch (error) {
      throw transportFailure(error, deadline.signal);
    } finally {
      deadline.dispose();
    }
  }

  prepareThread(value = {}) {
    const request = exactObject(value, ["title"], [], "new thread", { input: true });
    const title = request.title ?? "";
    return threadTicket({
      threadId: generated(this.makeOpaqueId, "chat"),
      title: unicodeScalar(title, "title", { maximum: 512, controls: false, input: true }),
      idempotencyKey: generated(this.makeOpaqueId, "thread_create", { idempotency: true }),
    });
  }

  async capabilities(value = {}) {
    const request = exactObject(value, ["signal"], [], "chat capabilities request", { input: true });
    const response = exactObject(await this.#post(DIRECT_CHAT_ROUTES.capabilities, {}, {
      signal: request.signal,
    }), ["visionInput", "visionMediaTypes", "maximumImageBytes"], [
      "visionInput", "visionMediaTypes", "maximumImageBytes",
    ], "chat capabilities response");
    if (typeof response.visionInput !== "boolean" || !Array.isArray(response.visionMediaTypes)
        || Object.getPrototypeOf(response.visionMediaTypes) !== Array.prototype
        || response.visionMediaTypes.some((type) => !['image/jpeg', 'image/png'].includes(type))
        || new Set(response.visionMediaTypes).size !== response.visionMediaTypes.length
        || !Number.isSafeInteger(response.maximumImageBytes)
        || (response.visionInput
          ? response.maximumImageBytes !== VISION_IMAGE_LIMIT
            || response.visionMediaTypes.join(',') !== 'image/jpeg,image/png'
          : response.maximumImageBytes !== 0 || response.visionMediaTypes.length !== 0)) {
      throw new DirectChatProtocolError("chat capabilities response is invalid");
    }
    return Object.freeze({
      visionInput: response.visionInput,
      visionMediaTypes: Object.freeze([...response.visionMediaTypes]),
      maximumImageBytes: response.maximumImageBytes,
    });
  }

  async createThread(prepared, options = {}) {
    const { signal } = exactObject(options, ["signal"], [], "create thread options", { input: true });
    const ticket = threadTicket(prepared);
    const response = exactObject(await this.#post(DIRECT_CHAT_ROUTES.threadsCreate, {
      threadId: ticket.threadId,
      title: ticket.title,
    }, { signal, idempotency: ticket.idempotencyKey, expectedStatus: 201 }), ["thread"], ["thread"], "thread creation response");
    return Object.freeze({ request: ticket, thread: responseThread(response.thread, ticket.threadId) });
  }

  retryCreateThread(prepared, options) {
    return this.createThread(prepared, options);
  }

  async listThreads(value = {}) {
    const request = exactObject(value, ["limit", "signal"], [], "thread list request", { input: true });
    const limit = request.limit ?? 50;
    const signal = request.signal;
    integer(limit, "limit", { minimum: 1, maximum: 200, input: true });
    const response = exactObject(await this.#post(DIRECT_CHAT_ROUTES.threadsList, { limit }, { signal }), ["threads"], ["threads"], "thread list response");
    if (!Array.isArray(response.threads) || response.threads.length > 200) throw new DirectChatProtocolError("thread list is invalid");
    const threads = response.threads.map((thread) => responseThread(thread));
    if (new Set(threads.map((thread) => thread.threadId)).size !== threads.length) {
      throw new DirectChatProtocolError("thread list contains a duplicate identifier");
    }
    return Object.freeze({ threads: Object.freeze(threads) });
  }

  async getThread(threadId, options = {}) {
    const { signal } = exactObject(options, ["signal"], [], "get thread options", { input: true });
    identifier(threadId, "threadId", { input: true });
    const response = exactObject(await this.#post(DIRECT_CHAT_ROUTES.threadsGet, { threadId }, { signal }), ["thread"], ["thread"], "thread response");
    return Object.freeze({ thread: responseThread(response.thread, threadId) });
  }

  prepareThreadDeletion(value = {}) {
    const request = exactObject(value, [
      "threadId", "expectedRevision", "expectedHash",
    ], [
      "threadId", "expectedRevision", "expectedHash",
    ], "new thread deletion", { input: true });
    return threadDeletionTicket({
      ...request,
      idempotencyKey: generated(this.makeOpaqueId, "thread_delete", { idempotency: true }),
    });
  }

  async deleteThread(prepared, options = {}) {
    const { signal } = exactObject(options, ["signal"], [], "delete thread options", { input: true });
    const ticket = threadDeletionTicket(prepared);
    const response = exactObject(await this.#post(DIRECT_CHAT_ROUTES.threadsDelete, {
      threadId: ticket.threadId,
      expectedRevision: ticket.expectedRevision,
      expectedHash: ticket.expectedHash,
    }, { signal, idempotency: ticket.idempotencyKey }), ["deleted", "threadId"], [
      "deleted", "threadId",
    ], "thread deletion response");
    if (response.deleted !== true
        || identifier(response.threadId, "thread deletion response threadId") !== ticket.threadId) {
      throw new DirectChatProtocolError("thread deletion response is invalid");
    }
    return Object.freeze({ request: ticket, deleted: true, threadId: ticket.threadId });
  }

  retryDeleteThread(prepared, options) {
    return this.deleteThread(prepared, options);
  }

  async listMessages(value = {}) {
    const request = exactObject(
      value,
      ["threadId", "afterRevision", "limit", "signal"],
      ["threadId"],
      "message list request",
      { input: true },
    );
    const threadId = request.threadId;
    const afterRevision = request.afterRevision ?? 0;
    const limit = request.limit ?? 100;
    const signal = request.signal;
    identifier(threadId, "threadId", { input: true });
    integer(afterRevision, "afterRevision", { maximum: 2_000, input: true });
    integer(limit, "limit", { minimum: 1, maximum: 200, input: true });
    const response = exactObject(await this.#post(DIRECT_CHAT_ROUTES.messagesList, {
      threadId,
      afterRevision,
      limit,
      attachmentSchema: 2,
    }, { signal }), ["messages"], ["messages"], "message list response");
    if (!Array.isArray(response.messages) || response.messages.length > limit) throw new DirectChatProtocolError("message list is invalid");
    const messages = response.messages.map((message) => responseMessage(message, threadId));
    let previousRevision = afterRevision;
    let previousMessageHash;
    for (const message of messages) {
      if (message.revision !== previousRevision + 1) throw new DirectChatProtocolError("message revisions are not contiguous");
      if (previousMessageHash !== undefined && message.previousHash !== previousMessageHash) {
        throw new DirectChatProtocolError("message hash chain is inconsistent");
      }
      previousRevision = message.revision;
      previousMessageHash = message.messageHash;
    }
    return Object.freeze({ messages: Object.freeze(messages) });
  }

  async getAttachment(value = {}) {
    const request = exactObject(value, ["threadId", "attachment", "signal"], [
      "threadId", "attachment",
    ], "attachment request", { input: true });
    const threadId = identifier(request.threadId, "threadId", { input: true });
    const descriptor = exactObject(request.attachment, [
      "attachmentId", "mediaType", "byteLength", "width", "height", "sha256",
    ], [
      "attachmentId", "mediaType", "byteLength", "width", "height", "sha256",
    ], "attachment descriptor", { input: true });
    const normalized = {
      attachmentId: identifier(descriptor.attachmentId, "attachmentId", { input: true }),
      mediaType: descriptor.mediaType,
      byteLength: integer(descriptor.byteLength, "byteLength", { minimum: 1, maximum: VISION_IMAGE_LIMIT, input: true }),
      width: integer(descriptor.width, "width", { minimum: 1, maximum: 4_096, input: true }),
      height: integer(descriptor.height, "height", { minimum: 1, maximum: 4_096, input: true }),
      sha256: descriptor.sha256,
    };
    if (!['image/jpeg', 'image/png'].includes(normalized.mediaType)
        || normalized.width * normalized.height > 16 * 1024 * 1024
        || typeof normalized.sha256 !== "string" || !HASH.test(normalized.sha256)) {
      throw new TypeError("attachment descriptor is invalid");
    }
    const bytes = await this.#postAttachment({ threadId, attachmentId: normalized.attachmentId }, normalized, {
      signal: request.signal,
    });
    if (await sha256Bytes(bytes) !== normalized.sha256) {
      throw new DirectChatProtocolError("Direct Chat attachment digest is inconsistent");
    }
    return Object.freeze({
      descriptor: Object.freeze(normalized),
      bytes,
    });
  }

  prepareRun(value = {}) {
    const request = exactObject(
      value,
      ["threadId", "content", "expectedRevision", "expectedHash", "attachment", "attachments"],
      ["threadId", "content", "expectedRevision", "expectedHash"],
      "new run",
      { input: true },
    );
    const { threadId, content, expectedRevision, expectedHash } = request;
    if (request.attachment !== undefined && request.attachments !== undefined) {
      throw new TypeError("new run attachment shape is ambiguous");
    }
    identifier(threadId, "threadId", { input: true });
    const ids = {
      messageId: generated(this.makeOpaqueId, "message"),
      generationId: generated(this.makeOpaqueId, "generation"),
      assistantMessageId: generated(this.makeOpaqueId, "assistant"),
    };
    const ticket = runTicket({
      threadId,
      ...ids,
      content,
      expectedRevision,
      expectedHash,
      ...(request.attachment === undefined ? {} : { attachment: canonicalAttachment(request.attachment) }),
      ...(request.attachments === undefined ? {} : { attachments: canonicalAttachments(request.attachments) }),
      idempotencyKey: generated(this.makeOpaqueId, "run_start", { idempotency: true }),
    });
    PREPARED_RUN_BODIES.set(ticket, serializedRunBody(ticket));
    return ticket;
  }

  async startRun(prepared, options = {}) {
    const { signal } = exactObject(options, ["signal"], [], "start run options", { input: true });
    // prepareRun() already returned an immutable, fully validated ticket and
    // bound its exact serialized body in this module-private WeakMap. Avoid a
    // second O(base64 bytes) validation pass immediately before mobile fetch;
    // any foreign or cloned ticket remains fully revalidated.
    const ticket = PREPARED_RUN_BODIES.has(prepared) ? prepared : runTicket(prepared);
    const { idempotencyKey: key, ...body } = ticket;
    const serializedBody = PREPARED_RUN_BODIES.get(prepared) ?? serializedRunBody(ticket);
    const response = exactObject(await this.#post(DIRECT_CHAT_ROUTES.runsStart, body, {
      signal,
      idempotency: key,
      expectedStatus: 202,
      timeoutMs: ticket.attachment === undefined && ticket.attachments === undefined
        ? this.timeoutMs
        : Math.max(this.timeoutMs, VISION_MUTATION_TIMEOUT_MS),
      serializedBody,
    }), ["generation"], ["generation"], "run start response");
    return Object.freeze({
      request: ticket,
      generation: responseGeneration(response.generation, ticket),
    });
  }

  retryRun(prepared, options) {
    return this.startRun(prepared, options);
  }

  async getRunStatus(value = {}) {
    const request = exactObject(
      value,
      ["threadId", "generationId", "signal"],
      ["threadId", "generationId"],
      "run status request",
      { input: true },
    );
    const { threadId, generationId, signal } = request;
    identifier(threadId, "threadId", { input: true });
    identifier(generationId, "generationId", { input: true });
    const response = exactObject(await this.#post(DIRECT_CHAT_ROUTES.runsStatus, {
      threadId,
      generationId,
    }, { signal }), ["generation"], ["generation"], "run status response");
    return Object.freeze({ generation: responseGeneration(response.generation, { threadId, generationId }) });
  }

  prepareCancellation(value = {}) {
    const request = exactObject(
      value,
      ["threadId", "generationId"],
      ["threadId", "generationId"],
      "new cancellation",
      { input: true },
    );
    const { threadId, generationId } = request;
    identifier(threadId, "threadId", { input: true });
    identifier(generationId, "generationId", { input: true });
    return cancellationTicket({
      threadId,
      generationId,
      idempotencyKey: generated(this.makeOpaqueId, "run_cancel", { idempotency: true }),
    });
  }

  async cancelRun(prepared, options = {}) {
    const { signal } = exactObject(options, ["signal"], [], "cancel run options", { input: true });
    const ticket = cancellationTicket(prepared);
    const response = exactObject(await this.#post(DIRECT_CHAT_ROUTES.runsCancel, {
      threadId: ticket.threadId,
      generationId: ticket.generationId,
    }, { signal, idempotency: ticket.idempotencyKey }), ["generation"], ["generation"], "run cancellation response");
    const generation = responseGeneration(response.generation, ticket);
    if (generation.status !== "cancelled") throw new DirectChatProtocolError("run cancellation did not return a cancelled generation");
    return Object.freeze({ request: ticket, generation });
  }

  async *streamRunEvents(value = {}) {
    const request = eventRequest(value);
    let afterSequence = request.afterSequence;
    let lastDeliveredDeltaHash;
    let reconnects = 0;
    while (!request.signal?.aborted) {
      const endpoint = `${this.baseOrigin}${DIRECT_CHAT_ROUTES.runsEvents}`;
      const deadline = timeoutSignal(request.signal, this.streamTimeoutMs);
      let reconnect = false;
      try {
        const response = requireResponse(await this.fetch(endpoint, {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          referrerPolicy: "same-origin",
          headers: addWebReleaseHeader(new Headers({
            accept: "text/event-stream",
            "content-type": JSON_CONTENT_TYPE,
            [CLOUD_CSRF_HEADER_NAME]: this.#csrf(),
          }), this.releaseId),
          body: JSON.stringify({
            threadId: request.threadId,
            generationId: request.generationId,
            afterSequence,
          }),
          signal: deadline.signal,
        }));
        if (!responseMatchesRoute(response, endpoint)) throw new DirectChatProtocolError("Direct Chat stream came from an unexpected URL");
        requirePinnedRelease(response, this.releaseId);
        requireNoStore(response);
        if (response.status !== 200) throw await responseFailure(response);
        if (mediaType(response) !== "text/event-stream") throw new DirectChatProtocolError("Direct Chat stream content type is invalid");
        for await (const block of sseBlocks(response)) {
          if (block.event === "delta") {
            if (block.id === undefined || !/^\d+$/u.test(block.id)) throw new DirectChatProtocolError("delta SSE id is invalid");
            const delta = responseDelta(block.value, request, afterSequence);
            if (String(delta.sequence) !== block.id) throw new DirectChatProtocolError("delta SSE id does not match its envelope");
            if (lastDeliveredDeltaHash !== undefined && delta.previousHash !== lastDeliveredDeltaHash) {
              throw new DirectChatProtocolError("delivered delta hash chain is inconsistent");
            }
            afterSequence = delta.sequence;
            lastDeliveredDeltaHash = delta.deltaHash;
            if (request.onCursor) {
              try { await request.onCursor(Object.freeze({ afterSequence }), delta); }
              catch { throw new DirectChatProtocolError("generation cursor persistence failed", { code: "cursor_persistence_failed" }); }
            }
            yield Object.freeze({ type: "delta", delta, afterSequence });
          } else if (block.event === "generation") {
            if (block.id !== undefined) throw new DirectChatProtocolError("generation SSE block may not contain an id");
            const generation = responseGeneration(block.value, request);
            if (!generation.terminal) throw new DirectChatProtocolError("generation SSE block is not terminal");
            if (!generation.deltasPruned && generation.deltaCount !== afterSequence) {
              throw new DirectChatProtocolError("terminal generation cursor does not match delivered deltas");
            }
            if (lastDeliveredDeltaHash !== undefined && generation.lastDeltaHash !== lastDeliveredDeltaHash) {
              throw new DirectChatProtocolError("terminal generation hash does not match delivered deltas");
            }
            yield Object.freeze({ type: "generation", generation, afterSequence });
            return;
          } else if (block.event === "reconnect") {
            if (block.id !== undefined) throw new DirectChatProtocolError("reconnect SSE block may not contain an id");
            const cursor = exactObject(block.value, ["afterSequence"], ["afterSequence"], "reconnect event");
            if (integer(cursor.afterSequence, "reconnect.afterSequence", { maximum: 8_192 }) !== afterSequence) {
              throw new DirectChatProtocolError("reconnect cursor does not match delivered deltas");
            }
            reconnect = true;
          } else {
            throw new DirectChatProtocolError("Direct Chat stream contains an unsupported event type");
          }
        }
        if (!reconnect) throw new DirectChatProtocolError("Direct Chat stream ended without a terminal or reconnect event");
      } catch (error) {
        if (request.signal?.aborted) return;
        const failure = transportFailure(error, deadline.signal);
        if (failure instanceof DirectChatProtocolError || !failure.retryable) throw failure;
        reconnect = true;
      } finally {
        deadline.dispose();
      }
      if (!reconnect) return;
      if (reconnects >= request.maxReconnects) {
        throw new DirectChatTransportError("Direct Chat event delivery was interrupted.", {
          code: "stream_interrupted",
          status: 503,
          retryable: true,
        });
      }
      reconnects += 1;
      try { await this.wait(Math.min(2_000, 100 * (2 ** (reconnects - 1))), request.signal); }
      catch (error) {
        if (request.signal?.aborted) return;
        throw transportFailure(error, request.signal);
      }
    }
  }
}
