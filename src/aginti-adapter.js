import { createHash } from "node:crypto";

import {
  AGINTI_RPC_PATHS,
  FAIL_CLOSED_AGENT_CAPABILITIES,
  canonicalJson,
  rpcPathIsMutation,
  validateAgentRequest,
  validateAgentResponse,
  validateEventEnvelope,
} from "./web/aginti-protocol.js";

const JSON_LIMIT = 2 * 1024 * 1024;
const STREAM_LIMIT = 8 * 1024 * 1024;
const SSE_BLOCK_LIMIT = 64 * 1024;
const PRINCIPAL_ID = /^[A-Za-z0-9._~-]{16,128}$/u;
const BROWSER_SESSION = /^[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9._~+/=-]{32,4096}$/u;

export const AGINTI_INTERNAL_HEADERS = Object.freeze({
  principal: "x-aginti-principal-id",
  browserSession: "x-aginti-browser-session-id",
  idempotency: "idempotency-key",
});

export class AgintiAdapterError extends Error {
  constructor(message, { code = "AGINTI_UNAVAILABLE", statusCode = 503, retryable = true } = {}) {
    super(message);
    this.name = "AgintiAdapterError";
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = retryable;
  }
}

function fail(message, options) {
  throw new AgintiAdapterError(message, options);
}

function exactDataObject(value, allowed, label, required = allowed) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label} must be a plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !allowed.includes(key)) throw new TypeError(`${label} contains an unsupported field`);
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${label} must contain only enumerable data properties`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(descriptors, key)) throw new TypeError(`${label}.${key} is required`);
  }
  return value;
}

function normalizeUpstream(value) {
  if (typeof value !== "string") throw new TypeError("upstream must be an exact loopback HTTP origin");
  const parsed = new URL(value);
  const port = Number(parsed.port);
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1"
      || !parsed.port || !Number.isSafeInteger(port) || port < 1024 || port > 65535
      || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new TypeError("upstream must be an exact 127.0.0.1 high-port HTTP origin");
  }
  return parsed.origin;
}

function normalizeContext(value, mutation) {
  const allowed = ["principalId", "browserSession", "idempotencyKey", "signal"];
  const required = mutation ? ["principalId", "browserSession", "idempotencyKey"] : ["principalId", "browserSession"];
  const context = exactDataObject(value, allowed, "AgInTi adapter context", required);
  if (!PRINCIPAL_ID.test(context.principalId)) throw new TypeError("principalId is invalid");
  if (!BROWSER_SESSION.test(context.browserSession)) throw new TypeError("browserSession is invalid");
  if (mutation) {
    if (typeof context.idempotencyKey !== "string" || !/^[A-Za-z0-9._~-]{16,160}$/u.test(context.idempotencyKey)) {
      throw new TypeError("idempotencyKey is invalid");
    }
  } else if (context.idempotencyKey !== undefined) {
    throw new TypeError("read-only AgInTi RPCs may not carry an idempotency key");
  }
  if (context.signal !== undefined && !(context.signal instanceof AbortSignal)) throw new TypeError("signal must be an AbortSignal");
  return context;
}

async function credential(provider) {
  let value;
  try { value = await provider(); }
  catch { fail("AgInTi transport credential is unavailable"); }
  try { validateAgintiTransportCredential(value); }
  catch { fail("AgInTi transport credential is unavailable"); }
  return value;
}

export function validateAgintiTransportCredential(value) {
  if (typeof value !== "string" || !TOKEN.test(value)) {
    throw new TypeError("AgInTi transport credential is invalid");
  }
  return true;
}

function mediaType(response) {
  return String(response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
}

function assertUnencoded(response) {
  if (response.headers.get("content-encoding") !== null) {
    fail("AgInTi returned an encoded response", { code: "AGINTI_RESPONSE_INVALID", statusCode: 502, retryable: false });
  }
}

async function readBoundedText(response, maximum) {
  const advertised = response.headers.get("content-length");
  if (advertised !== null && (!/^\d+$/u.test(advertised) || Number(advertised) > maximum)) {
    await response.body?.cancel?.().catch(() => {});
    fail("AgInTi response exceeded its public bound", { code: "AGINTI_RESPONSE_INVALID", statusCode: 502, retryable: false });
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    const value = await response.text();
    if (Buffer.byteLength(value, "utf8") > maximum) {
      fail("AgInTi response exceeded its public bound", { code: "AGINTI_RESPONSE_INVALID", statusCode: 502, retryable: false });
    }
    return value;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let output = "";
  let ended = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { ended = true; break; }
      if (!(value instanceof Uint8Array)) {
        fail("AgInTi response was not a byte stream", { code: "AGINTI_RESPONSE_INVALID", statusCode: 502, retryable: false });
      }
      size += value.byteLength;
      if (size > maximum) {
        fail("AgInTi response exceeded its public bound", { code: "AGINTI_RESPONSE_INVALID", statusCode: 502, retryable: false });
      }
      output += decoder.decode(value, { stream: true });
    }
    output += decoder.decode();
    return output;
  } catch (error) {
    if (error instanceof AgintiAdapterError) throw error;
    fail("AgInTi response was not valid UTF-8", { code: "AGINTI_RESPONSE_INVALID", statusCode: 502, retryable: false });
  } finally {
    if (!ended) await reader.cancel().catch(() => {});
    reader.releaseLock?.();
  }
}

function upstreamError(response) {
  const statusCode = [400, 401, 403, 404, 409, 429, 502, 503, 504].includes(response.status) ? response.status : 503;
  response.body?.cancel?.().catch(() => {});
  return new AgintiAdapterError("AgInTi did not accept the request", {
    code: response.status === 429 ? "AGINTI_RATE_LIMITED" : "AGINTI_UPSTREAM_REJECTED",
    statusCode,
    retryable: response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500,
  });
}

function responseFailure(error) {
  if (error instanceof AgintiAdapterError) return error;
  if (error?.name === "AbortError" || error?.name === "TimeoutError") {
    return new AgintiAdapterError("AgInTi request was interrupted", {
      code: error.name === "TimeoutError" ? "AGINTI_TIMEOUT" : "AGINTI_ABORTED",
      statusCode: error.name === "TimeoutError" ? 504 : 499,
      retryable: error.name === "TimeoutError",
    });
  }
  return new AgintiAdapterError("AgInTi transport is unavailable");
}

function requestHeaders(token, context, mutation, accept) {
  const headers = new Headers({
    accept,
    authorization: `Bearer ${token}`,
    "content-type": "application/json; charset=utf-8",
    [AGINTI_INTERNAL_HEADERS.principal]: context.principalId,
    [AGINTI_INTERNAL_HEADERS.browserSession]: context.browserSession,
  });
  if (mutation) headers.set(AGINTI_INTERNAL_HEADERS.idempotency, context.idempotencyKey);
  return headers;
}

function parseSseBlock(block) {
  const fields = Object.create(null);
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const match = /^(id|event|data): ?([^\r\n]*)$/u.exec(line);
    if (!match || Object.hasOwn(fields, match[1])) {
      fail("AgInTi event stream contained an invalid field", { code: "AGINTI_RESPONSE_INVALID", statusCode: 502, retryable: false });
    }
    fields[match[1]] = match[2];
  }
  if (!Object.hasOwn(fields, "id") || !Object.hasOwn(fields, "event") || !Object.hasOwn(fields, "data")) {
    fail("AgInTi event stream block was incomplete", { code: "AGINTI_RESPONSE_INVALID", statusCode: 502, retryable: false });
  }
  let value;
  try { value = JSON.parse(fields.data); }
  catch { fail("AgInTi event stream data was invalid", { code: "AGINTI_RESPONSE_INVALID", statusCode: 502, retryable: false }); }
  return Object.freeze({ id: fields.id, type: fields.event, value });
}

function eventHash(event) {
  return createHash("sha256").update(canonicalJson({
    schemaVersion: event.schemaVersion,
    id: event.id,
    seq: event.seq,
    type: event.type,
    threadId: event.threadId,
    runId: event.runId,
    createdAt: event.createdAt,
    payload: event.payload,
    previousHash: event.previousHash,
  }), "utf8").digest("hex");
}

async function* sseBlocks(response) {
  if (!response.body || typeof response.body.getReader !== "function") {
    fail("AgInTi event stream body was unavailable", { code: "AGINTI_RESPONSE_INVALID", statusCode: 502, retryable: false });
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let size = 0;
  let pendingCarriageReturn = false;
  let ended = false;
  const normalize = (value, final = false) => {
    let text = pendingCarriageReturn ? `\r${value}` : value;
    pendingCarriageReturn = false;
    if (!final && text.endsWith("\r")) {
      pendingCarriageReturn = true;
      text = text.slice(0, -1);
    }
    return text.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { ended = true; break; }
      if (!(value instanceof Uint8Array)) {
        fail("AgInTi event stream was not bytes", { code: "AGINTI_RESPONSE_INVALID", statusCode: 502, retryable: false });
      }
      size += value.byteLength;
      if (size > STREAM_LIMIT) {
        fail("AgInTi event stream exceeded its bound", { code: "AGINTI_RESPONSE_INVALID", statusCode: 502, retryable: false });
      }
      buffer += normalize(decoder.decode(value, { stream: true }));
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (Buffer.byteLength(block, "utf8") > SSE_BLOCK_LIMIT) {
          fail("AgInTi event block exceeded its bound", { code: "AGINTI_RESPONSE_INVALID", statusCode: 502, retryable: false });
        }
        if (block && !block.split("\n").every((line) => !line || line.startsWith(":"))) yield block;
      }
      if (Buffer.byteLength(buffer, "utf8") > SSE_BLOCK_LIMIT) {
        fail("AgInTi event block exceeded its bound", { code: "AGINTI_RESPONSE_INVALID", statusCode: 502, retryable: false });
      }
    }
    buffer += normalize(decoder.decode(), true);
    const tail = buffer.trim();
    if (tail) yield tail;
  } catch (error) {
    if (error instanceof AgintiAdapterError) throw error;
    throw responseFailure(error);
  } finally {
    if (!ended) await reader.cancel().catch(() => {});
    reader.releaseLock?.();
  }
}

export function createAgintiAgentAdapter({ upstream, credentialProvider, fetchImpl = globalThis.fetch } = {}) {
  const origin = normalizeUpstream(upstream);
  if (typeof credentialProvider !== "function") throw new TypeError("credentialProvider must be a function");
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");

  async function request(pathname, body, context) {
    if (!Object.values(AGINTI_RPC_PATHS).includes(pathname)) throw new TypeError("unknown AgInTi RPC path");
    const mutation = rpcPathIsMutation(pathname);
    const input = validateAgentRequest(pathname, body);
    const safeContext = normalizeContext(context, mutation);
    const token = await credential(credentialProvider);
    const endpoint = `${origin}${pathname}`;

    if (pathname === AGINTI_RPC_PATHS.runsEvents) {
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          cache: "no-store",
          redirect: "error",
          headers: requestHeaders(token, safeContext, false, "text/event-stream"),
          body: JSON.stringify(input),
          signal: safeContext.signal,
        });
      } catch (error) { throw responseFailure(error); }
      if (!response.ok) throw upstreamError(response);
      assertUnencoded(response);
      if (mediaType(response) !== "text/event-stream") {
        await response.body?.cancel?.().catch(() => {});
        fail("AgInTi event stream content type was invalid", { code: "AGINTI_RESPONSE_INVALID", statusCode: 502, retryable: false });
      }
      return (async function* events() {
        let sequence = input.afterSeq;
        let previousHash = input.afterHash;
        for await (const block of sseBlocks(response)) {
          const parsed = parseSseBlock(block);
          let event;
          try { event = validateEventEnvelope(parsed.value); }
          catch { fail("AgInTi event envelope was invalid", { code: "AGINTI_RESPONSE_INVALID", statusCode: 502, retryable: false }); }
          if (parsed.id !== event.id || parsed.type !== event.type || event.runId !== input.runId
              || event.seq !== sequence + 1 || event.previousHash !== previousHash
              || eventHash(event) !== event.hash) {
            fail("AgInTi event ledger verification failed", { code: "AGINTI_RESPONSE_INVALID", statusCode: 502, retryable: false });
          }
          sequence = event.seq;
          previousHash = event.hash;
          yield event;
        }
      })();
    }

    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        cache: "no-store",
        redirect: "error",
        headers: requestHeaders(token, safeContext, mutation, "application/json"),
        body: JSON.stringify(input),
        signal: safeContext.signal,
      });
    } catch (error) { throw responseFailure(error); }
    if (!response.ok) throw upstreamError(response);
    assertUnencoded(response);
    if (mediaType(response) !== "application/json") {
      await response.body?.cancel?.().catch(() => {});
      fail("AgInTi response content type was invalid", { code: "AGINTI_RESPONSE_INVALID", statusCode: 502, retryable: false });
    }
    let decoded;
    try { decoded = JSON.parse(await readBoundedText(response, JSON_LIMIT)); }
    catch (error) {
      if (error instanceof AgintiAdapterError) throw error;
      fail("AgInTi response JSON was invalid", { code: "AGINTI_RESPONSE_INVALID", statusCode: 502, retryable: false });
    }
    try { return validateAgentResponse(pathname, decoded); }
    catch { fail("AgInTi response envelope was invalid", { code: "AGINTI_RESPONSE_INVALID", statusCode: 502, retryable: false }); }
  }

  return Object.freeze({
    rpc: request,
    async capabilities(context) {
      try { return await request(AGINTI_RPC_PATHS.capabilities, {}, context); }
      catch { return FAIL_CLOSED_AGENT_CAPABILITIES; }
    },
  });
}
