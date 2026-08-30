import {
  AGINTI_IMAGE_ATTACHMENT_REQUEST_TIMEOUT_MS,
  AGINTI_RPC_PATHS,
  AgintiProtocolError,
  FAIL_CLOSED_AGENT_CAPABILITIES,
  failClosedCapabilities,
  initialEventCursor,
  rpcPathIsMutation,
  validateAgentRequest,
  validateAgentResponse,
  validateIdempotencyKey,
  validateRunId,
  verifyAgentEvent,
} from "./aginti-protocol.js";
import {
  addWebReleaseHeader,
  inspectWebReleaseResponse,
  optionalWebRelease,
} from "./web-release.js";

const JSON_LIMIT = 2 * 1024 * 1024;
const STREAM_LIMIT = 8 * 1024 * 1024;
const SSE_BLOCK_LIMIT = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_STREAM_WALL_MS = 70_000;
const ROLLOUT_IN_PROGRESS_CODE = "rollout_in_progress";
const ROLLOUT_RETRY_DEFAULT_SECONDS = 1;
const ROLLOUT_RETRY_MAXIMUM_SECONDS = 5;
const TERMINAL_EVENTS = new Set(["run.completed", "run.failed", "run.cancelled"]);
const FORBIDDEN_BROWSER_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "x-api-key",
  "x-aginti-browser-session-id",
  "x-aginti-principal-id",
  "x-lazyedge-browser-session",
  "x-lazyedge-principal-id",
  "x-lazyedge-idempotency-key",
]);

export class AgintiTransportError extends Error {
  constructor(message, {
    code = "AGINTI_UNAVAILABLE",
    status = 503,
    retryable = true,
    retryAfterMs,
    serverRelease,
  } = {}) {
    super(message);
    this.name = "AgintiTransportError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
    if (serverRelease !== undefined) this.serverRelease = optionalWebRelease(serverRelease);
  }
}

function requireFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} must be a function`);
  return value;
}

function normalizedBaseUrl(value) {
  const fallback = globalThis.location?.href;
  const base = value ?? fallback;
  if (typeof base !== "string") throw new TypeError("baseUrl is required outside a browser");
  const parsed = new URL(base);
  if (!/^https?:$/u.test(parsed.protocol) || parsed.username || parsed.password) {
    throw new TypeError("baseUrl must be an HTTP(S) URL without credentials");
  }
  return parsed;
}

function safePrefix(value) {
  if (typeof value !== "string" || !value.startsWith("/") || /[\\?#\u0000-\u001f\u007f]/u.test(value)
      || /%(?:2e|2f|5c)/iu.test(value)) {
    throw new TypeError("transportEndpoint must be an absolute-path prefix");
  }
  if (value.includes("//") || value.split("/").some((part) => part === "." || part === "..")) {
    throw new TypeError("transportEndpoint path is not normalized");
  }
  return value === "/" ? "" : value.replace(/\/$/u, "");
}

function endpointResolver(endpoint, baseUrl) {
  if (typeof endpoint === "string") {
    const prefix = safePrefix(endpoint);
    return (nativePath) => new URL(`${prefix}${nativePath}`, baseUrl);
  }
  requireFunction(endpoint, "transportEndpoint");
  return (nativePath) => {
    const result = endpoint(nativePath);
    if (typeof result !== "string" && !(result instanceof URL)) {
      throw new TypeError("transportEndpoint must return a URL or URL string");
    }
    return new URL(result, baseUrl);
  };
}

function resolveSameOrigin(resolveEndpoint, nativePath, baseUrl) {
  if (!Object.values(AGINTI_RPC_PATHS).includes(nativePath)) throw new TypeError("unknown AgInTi RPC path");
  const target = resolveEndpoint(nativePath);
  if (target.origin !== baseUrl.origin || target.username || target.password || target.search || target.hash) {
    throw new TypeError("browser transport must resolve to an exact same-origin URL without credentials, query, or fragment");
  }
  if (/[\\]/u.test(target.pathname) || /%(?:2e|2f|5c)/iu.test(target.pathname)) {
    throw new TypeError("transport URL contains an encoded or non-portable path separator");
  }
  if (!target.pathname.endsWith(nativePath)) throw new TypeError("transport URL must preserve the exact /agent/v1 RPC suffix");
  const prefix = target.pathname.slice(0, -nativePath.length);
  if (prefix && (!prefix.startsWith("/") || prefix.endsWith("/") || prefix.includes("//"))) {
    throw new TypeError("transport URL prefix is not normalized");
  }
  return target.href;
}

function idempotencyKey(factory) {
  const value = factory();
  return validateIdempotencyKey(value);
}

function defaultIdempotencyKey() {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  if (typeof globalThis.crypto?.getRandomValues !== "function") {
    throw new TypeError("secure randomness is unavailable for mutation idempotency");
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizedCsrf({ csrfToken, csrfHeader }) {
  if (csrfToken === undefined) return { token: () => undefined, header: undefined };
  const token = typeof csrfToken === "function" ? csrfToken : () => csrfToken;
  if (typeof csrfHeader !== "string" || !/^x-[a-z0-9-]{1,62}$/u.test(csrfHeader.toLowerCase())) {
    throw new TypeError("csrfHeader must be a bounded x-* header name");
  }
  if (FORBIDDEN_BROWSER_HEADERS.has(csrfHeader.toLowerCase())) throw new TypeError("csrfHeader is reserved");
  if (csrfHeader.toLowerCase() === "x-idempotency-key") throw new TypeError("csrfHeader is reserved");
  return { token, header: csrfHeader.toLowerCase() };
}

function requestHeaders({ accept, csrf, mutationKey, releaseId }) {
  const headers = addWebReleaseHeader(new Headers({
    accept,
    "content-type": "application/json; charset=utf-8",
  }), releaseId);
  const csrfValue = csrf.token();
  if (csrfValue !== undefined) {
    if (typeof csrfValue !== "string" || csrfValue.length < 16 || csrfValue.length > 1024 || /[\u0000-\u001f\u007f]/u.test(csrfValue)) {
      throw new TypeError("CSRF token is invalid");
    }
    headers.set(csrf.header, csrfValue);
  }
  if (mutationKey !== undefined) headers.set("idempotency-key", mutationKey);
  for (const name of headers.keys()) {
    if (FORBIDDEN_BROWSER_HEADERS.has(name)) throw new TypeError(`browser request may not set ${name}`);
  }
  return headers;
}

function requirePinnedRelease(response, releaseId) {
  const proof = inspectWebReleaseResponse(response, releaseId);
  if (proof.kind === "unpinned" || proof.kind === "match") return;
  if (proof.kind === "mismatch") {
    throw new AgintiTransportError("AgInTi requires the current browser app release", {
      code: "client_release_mismatch",
      status: 409,
      retryable: false,
      serverRelease: proof.releaseId,
    });
  }
  throw new AgintiProtocolError("AgInTi response is missing its release identity");
}

function deadlineSignal(signal, timeoutMs) {
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError("signal must be an AbortSignal");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) throw new TypeError("timeoutMs is invalid");
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal.reason ?? new DOMException("request aborted", "AbortError"));
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException("request timed out", "TimeoutError")), timeoutMs);
  return Object.freeze({
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortFromCaller);
    },
  });
}

function mediaType(response) {
  return String(response.headers.get("content-type") ?? "").toLowerCase().split(";", 1)[0].trim();
}

async function readBoundedText(response, maximum) {
  const advertised = response.headers.get("content-length");
  if (advertised !== null && (!/^\d+$/u.test(advertised) || Number(advertised) > maximum)) {
    throw new AgintiProtocolError("response exceeded its public size bound");
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    const value = await response.text();
    if (new TextEncoder().encode(value).byteLength > maximum) throw new AgintiProtocolError("response exceeded its public size bound");
    return value;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let result = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new AgintiProtocolError("response stream returned a non-byte chunk");
      size += value.byteLength;
      if (size > maximum) throw new AgintiProtocolError("response exceeded its public size bound");
      result += decoder.decode(value, { stream: true });
    }
    result += decoder.decode();
    return result;
  } finally {
    reader.releaseLock?.();
  }
}

function safeUpstreamCode(value) {
  if (value === ROLLOUT_IN_PROGRESS_CODE) return value;
  if (typeof value !== "string" || !/^[A-Z][A-Z0-9_]{0,79}$/u.test(value)) return "AGINTI_REQUEST_FAILED";
  return value;
}

function rolloutRetryAfterMs(response) {
  const value = response.headers.get("retry-after");
  const seconds = typeof value === "string" && /^\d+$/u.test(value)
    ? Number(value)
    : ROLLOUT_RETRY_DEFAULT_SECONDS;
  const bounded = Number.isSafeInteger(seconds)
    ? Math.min(ROLLOUT_RETRY_MAXIMUM_SECONDS, Math.max(1, seconds))
    : ROLLOUT_RETRY_DEFAULT_SECONDS;
  return bounded * 1_000;
}

async function responseError(response) {
  let code = "AGINTI_REQUEST_FAILED";
  if (mediaType(response) === "application/json") {
    try {
      const parsed = JSON.parse(await readBoundedText(response, 16 * 1024));
      code = safeUpstreamCode(parsed?.error?.code);
    } catch {
      code = "AGINTI_REQUEST_FAILED";
    }
  }
  const retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
  return new AgintiTransportError("AgInTi request was not accepted", {
    code,
    status: response.status,
    retryable,
    ...(response.status === 503 && code === ROLLOUT_IN_PROGRESS_CODE
      ? { retryAfterMs: rolloutRetryAfterMs(response) }
      : {}),
  });
}

function transportFailure(error) {
  if (error instanceof AgintiTransportError || error instanceof AgintiProtocolError) return error;
  if (error?.name === "AbortError" || error?.name === "TimeoutError") {
    return new AgintiTransportError("AgInTi request was interrupted", {
      code: error.name === "TimeoutError" ? "AGINTI_TIMEOUT" : "AGINTI_ABORTED",
      status: error.name === "TimeoutError" ? 504 : 499,
      retryable: error.name === "TimeoutError",
    });
  }
  return new AgintiTransportError("AgInTi transport is unavailable");
}

function parseSseBlock(block) {
  if (!block) return null;
  const lines = block.split("\n");
  if (lines.every((line) => line === "" || line.startsWith(":"))) return null;
  const fields = Object.create(null);
  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;
    const match = /^(id|event|data): ?([^\r\n]*)$/u.exec(line);
    if (!match || Object.hasOwn(fields, match[1])) throw new AgintiProtocolError("event stream contains an unsupported or repeated SSE field");
    fields[match[1]] = match[2];
  }
  if (!Object.hasOwn(fields, "id") || !Object.hasOwn(fields, "event") || !Object.hasOwn(fields, "data")) {
    throw new AgintiProtocolError("event stream block is incomplete");
  }
  let value;
  try {
    value = JSON.parse(fields.data);
  } catch {
    throw new AgintiProtocolError("event stream data is not valid JSON");
  }
  return { id: fields.id, type: fields.event, value };
}

function detachReader(reader) {
  // A verified terminal ledger event is sufficient to release the UI. Some
  // browser fetch implementations leave the underlying cancel promise pending
  // after that point, so transport teardown is deliberately best effort.
  try {
    const cancellation = reader.cancel();
    if (cancellation && typeof cancellation.catch === "function") {
      void cancellation.catch(() => { /* The event delivery transport is already detaching. */ });
    }
  } catch { /* The event delivery transport is already detaching. */ }
  try { reader.releaseLock?.(); } catch { /* Cancellation still owns the reader. */ }
}

async function* rawSseBlocks(response) {
  if (!response.body || typeof response.body.getReader !== "function") throw new AgintiProtocolError("event stream body is unavailable");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let buffer = "";
  let ended = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) { ended = true; break; }
      if (!(value instanceof Uint8Array)) throw new AgintiProtocolError("event stream returned a non-byte chunk");
      bytes += value.byteLength;
      if (bytes > STREAM_LIMIT) throw new AgintiProtocolError("event stream exceeded its connection bound");
      try {
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/gu, "\n");
      } catch {
        throw new AgintiProtocolError("event stream is not valid UTF-8");
      }
      if (new TextEncoder().encode(buffer).byteLength > SSE_BLOCK_LIMIT && !buffer.includes("\n\n")) {
        throw new AgintiProtocolError("event stream block exceeded its bound");
      }
      let separator;
      while ((separator = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        if (new TextEncoder().encode(block).byteLength > SSE_BLOCK_LIMIT) throw new AgintiProtocolError("event stream block exceeded its bound");
        yield block;
      }
    }
    try { buffer += decoder.decode(); } catch { throw new AgintiProtocolError("event stream is not valid UTF-8"); }
    const tail = buffer.trim();
    if (tail) {
      if (new TextEncoder().encode(tail).byteLength > SSE_BLOCK_LIMIT) throw new AgintiProtocolError("event stream block exceeded its bound");
      yield tail;
    }
  } finally {
    if (!ended) detachReader(reader);
    else reader.releaseLock?.();
  }
}

async function* agentSseBlocks(response) {
  for await (const block of rawSseBlocks(response)) {
    const parsed = parseSseBlock(block);
    if (parsed) yield parsed;
  }
}

function cursor(value) {
  if (value === undefined) return initialEventCursor();
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || !Number.isSafeInteger(value.seq) || value.seq < 0 || value.seq > 10_000_000_000
      || typeof value.hash !== "string" || !/^[a-f0-9]{64}$/u.test(value.hash)
      || Object.keys(value).some((key) => !["seq", "hash"].includes(key))) {
    throw new TypeError("event cursor is invalid");
  }
  if (value.seq === 0 && value.hash !== "0".repeat(64)) throw new TypeError("initial event cursor hash must be zero");
  return Object.freeze({ seq: value.seq, hash: value.hash });
}

function terminal(type) {
  return TERMINAL_EVENTS.has(type);
}

function validateReconnects(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 20) throw new TypeError("maxReconnects must be an integer from 0 through 20");
  return value;
}

export class AgintiBrowserClient {
  constructor({
    transportEndpoint,
    baseUrl,
    fetchImpl = globalThis.fetch,
    csrfToken,
    csrfHeader = "x-csrf-token",
    makeIdempotencyKey = defaultIdempotencyKey,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    streamWallMs = DEFAULT_STREAM_WALL_MS,
    wait = (milliseconds, signal) => new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, milliseconds);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException("aborted", "AbortError"));
      }, { once: true });
    }),
    digest,
    releaseId,
  } = {}) {
    this.baseUrl = normalizedBaseUrl(baseUrl);
    this.resolveEndpoint = endpointResolver(transportEndpoint, this.baseUrl);
    this.fetch = requireFunction(fetchImpl, "fetchImpl");
    if (fetchImpl === globalThis.fetch) this.fetch = this.fetch.bind(globalThis);
    this.csrf = normalizedCsrf({ csrfToken, csrfHeader });
    this.releaseId = optionalWebRelease(releaseId);
    this.makeIdempotencyKey = requireFunction(makeIdempotencyKey, "makeIdempotencyKey");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
      throw new TypeError("timeoutMs is invalid");
    }
    this.timeoutMs = timeoutMs;
    if (!Number.isSafeInteger(streamWallMs) || streamWallMs < 1_000 || streamWallMs > 120_000) {
      throw new TypeError("streamWallMs is invalid");
    }
    this.streamWallMs = streamWallMs;
    this.wait = requireFunction(wait, "wait");
    this.digest = digest;
  }

  endpoint(pathname) {
    return resolveSameOrigin(this.resolveEndpoint, pathname, this.baseUrl);
  }

  async call(pathname, body = {}, { signal, idempotency } = {}) {
    if (pathname === AGINTI_RPC_PATHS.runsEvents) throw new TypeError("use streamRunEvents for the events RPC");
    const request = validateAgentRequest(pathname, body);
    const mutation = rpcPathIsMutation(pathname);
    if (!mutation && idempotency !== undefined) throw new TypeError("read RPCs may not carry idempotency keys");
    const mutationKey = mutation ? validateIdempotencyKey(idempotency ?? idempotencyKey(this.makeIdempotencyKey)) : undefined;
    const endpoint = this.endpoint(pathname);
    const imageMutation = (pathname === AGINTI_RPC_PATHS.runsStart
      || pathname === AGINTI_RPC_PATHS.runsResume)
      && Array.isArray(request.input?.attachments);
    const deadline = deadlineSignal(
      signal,
      imageMutation ? AGINTI_IMAGE_ATTACHMENT_REQUEST_TIMEOUT_MS : this.timeoutMs,
    );
    let response;
    try {
      response = await this.fetch(endpoint, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "same-origin",
        headers: requestHeaders({ accept: "application/json", csrf: this.csrf, mutationKey, releaseId: this.releaseId }),
        body: JSON.stringify(request),
        signal: deadline.signal,
      });
    } catch (error) {
      deadline.dispose();
      throw transportFailure(deadline.signal.aborted ? (deadline.signal.reason ?? error) : error);
    }
    try {
      requirePinnedRelease(response, this.releaseId);
      if (!response.ok) throw await responseError(response);
      if (mediaType(response) !== "application/json") throw new AgintiProtocolError("AgInTi response content type is invalid");
      let value;
      try {
        value = JSON.parse(await readBoundedText(response, JSON_LIMIT));
      } catch (error) {
        if (deadline.signal.aborted) throw transportFailure(deadline.signal.reason ?? error);
        if (error instanceof AgintiProtocolError) throw error;
        throw new AgintiProtocolError("AgInTi response is not valid JSON");
      }
      return validateAgentResponse(pathname, value);
    } finally {
      deadline.dispose();
    }
  }

  async capabilities({ signal } = {}) {
    try {
      return await this.call(AGINTI_RPC_PATHS.capabilities, {}, { signal });
    } catch (error) {
      if (error?.code === "client_release_mismatch") throw error;
      return FAIL_CLOSED_AGENT_CAPABILITIES;
    }
  }

  listThreads(body = {}, options) { return this.call(AGINTI_RPC_PATHS.threadsList, body, options); }
  createThread(body = {}, options) { return this.call(AGINTI_RPC_PATHS.threadsCreate, body, options); }
  getThread(threadId, options) { return this.call(AGINTI_RPC_PATHS.threadsGet, { threadId }, options); }
  updateThread(body, options) { return this.call(AGINTI_RPC_PATHS.threadsUpdate, body, options); }
  deleteThread(threadId, options) { return this.call(AGINTI_RPC_PATHS.threadsDelete, { threadId }, options); }
  startRun(threadId, text, { search, attachments, ...options } = {}) {
    return this.call(AGINTI_RPC_PATHS.runsStart, {
      threadId,
      input: {
        text,
        ...(search === undefined ? {} : { search }),
        ...(attachments === undefined ? {} : { attachments }),
      },
    }, options);
  }
  runStatus(runId, options) { return this.call(AGINTI_RPC_PATHS.runsStatus, { runId }, options); }
  cancelRun(runId, options) { return this.call(AGINTI_RPC_PATHS.runsCancel, { runId }, options); }
  resumeRun(runId, text, { search, attachments, ...options } = {}) {
    if (text === undefined && (search !== undefined || attachments !== undefined)) {
      throw new TypeError("search and attachments require a corrected resume prompt");
    }
    return this.call(
      AGINTI_RPC_PATHS.runsResume,
      text === undefined ? { runId } : {
        runId,
        input: {
          text,
          ...(search === undefined ? {} : { search }),
          ...(attachments === undefined ? {} : { attachments }),
        },
      },
      options,
    );
  }
  listArtifacts(body, options) { return this.call(AGINTI_RPC_PATHS.artifactsList, body, options); }
  getArtifact(artifactId, options) { return this.call(AGINTI_RPC_PATHS.artifactsGet, { artifactId }, options); }

  async *streamRunEvents({
    runId,
    threadId,
    cursor: suppliedCursor,
    signal,
    maxReconnects = 5,
    onCursor,
  } = {}) {
    validateRunId(runId);
    if (onCursor !== undefined) requireFunction(onCursor, "onCursor");
    let delivery = cursor(suppliedCursor);
    let reconnects = 0;
    const maximum = validateReconnects(maxReconnects);
    const endpoint = this.endpoint(AGINTI_RPC_PATHS.runsEvents);
    let done = false;
    while (!done) {
      let response;
      const deadline = deadlineSignal(signal, this.streamWallMs);
      try {
        const request = validateAgentRequest(AGINTI_RPC_PATHS.runsEvents, {
          runId,
          afterSeq: delivery.seq,
          afterHash: delivery.hash,
        });
        response = await this.fetch(endpoint, {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          referrerPolicy: "same-origin",
          headers: requestHeaders({ accept: "text/event-stream", csrf: this.csrf, releaseId: this.releaseId }),
          body: JSON.stringify(request),
          signal: deadline.signal,
        });
        requirePinnedRelease(response, this.releaseId);
        if (!response.ok) throw await responseError(response);
        if (mediaType(response) !== "text/event-stream") throw new AgintiProtocolError("AgInTi event stream content type is invalid");
        for await (const block of agentSseBlocks(response)) {
          const event = await verifyAgentEvent(block.value, {
            expectedRunId: runId,
            expectedThreadId: threadId,
            afterSeq: delivery.seq,
            previousHash: delivery.hash,
            digest: this.digest,
          });
          if (block.id !== event.id || block.type !== event.type) throw new AgintiProtocolError("SSE fields do not match the event envelope");
          delivery = Object.freeze({ seq: event.seq, hash: event.hash });
          if (onCursor) {
            try { await onCursor(delivery, event); }
            catch { throw new AgintiProtocolError("delivery cursor persistence failed", { code: "CURSOR_PERSISTENCE_FAILED" }); }
          }
          yield Object.freeze({ event, cursor: delivery });
          if (terminal(event.type)) {
            done = true;
            break;
          }
        }
        if (done || signal?.aborted) return;
      } catch (error) {
        const failure = transportFailure(deadline.signal.aborted ? (deadline.signal.reason ?? error) : error);
        if (failure instanceof AgintiProtocolError || !failure.retryable || signal?.aborted) throw failure;
      } finally {
        deadline.dispose();
      }
      if (reconnects >= maximum) {
        throw new AgintiTransportError("AgInTi event stream ended before a terminal event", {
          code: "AGINTI_STREAM_INTERRUPTED",
          status: 503,
          retryable: true,
        });
      }
      reconnects += 1;
      await this.wait(Math.min(4_000, 250 * (2 ** (reconnects - 1))), signal);
    }
  }
}

export function selectDefaultMode(capabilities) {
  return failClosedCapabilities(capabilities).enabled ? "agent" : "chat";
}
