/*
 * Browser-safe public protocol for the AgInTi integration API.
 *
 * This module deliberately contains no agent implementation. It accepts only
 * AgInTi-owned thread, run, event, and artifact envelopes and returns frozen
 * presentation data. Unknown fields fail closed so private runtime state can
 * never silently become part of the cloud UI contract.
 */

export const AGINTI_SCHEMA_VERSION = "1";

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
const DIGEST = /^[a-f0-9]{64}$/u;
const PRIVATE_PATH = /(?:^|[\s("'`])\/(?:workspace|home|users|root|etc|usr|var|opt|srv|run|tmp|proc|sys|dev|mnt|media|aginti-(?:home|cache|env))(?:\/|\b)|(?:^|[\s("'`])[A-Za-z]:\\/iu;
const UNSAFE_PRESENTATION = /[<>]|(?:javascript\s*:|(?:https?|data|file)\s*:\/\/)/iu;
const CONTROL = /\u0000|[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const ZERO_HASH = "0".repeat(64);
const MAX_PLOT_MAGNITUDE = Number.MAX_SAFE_INTEGER;
const SEARCH_MODES = new Set(AGINTI_SEARCH_MODES);
const CREDENTIAL_QUERY_NAME = /(?:(?:^|[_-])(?:access[_-]?token|api[_-]?key|auth(?:orization)?|credential|key|password|secret|signature|token)(?:$|[_-])|^(?:(?:aws|google)?accesskeyid|googleaccessid|sig)$)/iu;
const utf8 = new TextEncoder();
const verifiedEvents = new WeakSet();

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

function input(value, { optional = false } = {}) {
  if (optional && value === undefined) return undefined;
  const object = exact(value, ["text", "search"], "input", ["text"]);
  const text = boundedText(object.text, "input.text", 32_000, { minimum: 1 }).trim();
  if (!text) invalid("input.text must contain non-whitespace text");
  if (utf8.encode(text).byteLength > 32 * 1024) invalid("input.text exceeds the UTF-8 byte limit");
  return Object.freeze({
    text,
    ...(object.search === undefined ? {} : { search: validateAgentSearch(object.search) }),
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
        ? { threadId: "", runId: validateRunId(object.runId) }
        : { threadId: validateThreadId(object.threadId), runId: "" });
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

export function validateArtifact(value) {
  const artifact = exact(value, ["id", "title", "kind", "spec"], "artifact");
  const kind = artifact.kind;
  if (!["plot", "table", "markdown", "sources"].includes(kind)) invalid("artifact kind is unsupported");
  const normalized = Object.freeze({
    id: validateArtifactId(artifact.id),
    title: title(artifact.title),
    kind,
    spec: kind === "plot"
      ? validatePlotSpec(artifact.spec)
      : (kind === "table"
        ? validateTableSpec(artifact.spec)
        : (kind === "markdown" ? validateMarkdownSpec(artifact.spec) : validateSourcesSpec(artifact.spec))),
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
    const payload = exact(value, ["artifact"], `${type} payload`);
    return Object.freeze({ artifact: validateArtifact(payload.artifact) });
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
  const attachments = exact(response.attachments, ["enabled"], "agent capabilities attachments");
  const search = response.search === undefined
    ? { enabled: false, modes: [], maximumSources: 0 }
    : exact(response.search, ["enabled", "modes", "maximumSources"], "agent capabilities search");
  const artifacts = exact(response.artifacts, ["kinds", "schemaVersion"], "agent capabilities artifacts");
  if (agent.kind !== "aginti" || agent.label !== "AgInTi Agent") invalid("agent authority must be AgInTi");
  if (model.label !== "LocalLLM") invalid("agent inference label must be LocalLLM");
  if (![actions.cancel, actions.resume, actions.retry, attachments.enabled, search.enabled].every((flag) => typeof flag === "boolean")) {
    invalid("agent capability flags must be booleans");
  }
  if (actions.retry || attachments.enabled) invalid("retry and attachments are not enabled in protocol v1");
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
  const artifactKinds = search.enabled
    ? ["plot", "table", "markdown", "sources"]
    : ["plot", "table", "markdown"];
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
    attachments: Object.freeze({ enabled: false }),
    ...(search.enabled ? {
      search: Object.freeze({ enabled: search.enabled, modes: Object.freeze(searchModes), maximumSources }),
    } : {}),
    artifacts: Object.freeze({ kinds: Object.freeze(artifactKinds), schemaVersion: AGINTI_SCHEMA_VERSION }),
  });
}

function publicMessage(value, index) {
  const message = exact(value, ["id", "role", "content", "runId", "createdAt", "digest"], `thread message[${index}]`);
  if (typeof message.id !== "string" || !/^msg_[A-Za-z0-9_-]{16,96}$/u.test(message.id)) invalid("thread message id is invalid");
  if (!["user", "assistant"].includes(message.role)) invalid("thread message role is invalid");
  if (!DIGEST.test(message.digest)) invalid("thread message digest is invalid");
  return Object.freeze({
    id: message.id,
    role: message.role,
    content: boundedText(message.content, `thread message[${index}].content`, 32_000),
    runId: validateRunId(message.runId),
    createdAt: timestamp(message.createdAt, `thread message[${index}].createdAt`),
    digest: message.digest,
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
  const messages = thread.messages ?? [];
  if (!Array.isArray(messages) || messages.length > 256) invalid("thread replay exceeds 256 messages");
  const checkedMessages = messages.map(publicMessage);
  if (checkedMessages.reduce((sum, message) => sum + message.content.length, 0) > 256_000) {
    invalid("thread replay exceeds 256000 characters");
  }
  return Object.freeze({
    id: validateThreadId(thread.id),
    title: title(thread.title),
    status: thread.status,
    revision: boundedInteger(thread.revision, "thread revision", { minimum: 1 }),
    createdAt: timestamp(thread.createdAt, "thread createdAt"),
    updatedAt: timestamp(thread.updatedAt, "thread updatedAt"),
    lastRunId: thread.lastRunId === null ? null : validateRunId(thread.lastRunId),
    authority: Object.freeze({
      kind: "aginti",
      mapped: authority.mapped,
      runtimeRevision: authority.runtimeRevision,
      contextDigest: authority.contextDigest,
      lastCompaction,
    }),
    replay: Object.freeze({
      prunedMessageCount: boundedInteger(replay.prunedMessageCount, "thread prunedMessageCount", { maximum: 10_000_000 }),
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
