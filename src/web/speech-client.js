import { CLOUD_CSRF_HEADER_NAME } from "./cloud-session-client.js";
import {
  addWebReleaseHeader,
  inspectWebReleaseResponse,
  optionalWebRelease,
} from "./web-release.js";

const TRANSCRIPTION_ROUTE = "/api/voice/transcribe";
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 240_000;
const MEDIA_TYPES = new Set([
  "audio/mp4", "audio/x-m4a", "audio/webm", "audio/ogg", "audio/wav", "audio/x-wav", "audio/mpeg",
]);
const CSRF_TOKEN = /^[A-Za-z0-9_-]{32,128}$/u;
const ERROR_CODE = /^[a-z][a-z0-9_]{0,79}$/u;
const LANGUAGE = /^(?:auto|[a-z]{2,3})$/u;
const TRANSCRIBED_LANGUAGE = /^(?:und|[a-z]{2,3})$/u;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const encoder = new TextEncoder();

export const BROWSER_SPEECH_LIMITS = Object.freeze({
  audioBytes: MAX_AUDIO_BYTES,
  durationSeconds: 120,
});

export class SpeechBrowserProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = "SpeechBrowserProtocolError";
    this.code = "speech_protocol_error";
    this.status = 502;
    this.retryable = false;
  }
}

export class SpeechBrowserTransportError extends Error {
  constructor(message, {
    code = "speech_unavailable",
    status = 503,
    retryable = true,
    serverRelease,
  } = {}) {
    super(message);
    this.name = "SpeechBrowserTransportError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    if (serverRelease !== undefined) this.serverRelease = optionalWebRelease(serverRelease);
  }
}

function exactObject(value, allowed, required, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SpeechBrowserProtocolError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new SpeechBrowserProtocolError(`${label} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !allowed.includes(key)
        || !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], "value")) {
      throw new SpeechBrowserProtocolError(`${label} contains an unsupported field or accessor`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(descriptors, key)) throw new SpeechBrowserProtocolError(`${label}.${key} is required`);
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

function normalizedMediaType(value) {
  if (typeof value !== "string") throw new TypeError("recording media type is invalid");
  const result = value.split(";", 1)[0].trim().toLowerCase();
  if (!MEDIA_TYPES.has(result)) throw new TypeError("recording media type is unsupported");
  return result;
}

function bytesToBase64(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_AUDIO_BYTES) {
    throw new TypeError("recording is outside its byte limit");
  }
  if (typeof bytes.toBase64 === "function") return bytes.toBase64();
  if (typeof globalThis.btoa !== "function") throw new TypeError("base64 encoding is unavailable");
  const parts = [];
  const encodingChunkBytes = 12 * 1024;
  const spreadChunkBytes = 1024;
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

function timeoutSignal(signal, timeoutMs) {
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError("signal must be an AbortSignal");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) {
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

function requireResponse(value) {
  if (value === null || typeof value !== "object" || !Number.isSafeInteger(value.status)
      || value.status < 100 || value.status > 599 || typeof value.headers?.get !== "function") {
    throw new SpeechBrowserProtocolError("speech transport returned an invalid response");
  }
  return value;
}

function responseMatchesRoute(response, endpoint) {
  if (response?.redirected === true || response?.type === "opaqueredirect") return false;
  if (typeof response?.url !== "string" || response.url === "") return true;
  try { return new URL(response.url).href === endpoint; }
  catch { return false; }
}

function requireNoStore(response) {
  const directives = String(response.headers?.get?.("cache-control") ?? "")
    .toLowerCase().split(",").map((value) => value.trim());
  if (!directives.includes("no-store")) {
    throw new SpeechBrowserProtocolError("speech response is missing its no-store policy");
  }
}

function requirePinnedRelease(response, releaseId) {
  const proof = inspectWebReleaseResponse(response, releaseId);
  if (proof.kind === "unpinned" || proof.kind === "match") return;
  if (proof.kind === "mismatch") {
    throw new SpeechBrowserTransportError("Voice input requires the current browser app release.", {
      code: "client_release_mismatch",
      status: 409,
      retryable: false,
      serverRelease: proof.releaseId,
    });
  }
  throw new SpeechBrowserProtocolError("speech response is missing its release identity");
}

async function readBoundedText(response, maximum) {
  const declared = response.headers?.get?.("content-length");
  if (declared !== null && declared !== undefined
      && (!/^\d+$/u.test(declared) || Number(declared) > maximum)) {
    throw new SpeechBrowserProtocolError("speech response exceeded its size limit");
  }
  const value = await response.text();
  if (encoder.encode(value).byteLength > maximum) {
    throw new SpeechBrowserProtocolError("speech response exceeded its size limit");
  }
  return value;
}

async function responseFailure(response) {
  let code = "speech_unavailable";
  try {
    if (String(response.headers?.get?.("content-type") ?? "").split(";", 1)[0].trim().toLowerCase()
        === "application/json") {
      const root = exactObject(JSON.parse(await readBoundedText(response, 16 * 1024)), ["error"], ["error"], "error response");
      const error = exactObject(root.error, ["code", "message"], ["code", "message"], "speech error");
      if (typeof error.code === "string" && ERROR_CODE.test(error.code)) code = error.code;
    }
  } catch { /* A malformed error response stays generic. */ }
  return new SpeechBrowserTransportError("Voice transcription was not accepted.", {
    code,
    status: response.status,
    retryable: [408, 425, 429].includes(response.status) || response.status >= 500,
  });
}

function transcriptionEnvelope(value) {
  const root = exactObject(value, ["transcription"], ["transcription"], "speech response");
  const result = exactObject(root.transcription, [
    "text", "language", "languageProbability", "durationSeconds", "audioRetained",
  ], [
    "text", "language", "languageProbability", "durationSeconds", "audioRetained",
  ], "speech transcription");
  if (typeof result.text !== "string" || result.text.length < 1
      || encoder.encode(result.text).byteLength > 32 * 1024 || CONTROL.test(result.text)
      || typeof result.language !== "string" || !TRANSCRIBED_LANGUAGE.test(result.language)
      || typeof result.languageProbability !== "number" || result.languageProbability < 0
      || result.languageProbability > 1 || typeof result.durationSeconds !== "number"
      || !Number.isFinite(result.durationSeconds) || result.durationSeconds <= 0
      || result.durationSeconds > 180 || result.audioRetained !== false) {
    throw new SpeechBrowserProtocolError("speech transcription is invalid");
  }
  return Object.freeze({
    text: result.text,
    language: result.language,
    languageProbability: result.languageProbability,
    durationSeconds: result.durationSeconds,
    audioRetained: false,
  });
}

function networkFailure(error, signal) {
  if (error instanceof SpeechBrowserProtocolError || error instanceof SpeechBrowserTransportError) return error;
  const reason = signal?.aborted ? signal.reason : error;
  if (reason?.name === "AbortError" || reason?.name === "TimeoutError") {
    return new SpeechBrowserTransportError("Voice transcription was interrupted.", {
      code: reason.name === "TimeoutError" ? "request_timeout" : "request_aborted",
      status: reason.name === "TimeoutError" ? 504 : 499,
      retryable: reason.name === "TimeoutError",
    });
  }
  return new SpeechBrowserTransportError("Voice transcription is unavailable.");
}

export class SpeechBrowserClient {
  constructor({
    baseUrl,
    csrfToken,
    releaseId,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
  } = {}) {
    if (typeof csrfToken !== "function") throw new TypeError("csrfToken must be a function");
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) {
      throw new TypeError("timeoutMs is invalid");
    }
    this.baseOrigin = normalizedBaseOrigin(baseUrl);
    this.readCsrf = csrfToken;
    this.releaseId = optionalWebRelease(releaseId);
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl === globalThis.fetch ? fetchImpl.bind(globalThis) : fetchImpl;
  }

  async transcribe(recording, { language = "auto", signal } = {}) {
    if (!(recording instanceof Blob) || recording.size < 1 || recording.size > MAX_AUDIO_BYTES) {
      throw new TypeError("recording is outside its byte limit");
    }
    const mediaType = normalizedMediaType(recording.type);
    if (typeof language !== "string" || !LANGUAGE.test(language)) throw new TypeError("language is invalid");
    const csrf = await this.readCsrf();
    if (typeof csrf !== "string" || !CSRF_TOKEN.test(csrf)) {
      throw new SpeechBrowserTransportError("Voice input requires a valid signed-in session.", {
        code: "authentication_required",
        status: 401,
        retryable: false,
      });
    }
    const deadline = timeoutSignal(signal, this.timeoutMs);
    const endpoint = `${this.baseOrigin}${TRANSCRIPTION_ROUTE}`;
    let bytes;
    let data;
    let body;
    try {
      bytes = new Uint8Array(await recording.arrayBuffer());
      if (deadline.signal.aborted) throw deadline.signal.reason;
      data = bytesToBase64(bytes);
      body = JSON.stringify({ mediaType, data, language });
      bytes.fill(0);
      bytes = null;
      data = null;
      const headers = addWebReleaseHeader(new Headers({
        accept: "application/json",
        "content-type": "application/json; charset=utf-8",
        [CLOUD_CSRF_HEADER_NAME]: csrf,
      }), this.releaseId);
      const response = requireResponse(await this.fetch(endpoint, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "same-origin",
        headers,
        body,
        signal: deadline.signal,
      }));
      body = null;
      if (!responseMatchesRoute(response, endpoint)) {
        throw new SpeechBrowserProtocolError("speech response came from an unexpected URL");
      }
      requirePinnedRelease(response, this.releaseId);
      requireNoStore(response);
      if (response.status !== 200) throw await responseFailure(response);
      if (String(response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase()
          !== "application/json") {
        throw new SpeechBrowserProtocolError("speech response content type is invalid");
      }
      let parsed;
      try { parsed = JSON.parse(await readBoundedText(response, MAX_RESPONSE_BYTES)); }
      catch (error) {
        if (error instanceof SpeechBrowserProtocolError) throw error;
        throw new SpeechBrowserProtocolError("speech response is not valid JSON");
      }
      return transcriptionEnvelope(parsed);
    } catch (error) {
      throw networkFailure(error, deadline.signal);
    } finally {
      bytes?.fill(0);
      bytes = null;
      data = null;
      body = null;
      deadline.dispose();
    }
  }
}
