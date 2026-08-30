/*
 * Browser-safe public protocol for the AgInTi integration API.
 *
 * This module deliberately contains no agent implementation. It accepts only
 * AgInTi-owned thread, run, event, and artifact envelopes and returns frozen
 * presentation data. Unknown fields fail closed so private runtime state can
 * never silently become part of the cloud UI contract.
 */

export const AGINTI_SCHEMA_VERSION = "1";
export const AGINTI_MAX_FILE_ARTIFACT_BYTES = 16 * 1024 * 1024;
export const AGINTI_IMAGE_ATTACHMENT_MEDIA_TYPES = Object.freeze(["image/png", "image/jpeg"]);
export const AGINTI_IMAGE_ATTACHMENT_COUNT_LIMIT = 4;
export const AGINTI_IMAGE_ATTACHMENT_BYTES_LIMIT = 4 * 1024 * 1024;
export const AGINTI_IMAGE_ATTACHMENT_TOTAL_BYTES_LIMIT = 16 * 1024 * 1024;
export const AGINTI_IMAGE_ATTACHMENT_REQUEST_TIMEOUT_MS = 515_000;

export const AGINTI_RPC_PATHS = Object.freeze({
  capabilities: "/agent/v1/capabilities",
  threadsList: "/agent/v1/threads/list",
  threadsCreate: "/agent/v1/threads/create",
  threadsGet: "/agent/v1/threads/get",
  threadsUpdate: "/agent/v1/threads/update",
  threadsDelete: "/agent/v1/threads/delete",
  runsStart: "/agent/v1/runs/start",
  runsStatus: "/agent/v1/runs/status",
  runsEvents: "/agent/v1/runs/events",
  runsCancel: "/agent/v1/runs/cancel",
  runsResume: "/agent/v1/runs/resume",
  artifactsList: "/agent/v1/artifacts/list",
  artifactsGet: "/agent/v1/artifacts/get",
});

export const AGINTI_EVENT_TYPES = Object.freeze([
  "run.status",
  "plan.updated",
  "context.compacted",
  "tool.started",
  "tool.progress",
  "tool.completed",
  "tool.failed",
  "output.delta",
  "output.completed",
  "artifact.created",
  "artifact.updated",
  "run.completed",
  "run.failed",
  "run.cancelled",
]);

export const AGINTI_RUN_STATUSES = Object.freeze([
  "starting",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

export const AGINTI_SEARCH_MODES = Object.freeze(["web", "papers", "both"]);

export const FAIL_CLOSED_AGENT_CAPABILITIES = Object.freeze({
  schemaVersion: AGINTI_SCHEMA_VERSION,
  enabled: false,
  agent: Object.freeze({ kind: "aginti", label: "AgInTi Agent" }),
  model: Object.freeze({ label: "LocalLLM" }),
  actions: Object.freeze({ cancel: false, resume: false, retry: false }),
  attachments: Object.freeze({ enabled: false }),
  artifacts: Object.freeze({
    kinds: Object.freeze(["plot", "table", "markdown"]),
    schemaVersion: AGINTI_SCHEMA_VERSION,
  }),
});

const EVENT_TYPES = new Set(AGINTI_EVENT_TYPES);
const RUN_STATUSES = new Set(AGINTI_RUN_STATUSES);
const MUTATIONS = new Set([
  AGINTI_RPC_PATHS.threadsCreate,
  AGINTI_RPC_PATHS.threadsUpdate,
  AGINTI_RPC_PATHS.threadsDelete,
  AGINTI_RPC_PATHS.runsStart,
  AGINTI_RPC_PATHS.runsCancel,
  AGINTI_RPC_PATHS.runsResume,
]);
const THREAD_ID = /^thr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const RUN_ID = /^run_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ARTIFACT_ID = /^art_[A-Za-z0-9_-]{32,86}$/u;
const ATTACHMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const FILE_ARTIFACT_MIMES = new Set(["application/pdf", "application/x-tex", "text/x-tex"]);
const PRIVATE_PATH = /(?:^|[\s("'`])\/(?:workspace|home|users|root|etc|usr|var|opt|srv|run|tmp|proc|sys|dev|mnt|media|aginti-(?:home|cache|env))(?:\/|\b)|(?:^|[\s("'`])[A-Za-z]:\\/iu;
const UNSAFE_PRESENTATION = /[<>]|(?:javascript\s*:|(?:https?|data|file)\s*:\/\/)/iu;
const CONTROL = /\u0000|[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const ZERO_HASH = "0".repeat(64);
const MAX_PLOT_MAGNITUDE = Number.MAX_SAFE_INTEGER;
const SEARCH_MODES = new Set(AGINTI_SEARCH_MODES);
const CREDENTIAL_QUERY_NAME = /(?:(?:^|[_-])(?:access[_-]?token|api[_-]?key|auth(?:orization)?|credential|key|password|secret|signature|token)(?:$|[_-])|^(?:(?:aws|google)?accesskeyid|googleaccessid|sig)$)/iu;
const utf8 = new TextEncoder();
const verifiedEvents = new WeakSet();
const preparedImageAttachmentBytes = new WeakMap();

export class AgintiProtocolError extends Error {
  constructor(message, { code = "AGINTI_PROTOCOL_ERROR" } = {}) {
    super(message);
    this.name = "AgintiProtocolError";
    this.code = code;
  }
}

function invalid(message, code) {
  throw new AgintiProtocolError(message, code ? { code } : undefined);
}

function dataProperties(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${label} must be a plain JSON object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid(`${label} must be a plain JSON object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  for (const key of keys) {
    if (typeof key !== "string") invalid(`${label} may not contain symbol keys`);
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      invalid(`${label} must contain only enumerable data properties`);
    }
  }
  return { descriptors, keys };
}

function exact(value, allowed, label, required = allowed) {
  const { keys } = dataProperties(value, label);
  const permitted = new Set(allowed);
  for (const key of keys) {
    if (!permitted.has(key)) invalid(`${label} contains unsupported field ${JSON.stringify(key)}`, "UNSUPPORTED_FIELD");
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) invalid(`${label}.${key} is required`);
  }
  return value;
}

function denseDataArray(value, label, { minimum = 0, maximum } = {}) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    invalid(`${label} must contain ${minimum}-${maximum} entries`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/u.test(key)
        || Number(key) >= value.length) invalid(`${label} contains an unsupported field`);
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      invalid(`${label} must contain only enumerable data entries`);
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(descriptors, String(index))) invalid(`${label} may not contain sparse entries`);
  }
  return value;
}

function boundedInteger(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    invalid(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
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

function boundedText(value, label, maximum, { minimum = 0, presentation = false } = {}) {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
    invalid(`${label} must contain ${minimum}-${maximum} characters`);
  }
  if (!isUnicodeScalarText(value)) invalid(`${label} contains malformed Unicode text`);
  if (CONTROL.test(value)) invalid(`${label} contains forbidden control characters`);
  if (presentation && (UNSAFE_PRESENTATION.test(value) || PRIVATE_PATH.test(value))) {
    invalid(`${label} contains markup, a URL, or a private runtime path`, "UNSAFE_PRESENTATION");
  }
  return value;
}

function label(value, name, maximum = 120) {
  const result = boundedText(value, name, maximum, { minimum: 1, presentation: true }).trim();
  if (!result) invalid(`${name} must contain non-whitespace text`);
  return result;
}

function finite(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(`${name} must be a finite number`);
  return value;
}

function plotNumber(value, name) {
  const result = finite(value, name);
  if (Math.abs(result) > MAX_PLOT_MAGNITUDE) {
    invalid(`${name} exceeds the supported plot magnitude`);
  }
  return result;
}

function validatePlotRange(values, name, { includeZero = false } = {}) {
  let minimum = includeZero ? 0 : Math.min(...values);
  let maximum = includeZero ? 0 : Math.max(...values);
  if (includeZero) {
    minimum = Math.min(minimum, ...values);
    maximum = Math.max(maximum, ...values);
  }
  if (minimum === maximum) {
    minimum -= 1;
    maximum += 1;
  }
  const span = maximum - minimum;
  if (![minimum, maximum, span].every(Number.isFinite) || span <= 0) {
    invalid(`${name} produces an unsupported numeric range`);
  }
}

function timestamp(value, name, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  const result = boundedText(value, name, 40, { minimum: 20 });
  const parsed = new Date(result);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== result) {
    invalid(`${name} must be a canonical UTC ISO timestamp`);
  }
  return result;
}

export function validateThreadId(value) {
  if (typeof value !== "string" || !THREAD_ID.test(value)) invalid("threadId is invalid");
  return value;
}

export function validateRunId(value) {
  if (typeof value !== "string" || !RUN_ID.test(value)) invalid("runId is invalid");
  return value;
}

export function validateArtifactId(value) {
  if (typeof value !== "string" || !ARTIFACT_ID.test(value)) invalid("artifactId is invalid");
  return value;
}

export function validateIdempotencyKey(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._~-]{16,160}$/u.test(value)) {
    invalid("idempotency key must be an opaque 16-160 character identifier", "INVALID_IDEMPOTENCY_KEY");
  }
  return value;
}

export function rpcPathIsMutation(pathname) {
  return MUTATIONS.has(pathname);
}

function title(value, { optional = false } = {}) {
  if (optional && value === undefined) return undefined;
  return label(value, "title", 120);
}

export function validateAgentSearch(value) {
  const search = exact(value, ["mode", "limit"], "input.search");
  if (!SEARCH_MODES.has(search.mode)) invalid("input.search.mode must be web, papers, or both");
  return Object.freeze({
    mode: search.mode,
    limit: boundedInteger(search.limit, "input.search.limit", { minimum: 1, maximum: 20 }),
  });
}

function decodedBase64Length(value) {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function bytesToBase64(bytes) {
  if (typeof bytes.toBase64 === "function") return bytes.toBase64();
  if (typeof globalThis.btoa !== "function") invalid("image base64 encoding is unavailable");
  const parts = [];
  const encodingChunkBytes = 9 * 1024;
  const spreadChunkBytes = 3 * 1024;
  for (let offset = 0; offset < bytes.byteLength; offset += encodingChunkBytes) {
    const end = Math.min(offset + encodingChunkBytes, bytes.byteLength);
    let binary = "";
    for (let cursor = offset; cursor < end; cursor += spreadChunkBytes) {
      binary += String.fromCharCode(...bytes.subarray(cursor, Math.min(cursor + spreadChunkBytes, end)));
    }
    parts.push(globalThis.btoa(binary));
  }
  return parts.join("");
}

function boundedCanonicalBase64(value, label) {
  const maximumCharacters = Math.ceil(AGINTI_IMAGE_ATTACHMENT_BYTES_LIMIT / 3) * 4;
  if (typeof value !== "string" || value.length < 4 || value.length > maximumCharacters || value.length % 4 !== 0) {
    invalid(`${label} is not bounded canonical base64`);
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const contentLength = value.length - padding;
  if ((padding === 0 && contentLength % 4 !== 0)
      || (padding === 1 && contentLength % 4 !== 3)
      || (padding === 2 && contentLength % 4 !== 2)) {
    invalid(`${label} is not bounded canonical base64`);
  }
  for (let index = 0; index < contentLength; index += 1) {
    const code = value.charCodeAt(index);
    if (!((code >= 0x41 && code <= 0x5a)
        || (code >= 0x61 && code <= 0x7a)
        || (code >= 0x30 && code <= 0x39)
        || code === 0x2b || code === 0x2f)) {
      invalid(`${label} is not bounded canonical base64`);
    }
  }
  for (let index = contentLength; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 0x3d) invalid(`${label} is not bounded canonical base64`);
  }
  const finalCode = value.charCodeAt(contentLength - 1);
  const finalSextet = finalCode >= 0x41 && finalCode <= 0x5a ? finalCode - 0x41
    : finalCode >= 0x61 && finalCode <= 0x7a ? finalCode - 0x61 + 26
    : finalCode >= 0x30 && finalCode <= 0x39 ? finalCode - 0x30 + 52
    : finalCode === 0x2b ? 62 : 63;
  if ((padding === 2 && (finalSextet & 0x0f) !== 0)
      || (padding === 1 && (finalSextet & 0x03) !== 0)) {
    invalid(`${label} is not canonical base64`);
  }
  const bytes = decodedBase64Length(value);
  if (!Number.isSafeInteger(bytes) || bytes < 16 || bytes > AGINTI_IMAGE_ATTACHMENT_BYTES_LIMIT) {
    invalid(`${label} exceeds the decoded byte limit`);
  }
  return bytes;
}

function imageAttachment(value, index) {
  const trustedBytes = value && typeof value === "object"
    ? preparedImageAttachmentBytes.get(value)
    : undefined;
  if (trustedBytes !== undefined) {
    return Object.freeze({
      attachmentId: value.attachmentId,
      mediaType: value.mediaType,
      data: value.data,
      byteLength: trustedBytes,
    });
  }
  const attachment = exact(
    value,
    ["attachmentId", "mediaType", "data"],
    `input.attachments[${index}]`,
  );
  if (typeof attachment.attachmentId !== "string" || !ATTACHMENT_ID.test(attachment.attachmentId)) {
    invalid(`input.attachments[${index}].attachmentId is invalid`);
  }
  if (!AGINTI_IMAGE_ATTACHMENT_MEDIA_TYPES.includes(attachment.mediaType)) {
    invalid(`input.attachments[${index}].mediaType is unsupported`);
  }
  const byteLength = boundedCanonicalBase64(attachment.data, `input.attachments[${index}].data`);
  return Object.freeze({
    attachmentId: attachment.attachmentId,
    mediaType: attachment.mediaType,
    data: attachment.data,
    byteLength,
  });
}

export function prepareAgentImageAttachments(value) {
  denseDataArray(value, "canonical image attachments", {
    minimum: 1,
    maximum: AGINTI_IMAGE_ATTACHMENT_COUNT_LIMIT,
  });
  const attachments = [];
  const identifiers = new Set();
  let totalBytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const image = exact(
      value[index],
      ["attachmentId", "mediaType", "byteLength", "width", "height", "bytes"],
      `canonical image attachments[${index}]`,
    );
    if (typeof image.attachmentId !== "string" || !ATTACHMENT_ID.test(image.attachmentId)
        || !AGINTI_IMAGE_ATTACHMENT_MEDIA_TYPES.includes(image.mediaType)
        || !(image.bytes instanceof Uint8Array)
        || !Number.isSafeInteger(image.byteLength) || image.byteLength !== image.bytes.byteLength
        || image.byteLength < 16 || image.byteLength > AGINTI_IMAGE_ATTACHMENT_BYTES_LIMIT
        || !Number.isSafeInteger(image.width) || image.width < 1 || image.width > 4_096
        || !Number.isSafeInteger(image.height) || image.height < 1 || image.height > 4_096
        || image.width * image.height > 16 * 1024 * 1024) {
      invalid(`canonical image attachments[${index}] is invalid`);
    }
    if (identifiers.has(image.attachmentId)) invalid("canonical image attachment identifiers must be unique");
    identifiers.add(image.attachmentId);
    totalBytes += image.byteLength;
    if (totalBytes > AGINTI_IMAGE_ATTACHMENT_TOTAL_BYTES_LIMIT) {
      invalid("canonical image attachments exceed the aggregate decoded byte limit");
    }
    const attachment = Object.freeze({
      attachmentId: image.attachmentId,
      mediaType: image.mediaType,
      data: bytesToBase64(image.bytes),
    });
    preparedImageAttachmentBytes.set(attachment, image.byteLength);
    attachments.push(attachment);
  }
  return Object.freeze(attachments);
}

export function validateAgentImageAttachments(value) {
  denseDataArray(value, "input.attachments", {
    minimum: 1,
    maximum: AGINTI_IMAGE_ATTACHMENT_COUNT_LIMIT,
  });
  const attachments = [];
  const identifiers = new Set();
  let totalBytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const attachment = imageAttachment(value[index], index);
    if (identifiers.has(attachment.attachmentId)) invalid("input attachment identifiers must be unique");
    identifiers.add(attachment.attachmentId);
    totalBytes += attachment.byteLength;
    if (totalBytes > AGINTI_IMAGE_ATTACHMENT_TOTAL_BYTES_LIMIT) {
      invalid("input attachments exceed the aggregate decoded byte limit");
    }
    attachments.push(Object.freeze({
      attachmentId: attachment.attachmentId,
      mediaType: attachment.mediaType,
      data: attachment.data,
    }));
  }
  return Object.freeze(attachments);
}

function input(value, { optional = false } = {}) {
  if (optional && value === undefined) return undefined;
  const object = exact(value, ["text", "search", "attachments"], "input", ["text"]);
  const text = boundedText(object.text, "input.text", 32_000, { minimum: 1 }).trim();
  if (!text) invalid("input.text must contain non-whitespace text");
  if (utf8.encode(text).byteLength > 32 * 1024) invalid("input.text exceeds the UTF-8 byte limit");
  return Object.freeze({
    text,
    ...(object.search === undefined ? {} : { search: validateAgentSearch(object.search) }),
    ...(object.attachments === undefined ? {} : { attachments: validateAgentImageAttachments(object.attachments) }),
  });
}

export function validateAgentRequest(pathname, value = {}) {
  switch (pathname) {
    case AGINTI_RPC_PATHS.capabilities:
      exact(value, [], "request");
      return Object.freeze({});
    case AGINTI_RPC_PATHS.threadsList: {
      const object = exact(value, ["limit", "before"], "request", []);
      return Object.freeze({
        limit: object.limit === undefined ? 50 : boundedInteger(object.limit, "limit", { minimum: 1, maximum: 100 }),
        before: object.before === undefined ? "" : boundedText(object.before, "before", 128),
      });
    }
    case AGINTI_RPC_PATHS.threadsCreate: {
      const object = exact(value, ["title"], "request", []);
      return Object.freeze({ title: title(object.title, { optional: true }) ?? "New agent thread" });
    }
    case AGINTI_RPC_PATHS.threadsGet:
    case AGINTI_RPC_PATHS.threadsDelete: {
      const object = exact(value, ["threadId"], "request");
      return Object.freeze({ threadId: validateThreadId(object.threadId) });
    }
    case AGINTI_RPC_PATHS.threadsUpdate: {
      const object = exact(value, ["threadId", "title"], "request");
      return Object.freeze({ threadId: validateThreadId(object.threadId), title: title(object.title) });
    }
    case AGINTI_RPC_PATHS.runsStart: {
      const object = exact(value, ["threadId", "input"], "request");
      return Object.freeze({ threadId: validateThreadId(object.threadId), input: input(object.input) });
    }
    case AGINTI_RPC_PATHS.runsStatus:
    case AGINTI_RPC_PATHS.runsCancel: {
      const object = exact(value, ["runId"], "request");
      return Object.freeze({ runId: validateRunId(object.runId) });
    }
    case AGINTI_RPC_PATHS.runsEvents: {
      const object = exact(value, ["runId", "afterSeq", "afterHash"], "request");
      const afterSeq = boundedInteger(object.afterSeq, "afterSeq", { maximum: 10_000_000_000 });
      if (typeof object.afterHash !== "string" || !DIGEST.test(object.afterHash)) {
        invalid("afterHash must be a lowercase SHA-256 digest");
      }
      if (afterSeq === 0 && object.afterHash !== ZERO_HASH) {
        invalid("afterHash must be the zero hash when afterSeq is 0");
      }
      if (afterSeq > 0 && object.afterHash === ZERO_HASH) {
        invalid("afterHash must not be the zero hash when afterSeq is greater than 0");
      }
      return Object.freeze({
        runId: validateRunId(object.runId),
        afterSeq,
        afterHash: object.afterHash,
      });
    }
    case AGINTI_RPC_PATHS.runsResume: {
      const object = exact(value, ["runId", "input"], "request", ["runId"]);
      const nextInput = input(object.input, { optional: true });
      return Object.freeze({
        runId: validateRunId(object.runId),
        ...(nextInput === undefined ? {} : { input: nextInput }),
      });
    }
    case AGINTI_RPC_PATHS.artifactsList: {
      const object = exact(value, ["threadId", "runId"], "request", []);
      if ((object.threadId === undefined) === (object.runId === undefined)) {
        invalid("exactly one of threadId or runId is required");
      }
      return Object.freeze(object.threadId === undefined
        ? { runId: validateRunId(object.runId) }
        : { threadId: validateThreadId(object.threadId) });
    }
    case AGINTI_RPC_PATHS.artifactsGet: {
      const object = exact(value, ["artifactId"], "request");
      return Object.freeze({ artifactId: validateArtifactId(object.artifactId) });
    }
    default:
      invalid("unknown AgInTi RPC path", "NOT_FOUND");
  }
}

export function validatePlotSpec(value) {
  const spec = exact(
    value,
    ["schemaVersion", "type", "xLabel", "yLabel", "labels", "series"],
    "plot spec",
    ["schemaVersion", "type", "series"],
  );
  if (spec.schemaVersion !== AGINTI_SCHEMA_VERSION || !["line", "bar", "scatter", "area"].includes(spec.type)) {
    invalid("plot schema version or type is unsupported");
  }
  if (!Array.isArray(spec.series) || spec.series.length < 1 || spec.series.length > 8) {
    invalid("plot series must contain 1-8 entries");
  }
  const categorical = spec.type !== "scatter";
  let labels;
  if (categorical) {
    if (!Array.isArray(spec.labels) || spec.labels.length < 1 || spec.labels.length > 128) {
      invalid("categorical plots require 1-128 labels");
    }
    labels = spec.labels.map((item, index) => label(item, `plot labels[${index}]`, 160));
  } else if (spec.labels !== undefined) {
    invalid("scatter plots do not accept labels");
  }
  let points = 0;
  const names = new Set();
  const series = spec.series.map((entry, index) => {
    const item = exact(
      entry,
      categorical ? ["name", "data"] : ["name", "points"],
      `plot series[${index}]`,
    );
    const name = label(item.name, `plot series[${index}].name`);
    if (names.has(name)) invalid("plot series names must be unique");
    names.add(name);
    if (categorical) {
      if (!Array.isArray(item.data) || item.data.length !== labels.length) {
        invalid(`plot series[${index}].data must match labels length`);
      }
      points += item.data.length;
      return Object.freeze({
        name,
        data: Object.freeze(item.data.map((point, pointIndex) => plotNumber(point, `plot series[${index}].data[${pointIndex}]`))),
      });
    }
    if (!Array.isArray(item.points) || item.points.length < 1) invalid("scatter points must not be empty");
    points += item.points.length;
    return Object.freeze({
      name,
      points: Object.freeze(item.points.map((point, pointIndex) => {
        const pair = exact(point, ["x", "y"], `plot series[${index}].points[${pointIndex}]`);
        return Object.freeze({
          x: plotNumber(pair.x, `plot series[${index}].points[${pointIndex}].x`),
          y: plotNumber(pair.y, `plot series[${index}].points[${pointIndex}].y`),
        });
      })),
    });
  });
  if (points > 500) invalid("plot contains more than 500 total points");
  const normalizedPoints = series.flatMap((entry) => categorical
    ? entry.data.map((y, x) => ({ x, y }))
    : entry.points);
  validatePlotRange(normalizedPoints.map(({ y }) => y), "plot y values", { includeZero: true });
  validatePlotRange(normalizedPoints.map(({ x }) => x), "plot x values");
  return Object.freeze({
    schemaVersion: AGINTI_SCHEMA_VERSION,
    type: spec.type,
    ...(spec.xLabel === undefined ? {} : { xLabel: label(spec.xLabel, "plot xLabel") }),
    ...(spec.yLabel === undefined ? {} : { yLabel: label(spec.yLabel, "plot yLabel") }),
    ...(labels === undefined ? {} : { labels: Object.freeze(labels) }),
    series: Object.freeze(series),
  });
}

export function validateTableSpec(value) {
  const spec = exact(value, ["schemaVersion", "columns", "rows"], "table spec");
  if (spec.schemaVersion !== AGINTI_SCHEMA_VERSION) invalid("table spec schemaVersion must be 1");
  if (!Array.isArray(spec.columns) || spec.columns.length < 1 || spec.columns.length > 12) {
    invalid("table columns must contain 1-12 entries");
  }
  if (!Array.isArray(spec.rows) || spec.rows.length > 200) invalid("table rows may contain at most 200 entries");
  const keys = new Set();
  const columns = spec.columns.map((column, index) => {
    const item = exact(column, ["key", "label"], `table columns[${index}]`);
    if (typeof item.key !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,47}$/u.test(item.key) || keys.has(item.key)) {
      invalid(`table columns[${index}].key is invalid or duplicated`);
    }
    keys.add(item.key);
    return Object.freeze({ key: item.key, label: label(item.label, `table columns[${index}].label`) });
  });
  const rows = spec.rows.map((row, rowIndex) => {
    const { keys: rowKeys } = dataProperties(row, `table rows[${rowIndex}]`);
    if (rowKeys.some((key) => !keys.has(key))) invalid(`table rows[${rowIndex}] contains an unknown column`);
    return Object.freeze(Object.fromEntries(columns.map(({ key }) => {
      const cell = row[key] ?? null;
      if (cell === null || typeof cell === "boolean") return [key, cell];
      if (typeof cell === "number") return [key, finite(cell, `table rows[${rowIndex}].${key}`)];
      return [key, boundedText(cell, `table rows[${rowIndex}].${key}`, 2_000, { presentation: true })];
    })));
  });
  return Object.freeze({ schemaVersion: AGINTI_SCHEMA_VERSION, columns: Object.freeze(columns), rows: Object.freeze(rows) });
}

export function validateMarkdownSpec(value) {
  const spec = exact(value, ["schemaVersion", "markdown"], "markdown spec");
  if (spec.schemaVersion !== AGINTI_SCHEMA_VERSION) invalid("markdown spec schemaVersion must be 1");
  const markdown = boundedText(spec.markdown, "markdown", 32_000);
  if (/<\/?[A-Za-z][^>]*>|!\[[^\]]*\]\s*\(|\[[^\]]+\]\s*\([^)]*\)|(?:https?|data|file|javascript)\s*:|(?:^|[\s("'`])\/(?:workspace|home|users|root|etc|usr|var|opt|srv|run|tmp|proc|sys|dev|mnt|media|aginti-(?:home|cache|env))(?:\/|\b)|(?:^|[\s("'`])[A-Za-z]:\\/imu.test(markdown)) {
    invalid("markdown artifacts may not contain HTML, links, images, URLs, or private runtime paths", "UNSAFE_PRESENTATION");
  }
  return Object.freeze({ schemaVersion: AGINTI_SCHEMA_VERSION, markdown });
}

function sourceUrl(value, name) {
  const raw = boundedText(value, name, 2_048, { minimum: 1 });
  let parsed;
  try { parsed = new URL(raw); }
  catch { invalid(`${name} must be an HTTPS URL`); }
  if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password
      || (parsed.port && parsed.port !== "443") || parsed.hash) {
    invalid(`${name} must be a credential-free HTTPS URL without a fragment`);
  }
  for (const [key] of parsed.searchParams) {
    if (CREDENTIAL_QUERY_NAME.test(key)) invalid(`${name} may not contain credential query fields`);
  }
  return parsed.href;
}

function sourceDate(value, name) {
  if (value === null) return null;
  const result = boundedText(value, name, 10, { minimum: 10 });
  const parsed = new Date(`${result}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(result) || !Number.isFinite(parsed.getTime())
      || parsed.toISOString().slice(0, 10) !== result) {
    invalid(`${name} must be a canonical calendar date or null`);
  }
  return result;
}

function sourceDoi(value, name) {
  if (value === null) return null;
  const result = boundedText(value, name, 300, { minimum: 7, presentation: true }).trim();
  if (!/^10\.\d{4,9}\/[A-Za-z0-9][A-Za-z0-9._;()/:+-]*$/u.test(result)) {
    invalid(`${name} must be a DOI or null`);
  }
  return result;
}

export function validateSourcesSpec(value) {
  const spec = exact(value, ["schemaVersion", "sources"], "sources spec");
  if (spec.schemaVersion !== AGINTI_SCHEMA_VERSION) invalid("sources spec schemaVersion must be 1");
  const sourceItems = denseDataArray(spec.sources, "sources", { minimum: 1, maximum: 20 });
  const sources = sourceItems.map((source, offset) => {
    const item = exact(
      source,
      ["index", "title", "url", "snippet", "providers", "kind", "publishedDate", "doi"],
      `sources[${offset}]`,
    );
    if (item.index !== offset + 1) invalid(`sources[${offset}].index must match its one-based position`);
    const providerItems = denseDataArray(item.providers, `sources[${offset}].providers`, { minimum: 1, maximum: 12 });
    const providers = providerItems.map((provider, index) => label(
      provider,
      `sources[${offset}].providers[${index}]`,
      100,
    ));
    if (new Set(providers).size !== providers.length) invalid(`sources[${offset}].providers must be unique`);
    if (!["web", "paper"].includes(item.kind)) invalid(`sources[${offset}].kind must be web or paper`);
    return Object.freeze({
      index: item.index,
      title: label(item.title, `sources[${offset}].title`, 500),
      url: sourceUrl(item.url, `sources[${offset}].url`),
      snippet: boundedText(item.snippet, `sources[${offset}].snippet`, 4_000, { presentation: true }).trim(),
      providers: Object.freeze(providers),
      kind: item.kind,
      publishedDate: sourceDate(item.publishedDate, `sources[${offset}].publishedDate`),
      doi: sourceDoi(item.doi, `sources[${offset}].doi`),
    });
  });
  return Object.freeze({ schemaVersion: AGINTI_SCHEMA_VERSION, sources: Object.freeze(sources) });
}

export function validateFileSpec(value) {
  const spec = exact(value, ["schemaVersion", "filename", "mime", "bytes", "sha256"], "file spec");
  if (spec.schemaVersion !== AGINTI_SCHEMA_VERSION) invalid("file spec schemaVersion must be 1");
  const filename = boundedText(spec.filename, "file filename", 240, { minimum: 1, presentation: true });
  if (filename === "." || filename === ".." || filename.trim() !== filename
      || filename.includes("/") || filename.includes("\\")) {
    invalid("file filename must be a safe single basename");
  }
  if (typeof spec.mime !== "string" || !FILE_ARTIFACT_MIMES.has(spec.mime)) {
    invalid("file mime is unsupported");
  }
  const extension = filename.toLowerCase().endsWith(".pdf")
    ? "pdf"
    : (filename.toLowerCase().endsWith(".tex") ? "tex" : null);
  if ((spec.mime === "application/pdf" && extension !== "pdf")
      || (spec.mime !== "application/pdf" && extension !== "tex")) {
    invalid("file filename extension does not match its mime");
  }
  const bytes = boundedInteger(spec.bytes, "file bytes", { minimum: 1, maximum: AGINTI_MAX_FILE_ARTIFACT_BYTES });
  if (typeof spec.sha256 !== "string" || !DIGEST.test(spec.sha256)) {
    invalid("file sha256 must be a lowercase SHA-256 digest");
  }
  return Object.freeze({
    schemaVersion: AGINTI_SCHEMA_VERSION,
    filename,
    mime: spec.mime,
    bytes,
    sha256: spec.sha256,
  });
}

export function validateArtifact(value) {
  const artifact = exact(value, ["id", "title", "kind", "spec"], "artifact");
  const kind = artifact.kind;
  if (!["plot", "table", "markdown", "sources", "file"].includes(kind)) invalid("artifact kind is unsupported");
  const normalized = Object.freeze({
    id: validateArtifactId(artifact.id),
    title: title(artifact.title),
    kind,
    spec: kind === "plot"
      ? validatePlotSpec(artifact.spec)
      : (kind === "table"
        ? validateTableSpec(artifact.spec)
        : (kind === "markdown"
          ? validateMarkdownSpec(artifact.spec)
          : (kind === "sources" ? validateSourcesSpec(artifact.spec) : validateFileSpec(artifact.spec)))),
  });
  if (utf8.encode(JSON.stringify(normalized)).byteLength > 48 * 1024) {
    invalid("artifact exceeds its 48 KiB public contract", "ARTIFACT_TOO_LARGE");
  }
  return normalized;
}

export function validateEventPayload(type, value) {
  if (!EVENT_TYPES.has(type)) invalid(`unsupported event type ${JSON.stringify(type)}`);
  if (type === "run.status") {
    const payload = exact(value, ["status"], "run.status payload");
    if (!RUN_STATUSES.has(payload.status)) invalid("run.status status is invalid");
    return Object.freeze({ status: payload.status });
  }
  if (type === "plan.updated") {
    const payload = exact(value, ["steps"], "plan.updated payload");
    if (!Array.isArray(payload.steps) || payload.steps.length > 64) invalid("plan steps may contain at most 64 items");
    return Object.freeze({
      steps: Object.freeze(payload.steps.map((step, index) => {
        const item = exact(step, ["id", "label", "status"], `plan step[${index}]`);
        if (typeof item.id !== "string" || !/^[A-Za-z0-9._~-]{1,96}$/u.test(item.id)) invalid("plan step id is invalid");
        if (!["pending", "in_progress", "completed", "failed"].includes(item.status)) invalid("plan step status is invalid");
        return Object.freeze({ id: item.id, label: label(item.label, `plan step[${index}].label`, 240), status: item.status });
      })),
    });
  }
  if (type === "context.compacted") {
    const payload = exact(value, ["compactedMessages", "tokensBefore", "tokensAfter"], "context.compacted payload");
    return Object.freeze({
      compactedMessages: boundedInteger(payload.compactedMessages, "compactedMessages", { maximum: 1_000_000 }),
      tokensBefore: boundedInteger(payload.tokensBefore, "tokensBefore", { maximum: 10_000_000 }),
      tokensAfter: boundedInteger(payload.tokensAfter, "tokensAfter", { maximum: 10_000_000 }),
    });
  }
  if (type.startsWith("tool.")) {
    const payload = exact(value, ["callId", "publicLabel", "publicSummary", "at"], `${type} payload`);
    if (typeof payload.callId !== "string" || !/^[A-Za-z0-9._~-]{1,128}$/u.test(payload.callId)) invalid("tool callId is invalid");
    return Object.freeze({
      callId: payload.callId,
      publicLabel: label(payload.publicLabel, `${type} publicLabel`),
      publicSummary: label(payload.publicSummary, `${type} publicSummary`, 400),
      at: timestamp(payload.at, `${type} at`),
    });
  }
  if (type === "output.delta") {
    const payload = exact(value, ["text"], "output.delta payload");
    return Object.freeze({ text: boundedText(payload.text, "output.delta text", 4_000, { minimum: 1 }) });
  }
  if (type === "artifact.created" || type === "artifact.updated") {
    const eventLabel = `${type} payload`;
    const payload = exact(value, ["artifact", "receiptDigest"], eventLabel, ["artifact"]);
    const artifact = validateArtifact(payload.artifact);
    if (artifact.kind === "file") {
      exact(value, ["artifact", "receiptDigest"], eventLabel);
      if (typeof payload.receiptDigest !== "string" || !DIGEST.test(payload.receiptDigest)) {
        invalid(`${type} file receiptDigest must be a lowercase SHA-256 digest`);
      }
      return Object.freeze({ artifact, receiptDigest: payload.receiptDigest });
    }
    exact(value, ["artifact"], eventLabel);
    return Object.freeze({ artifact });
  }
  exact(value, [], `${type} payload`);
  return Object.freeze({});
}

export function validateEventEnvelope(value) {
  const event = exact(
    value,
    ["schemaVersion", "id", "seq", "type", "threadId", "runId", "createdAt", "payload", "previousHash", "hash"],
    "agent event",
  );
  if (event.schemaVersion !== AGINTI_SCHEMA_VERSION) invalid("agent event schemaVersion must be 1");
  const runId = validateRunId(event.runId);
  const threadId = validateThreadId(event.threadId);
  const seq = boundedInteger(event.seq, "agent event seq", { minimum: 1, maximum: 10_000_000_000 });
  if (event.id !== `${runId}.${seq}`) invalid("agent event id does not match runId and seq");
  if (!DIGEST.test(event.previousHash) || !DIGEST.test(event.hash)) invalid("agent event hashes are invalid");
  const envelope = Object.freeze({
    schemaVersion: AGINTI_SCHEMA_VERSION,
    id: event.id,
    seq,
    type: event.type,
    threadId,
    runId,
    createdAt: timestamp(event.createdAt, "agent event createdAt"),
    payload: validateEventPayload(event.type, event.payload),
    previousHash: event.previousHash,
  });
  return Object.freeze({ ...envelope, hash: event.hash });
}

function canonicalize(value, seen) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid("canonical data contains a non-finite number");
    return value;
  }
  if (typeof value !== "object") invalid("canonical data must be JSON-compatible");
  if (seen.has(value)) invalid("canonical data may not be cyclic");
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const allowedKeys = new Set(["length"]);
    result = new Array(value.length);
    for (let index = 0; index < value.length; index += 1) {
      const key = String(index);
      allowedKeys.add(key);
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) invalid("canonical arrays may not be sparse");
      result[index] = canonicalize(descriptor.value, seen);
    }
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !allowedKeys.has(key))) {
      invalid("canonical arrays may not contain extra properties");
    }
  } else {
    const { descriptors, keys } = dataProperties(value, "canonical data");
    result = {};
    for (const key of [...keys].sort()) {
      if (descriptors[key].value === undefined) invalid("canonical data may not contain undefined");
      result[key] = canonicalize(descriptors[key].value, seen);
    }
  }
  seen.delete(value);
  return result;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value, new Set()));
}

async function sha256Hex(value, digest) {
  if (digest !== undefined) {
    if (typeof digest !== "function") invalid("digest must be a function");
    const result = await digest(value);
    if (typeof result !== "string" || !DIGEST.test(result)) invalid("digest function returned an invalid SHA-256 value");
    return result;
  }
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof subtle.digest !== "function") invalid("Web Crypto SHA-256 is unavailable", "CRYPTO_UNAVAILABLE");
  const bytes = await subtle.digest("SHA-256", utf8.encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function verifyAgentEvent(value, {
  expectedRunId,
  expectedThreadId,
  afterSeq = 0,
  previousHash = ZERO_HASH,
  digest,
} = {}) {
  const event = validateEventEnvelope(value);
  validateRunId(expectedRunId);
  if (expectedThreadId !== undefined) validateThreadId(expectedThreadId);
  boundedInteger(afterSeq, "event cursor sequence", { maximum: 10_000_000_000 });
  if (!DIGEST.test(previousHash)) invalid("event cursor hash is invalid");
  if (event.runId !== expectedRunId || (expectedThreadId !== undefined && event.threadId !== expectedThreadId)) {
    invalid("agent event ownership does not match the requested run", "LEDGER_OWNERSHIP_MISMATCH");
  }
  if (event.seq !== afterSeq + 1 || event.previousHash !== previousHash) {
    invalid("agent event is not contiguous with the delivery cursor", "LEDGER_CURSOR_MISMATCH");
  }
  const envelope = {
    schemaVersion: event.schemaVersion,
    id: event.id,
    seq: event.seq,
    type: event.type,
    threadId: event.threadId,
    runId: event.runId,
    createdAt: event.createdAt,
    payload: event.payload,
    previousHash: event.previousHash,
  };
  const computed = await sha256Hex(canonicalJson(envelope), digest);
  if (computed !== event.hash) invalid("agent event hash verification failed", "LEDGER_HASH_MISMATCH");
  verifiedEvents.add(event);
  return event;
}

export function assertVerifiedAgentEvent(value) {
  if (!value || typeof value !== "object" || !verifiedEvents.has(value)) {
    invalid("agent event has not passed ledger verification", "UNVERIFIED_EVENT");
  }
  return value;
}

export function validateAgentCapabilities(value) {
  const response = exact(
    value,
    ["schemaVersion", "enabled", "agent", "model", "actions", "attachments", "search", "artifacts"],
    "agent capabilities",
    ["schemaVersion", "enabled", "agent", "model", "actions", "attachments", "artifacts"],
  );
  if (response.schemaVersion !== AGINTI_SCHEMA_VERSION || typeof response.enabled !== "boolean") {
    invalid("agent capabilities schemaVersion or enabled flag is invalid");
  }
  const agent = exact(response.agent, ["kind", "label"], "agent capabilities agent");
  const model = exact(response.model, ["label"], "agent capabilities model");
  const actions = exact(response.actions, ["cancel", "resume", "retry"], "agent capabilities actions");
  const attachmentFields = [
    "enabled", "transport", "acceptedMediaTypes", "maximumCount", "maximumBytesEach",
    "maximumBytesTotal", "requestTimeoutMs", "model", "persistence",
  ];
  const attachments = exact(
    response.attachments,
    attachmentFields,
    "agent capabilities attachments",
    ["enabled"],
  );
  const search = response.search === undefined
    ? { enabled: false, modes: [], maximumSources: 0 }
    : exact(response.search, ["enabled", "modes", "maximumSources"], "agent capabilities search");
  const artifacts = exact(response.artifacts, ["kinds", "schemaVersion"], "agent capabilities artifacts");
  if (agent.kind !== "aginti" || agent.label !== "AgInTi Agent") invalid("agent authority must be AgInTi");
  if (model.label !== "LocalLLM") invalid("agent inference label must be LocalLLM");
  if (![actions.cancel, actions.resume, actions.retry, attachments.enabled, search.enabled].every((flag) => typeof flag === "boolean")) {
    invalid("agent capability flags must be booleans");
  }
  if (actions.retry) invalid("retry is not enabled in protocol v1");
  let attachmentCapability = Object.freeze({ enabled: false });
  if (attachments.enabled) {
    exact(attachments, attachmentFields, "agent capabilities attachments");
    denseDataArray(attachments.acceptedMediaTypes, "agent capabilities attachment media types", {
      minimum: AGINTI_IMAGE_ATTACHMENT_MEDIA_TYPES.length,
      maximum: AGINTI_IMAGE_ATTACHMENT_MEDIA_TYPES.length,
    });
    if (!response.enabled
        || attachments.transport !== "inline-base64"
        || canonicalJson(attachments.acceptedMediaTypes) !== canonicalJson(AGINTI_IMAGE_ATTACHMENT_MEDIA_TYPES)
        || attachments.maximumCount !== AGINTI_IMAGE_ATTACHMENT_COUNT_LIMIT
        || attachments.maximumBytesEach !== AGINTI_IMAGE_ATTACHMENT_BYTES_LIMIT
        || attachments.maximumBytesTotal !== AGINTI_IMAGE_ATTACHMENT_TOTAL_BYTES_LIMIT
        || attachments.requestTimeoutMs !== AGINTI_IMAGE_ATTACHMENT_REQUEST_TIMEOUT_MS
        || attachments.model !== "localllm-vision"
        || attachments.persistence !== "retained-reference-v1") {
      invalid("agent attachment capabilities are invalid");
    }
    attachmentCapability = Object.freeze({
      enabled: true,
      transport: "inline-base64",
      acceptedMediaTypes: AGINTI_IMAGE_ATTACHMENT_MEDIA_TYPES,
      maximumCount: AGINTI_IMAGE_ATTACHMENT_COUNT_LIMIT,
      maximumBytesEach: AGINTI_IMAGE_ATTACHMENT_BYTES_LIMIT,
      maximumBytesTotal: AGINTI_IMAGE_ATTACHMENT_TOTAL_BYTES_LIMIT,
      requestTimeoutMs: AGINTI_IMAGE_ATTACHMENT_REQUEST_TIMEOUT_MS,
      model: "localllm-vision",
      persistence: "retained-reference-v1",
    });
  } else {
    exact(attachments, ["enabled"], "agent capabilities attachments");
  }
  const searchModes = search.enabled ? AGINTI_SEARCH_MODES : [];
  const maximumSources = search.enabled
    ? boundedInteger(search.maximumSources, "agent capabilities search maximumSources", { minimum: 1, maximum: 20 })
    : 0;
  denseDataArray(search.modes, "agent capabilities search modes", {
    minimum: searchModes.length,
    maximum: searchModes.length,
  });
  if (canonicalJson(search.modes) !== canonicalJson(searchModes)
      || (!search.enabled && search.maximumSources !== 0)) {
    invalid("agent search capabilities are invalid");
  }
  if (search.enabled && !response.enabled) invalid("disabled capabilities may not advertise search");
  const legacyArtifactKinds = search.enabled
    ? ["plot", "table", "markdown", "sources"]
    : ["plot", "table", "markdown"];
  const fileArtifactKinds = Object.freeze([...legacyArtifactKinds, "file"]);
  const artifactKinds = canonicalJson(artifacts.kinds) === canonicalJson(fileArtifactKinds)
    ? fileArtifactKinds
    : legacyArtifactKinds;
  if (artifacts.schemaVersion !== AGINTI_SCHEMA_VERSION
      || !Array.isArray(artifacts.kinds)
      || canonicalJson(artifacts.kinds) !== canonicalJson(artifactKinds)) {
    invalid("agent artifact capabilities are invalid");
  }
  if (!response.enabled && (actions.cancel || actions.resume)) invalid("disabled capabilities may not advertise actions");
  return Object.freeze({
    schemaVersion: AGINTI_SCHEMA_VERSION,
    enabled: response.enabled,
    agent: Object.freeze({ kind: "aginti", label: "AgInTi Agent" }),
    model: Object.freeze({ label: "LocalLLM" }),
    actions: Object.freeze({ cancel: actions.cancel, resume: actions.resume, retry: false }),
    attachments: attachmentCapability,
    ...(search.enabled ? {
      search: Object.freeze({ enabled: search.enabled, modes: Object.freeze(searchModes), maximumSources }),
    } : {}),
    artifacts: Object.freeze({ kinds: Object.freeze(artifactKinds), schemaVersion: AGINTI_SCHEMA_VERSION }),
  });
}

function publicMessage(value, index) {
  const message = exact(
    value,
    ["id", "role", "content", "runId", "createdAt", "digest", "attachments"],
    `thread message[${index}]`,
    ["id", "role", "content", "runId", "createdAt", "digest"],
  );
  if (typeof message.id !== "string" || !/^msg_[A-Za-z0-9_-]{16,96}$/u.test(message.id)) invalid("thread message id is invalid");
  if (!["user", "assistant"].includes(message.role)) invalid("thread message role is invalid");
  if (!DIGEST.test(message.digest)) invalid("thread message digest is invalid");
  let attachments;
  if (message.attachments !== undefined) {
    if (message.role !== "user") invalid("only Agent user messages may contain attachments");
    denseDataArray(message.attachments, `thread message[${index}].attachments`, {
      minimum: 1,
      maximum: AGINTI_IMAGE_ATTACHMENT_COUNT_LIMIT,
    });
    const identifiers = new Set();
    let totalBytes = 0;
    attachments = message.attachments.map((value, attachmentIndex) => {
      const attachment = exact(
        value,
        ["attachmentId", "mediaType", "byteLength", "width", "height", "sha256"],
        `thread message[${index}].attachments[${attachmentIndex}]`,
      );
      if (typeof attachment.attachmentId !== "string" || !ATTACHMENT_ID.test(attachment.attachmentId)
          || identifiers.has(attachment.attachmentId)
          || !AGINTI_IMAGE_ATTACHMENT_MEDIA_TYPES.includes(attachment.mediaType)
          || !DIGEST.test(attachment.sha256)) {
        invalid(`thread message[${index}].attachments[${attachmentIndex}] is invalid`);
      }
      identifiers.add(attachment.attachmentId);
      const byteLength = boundedInteger(
        attachment.byteLength,
        `thread message[${index}].attachments[${attachmentIndex}].byteLength`,
        { minimum: 16, maximum: AGINTI_IMAGE_ATTACHMENT_BYTES_LIMIT },
      );
      const width = boundedInteger(
        attachment.width,
        `thread message[${index}].attachments[${attachmentIndex}].width`,
        { minimum: 1, maximum: 8_192 },
      );
      const height = boundedInteger(
        attachment.height,
        `thread message[${index}].attachments[${attachmentIndex}].height`,
        { minimum: 1, maximum: 8_192 },
      );
      if (width * height > 20_000_000) {
        invalid(`thread message[${index}].attachments[${attachmentIndex}] exceeds the decoded pixel limit`);
      }
      totalBytes += byteLength;
      if (totalBytes > AGINTI_IMAGE_ATTACHMENT_TOTAL_BYTES_LIMIT) {
        invalid(`thread message[${index}].attachments exceed the aggregate byte limit`);
      }
      return Object.freeze({
        attachmentId: attachment.attachmentId,
        mediaType: attachment.mediaType,
        byteLength,
        width,
        height,
        sha256: attachment.sha256,
      });
    });
  }
  return Object.freeze({
    id: message.id,
    role: message.role,
    content: boundedText(message.content, `thread message[${index}].content`, 32_000),
    runId: validateRunId(message.runId),
    createdAt: timestamp(message.createdAt, `thread message[${index}].createdAt`),
    digest: message.digest,
    ...(attachments === undefined ? {} : { attachments: Object.freeze(attachments) }),
  });
}

export function validateThread(value) {
  const thread = exact(
    value,
    ["id", "title", "status", "revision", "createdAt", "updatedAt", "lastRunId", "authority", "replay", "messages"],
    "thread",
    ["id", "title", "status", "revision", "createdAt", "updatedAt", "lastRunId", "authority", "replay"],
  );
  if (!["idle", "running", "deleting"].includes(thread.status)) invalid("thread status is invalid");
  const authority = exact(
    thread.authority,
    ["kind", "mapped", "runtimeRevision", "contextDigest", "lastCompaction"],
    "thread authority",
  );
  if (authority.kind !== "aginti" || typeof authority.mapped !== "boolean") invalid("thread authority is invalid");
  if (authority.runtimeRevision !== null) boundedInteger(authority.runtimeRevision, "thread runtimeRevision", { minimum: 1 });
  if (authority.contextDigest !== null && !DIGEST.test(authority.contextDigest)) invalid("thread contextDigest is invalid");
  let lastCompaction = null;
  if (authority.lastCompaction !== null) {
    const item = exact(
      authority.lastCompaction,
      ["compactedMessages", "tokensBefore", "tokensAfter", "digest"],
      "thread lastCompaction",
    );
    if (!DIGEST.test(item.digest)) invalid("lastCompaction digest is invalid");
    lastCompaction = Object.freeze({
      compactedMessages: boundedInteger(item.compactedMessages, "lastCompaction compactedMessages", { maximum: 1_000_000 }),
      tokensBefore: boundedInteger(item.tokensBefore, "lastCompaction tokensBefore", { maximum: 10_000_000 }),
      tokensAfter: boundedInteger(item.tokensAfter, "lastCompaction tokensAfter", { maximum: 10_000_000 }),
      digest: item.digest,
    });
  }
  const replay = exact(thread.replay, ["prunedMessageCount", "anchorDigest"], "thread replay");
  if (!DIGEST.test(replay.anchorDigest)) invalid("thread replay anchorDigest is invalid");
  const prunedMessageCount = boundedInteger(replay.prunedMessageCount, "thread prunedMessageCount", {
    maximum: 10_000_000,
  });
  if ((prunedMessageCount === 0) !== (replay.anchorDigest === ZERO_HASH)) {
    invalid("thread replay anchor is inconsistent");
  }
  const messages = thread.messages ?? [];
  if (!Array.isArray(messages) || messages.length > 256) invalid("thread replay exceeds 256 messages");
  const checkedMessages = messages.map(publicMessage);
  if (checkedMessages.reduce((sum, message) => sum + message.content.length, 0) > 256_000) {
    invalid("thread replay exceeds 256000 characters");
  }
  const lastRunId = thread.lastRunId === null ? null : validateRunId(thread.lastRunId);
  if (lastRunId === null && checkedMessages.length !== 0) {
    invalid("thread replay messages require a lastRunId");
  }
  if (lastRunId === null && thread.status === "running") {
    invalid("a running thread requires a lastRunId");
  }
  if (lastRunId === null && prunedMessageCount !== 0) {
    invalid("a pristine thread cannot declare a pruned replay prefix");
  }
  return Object.freeze({
    id: validateThreadId(thread.id),
    title: title(thread.title),
    status: thread.status,
    revision: boundedInteger(thread.revision, "thread revision", { minimum: 1 }),
    createdAt: timestamp(thread.createdAt, "thread createdAt"),
    updatedAt: timestamp(thread.updatedAt, "thread updatedAt"),
    lastRunId,
    authority: Object.freeze({
      kind: "aginti",
      mapped: authority.mapped,
      runtimeRevision: authority.runtimeRevision,
      contextDigest: authority.contextDigest,
      lastCompaction,
    }),
    replay: Object.freeze({
      prunedMessageCount,
      anchorDigest: replay.anchorDigest,
    }),
    messages: Object.freeze(checkedMessages),
  });
}

export function validateRun(value) {
  const run = exact(
    value,
    ["id", "threadId", "previousRunId", "status", "createdAt", "startedAt", "completedAt", "cancelRequestedAt", "output", "error", "authority", "eventCursor"],
    "run",
  );
  if (!RUN_STATUSES.has(run.status)) invalid("run status is invalid");
  const authority = exact(run.authority, ["kind", "snapshotHash", "runtimeRevision", "contextDigest"], "run authority");
  if (authority.kind !== "aginti") invalid("run authority must be AgInTi");
  for (const [key, value] of [["snapshotHash", authority.snapshotHash], ["contextDigest", authority.contextDigest]]) {
    if (value !== null && !DIGEST.test(value)) invalid(`run ${key} is invalid`);
  }
  if (authority.runtimeRevision !== null) boundedInteger(authority.runtimeRevision, "run runtimeRevision", { minimum: 1 });
  const cursor = exact(run.eventCursor, ["firstSeq", "lastSeq", "lastHash", "prunedThroughSeq"], "run eventCursor");
  const firstSeq = boundedInteger(cursor.firstSeq, "run firstSeq", { minimum: 1, maximum: 10_000_000_001 });
  const lastSeq = boundedInteger(cursor.lastSeq, "run lastSeq", { maximum: 10_000_000_000 });
  const prunedThroughSeq = boundedInteger(cursor.prunedThroughSeq, "run prunedThroughSeq", { maximum: 10_000_000_000 });
  if (!DIGEST.test(cursor.lastHash) || firstSeq > lastSeq + 1 || prunedThroughSeq >= firstSeq) invalid("run event cursor is inconsistent");
  if (firstSeq !== 1 || prunedThroughSeq !== 0) invalid("run event cursor v1 does not support pruned ledgers");
  let error = null;
  if (run.error !== null) {
    const item = exact(run.error, ["code", "message"], "run error");
    error = Object.freeze({
      code: label(item.code, "run error code", 96),
      message: label(item.message, "run error message", 600),
    });
  }
  return Object.freeze({
    id: validateRunId(run.id),
    threadId: validateThreadId(run.threadId),
    previousRunId: run.previousRunId === null ? null : validateRunId(run.previousRunId),
    status: run.status,
    createdAt: timestamp(run.createdAt, "run createdAt"),
    startedAt: timestamp(run.startedAt, "run startedAt", { nullable: true }),
    completedAt: timestamp(run.completedAt, "run completedAt", { nullable: true }),
    cancelRequestedAt: timestamp(run.cancelRequestedAt, "run cancelRequestedAt", { nullable: true }),
    output: boundedText(run.output, "run output", 32_000),
    error,
    authority: Object.freeze({
      kind: "aginti",
      snapshotHash: authority.snapshotHash,
      runtimeRevision: authority.runtimeRevision,
      contextDigest: authority.contextDigest,
    }),
    eventCursor: Object.freeze({ firstSeq, lastSeq, lastHash: cursor.lastHash, prunedThroughSeq }),
  });
}

// This validator accepts a full threads/get replay projection plus the exact
// runs/status records named by its messages and lastRunId. Retained-native
// threads may expose an empty optional message projection even when their head
// extends older durable runs; in that case the exact head remains authoritative
// but the unseen prefix is deliberately opaque.
export function validateThreadRunAncestry(threadValue, runValues) {
  const thread = validateThread(threadValue);
  if (thread.status === "deleting") invalid("a deleting thread cannot unlock Agent follow-up");
  denseDataArray(runValues, "thread replay runs", { maximum: 257 });
  const runs = runValues.map(validateRun);
  const expectedRunIds = new Set(thread.messages.map((message) => message.runId));
  if (thread.lastRunId !== null) expectedRunIds.add(thread.lastRunId);
  const runsById = new Map();
  for (const run of runs) {
    if (run.threadId !== thread.id) invalid("thread replay run belongs to a different thread");
    if (runsById.has(run.id)) invalid("thread replay contains a duplicate run");
    if (!expectedRunIds.has(run.id)) invalid("thread replay contains an unexpected run");
    runsById.set(run.id, run);
  }
  if (runsById.size !== expectedRunIds.size) invalid("thread replay is missing a run status");
  if (thread.lastRunId === null) {
    return Object.freeze({
      runs: Object.freeze([]),
      headRun: null,
      omittedPrefix: false,
      requiresThreadRefresh: false,
    });
  }

  const headRun = runsById.get(thread.lastRunId);
  if (!headRun) invalid("thread replay is missing its declared run head");
  const active = (run) => run.status === "starting" || run.status === "running";
  const headIsActive = active(headRun);
  // Thread and run snapshots come from separate RPCs. A run may atomically
  // finish between them, but a terminal head can never become active again.
  if (thread.status !== "running" && headIsActive) {
    invalid("thread status does not match its replayed run head");
  }
  const requiresThreadRefresh = thread.status === "running" && !headIsActive;
  for (const run of runs) {
    if (run.id !== headRun.id && active(run)) invalid("a historical replay run is not terminal");
  }
  const assistantRuns = new Set(
    thread.messages.filter((message) => message.role === "assistant").map((message) => message.runId),
  );
  for (const runId of assistantRuns) {
    if (active(runsById.get(runId))) invalid("a persisted assistant replay run is not terminal");
  }

  const successorCounts = new Map();
  for (const run of runs) {
    if (run.previousRunId === null) continue;
    const successors = (successorCounts.get(run.previousRunId) ?? 0) + 1;
    if (successors > 1) invalid("thread replay run ancestry branches");
    successorCounts.set(run.previousRunId, successors);
    const previous = runsById.get(run.previousRunId);
    if (previous && previous.createdAt > run.createdAt) invalid("thread replay predecessor is newer than its successor");
  }
  const completed = new Set();
  for (const origin of runs) {
    if (completed.has(origin.id)) continue;
    const path = new Set();
    let ancestor = origin;
    while (ancestor && !completed.has(ancestor.id)) {
      if (path.has(ancestor.id)) invalid("thread replay run ancestry contains a cycle");
      path.add(ancestor.id);
      ancestor = ancestor.previousRunId === null ? null : runsById.get(ancestor.previousRunId);
    }
    for (const runId of path) completed.add(runId);
  }
  const newestFirst = [];
  const visited = new Set();
  let omittedPrefix = false;
  let cursor = headRun;
  while (cursor) {
    if (visited.has(cursor.id)) invalid("thread replay run ancestry contains a cycle");
    visited.add(cursor.id);
    newestFirst.push(cursor);
    if (cursor.previousRunId === null) break;
    const previous = runsById.get(cursor.previousRunId);
    if (!previous) {
      if (thread.messages.length === 0) {
        omittedPrefix = true;
        break;
      }
      if (thread.replay.prunedMessageCount === 0 || thread.replay.anchorDigest === ZERO_HASH) {
        invalid("thread replay predecessor is missing without a pruned-prefix proof");
      }
      omittedPrefix = true;
      break;
    }
    cursor = previous;
  }
  if ((successorCounts.get(headRun.id) ?? 0) !== 0) {
    invalid("thread replay declared head has a successor");
  }
  if (visited.size !== runsById.size) invalid("thread replay contains a disconnected run ancestry");
  return Object.freeze({
    runs: Object.freeze(newestFirst.reverse()),
    headRun,
    omittedPrefix,
    requiresThreadRefresh,
  });
}

export function validateAgentResponse(pathname, value) {
  if (pathname === AGINTI_RPC_PATHS.capabilities) return validateAgentCapabilities(value);
  if (pathname === AGINTI_RPC_PATHS.threadsList) {
    const response = exact(value, ["schemaVersion", "threads", "nextBefore"], "thread list response");
    if (response.schemaVersion !== AGINTI_SCHEMA_VERSION || !Array.isArray(response.threads) || response.threads.length > 100) {
      invalid("thread list response is invalid");
    }
    if (response.nextBefore !== null && (typeof response.nextBefore !== "string" || !THREAD_ID.test(response.nextBefore))) {
      invalid("thread list nextBefore is invalid");
    }
    return Object.freeze({
      schemaVersion: AGINTI_SCHEMA_VERSION,
      threads: Object.freeze(response.threads.map(validateThread)),
      nextBefore: response.nextBefore,
    });
  }
  if ([AGINTI_RPC_PATHS.threadsCreate, AGINTI_RPC_PATHS.threadsGet, AGINTI_RPC_PATHS.threadsUpdate].includes(pathname)) {
    const response = exact(value, ["schemaVersion", "thread"], "thread response");
    if (response.schemaVersion !== AGINTI_SCHEMA_VERSION) invalid("thread response schemaVersion must be 1");
    return Object.freeze({ schemaVersion: AGINTI_SCHEMA_VERSION, thread: validateThread(response.thread) });
  }
  if (pathname === AGINTI_RPC_PATHS.threadsDelete) {
    const response = exact(value, ["schemaVersion", "deleted", "threadId"], "thread delete response");
    if (response.schemaVersion !== AGINTI_SCHEMA_VERSION || response.deleted !== true) invalid("thread delete response is invalid");
    return Object.freeze({ schemaVersion: AGINTI_SCHEMA_VERSION, deleted: true, threadId: validateThreadId(response.threadId) });
  }
  if ([AGINTI_RPC_PATHS.runsStart, AGINTI_RPC_PATHS.runsStatus, AGINTI_RPC_PATHS.runsCancel, AGINTI_RPC_PATHS.runsResume].includes(pathname)) {
    const response = exact(value, ["schemaVersion", "run"], "run response");
    if (response.schemaVersion !== AGINTI_SCHEMA_VERSION) invalid("run response schemaVersion must be 1");
    return Object.freeze({ schemaVersion: AGINTI_SCHEMA_VERSION, run: validateRun(response.run) });
  }
  if (pathname === AGINTI_RPC_PATHS.artifactsList) {
    const response = exact(value, ["schemaVersion", "artifacts"], "artifact list response");
    if (response.schemaVersion !== AGINTI_SCHEMA_VERSION || !Array.isArray(response.artifacts) || response.artifacts.length > 32) {
      invalid("artifact list response is invalid");
    }
    return Object.freeze({ schemaVersion: AGINTI_SCHEMA_VERSION, artifacts: Object.freeze(response.artifacts.map(validateArtifact)) });
  }
  if (pathname === AGINTI_RPC_PATHS.artifactsGet) {
    const response = exact(value, ["schemaVersion", "artifact"], "artifact response");
    if (response.schemaVersion !== AGINTI_SCHEMA_VERSION) invalid("artifact response schemaVersion must be 1");
    return Object.freeze({ schemaVersion: AGINTI_SCHEMA_VERSION, artifact: validateArtifact(response.artifact) });
  }
  invalid("unknown AgInTi response path", "NOT_FOUND");
}

export function failClosedCapabilities(value) {
  try {
    return validateAgentCapabilities(value);
  } catch {
    return FAIL_CLOSED_AGENT_CAPABILITIES;
  }
}

export function initialEventCursor() {
  return Object.freeze({ seq: 0, hash: ZERO_HASH });
}
