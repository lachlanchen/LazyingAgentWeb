import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer as createNodeServer } from 'node:http';
import { isIP } from 'node:net';

import {
  AGENT_ROUTE_MAP,
  CLOUD_HTTP_LIMITS,
  CLOUD_ROUTES,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  IDEMPOTENCY_HEADER_NAME,
  SESSION_COOKIE_NAME,
  TRUSTED_CLIENT_ADDRESS_HEADER,
  TRUSTED_PUBLIC_AUTHORITY_HEADER,
  CloudHttpError,
  bodyLimitForRoute,
  classifyRequestTarget,
  routeRequiresIdempotency,
  snapshotAndValidateAssetMap,
  validateAccountConfig,
  validateAgentIdempotencyKey,
  validateChatRequest,
  validateEmptyBody,
  validateLoginBody,
  validatePublicOrigin,
  validateRequestIdempotencyKey,
  validateTransportAgentRequest
} from './http-contract.js';
import { ControlPlaneError } from './errors.js';
import { VISION_MODEL_ALIAS } from './vision-attachment.js';
import {
  AGINTI_RPC_PATHS,
  FAIL_CLOSED_AGENT_CAPABILITIES,
  validateAgentResponse,
  validateEventEnvelope
} from './web/aginti-protocol.js';

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const DYNAMIC_CACHE_CONTROL = 'no-store';
const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;
const REMEMBERED_SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const GLOBAL_DISPATCH_RETRY_MS = 250;
const SAFE_FAILURE_CODES = new Set([
  'provider_unavailable',
  'timeout',
  'internal_error',
  'response_limit',
  'content_rejected'
]);
const PUBLIC_THREAD_FIELDS = Object.freeze([
  'threadId', 'title', 'modelAlias', 'revision', 'ledgerHash', 'messageCount',
  'ledgerBytes', 'currentGenerationId', 'createdAt', 'updatedAt'
]);
const PUBLIC_MESSAGE_FIELDS = Object.freeze([
  'threadId', 'messageId', 'revision', 'role', 'content', 'contentBytes',
  'previousHash', 'messageHash', 'generationId', 'createdAt'
]);
const PUBLIC_GENERATION_FIELDS = Object.freeze([
  'threadId', 'generationId', 'assistantMessageId', 'status', 'terminal',
  'modelAlias', 'sourceRevision', 'sourceHash', 'deltaCount', 'deltaBytes',
  'lastDeltaHash', 'finalRevision', 'finalHash', 'failureCode', 'deltasPruned',
  'startedAt', 'updatedAt', 'terminalAt', 'prunedAt'
]);
const PUBLIC_DELTA_FIELDS = Object.freeze([
  'threadId', 'generationId', 'sequence', 'content', 'contentBytes',
  'previousHash', 'deltaHash', 'createdAt'
]);

function epochMilliseconds(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  const result = date.getTime();
  if (!Number.isFinite(result)) throw new TypeError('clock returned an invalid time');
  return result;
}

function exactLimitOverrides(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)
      || Object.getPrototypeOf(input) !== Object.prototype) {
    throw new TypeError('limits must be a plain object');
  }
  const bounds = Object.freeze({
    bodyTimeoutMs: [50, 15_000],
    visionBodyTimeoutMs: [1_000, 120_000],
    dependencyTimeoutMs: [50, 120_000],
    jobTimeoutMs: [50, 600_000],
    sseLifetimeMs: [100, 120_000],
    ssePollMs: [5, 5_000],
    concurrentBodies: [1, 256],
    concurrentBodiesPerSource: [1, 16],
    concurrentLogins: [1, 32],
    concurrentLoginsPerSource: [1, 4],
    concurrentStreams: [1, 64],
    concurrentStreamsPerSession: [1, 8],
    loginAttemptsPerMinute: [1, 60],
    directChatJobs: [1, 32]
  });
  const result = { ...CLOUD_HTTP_LIMITS };
  for (const [name, value] of Object.entries(input)) {
    if (!Object.hasOwn(bounds, name)) throw new TypeError(`unsupported HTTP limit ${name}`);
    const [minimum, maximum] = bounds[name];
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new TypeError(`${name} is outside its safe range`);
    }
    result[name] = value;
  }
  if (result.concurrentBodiesPerSource > result.concurrentBodies
      || result.concurrentLoginsPerSource > result.concurrentLogins
      || result.concurrentStreamsPerSession > result.concurrentStreams) {
    throw new TypeError('per-source concurrency cannot exceed total concurrency');
  }
  return Object.freeze(result);
}

function requireMethods(value, name, methods) {
  if (!value || methods.some((method) => typeof value[method] !== 'function')) {
    throw new TypeError(`${name} must provide ${methods.join('(), ')}()`);
  }
  return value;
}

function validatePasswordVerifier(value) {
  if (!value || value.algorithm !== 'scrypt' || typeof value.verify !== 'function') {
    throw new TypeError('passwordVerifier must be an injected scrypt verifier');
  }
  return value;
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function derivedIdempotencyKey(label, ...parts) {
  return `${label}.${sha256(parts.join('\u0000'))}`;
}

function safeEqual(first, second) {
  if (typeof first !== 'string' || typeof second !== 'string') return false;
  const firstBytes = Buffer.from(first, 'utf8');
  const secondBytes = Buffer.from(second, 'utf8');
  const maximum = Math.max(firstBytes.byteLength, secondBytes.byteLength, 1);
  const left = Buffer.alloc(maximum);
  const right = Buffer.alloc(maximum);
  firstBytes.copy(left);
  secondBytes.copy(right);
  return timingSafeEqual(left, right) && firstBytes.byteLength === secondBytes.byteLength;
}

function opaqueToken() {
  return randomBytes(32).toString('base64url');
}

function commonSecurityHeaders() {
  return {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
    'x-frame-options': 'DENY',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'strict-transport-security': 'max-age=31536000; includeSubDomains',
    'cross-origin-resource-policy': 'same-origin',
    'cross-origin-opener-policy': 'same-origin'
  };
}

function dynamicHeaders(extra = {}) {
  return {
    ...commonSecurityHeaders(),
    'cache-control': DYNAMIC_CACHE_CONTROL,
    pragma: 'no-cache',
    expires: '0',
    ...extra
  };
}

function writeHead(res, status, headers) {
  if (res.headersSent) return;
  res.writeHead(status, headers);
}

function sendBuffer(req, res, status, body, headers) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
  writeHead(res, status, { ...headers, 'content-length': String(payload.byteLength) });
  res.end(req.method === 'HEAD' ? undefined : payload);
}

function encodeJson(value, maximum = CLOUD_HTTP_LIMITS.responseJsonBytes) {
  const body = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  if (body.byteLength > maximum) throw new CloudHttpError(502, 'response_too_large', 'An upstream response exceeded its public limit.');
  return body;
}

function sendJson(req, res, status, value, extraHeaders = {}) {
  sendBuffer(req, res, status, encodeJson(value), dynamicHeaders({
    'content-type': JSON_CONTENT_TYPE,
    ...extraHeaders
  }));
}

function publicError(error) {
  if (error instanceof CloudHttpError) return error;
  if (error instanceof ControlPlaneError) {
    const mapping = {
      invalid_input: [400, 'invalid_request'],
      not_found: [404, 'not_found'],
      conflict: [409, 'conflict'],
      idempotency_conflict: [409, 'idempotency_conflict'],
      storage_security_error: [503, 'storage_unavailable'],
      storage_corruption: [503, 'storage_unavailable'],
      unsupported_schema: [503, 'storage_unavailable']
    };
    const [status, code] = mapping[error.code] ?? [500, 'internal_error'];
    return new CloudHttpError(status, code, status >= 500 ? 'The service is temporarily unavailable.' : 'The request could not be completed.');
  }
  if (typeof error?.code === 'string' && error.code.startsWith('AGINTI_')) {
    const status = Number(error.statusCode);
    return new CloudHttpError(
      [400, 401, 403, 404, 409, 429, 502, 503, 504].includes(status) ? status : 503,
      status === 429 ? 'agent_rate_limited' : 'agent_unavailable',
      status < 500 ? 'The Agent request was not accepted.' : 'AgInTi Agent is temporarily unavailable.'
    );
  }
  if (error?.name === 'AbortError') return new CloudHttpError(499, 'request_cancelled', 'The request was cancelled.');
  if (error?.name === 'TimeoutError') return new CloudHttpError(504, 'dependency_timeout', 'A required service timed out.');
  return new CloudHttpError(500, 'internal_error', 'The service could not complete the request.');
}

function sendError(req, res, error) {
  const safe = publicError(error);
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  const headers = {
    ...(safe.retryAfter === undefined ? {} : { 'retry-after': String(safe.retryAfter) }),
    ...([408, 413].includes(safe.status) || safe.code === 'unexpected_body' || req.shouldKeepAlive === false
      ? { connection: 'close' }
      : {})
  };
  sendJson(req, res, safe.status === 499 ? 400 : safe.status, {
    error: { code: safe.code, message: safe.message }
  }, headers);
}

function methodNotAllowed(req, res, allow) {
  sendJson(req, res, 405, { error: { code: 'method_not_allowed', message: 'The request method is not allowed.' } }, { allow });
}

function rawHeaderValues(req, requestedName) {
  const name = requestedName.toLowerCase();
  const values = [];
  if (Array.isArray(req.rawHeaders)) {
    for (let index = 0; index + 1 < req.rawHeaders.length; index += 2) {
      if (String(req.rawHeaders[index]).toLowerCase() === name) values.push(req.rawHeaders[index + 1]);
    }
    return values;
  }
  const value = req.headers?.[name];
  if (Array.isArray(value)) return value;
  return value === undefined ? [] : [value];
}

function isLoopbackPeer(peer) {
  return peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
}

function requirePublicAuthority(req, publicHost) {
  const hostValues = rawHeaderValues(req, 'host');
  const asserted = rawHeaderValues(req, TRUSTED_PUBLIC_AUTHORITY_HEADER);
  const peer = req.socket?.remoteAddress;
  if (hostValues.length !== 1 || hostValues[0] !== publicHost) {
    throw new CloudHttpError(421, 'misdirected_request', 'The request authority is not accepted.');
  }
  if (isLoopbackPeer(peer)) {
    if (asserted.length !== 1 || asserted[0] !== publicHost) {
      throw new CloudHttpError(421, 'misdirected_request', 'The trusted proxy authority assertion is not accepted.');
    }
  } else if (asserted.length !== 0) {
    throw new CloudHttpError(421, 'misdirected_request', 'A trusted proxy authority assertion was received from an untrusted peer.');
  }
}

export function resolveTrustedClientAddress(req) {
  const peer = req.socket?.remoteAddress;
  const loopback = isLoopbackPeer(peer);
  const asserted = rawHeaderValues(req, TRUSTED_CLIENT_ADDRESS_HEADER);
  if (loopback) {
    if (asserted.length !== 1 || typeof asserted[0] !== 'string' || isIP(asserted[0]) === 0) {
      throw new CloudHttpError(403, 'proxy_assertion_rejected', 'The trusted proxy client-address assertion is missing or invalid.');
    }
    return asserted[0];
  }
  if (asserted.length !== 0) {
    throw new CloudHttpError(403, 'proxy_assertion_rejected', 'A client-address assertion was received from an untrusted peer.');
  }
  if (typeof peer !== 'string' || isIP(peer) === 0) {
    throw new CloudHttpError(403, 'peer_rejected', 'The network peer address is invalid.');
  }
  return peer;
}

class ConcurrencyGate {
  #maximum;
  #perSource;
  #sources = new Map();
  #total = 0;

  constructor(maximum, perSource) {
    this.#maximum = maximum;
    this.#perSource = perSource;
  }

  enter(source) {
    const current = this.#sources.get(source) ?? 0;
    if (this.#total >= this.#maximum || current >= this.#perSource) return null;
    this.#total += 1;
    this.#sources.set(source, current + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#total -= 1;
      const next = (this.#sources.get(source) ?? 1) - 1;
      if (next <= 0) this.#sources.delete(source);
      else this.#sources.set(source, next);
    };
  }

  get active() {
    return this.#total;
  }
}

function hasRequestBodyFraming(req) {
  const contentLengths = rawHeaderValues(req, 'content-length');
  const transferEncodings = rawHeaderValues(req, 'transfer-encoding');
  const contentEncodings = rawHeaderValues(req, 'content-encoding');
  const expectations = rawHeaderValues(req, 'expect');
  const validEmptyLength = contentLengths.length === 0
    || (contentLengths.length === 1 && contentLengths[0] === '0');
  return !validEmptyLength || transferEncodings.length !== 0
    || contentEncodings.length !== 0 || expectations.length !== 0;
}

function rejectRequestBodyFraming(req) {
  if (hasRequestBodyFraming(req)) {
    req.shouldKeepAlive = false;
    throw new CloudHttpError(400, 'unexpected_body', 'This request does not accept a body.');
  }
}

function publicOwnedRecord(value, accountId, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CloudHttpError(503, 'storage_unavailable', `The stored ${label} ownership is invalid.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const owner = descriptors.accountId;
  if (!owner || !owner.enumerable || !Object.hasOwn(owner, 'value') || owner.value !== accountId) {
    throw new CloudHttpError(503, 'storage_unavailable', `The stored ${label} ownership is invalid.`);
  }
  const result = {};
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new CloudHttpError(503, 'storage_unavailable', `The stored ${label} shape is invalid.`);
    }
    result[field] = descriptor.value;
  }
  return Object.freeze(result);
}

function publicThread(value, accountId) {
  return publicOwnedRecord(value, accountId, PUBLIC_THREAD_FIELDS, 'chat thread');
}

function publicMessage(value, accountId) {
  const message = publicOwnedRecord(value, accountId, PUBLIC_MESSAGE_FIELDS, 'chat message');
  if (value.attachment === undefined) return message;
  const attachment = value.attachment;
  if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) {
    throw new CloudHttpError(503, 'storage_unavailable', 'The stored chat attachment descriptor is invalid.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(attachment);
  const expected = ['attachmentId', 'mediaType', 'byteLength', 'width', 'height', 'sha256'];
  if (Reflect.ownKeys(descriptors).length !== expected.length
      || expected.some((field) => !descriptors[field]?.enumerable
        || !Object.hasOwn(descriptors[field], 'value'))) {
    throw new CloudHttpError(503, 'storage_unavailable', 'The stored chat attachment descriptor is invalid.');
  }
  return Object.freeze({ ...message, attachment: Object.freeze({ ...attachment }) });
}

function publicGeneration(value, accountId) {
  return publicOwnedRecord(value, accountId, PUBLIC_GENERATION_FIELDS, 'chat generation');
}

function publicDelta(value, accountId) {
  return publicOwnedRecord(value, accountId, PUBLIC_DELTA_FIELDS, 'chat delta');
}

function requireAgentResponseCorrelation(pathname, input, response) {
  let matches = true;
  if ([AGINTI_RPC_PATHS.threadsGet, AGINTI_RPC_PATHS.threadsUpdate].includes(pathname)) {
    matches = response.thread.id === input.threadId;
  } else if (pathname === AGINTI_RPC_PATHS.threadsDelete) {
    matches = response.threadId === input.threadId;
  } else if (pathname === AGINTI_RPC_PATHS.runsStart) {
    matches = response.run.threadId === input.threadId;
  } else if ([AGINTI_RPC_PATHS.runsStatus, AGINTI_RPC_PATHS.runsCancel].includes(pathname)) {
    matches = response.run.id === input.runId;
  } else if (pathname === AGINTI_RPC_PATHS.runsResume) {
    matches = response.run.previousRunId === input.runId;
  } else if (pathname === AGINTI_RPC_PATHS.artifactsGet) {
    matches = response.artifact.id === input.artifactId;
  }
  if (!matches) {
    throw new CloudHttpError(502, 'invalid_agent_response', 'AgInTi returned a response for a different resource.');
  }
  return response;
}

class LoginAdmission {
  #attempts = new Map();
  #clock;
  #gate;
  #maximumAttempts;

  constructor({ clock, maximum, perSource, maximumAttempts }) {
    this.#clock = clock;
    this.#gate = new ConcurrencyGate(maximum, perSource);
    this.#maximumAttempts = maximumAttempts;
  }

  enter(source) {
    const now = epochMilliseconds(this.#clock);
    const existing = this.#attempts.get(source);
    const record = !existing || now - existing.windowStart >= 60_000
      ? { windowStart: now, count: 0, lastSeen: now }
      : existing;
    if (record.count >= this.#maximumAttempts) {
      record.lastSeen = now;
      this.#attempts.set(source, record);
      return { error: new CloudHttpError(429, 'login_rate_limited', 'Sign-in is temporarily rate limited.', { retryAfter: 60 }) };
    }
    const release = this.#gate.enter(source);
    if (!release) {
      return { error: new CloudHttpError(503, 'login_busy', 'The sign-in service is temporarily busy.', { retryAfter: 2 }) };
    }
    record.count += 1;
    record.lastSeen = now;
    this.#attempts.set(source, record);
    if (this.#attempts.size > 1_024) {
      const oldest = [...this.#attempts.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen).slice(0, 256);
      for (const [key] of oldest) if (key !== source) this.#attempts.delete(key);
    }
    return { release };
  }
}

function validateJsonContentType(req) {
  const encoding = req.headers['content-encoding'];
  if (encoding !== undefined && String(encoding).toLowerCase() !== 'identity') {
    throw new CloudHttpError(415, 'unsupported_content_encoding', 'Compressed request bodies are not accepted.');
  }
  const value = req.headers['content-type'];
  if (typeof value !== 'string') throw new CloudHttpError(415, 'unsupported_media_type', 'Content-Type must be application/json.');
  const parts = value.toLowerCase().split(';').map((part) => part.trim());
  if (parts[0] !== 'application/json' || parts.length > 2 || (parts.length === 2 && parts[1] !== 'charset=utf-8')) {
    throw new CloudHttpError(415, 'unsupported_media_type', 'Content-Type must be application/json.');
  }
}

function readJsonBody(req, maximum, timeoutMs) {
  validateJsonContentType(req);
  const advertised = req.headers['content-length'];
  if (advertised !== undefined && (typeof advertised !== 'string' || !/^\d+$/u.test(advertised)
      || Number(advertised) > maximum)) {
    req.shouldKeepAlive = false;
    throw new CloudHttpError(413, 'request_too_large', 'The request body is too large.');
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('aborted', onAborted);
      req.off('error', onError);
      callback();
    };
    const onData = (chunk) => {
      bytes += chunk.byteLength;
      if (bytes > maximum) {
        req.shouldKeepAlive = false;
        finish(() => reject(new CloudHttpError(413, 'request_too_large', 'The request body is too large.')));
        req.pause();
        return;
      }
      chunks.push(Buffer.from(chunk));
    };
    const onEnd = () => finish(() => {
      let value;
      try {
        const source = Buffer.concat(chunks, bytes).toString('utf8');
        if (Buffer.byteLength(source, 'utf8') !== bytes || source.length === 0) throw new Error('invalid UTF-8 or empty body');
        value = JSON.parse(source);
      } catch (error) {
        reject(new CloudHttpError(400, 'invalid_json', 'The request body must be valid UTF-8 JSON.', { cause: error }));
        return;
      }
      resolve(value);
    });
    const onAborted = () => finish(() => reject(new CloudHttpError(400, 'request_aborted', 'The request body was interrupted.')));
    const onError = (error) => finish(() => reject(new CloudHttpError(400, 'request_error', 'The request body could not be read.', { cause: error })));
    const timer = setTimeout(() => finish(() => {
      req.shouldKeepAlive = false;
      reject(new CloudHttpError(408, 'request_timeout', 'The request body was not received in time.'));
    }), timeoutMs);
    timer.unref?.();
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('aborted', onAborted);
    req.once('error', onError);
  });
}

function requireOriginAndFetchMetadata(req, publicOrigin) {
  if (req.headers.origin !== publicOrigin) {
    throw new CloudHttpError(403, 'origin_rejected', 'The request origin is not allowed.');
  }
  if (req.headers['sec-fetch-site'] !== 'same-origin') {
    throw new CloudHttpError(403, 'fetch_metadata_rejected', 'Cross-site requests are not allowed.');
  }
  const mode = req.headers['sec-fetch-mode'];
  if (!['cors', 'same-origin'].includes(mode) || req.headers['sec-fetch-dest'] !== 'empty') {
    throw new CloudHttpError(403, 'fetch_metadata_rejected', 'The request fetch metadata is not allowed.');
  }
}

function parseCookie(req, name) {
  const header = req.headers.cookie;
  if (header === undefined) return null;
  if (typeof header !== 'string' || Buffer.byteLength(header, 'utf8') > CLOUD_HTTP_LIMITS.cookieBytes) {
    throw new CloudHttpError(400, 'invalid_cookie', 'The Cookie header is invalid.');
  }
  const matches = [];
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    if (part.slice(0, index).trim() === name) matches.push(part.slice(index + 1).trim());
  }
  if (matches.length > 1) throw new CloudHttpError(400, 'invalid_cookie', 'A session cookie was duplicated.');
  if (matches.length === 0) return null;
  if (!/^[A-Za-z0-9_-]{32,128}$/u.test(matches[0])) throw new CloudHttpError(401, 'invalid_session', 'The browser session is invalid.');
  return matches[0];
}

function csrfFromRequest(req) {
  const value = req.headers[CSRF_HEADER_NAME];
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/u.test(value)) {
    throw new CloudHttpError(403, 'csrf_rejected', 'The CSRF token is missing or invalid.');
  }
  return value;
}

function requestIdempotency(req, agent = false) {
  const value = req.headers[IDEMPOTENCY_HEADER_NAME];
  return agent ? validateAgentIdempotencyKey(value) : validateRequestIdempotencyKey(value);
}

function sessionCookie(value, maximumAge) {
  return `${SESSION_COOKIE_NAME}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maximumAge}`;
}

function csrfCookie(value, maximumAge) {
  return `${CSRF_COOKIE_NAME}=${value}; Path=/; Secure; SameSite=Strict; Max-Age=${maximumAge}`;
}

function clearedCookies() {
  const suffix = 'Path=/; Secure; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT';
  return [
    `${SESSION_COOKIE_NAME}=; ${suffix}; HttpOnly`,
    `${CSRF_COOKIE_NAME}=; ${suffix}`
  ];
}

function browserSessionId(sessionToken) {
  return sha256(sessionToken);
}

function requestAbortController(req, res) {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) controller.abort(new DOMException('request disconnected', 'AbortError'));
  };
  const close = () => { if (!res.writableEnded) abort(); };
  req.once('aborted', abort);
  res.once('close', close);
  return {
    controller,
    cleanup() {
      req.off('aborted', abort);
      res.off('close', close);
    }
  };
}

function deadlineSignal(parentSignal, milliseconds, message) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal.reason ?? new DOMException('aborted', 'AbortError'));
  if (parentSignal.aborted) abortFromParent();
  else parentSignal.addEventListener('abort', abortFromParent, { once: true });
  const timer = setTimeout(() => {
    const error = new Error(message);
    error.name = 'TimeoutError';
    controller.abort(error);
  }, milliseconds);
  timer.unref?.();
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      parentSignal.removeEventListener('abort', abortFromParent);
    }
  };
}

async function withTimeout(callback, { signal, milliseconds, timeoutMessage = 'dependency timed out' }) {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal.reason ?? new DOMException('aborted', 'AbortError'));
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timer = setTimeout(() => {
    const error = new Error(timeoutMessage);
    error.name = 'TimeoutError';
    controller.abort(error);
  }, milliseconds);
  timer.unref?.();
  try {
    return await Promise.race([
      Promise.resolve().then(() => callback(controller.signal)),
      new Promise((_, reject) => {
        const aborted = () => reject(controller.signal.reason ?? new DOMException('aborted', 'AbortError'));
        if (controller.signal.aborted) aborted();
        else controller.signal.addEventListener('abort', aborted, { once: true });
      })
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abortFromCaller);
  }
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    timer.unref?.();
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function nextWithAbort(iterator, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, signal.reason ?? new DOMException('aborted', 'AbortError'));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(() => iterator.next()).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error)
    );
  });
}

async function* abortableAsyncIterable(iterable, signal) {
  const iterator = iterable[Symbol.asyncIterator]();
  try {
    while (true) {
      const item = await nextWithAbort(iterator, signal);
      if (item.done) return;
      yield item.value;
    }
  } finally {
    if (signal.aborted && typeof iterator.return === 'function') {
      try { void iterator.return(); } catch { /* The aborted producer is already detached. */ }
    }
  }
}

function valueWithAbort(value, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, result) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback(result);
    };
    const onAbort = () => finish(reject, signal.reason ?? new DOMException('aborted', 'AbortError'));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(value).then(
      (result) => finish(resolve, result),
      (error) => finish(reject, error)
    );
  });
}

function jsonSseEvent({ event, data, id }) {
  return `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function writeSse(res, value, signal) {
  if (signal.aborted || res.writableEnded || res.destroyed) throw signal.reason ?? new DOMException('aborted', 'AbortError');
  if (res.write(value)) return;
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      res.off('drain', onDrain);
      res.off('close', onClose);
      signal.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onDrain = () => finish(resolve);
    const onClose = () => finish(reject, new DOMException('response closed', 'AbortError'));
    const onAbort = () => finish(reject, signal.reason ?? new DOMException('aborted', 'AbortError'));
    res.once('drain', onDrain);
    res.once('close', onClose);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function safeConnectorFailure(error, timedOut) {
  if (timedOut || error?.name === 'TimeoutError') return 'timeout';
  return SAFE_FAILURE_CODES.has(error?.failureCode) ? error.failureCode : 'provider_unavailable';
}

function splitUtf8(value, maximumBytes) {
  if (typeof value !== 'string' || value.length < 1 || value.includes('\u0000')) {
    throw new Error('connector returned an invalid delta');
  }
  const chunks = [];
  let chunk = '';
  let bytes = 0;
  for (const scalar of value) {
    const scalarBytes = Buffer.byteLength(scalar, 'utf8');
    if (bytes + scalarBytes > maximumBytes && chunk) {
      chunks.push(chunk);
      chunk = '';
      bytes = 0;
    }
    if (scalarBytes > maximumBytes) throw new Error('connector delta scalar exceeds its byte limit');
    chunk += scalar;
    bytes += scalarBytes;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

async function persistedDeltas(store, accountId, threadId, generationId) {
  const result = [];
  let afterSequence = 0;
  let generation = null;
  while (result.length < 8_192) {
    const page = store.replayGeneration({ accountId, threadId, generationId, afterSequence, limit: 200 });
    generation = page.generation;
    result.push(...page.deltas);
    if (page.deltas.length === 0 || !page.hasMore) break;
    afterSequence = page.deltas[page.deltas.length - 1].sequence;
  }
  return { generation, deltas: result };
}

export function createCloudRequestHandler({
  releaseId,
  assetMap,
  publicOrigin,
  account,
  passwordVerifier,
  sessionStore,
  controlStore,
  directChatStore,
  directChatContext,
  directChatConnector,
  visionEnabled = false,
  visionModelAlias = VISION_MODEL_ALIAS,
  agintiAdapter,
  clock = () => new Date(),
  limits: limitOverrides = {}
} = {}) {
  const assets = snapshotAndValidateAssetMap(assetMap, releaseId);
  const origin = validatePublicOrigin(publicOrigin);
  const publicHost = new URL(origin).host;
  const configuredAccount = validateAccountConfig(account);
  const verifier = validatePasswordVerifier(passwordVerifier);
  const sessions = requireMethods(sessionStore ?? controlStore, 'sessionStore', [
    'createBrowserSession', 'authenticateBrowserSession', 'authenticateBrowserMutation', 'revokeBrowserSession'
  ]);
  const controls = requireMethods(controlStore, 'controlStore', ['getAccount']);
  const chat = requireMethods(directChatStore, 'directChatStore', [
    'createThread', 'getThread', 'listThreads', 'startTurn',
    'appendGenerationDelta', 'finalizeGeneration', 'cancelGeneration', 'failGeneration',
    'getGeneration', 'replayGeneration', 'listMessages',
    'getVisionAttachment', 'getLatestVisionAttachment',
    'claimGenerationLease', 'markGenerationDispatchStarted', 'renewGenerationLease',
    'releaseGenerationLease', 'getGenerationLease'
  ]);
  if (directChatConnector !== undefined && directChatConnector !== null && typeof directChatConnector.generate !== 'function') {
    throw new TypeError('directChatConnector must provide generate()');
  }
  if (typeof visionEnabled !== 'boolean' || typeof visionModelAlias !== 'string'
      || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(visionModelAlias)) {
    throw new TypeError('Direct Chat vision configuration is invalid');
  }
  const contextCoordinator = directChatContext === undefined || directChatContext === null
    ? null
    : requireMethods(directChatContext, 'directChatContext', ['prepareForTurn', 'assemble']);
  if (directChatConnector && contextCoordinator === null) {
    throw new TypeError('directChatContext is required when Direct LocalLLM chat is enabled');
  }
  if (agintiAdapter !== undefined && agintiAdapter !== null
      && (typeof agintiAdapter.rpc !== 'function' || typeof agintiAdapter.capabilities !== 'function')) {
    throw new TypeError('agintiAdapter must provide the frozen rpc() and capabilities() interface');
  }
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');
  const limits = exactLimitOverrides(limitOverrides);
  const bodyGate = new ConcurrencyGate(limits.concurrentBodies, limits.concurrentBodiesPerSource);
  const loginAdmission = new LoginAdmission({
    clock,
    maximum: limits.concurrentLogins,
    perSource: limits.concurrentLoginsPerSource,
    maximumAttempts: limits.loginAttemptsPerMinute
  });
  const streamGate = new ConcurrencyGate(limits.concurrentStreams, limits.concurrentStreamsPerSession);
  const jobs = new Map();
  let stopping = false;
  let backgroundDrain = null;

  async function authenticate(req, { csrf = true } = {}) {
    const sessionToken = parseCookie(req, SESSION_COOKIE_NAME);
    if (!sessionToken) return null;
    const session = await sessions.authenticateBrowserSession({ sessionToken });
    if (!session || session.accountId !== configuredAccount.principalId) return null;
    if (csrf) {
      const csrfToken = csrfFromRequest(req);
      const mutated = await sessions.authenticateBrowserMutation({ sessionToken, csrfToken });
      if (!mutated || mutated.accountId !== configuredAccount.principalId) {
        throw new CloudHttpError(403, 'csrf_rejected', 'The CSRF token is missing or invalid.');
      }
    }
    return Object.freeze({
      token: sessionToken,
      view: session,
      browserSession: browserSessionId(sessionToken)
    });
  }

  function requireAuthentication(value) {
    if (!value) throw new CloudHttpError(401, 'authentication_required', 'A valid browser session is required.');
    return value;
  }

  async function handleLogin(req, res, body, requestSignal, clientAddress) {
    const admission = loginAdmission.enter(`${clientAddress}\u0000${configuredAccount.principalId}`);
    if (admission.error) throw admission.error;
    let password = body.password;
    try {
      const passwordAccepted = await withTimeout(
        (signal) => verifier.verify(password, { signal }),
        { signal: requestSignal, milliseconds: limits.dependencyTimeoutMs, timeoutMessage: 'password verification timed out' }
      );
      const accepted = passwordAccepted === true && safeEqual(body.username, configuredAccount.username);
      password = undefined;
      if (!accepted) throw new CloudHttpError(401, 'invalid_credentials', 'The username or password was not accepted.');
      const boundAccount = await controls.getAccount(configuredAccount.principalId);
      if (!boundAccount || boundAccount.id !== configuredAccount.principalId) {
        throw new CloudHttpError(503, 'account_unavailable', 'The configured account is unavailable.');
      }
      const sessionToken = opaqueToken();
      const csrfToken = opaqueToken();
      const maximumAge = body.remember ? REMEMBERED_SESSION_MAX_AGE_SECONDS : SESSION_MAX_AGE_SECONDS;
      const expiresAt = new Date(epochMilliseconds(clock) + maximumAge * 1_000).toISOString();
      await sessions.createBrowserSession({
        accountId: configuredAccount.principalId,
        sessionToken,
        csrfToken,
        expiresAt,
        idempotencyKey: derivedIdempotencyKey('login', sessionToken)
      });
      sendJson(req, res, 200, {
        authenticated: true,
        username: configuredAccount.username,
        csrfToken
      }, {
        'set-cookie': [sessionCookie(sessionToken, maximumAge), csrfCookie(csrfToken, maximumAge)]
      });
    } finally {
      password = undefined;
      admission.release?.();
    }
  }

  async function handleSession(req, res) {
    const withoutCsrf = await authenticate(req, { csrf: false });
    if (!withoutCsrf) {
      sendJson(req, res, 200, { authenticated: false }, { 'set-cookie': clearedCookies() });
      return;
    }
    const authenticated = requireAuthentication(await authenticate(req));
    sendJson(req, res, 200, {
      authenticated: true,
      username: configuredAccount.username,
      csrfToken: csrfFromRequest(req)
    });
    return authenticated;
  }

  async function handleLogout(req, res) {
    const session = requireAuthentication(await authenticate(req));
    const idempotencyKey = derivedIdempotencyKey('logout', session.token);
    await sessions.revokeBrowserSession({
      accountId: configuredAccount.principalId,
      sessionToken: session.token,
      idempotencyKey
    });
    sendJson(req, res, 200, {
      signedOut: true,
      // The frozen transport has no browser-session-scoped cancellation RPC.
      // Never imply that revoking a cloud cookie cancelled AgInTi-owned work.
      agentCancellationPending: agintiAdapter !== undefined && agintiAdapter !== null
    }, { 'set-cookie': clearedCookies() });
  }

  function closeGenerationJobs() {
    stopping = true;
    if (backgroundDrain) return backgroundDrain;
    const pending = [...jobs.values()];
    for (const job of pending) {
      if (!job.controller.signal.aborted) {
        const error = new Error('cloud server is stopping');
        error.code = 'server_stopping';
        job.controller.abort(error);
      }
    }
    backgroundDrain = Promise.allSettled(pending.map((job) => job.promise)).then(() => undefined);
    return backgroundDrain;
  }

  function scheduleGeneration(accountId, threadId, generationId, startKey, preparation) {
    const jobKey = `${threadId}:${generationId}`;
    if (jobs.has(jobKey)) return true;
    if (stopping || !directChatConnector || jobs.size >= limits.directChatJobs) return false;
    const controller = new AbortController();
    const job = { controller, timedOut: false, promise: null, lease: null };
    jobs.set(jobKey, job);
    const timer = setTimeout(() => {
      job.timedOut = true;
      const error = new Error('direct chat generation timed out');
      error.name = 'TimeoutError';
      controller.abort(error);
    }, limits.jobTimeoutMs);
    timer.unref?.();
    job.promise = (async () => {
      try {
        const thread = chat.getThread(accountId, threadId);
        if (!thread) throw new Error('direct chat thread disappeared');
        const persisted = await persistedDeltas(chat, accountId, threadId, generationId);
        if (!persisted.generation || persisted.generation.status !== 'in_progress') return;
        const ownerToken = opaqueToken();
        let lease;
        try {
          lease = chat.claimGenerationLease({
            accountId,
            threadId,
            generationId,
            ownerToken,
            ttlMs: 30_000
          });
        } catch (error) {
          const observed = chat.getGenerationLease({ accountId, threadId, generationId });
          if (observed?.phase === 'interrupted') {
            try {
              chat.failGeneration({
                accountId,
                threadId,
                generationId,
                failureCode: 'provider_unavailable',
                idempotencyKey: derivedIdempotencyKey('chat-interrupted', startKey, generationId)
              });
            } catch {
              // Another process may have resolved the terminal state.
            }
          }
          return;
        }
        job.lease = Object.freeze({ ownerToken, fence: lease.fence });
        const renewTimer = setInterval(() => {
          try {
            chat.renewGenerationLease({
              accountId,
              threadId,
              generationId,
              ownerToken,
              fence: lease.fence,
              ttlMs: 30_000
            });
          } catch (error) {
            if (!controller.signal.aborted) controller.abort(error);
          }
        }, 10_000);
        renewTimer.unref?.();
        job.renewTimer = renewTimer;
        if (persisted.deltas.length !== 0) {
          const error = new Error('a partially delivered stateless generation cannot be redispatched');
          error.failureCode = 'provider_unavailable';
          throw error;
        }
        const context = await contextCoordinator.assemble({
          accountId,
          threadId,
          sourceRevision: persisted.generation.sourceRevision,
          sourceHash: persisted.generation.sourceHash,
          ...(preparation === undefined ? {} : { preparation })
        });
        const visionAttachment = chat.getLatestVisionAttachment({
          accountId,
          threadId,
          sourceRevision: persisted.generation.sourceRevision
        });
        if ((persisted.generation.modelAlias === visionModelAlias) !== (visionAttachment !== null)) {
          const error = new Error('persisted vision inference authority is inconsistent');
          error.failureCode = 'content_rejected';
          throw error;
        }
        while (true) {
          if (controller.signal.aborted) throw controller.signal.reason;
          const marker = chat.markGenerationDispatchStarted({
            accountId,
            threadId,
            generationId,
            ownerToken,
            fence: lease.fence
          });
          if (marker.dispatchAuthorized === true) break;
          if (marker.dispatchState !== 'global_busy') {
            const error = new Error('inference dispatch is already ambiguous');
            error.failureCode = 'provider_unavailable';
            throw error;
          }
          await delay(GLOBAL_DISPATCH_RETRY_MS, controller.signal);
        }
        const output = await valueWithAbort(directChatConnector.generate({
          modelAlias: persisted.generation.modelAlias,
          context: context.payload,
          ...(visionAttachment === null ? {} : {
            visionAttachment: Object.freeze({
              attachmentId: visionAttachment.attachmentId,
              messageId: visionAttachment.messageId,
              mediaType: visionAttachment.mediaType,
              byteLength: visionAttachment.byteLength,
              width: visionAttachment.width,
              height: visionAttachment.height,
              contentSha256: visionAttachment.contentSha256,
              content: visionAttachment.content
            })
          }),
          replay: Object.freeze({
            deltaCount: persisted.generation.deltaCount,
            lastDeltaHash: persisted.generation.lastDeltaHash
          }),
          signal: controller.signal
        }), controller.signal);
        if (!output || typeof output[Symbol.asyncIterator] !== 'function') {
          throw new Error('directChatConnector.generate() must return an async iterable');
        }
        let sequence = persisted.generation.deltaCount;
        let hash = persisted.generation.lastDeltaHash;
        let outputBytes = persisted.generation.deltaBytes;
        for await (const rawDelta of abortableAsyncIterable(output, controller.signal)) {
          if (controller.signal.aborted) throw controller.signal.reason;
          for (const delta of splitUtf8(rawDelta, limits.connectorDeltaBytes)) {
            outputBytes += Buffer.byteLength(delta, 'utf8');
            if (outputBytes > limits.connectorOutputBytes) {
              const error = new Error('connector output limit exceeded');
              error.failureCode = 'response_limit';
              throw error;
            }
            const appended = chat.appendGenerationDelta({
              accountId,
              threadId,
              generationId,
              expectedSequence: sequence,
              expectedHash: hash,
              content: delta,
              dispatchLease: job.lease
            });
            sequence = appended.sequence;
            hash = appended.deltaHash;
          }
        }
        if (controller.signal.aborted) throw controller.signal.reason;
        chat.finalizeGeneration({
          accountId,
          threadId,
          generationId,
          idempotencyKey: derivedIdempotencyKey('chat-finalize', startKey, generationId),
          dispatchLease: job.lease
        });
      } catch (error) {
        const current = chat.getGeneration({ accountId, threadId, generationId });
        if (!current || current.status !== 'in_progress') return;
        if (error?.code === 'server_stopping') return;
        try {
          chat.failGeneration({
            accountId,
            threadId,
            generationId,
            failureCode: safeConnectorFailure(error, job.timedOut),
            idempotencyKey: derivedIdempotencyKey('chat-fail', startKey, generationId),
            ...(job.lease === null ? {} : { dispatchLease: job.lease })
          });
        } catch {
          // Another request may have cancelled or completed the same durable generation.
        }
      } finally {
        clearTimeout(timer);
        if (job.renewTimer) clearInterval(job.renewTimer);
        if (job.lease) {
          try {
            chat.releaseGenerationLease({
              accountId,
              threadId,
              generationId,
              ownerToken: job.lease.ownerToken,
              fence: job.lease.fence
            });
          } catch {
            // A terminal write, cancellation, expiry, or newer fence already owns the durable result.
          }
        }
        if (jobs.get(jobKey) === job) jobs.delete(jobKey);
      }
    })();
    void job.promise.catch(() => {
      // The durable generation remains recoverable; shutdown waits for this task.
    });
    return true;
  }

  function schedulePersistedGeneration(accountId, threadId, generationId) {
    return scheduleGeneration(
      accountId,
      threadId,
      generationId,
      derivedIdempotencyKey('chat-recovery', accountId, threadId, generationId),
      undefined
    );
  }

  async function handleChat(req, res, route, body, session, requestSignal) {
    const accountId = configuredAccount.principalId;
    const input = validateChatRequest(route.pathname, body);
    const idempotencyKey = routeRequiresIdempotency(route.pathname)
      ? requestIdempotency(req)
      : undefined;
    if (route.pathname === CLOUD_ROUTES.chatCapabilities) {
      sendJson(req, res, 200, {
        visionInput: visionEnabled,
        visionMediaTypes: visionEnabled ? ['image/jpeg', 'image/png'] : [],
        maximumImageBytes: visionEnabled ? 4 * 1024 * 1024 : 0
      });
      return;
    }
    if (route.pathname === CLOUD_ROUTES.chatThreadsList) {
      const threads = chat.listThreads({ accountId, limit: input.limit })
        .map((thread) => publicThread(thread, accountId));
      sendJson(req, res, 200, { threads });
      return;
    }
    if (route.pathname === CLOUD_ROUTES.chatThreadsCreate) {
      const thread = chat.createThread({ accountId, ...input, idempotencyKey });
      sendJson(req, res, 201, { thread: publicThread(thread, accountId) });
      return;
    }
    if (route.pathname === CLOUD_ROUTES.chatThreadsGet) {
      const thread = chat.getThread(accountId, input.threadId);
      if (!thread) throw new CloudHttpError(404, 'not_found', 'The chat thread does not exist.');
      sendJson(req, res, 200, { thread: publicThread(thread, accountId) });
      return;
    }
    if (route.pathname === CLOUD_ROUTES.chatMessagesList) {
      const thread = chat.getThread(accountId, input.threadId);
      if (!thread) throw new CloudHttpError(404, 'not_found', 'The chat thread does not exist.');
      const messages = chat.listMessages({ accountId, ...input });
      sendJson(req, res, 200, { messages: messages.map((message) => publicMessage(message, accountId)) });
      return;
    }
    if (route.pathname === CLOUD_ROUTES.chatAttachmentsGet) {
      const attachment = chat.getVisionAttachment({ accountId, ...input });
      if (!attachment) throw new CloudHttpError(404, 'not_found', 'The chat attachment does not exist.');
      sendBuffer(req, res, 200, attachment.content, dynamicHeaders({
        'content-type': attachment.mediaType,
        'content-disposition': 'inline',
        'x-content-type-options': 'nosniff'
      }));
      return;
    }
    if (route.pathname === CLOUD_ROUTES.chatRunsStart) {
      if (!directChatConnector) throw new CloudHttpError(503, 'localllm_unavailable', 'Direct LocalLLM chat is unavailable.');
      const existing = chat.getGeneration({ accountId, threadId: input.threadId, generationId: input.generationId });
      if (!existing && input.attachment !== undefined && !visionEnabled) {
        throw new CloudHttpError(503, 'vision_unavailable', 'Direct LocalLLM vision is not enabled.');
      }
      if (!existing && !visionEnabled && input.expectedRevision > 0
          && chat.getLatestVisionAttachment({
            accountId,
            threadId: input.threadId,
            sourceRevision: input.expectedRevision
          }) !== null) {
        throw new CloudHttpError(503, 'vision_unavailable', 'Direct LocalLLM vision is not enabled.');
      }
      if (!existing && jobs.size >= limits.directChatJobs) {
        throw new CloudHttpError(503, 'chat_busy', 'Direct chat is temporarily busy.', { retryAfter: 2 });
      }
      const preparation = existing ? undefined : await contextCoordinator.prepareForTurn({
        accountId,
        threadId: input.threadId,
        expectedRevision: input.expectedRevision,
        expectedHash: input.expectedHash,
        pendingUser: Object.freeze({ messageId: input.messageId, content: input.content }),
        signal: requestSignal
      });
      const turn = chat.startTurn({
        accountId,
        threadId: input.threadId,
        messageId: input.messageId,
        content: input.content,
        generationId: input.generationId,
        assistantMessageId: input.assistantMessageId,
        expectedRevision: input.expectedRevision,
        expectedHash: input.expectedHash,
        idempotencyKey,
        ...(input.attachment === undefined ? {} : { attachment: input.attachment })
      });
      const { generation } = turn;
      if (generation.status === 'in_progress' && !scheduleGeneration(
        accountId,
        input.threadId,
        input.generationId,
        idempotencyKey,
        preparation
      )) {
        throw new CloudHttpError(503, 'chat_resume_pending', 'The persisted generation is waiting for LocalLLM capacity.', { retryAfter: 2 });
      }
      sendJson(req, res, 202, { generation: publicGeneration(generation, accountId) });
      return;
    }
    if (route.pathname === CLOUD_ROUTES.chatRunsStatus) {
      const generation = chat.getGeneration({ accountId, ...input });
      if (!generation) throw new CloudHttpError(404, 'not_found', 'The chat generation does not exist.');
      if (generation.status === 'in_progress') {
        schedulePersistedGeneration(accountId, input.threadId, input.generationId);
      }
      sendJson(req, res, 200, { generation: publicGeneration(generation, accountId) });
      return;
    }
    if (route.pathname === CLOUD_ROUTES.chatRunsCancel) {
      const generation = chat.cancelGeneration({ accountId, ...input, idempotencyKey });
      const job = jobs.get(`${input.threadId}:${input.generationId}`);
      if (job && !job.controller.signal.aborted) {
        const error = new Error('direct chat generation cancelled');
        error.code = 'generation_cancelled';
        job.controller.abort(error);
      }
      sendJson(req, res, 200, { generation: publicGeneration(generation, accountId) });
      return;
    }
    if (route.pathname === CLOUD_ROUTES.chatRunsEvents) {
      await streamChatEvents(req, res, input, accountId, requestSignal);
      return;
    }
    throw new CloudHttpError(404, 'not_found', 'The requested route does not exist.');
  }

  async function streamChatEvents(req, res, input, accountId, signal) {
    const initial = chat.getGeneration({ accountId, threadId: input.threadId, generationId: input.generationId });
    if (!initial) throw new CloudHttpError(404, 'not_found', 'The chat generation does not exist.');
    if (initial.status === 'in_progress') {
      schedulePersistedGeneration(accountId, input.threadId, input.generationId);
    }
    writeHead(res, 200, dynamicHeaders({
      'content-type': 'text/event-stream; charset=utf-8',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    }));
    res.flushHeaders?.();
    let afterSequence = input.afterSequence;
    const streamDeadline = deadlineSignal(
      signal,
      limits.sseLifetimeMs,
      'Direct Chat event stream reached its reconnect boundary'
    );
    try {
      while (!streamDeadline.signal.aborted && !res.writableEnded) {
        const page = chat.replayGeneration({
          accountId,
          threadId: input.threadId,
          generationId: input.generationId,
          afterSequence,
          limit: 200
        });
        for (const delta of page.deltas) {
          await writeSse(res, jsonSseEvent({
            event: 'delta',
            id: delta.sequence,
            data: publicDelta(delta, accountId)
          }), streamDeadline.signal);
          afterSequence = delta.sequence;
        }
        if (page.generation.terminal) {
          await writeSse(res, jsonSseEvent({
            event: 'generation',
            data: publicGeneration(page.generation, accountId)
          }), streamDeadline.signal);
          res.end();
          return;
        }
        if (page.deltas.length === 0) {
          await delay(limits.ssePollMs, streamDeadline.signal);
        }
      }
    } catch (error) {
      if (!streamDeadline.signal.aborted || signal.aborted) throw error;
    } finally {
      streamDeadline.cleanup();
    }
    if (!signal.aborted && !res.writableEnded && !res.destroyed) {
      // Give a healthy reader an authenticated cursor before the bounded
      // reconnect. A stalled reader has already applied backpressure, so keep
      // the hard socket cutoff instead of buffering more data for it.
      if (res.writableNeedDrain) {
        res.destroy();
      } else {
        res.end(jsonSseEvent({ event: 'reconnect', data: { afterSequence } }));
      }
    }
  }

  async function handleAgent(req, res, route, body, session, requestSignal) {
    const nativePath = route.nativeAgentPath;
    const input = validateTransportAgentRequest(nativePath, body);
    const mutation = routeRequiresIdempotency(route.pathname, nativePath);
    const idempotencyKey = mutation ? requestIdempotency(req, true) : undefined;
    if (!agintiAdapter) {
      if (nativePath === AGINTI_RPC_PATHS.capabilities) {
        sendJson(req, res, 200, FAIL_CLOSED_AGENT_CAPABILITIES);
        return;
      }
      throw new CloudHttpError(503, 'agent_unavailable', 'AgInTi Agent is unavailable.');
    }
    const contextFor = (signal) => Object.freeze({
      principalId: configuredAccount.principalId,
      browserSession: session.browserSession,
      ...(mutation ? { idempotencyKey } : {}),
      signal
    });
    if (nativePath === AGINTI_RPC_PATHS.runsEvents) {
      const streamDeadline = deadlineSignal(requestSignal, limits.sseLifetimeMs, 'Agent event stream reached its reconnect boundary');
      try {
        const events = await valueWithAbort(
          agintiAdapter.rpc(nativePath, input, contextFor(streamDeadline.signal)),
          streamDeadline.signal
        );
        if (!events || typeof events[Symbol.asyncIterator] !== 'function') {
          throw new CloudHttpError(502, 'invalid_agent_response', 'AgInTi returned an invalid event stream.');
        }
        writeHead(res, 200, dynamicHeaders({
          'content-type': 'text/event-stream; charset=utf-8',
          connection: 'keep-alive',
          'x-accel-buffering': 'no'
        }));
        res.flushHeaders?.();
        for await (const rawEvent of abortableAsyncIterable(events, streamDeadline.signal)) {
          let event;
          try { event = validateEventEnvelope(rawEvent); }
          catch (error) { throw new CloudHttpError(502, 'invalid_agent_response', 'AgInTi returned an invalid event.', { cause: error }); }
          if (event.runId !== input.runId) {
            throw new CloudHttpError(502, 'invalid_agent_response', 'AgInTi returned an event for a different run.');
          }
          await writeSse(res, jsonSseEvent({ event: event.type, id: event.id, data: event }), streamDeadline.signal);
        }
      } catch (error) {
        if (!streamDeadline.signal.aborted || requestSignal.aborted) throw error;
      } finally {
        streamDeadline.cleanup();
      }
      if (!requestSignal.aborted && !res.writableEnded) res.end();
      return;
    }
    try {
      const response = await withTimeout(
        (signal) => nativePath === AGINTI_RPC_PATHS.capabilities
          ? agintiAdapter.capabilities(contextFor(signal))
          : agintiAdapter.rpc(nativePath, input, contextFor(signal)),
        { signal: requestSignal, milliseconds: limits.dependencyTimeoutMs, timeoutMessage: 'AgInTi request timed out' }
      );
      let validated;
      try { validated = validateAgentResponse(nativePath, response); }
      catch (error) { throw new CloudHttpError(502, 'invalid_agent_response', 'AgInTi returned an invalid response.', { cause: error }); }
      requireAgentResponseCorrelation(nativePath, input, validated);
      sendJson(req, res, 200, validated);
    } catch (error) {
      if (nativePath === AGINTI_RPC_PATHS.capabilities) {
        sendJson(req, res, 200, FAIL_CLOSED_AGENT_CAPABILITIES);
        return;
      }
      throw error;
    }
  }

  const handler = async (req, res) => {
    const disconnect = requestAbortController(req, res);
    let releaseBody = null;
    let releaseStream = null;
    try {
      requirePublicAuthority(req, publicHost);
      const clientAddress = resolveTrustedClientAddress(req);
      if (req.method !== 'POST') rejectRequestBodyFraming(req);
      const route = classifyRequestTarget(req.url, assets);
      if (route.kind === 'invalid' || route.kind === 'not_found') {
        if (req.method === 'POST' && hasRequestBodyFraming(req)) req.shouldKeepAlive = false;
        if (route.kind === 'invalid') throw new CloudHttpError(400, 'invalid_target', 'The request target is not normalized.');
        throw new CloudHttpError(404, 'not_found', 'The requested route does not exist.');
      }
      if (route.kind === 'asset') {
        if (!['GET', 'HEAD'].includes(req.method)) {
          if (hasRequestBodyFraming(req)) req.shouldKeepAlive = false;
          methodNotAllowed(req, res, 'GET, HEAD');
          return;
        }
        const asset = assets.get(route.target);
        const cacheControl = route.target === '/sw.js'
          ? 'no-store, no-cache, must-revalidate'
          : (assets.isImmutable(route.target) ? IMMUTABLE_CACHE_CONTROL : DYNAMIC_CACHE_CONTROL);
        sendBuffer(req, res, 200, asset.body, {
          ...commonSecurityHeaders(),
          ...asset.headers,
          'content-type': asset.contentType,
          'cache-control': cacheControl,
          ...(route.target === '/' ? {
            'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; font-src 'none'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; worker-src 'self'"
          } : {}),
          ...(route.target === '/sw.js' ? { pragma: 'no-cache', expires: '0', 'service-worker-allowed': '/' } : {})
        });
        return;
      }
      if (req.method !== 'POST') {
        methodNotAllowed(req, res, 'POST');
        return;
      }
      requireOriginAndFetchMetadata(req, origin);
      const preauthenticated = route.kind === 'chat' || route.kind === 'agent'
        ? requireAuthentication(await authenticate(req))
        : null;
      const admissionKey = preauthenticated
        ? `${clientAddress}\u0000${configuredAccount.principalId}`
        : clientAddress;
      releaseBody = bodyGate.enter(admissionKey);
      if (!releaseBody) throw new CloudHttpError(503, 'request_busy', 'The request service is temporarily busy.', { retryAfter: 1 });
      const body = await readJsonBody(
        req,
        bodyLimitForRoute(route.pathname),
        route.pathname === CLOUD_ROUTES.chatRunsStart
          ? limits.visionBodyTimeoutMs
          : limits.bodyTimeoutMs
      );
      releaseBody();
      releaseBody = null;
      const streamRoute = route.pathname === CLOUD_ROUTES.chatRunsEvents
        || (route.kind === 'agent' && route.nativeAgentPath === AGINTI_RPC_PATHS.runsEvents);
      if (streamRoute) {
        releaseStream = streamGate.enter(preauthenticated.browserSession);
        if (!releaseStream) {
          throw new CloudHttpError(429, 'stream_rate_limited', 'Too many event streams are active.', { retryAfter: 2 });
        }
      }
      if (route.pathname === CLOUD_ROUTES.login) {
        await handleLogin(req, res, validateLoginBody(body), disconnect.controller.signal, clientAddress);
        return;
      }
      if (route.pathname === CLOUD_ROUTES.session) {
        validateEmptyBody(body, 'session request');
        await handleSession(req, res);
        return;
      }
      if (route.pathname === CLOUD_ROUTES.logout) {
        validateEmptyBody(body, 'logout request');
        await handleLogout(req, res);
        return;
      }
      if (route.kind === 'chat') {
        await handleChat(req, res, route, body, preauthenticated, disconnect.controller.signal);
        return;
      }
      if (route.kind === 'agent') {
        await handleAgent(req, res, route, body, preauthenticated, disconnect.controller.signal);
        return;
      }
      throw new CloudHttpError(404, 'not_found', 'The requested route does not exist.');
    } catch (error) {
      sendError(req, res, error);
    } finally {
      releaseBody?.();
      releaseStream?.();
      disconnect.cleanup();
    }
  };
  Object.defineProperties(handler, {
    releaseId: { value: assets.releaseId, enumerable: true },
    closeBackgroundJobs: { value: closeGenerationJobs, enumerable: true },
    activeDirectChatJobs: { get: () => jobs.size, enumerable: true },
    activeStreams: { get: () => streamGate.active, enumerable: true }
  });
  return handler;
}

export function createCloudServer(options) {
  const handler = createCloudRequestHandler(options);
  const server = createNodeServer({
    connectionsCheckingInterval: 1_000,
    highWaterMark: 64 * 1024,
    insecureHTTPParser: false,
    joinDuplicateHeaders: false,
    keepAlive: true,
    keepAliveInitialDelay: 1_000,
    maxHeaderSize: 16 * 1024,
    noDelay: true,
    requireHostHeader: true,
    uniqueHeaders: ['content-length', 'content-type', 'cache-control']
  }, handler);
  server.headersTimeout = 10_000;
  server.requestTimeout = 20_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
  server.on('close', () => { void handler.closeBackgroundJobs(); });
  let shutdownPromise = null;
  Object.defineProperty(server, 'shutdown', {
    enumerable: true,
    value() {
      if (shutdownPromise) return shutdownPromise;
      const drained = handler.closeBackgroundJobs();
      shutdownPromise = new Promise((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections?.();
      }).then(() => drained);
      return shutdownPromise;
    }
  });
  return server;
}

export const CLOUD_AGENT_PUBLIC_ROUTES = Object.freeze(Object.keys(AGENT_ROUTE_MAP));
