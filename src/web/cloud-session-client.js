const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const JSON_RESPONSE_LIMIT = 32 * 1024;
const ERROR_RESPONSE_LIMIT = 16 * 1024;
const COOKIE_LIMIT = 4_096;
const DEFAULT_TIMEOUT_MS = 30_000;

export const CLOUD_SESSION_ROUTES = Object.freeze({
  login: "/api/login",
  session: "/api/session",
  logout: "/api/logout",
});

export const CLOUD_CSRF_COOKIE_NAME = "__Host-lazying_csrf";
export const CLOUD_CSRF_HEADER_NAME = "x-csrf-token";

const ERROR_CODE = /^[a-z][a-z0-9_]{0,79}$/u;
const CSRF_TOKEN = /^[A-Za-z0-9_-]{32,128}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const encoder = new TextEncoder();

export class CloudBrowserProtocolError extends Error {
  constructor(message, { code = "cloud_protocol_error" } = {}) {
    super(message);
    this.name = "CloudBrowserProtocolError";
    this.code = code;
    this.status = 502;
    this.retryable = false;
  }
}

export class CloudBrowserTransportError extends Error {
  constructor(message, {
    code = "cloud_unavailable",
    status = 503,
    retryable = true,
  } = {}) {
    super(message);
    this.name = "CloudBrowserTransportError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function exactObject(value, allowed, required, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CloudBrowserProtocolError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CloudBrowserProtocolError(`${label} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !allowed.includes(key)) {
      throw new CloudBrowserProtocolError(`${label} contains an unsupported field`);
    }
    if (!descriptors[key].enumerable || !Object.hasOwn(descriptors[key], "value")) {
      throw new CloudBrowserProtocolError(`${label} contains an accessor`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new CloudBrowserProtocolError(`${label}.${key} is required`);
  }
  return value;
}

function utf8Length(value) {
  return encoder.encode(value).byteLength;
}

function boundedText(value, label, { minimum = 1, maximum, controls = false } = {}) {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const bytes = utf8Length(value);
  if (bytes < minimum || bytes > maximum || (!controls && CONTROL.test(value))) {
    throw new TypeError(`${label} is invalid`);
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

export function readCloudCsrfCookie(source = () => globalThis.document?.cookie ?? "") {
  const raw = typeof source === "function" ? source() : source;
  if (typeof raw !== "string" || utf8Length(raw) > COOKIE_LIMIT || CONTROL.test(raw)) {
    throw new CloudBrowserProtocolError("browser cookies are invalid", { code: "invalid_cookie" });
  }
  const matches = [];
  for (const component of raw.split(";")) {
    const part = component.trim();
    if (!part) continue;
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    if (name === CLOUD_CSRF_COOKIE_NAME) matches.push(part.slice(separator + 1).trim());
  }
  if (matches.length > 1) {
    throw new CloudBrowserProtocolError("the CSRF cookie is duplicated", { code: "invalid_cookie" });
  }
  if (matches.length === 0) return undefined;
  if (!CSRF_TOKEN.test(matches[0])) {
    throw new CloudBrowserProtocolError("the CSRF cookie is invalid", { code: "invalid_cookie" });
  }
  return matches[0];
}

function timeoutSignal(signal, timeoutMs) {
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError("signal must be an AbortSignal");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
    throw new TypeError("timeoutMs is invalid");
  }
  const controller = new AbortController();
  const forward = () => controller.abort(signal.reason ?? new DOMException("request aborted", "AbortError"));
  if (signal?.aborted) forward();
  else signal?.addEventListener("abort", forward, { once: true });
  const timer = setTimeout(
    () => controller.abort(new DOMException("request timed out", "TimeoutError")),
    timeoutMs,
  );
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

function requireResponse(value) {
  if (value === null || typeof value !== "object" || !Number.isSafeInteger(value.status)
      || value.status < 100 || value.status > 599 || typeof value.headers?.get !== "function") {
    throw new CloudBrowserProtocolError("cloud transport returned an invalid response");
  }
  return value;
}

function requireNoStore(response) {
  const directives = String(response.headers?.get?.("cache-control") ?? "")
    .toLowerCase()
    .split(",")
    .map((value) => value.trim());
  if (!directives.includes("no-store")) {
    throw new CloudBrowserProtocolError("cloud response is missing its no-store policy");
  }
}

async function readBoundedText(response, maximum) {
  const advertised = response.headers?.get?.("content-length");
  if (advertised !== null && advertised !== undefined
      && (!/^\d+$/u.test(advertised) || Number(advertised) > maximum)) {
    throw new CloudBrowserProtocolError("cloud response exceeded its size limit");
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    const value = await response.text();
    if (utf8Length(value) > maximum) throw new CloudBrowserProtocolError("cloud response exceeded its size limit");
    return value;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let result = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new CloudBrowserProtocolError("cloud response returned a non-byte chunk");
      bytes += value.byteLength;
      if (bytes > maximum) throw new CloudBrowserProtocolError("cloud response exceeded its size limit");
      result += decoder.decode(value, { stream: true });
    }
    result += decoder.decode();
    return result;
  } catch (error) {
    if (error instanceof CloudBrowserProtocolError) throw error;
    throw new CloudBrowserProtocolError("cloud response is not valid UTF-8");
  } finally {
    reader.releaseLock?.();
  }
}

function responseMatchesRoute(response, endpoint) {
  if (response?.redirected === true || response?.type === "opaqueredirect") return false;
  if (typeof response?.url !== "string" || response.url === "") return true;
  try { return new URL(response.url).href === endpoint; }
  catch { return false; }
}

function safeErrorCode(value) {
  return typeof value === "string" && ERROR_CODE.test(value) ? value : "request_failed";
}

async function responseFailure(response, action) {
  let code = "request_failed";
  if (mediaType(response) === "application/json") {
    try {
      const parsed = JSON.parse(await readBoundedText(response, ERROR_RESPONSE_LIMIT));
      const envelope = exactObject(parsed, ["error"], ["error"], "error response");
      const error = exactObject(envelope.error, ["code", "message"], ["code", "message"], "error");
      boundedText(error.message, "error.message", { maximum: 512 });
      code = safeErrorCode(error.code);
    } catch {
      code = "request_failed";
    }
  }
  return new CloudBrowserTransportError(`${action} request was not accepted.`, {
    code,
    status: Number.isSafeInteger(response?.status) ? response.status : 503,
    retryable: [408, 425, 429].includes(response?.status) || response?.status >= 500,
  });
}

function networkFailure(error, action, signal) {
  if (error instanceof CloudBrowserProtocolError || error instanceof CloudBrowserTransportError) return error;
  const reason = signal?.aborted ? signal.reason : error;
  if (reason?.name === "AbortError" || reason?.name === "TimeoutError") {
    return new CloudBrowserTransportError(`${action} request was interrupted.`, {
      code: reason.name === "TimeoutError" ? "request_timeout" : "request_aborted",
      status: reason.name === "TimeoutError" ? 504 : 499,
      retryable: reason.name === "TimeoutError",
    });
  }
  return new CloudBrowserTransportError(`${action} service is unavailable.`);
}

function sessionEnvelope(value) {
  const session = exactObject(value, ["authenticated", "username", "csrfToken"], ["authenticated"], "session response");
  if (typeof session.authenticated !== "boolean") {
    throw new CloudBrowserProtocolError("session response authenticated flag is invalid");
  }
  if (!session.authenticated) {
    if (Object.keys(session).length !== 1) throw new CloudBrowserProtocolError("signed-out session contains unsupported state");
    return Object.freeze({ authenticated: false });
  }
  boundedText(session.username, "session.username", { maximum: 128 });
  if (typeof session.csrfToken !== "string" || !CSRF_TOKEN.test(session.csrfToken)) {
    throw new CloudBrowserProtocolError("session response CSRF token is invalid");
  }
  return Object.freeze({ authenticated: true, username: session.username, csrfToken: session.csrfToken });
}

function logoutEnvelope(value) {
  const result = exactObject(
    value,
    ["signedOut", "agentCancellationPending"],
    ["signedOut", "agentCancellationPending"],
    "logout response",
  );
  if (result.signedOut !== true || typeof result.agentCancellationPending !== "boolean") {
    throw new CloudBrowserProtocolError("logout response is invalid");
  }
  return Object.freeze({ signedOut: true, agentCancellationPending: result.agentCancellationPending });
}

function loginRequest(value) {
  const request = exactObject(value, ["username", "password", "remember"], ["username", "password", "remember"], "login request");
  boundedText(request.username, "username", { maximum: 128 });
  boundedText(request.password, "password", { maximum: 1_024, controls: true });
  if (typeof request.remember !== "boolean") throw new TypeError("remember must be boolean");
  return Object.freeze({ username: request.username, password: request.password, remember: request.remember });
}

export class CloudSessionClient {
  constructor(options = {}) {
    const config = exactObject(
      options,
      ["baseUrl", "fetchImpl", "cookieSource", "timeoutMs"],
      [],
      "session client options",
    );
    const baseUrl = config.baseUrl;
    const fetchImpl = config.fetchImpl ?? globalThis.fetch;
    const cookieSource = config.cookieSource;
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
      throw new TypeError("timeoutMs is invalid");
    }
    this.baseOrigin = normalizedBaseOrigin(baseUrl);
    this.fetch = fetchImpl === globalThis.fetch ? fetchImpl.bind(globalThis) : fetchImpl;
    this.readCookie = cookieReader(cookieSource);
    this.timeoutMs = timeoutMs;
  }

  csrfToken() {
    return readCloudCsrfCookie(this.readCookie);
  }

  async #post(route, body, { signal, csrf, expectedStatus, action }) {
    const endpoint = `${this.baseOrigin}${route}`;
    const deadline = timeoutSignal(signal, this.timeoutMs);
    const headers = new Headers({
      accept: "application/json",
      "content-type": JSON_CONTENT_TYPE,
    });
    if (csrf !== undefined) headers.set(CLOUD_CSRF_HEADER_NAME, csrf);
    let response;
    try {
      response = requireResponse(await this.fetch(endpoint, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "same-origin",
        headers,
        body: JSON.stringify(body),
        signal: deadline.signal,
      }));
      if (!responseMatchesRoute(response, endpoint)) {
        throw new CloudBrowserProtocolError("cloud response came from an unexpected URL");
      }
      requireNoStore(response);
      if (response.status !== expectedStatus) throw await responseFailure(response, action);
      if (mediaType(response) !== "application/json") {
        throw new CloudBrowserProtocolError("cloud response content type is invalid");
      }
      let value;
      try { value = JSON.parse(await readBoundedText(response, JSON_RESPONSE_LIMIT)); }
      catch (error) {
        if (error instanceof CloudBrowserProtocolError) throw error;
        throw new CloudBrowserProtocolError("cloud response is not valid JSON");
      }
      return value;
    } catch (error) {
      throw networkFailure(error, action, deadline.signal);
    } finally {
      deadline.dispose();
    }
  }

  async restore(options = {}) {
    const { signal } = exactObject(options, ["signal"], [], "session restore options");
    const csrf = this.csrfToken();
    const session = sessionEnvelope(await this.#post(CLOUD_SESSION_ROUTES.session, {}, {
      signal,
      csrf,
      expectedStatus: 200,
      action: "Session restore",
    }));
    if (session.authenticated && (csrf === undefined || session.csrfToken !== csrf)) {
      throw new CloudBrowserProtocolError("restored session is not bound to the browser CSRF cookie");
    }
    return session;
  }

  async login(value, options = {}) {
    const { signal } = exactObject(options, ["signal"], [], "sign-in options");
    const request = loginRequest(value);
    const session = sessionEnvelope(await this.#post(CLOUD_SESSION_ROUTES.login, request, {
      signal,
      expectedStatus: 200,
      action: "Sign-in",
    }));
    if (!session.authenticated) throw new CloudBrowserProtocolError("sign-in returned a signed-out session");
    const csrf = this.csrfToken();
    if (csrf === undefined || csrf !== session.csrfToken) {
      throw new CloudBrowserProtocolError("signed-in session is not bound to the browser CSRF cookie");
    }
    return session;
  }

  async logout(options = {}) {
    const { signal } = exactObject(options, ["signal"], [], "sign-out options");
    const csrf = this.csrfToken();
    if (csrf === undefined) {
      throw new CloudBrowserTransportError("Sign-out request was not accepted.", {
        code: "authentication_required",
        status: 401,
        retryable: false,
      });
    }
    return logoutEnvelope(await this.#post(CLOUD_SESSION_ROUTES.logout, {}, {
      signal,
      csrf,
      expectedStatus: 200,
      action: "Sign-out",
    }));
  }
}
