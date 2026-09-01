import { TextDecoder } from "node:util";

const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MEDIA_TYPES = Object.freeze({
  "audio/mp4": "voice.m4a",
  "audio/x-m4a": "voice.m4a",
  "audio/webm": "voice.webm",
  "audio/ogg": "voice.ogg",
  "audio/wav": "voice.wav",
  "audio/x-wav": "voice.wav",
  "audio/mpeg": "voice.mp3",
});
const LANGUAGE = /^(?:auto|[a-z]{2,3})$/u;

export class SpeechConnectorError extends Error {
  constructor(code, message, { cause, retryable = true } = {}) {
    super(message, { cause });
    this.name = "SpeechConnectorError";
    this.code = code;
    this.retryable = retryable;
  }
}

function fail(code, message, options) {
  throw new SpeechConnectorError(code, message, options);
}

function exactObject(value, allowed, required, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !allowed.includes(key)
        || !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], "value")) {
      throw new TypeError(`${label} contains an unsupported field or accessor`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(descriptors, key)) throw new TypeError(`${label}.${key} is required`);
  }
  return value;
}

function canonicalBaseUrl(value) {
  if (typeof value !== "string") throw new TypeError("baseUrl must be a string");
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1"
      || !/^[1-9]\d{3,4}$/u.test(url.port) || Number(url.port) < 1_024
      || Number(url.port) > 65_535 || url.pathname !== "/api/speech"
      || url.username || url.password || url.search || url.hash
      || url.toString().replace(/\/$/u, "") !== value) {
    throw new TypeError("baseUrl must be an exact private 127.0.0.1 HTTP /api/speech endpoint");
  }
  return value;
}

async function credential(provider) {
  const value = await provider();
  if (typeof value !== "string" || value.length < 16 || value.length > 4_096
      || /[\s\u0000-\u001f\u007f]/u.test(value)) {
    fail("SPEECH_CREDENTIAL_INVALID", "The speech transport credential is unavailable.");
  }
  return value;
}

function contentType(response) {
  return response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
}

function requireNoStore(response) {
  const directives = String(response.headers.get("cache-control") ?? "")
    .split(",").map((value) => value.trim().toLowerCase());
  if (!directives.includes("no-store")) {
    fail("SPEECH_RESPONSE_INVALID", "The speech service returned a cacheable response.", {
      retryable: false,
    });
  }
}

async function discard(response) {
  try { await response.body?.cancel(); } catch { /* The error body is private and ignored. */ }
}

async function readBoundedJson(response, signal) {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    await discard(response);
    fail("SPEECH_RESPONSE_INVALID", "The speech response exceeded its size limit.", { retryable: false });
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) {
    fail("SPEECH_RESPONSE_INVALID", "The speech response exceeded its size limit.", { retryable: false });
  }
  if (signal?.aborted) throw signal.reason ?? new DOMException("aborted", "AbortError");
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    fail("SPEECH_RESPONSE_INVALID", "The speech service returned malformed JSON.", {
      cause,
      retryable: false,
    });
  }
}

function statusEnvelope(value) {
  const root = exactObject(value, [
    "schema", "enabled", "state", "model_loaded", "accepted_media_types",
    "maximum_audio_bytes", "maximum_duration_seconds", "persistence", "fault",
  ], [
    "schema", "enabled", "state", "model_loaded", "accepted_media_types",
    "maximum_audio_bytes", "maximum_duration_seconds", "persistence", "fault",
  ], "speech status");
  if (root.schema !== "localllm/speech-status/v1" || typeof root.enabled !== "boolean"
      || !["disabled", "cold", "ready", "busy", "faulted"].includes(root.state)
      || typeof root.model_loaded !== "boolean" || !Array.isArray(root.accepted_media_types)
      || root.accepted_media_types.some((value) => !Object.hasOwn(MEDIA_TYPES, value))
      || !Number.isSafeInteger(root.maximum_audio_bytes) || root.maximum_audio_bytes < 1
      || root.maximum_audio_bytes > 12 * 1024 * 1024
      || !Number.isSafeInteger(root.maximum_duration_seconds)
      || root.maximum_duration_seconds < 1 || root.maximum_duration_seconds > 180
      || root.persistence !== "transient-until-transcribed"
      || (root.fault !== null && (typeof root.fault !== "string" || root.fault.length > 128))) {
    throw new TypeError("speech status is invalid");
  }
  return Object.freeze({
    enabled: root.enabled,
    state: root.state,
    modelLoaded: root.model_loaded,
    acceptedMediaTypes: Object.freeze([...root.accepted_media_types]),
    maximumAudioBytes: Math.min(root.maximum_audio_bytes, MAX_AUDIO_BYTES),
    maximumDurationSeconds: root.maximum_duration_seconds,
  });
}

function transcriptionEnvelope(value) {
  const root = exactObject(value, [
    "schema", "text", "language", "language_probability", "duration_seconds", "audio_retained",
  ], [
    "schema", "text", "language", "language_probability", "duration_seconds", "audio_retained",
  ], "speech transcription");
  if (root.schema !== "localllm/speech-transcription/v1"
      || typeof root.text !== "string" || root.text.length < 1
      || Buffer.byteLength(root.text, "utf8") > 32 * 1024
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(root.text)
      || typeof root.language !== "string" || !/^(?:und|[a-z]{2,3})$/u.test(root.language)
      || typeof root.language_probability !== "number"
      || root.language_probability < 0 || root.language_probability > 1
      || typeof root.duration_seconds !== "number" || !Number.isFinite(root.duration_seconds)
      || root.duration_seconds <= 0 || root.duration_seconds > 180
      || root.audio_retained !== false) {
    throw new TypeError("speech transcription is invalid");
  }
  return Object.freeze({
    text: root.text,
    language: root.language,
    languageProbability: root.language_probability,
    durationSeconds: root.duration_seconds,
    audioRetained: false,
  });
}

export function createSpeechConnector({
  baseUrl,
  credentialProvider,
  fetchImpl = globalThis.fetch,
} = {}) {
  const endpoint = canonicalBaseUrl(baseUrl);
  if (typeof credentialProvider !== "function") throw new TypeError("credentialProvider must be a function");
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");

  async function request(pathname, init) {
    const token = await credential(credentialProvider);
    let response;
    try {
      response = await fetchImpl(`${endpoint}${pathname}`, {
        ...init,
        redirect: "error",
        cache: "no-store",
        headers: { accept: "application/json", authorization: `Bearer ${token}` },
      });
    } catch (cause) {
      if (cause?.name === "AbortError" || init.signal?.aborted) throw init.signal?.reason ?? cause;
      fail("SPEECH_TRANSPORT_UNAVAILABLE", "The speech service is unavailable.", { cause });
    }
    if (!(response instanceof Response) || (response.url && !response.url.startsWith(`${endpoint}/`))) {
      await discard(response);
      fail("SPEECH_TRANSPORT_INVALID", "The speech transport returned an invalid response.", {
        retryable: false,
      });
    }
    requireNoStore(response);
    if (!response.ok) {
      await discard(response);
      fail(
        response.status === 429 ? "SPEECH_BUSY" : "SPEECH_UPSTREAM_REJECTED",
        response.status === 429
          ? "Speech transcription is temporarily busy."
          : "The speech service did not accept the recording.",
        { retryable: response.status === 429 || response.status >= 500 },
      );
    }
    if (contentType(response) !== "application/json") {
      await discard(response);
      fail("SPEECH_RESPONSE_INVALID", "The speech service returned an invalid content type.", {
        retryable: false,
      });
    }
    return response;
  }

  async function status({ signal } = {}) {
    const response = await request("/status", { method: "GET", signal });
    try { return statusEnvelope(await readBoundedJson(response, signal)); }
    catch (cause) {
      if (cause instanceof SpeechConnectorError) throw cause;
      fail("SPEECH_RESPONSE_INVALID", "The speech service returned invalid status.", {
        cause,
        retryable: false,
      });
    }
  }

  async function transcribe(input = {}) {
    const checked = exactObject(
      input,
      ["mediaType", "audio", "language", "signal"],
      ["mediaType", "audio", "language", "signal"],
      "speech transcription input",
    );
    if (!Object.hasOwn(MEDIA_TYPES, checked.mediaType)) throw new TypeError("mediaType is unsupported");
    if (!(checked.audio instanceof Uint8Array) || checked.audio.byteLength < 1
        || checked.audio.byteLength > MAX_AUDIO_BYTES) {
      throw new TypeError("audio is outside its byte bound");
    }
    if (typeof checked.language !== "string" || !LANGUAGE.test(checked.language)) {
      throw new TypeError("language is invalid");
    }
    if (!(checked.signal instanceof AbortSignal)) throw new TypeError("signal must be an AbortSignal");
    const form = new FormData();
    form.append(
      "file",
      new Blob([checked.audio], { type: checked.mediaType }),
      MEDIA_TYPES[checked.mediaType],
    );
    const response = await request(`/transcriptions?language=${checked.language}`, {
      method: "POST",
      body: form,
      signal: checked.signal,
    });
    try { return transcriptionEnvelope(await readBoundedJson(response, checked.signal)); }
    catch (cause) {
      if (cause instanceof SpeechConnectorError) throw cause;
      fail("SPEECH_RESPONSE_INVALID", "The speech service returned an invalid transcription.", {
        cause,
        retryable: false,
      });
    }
  }

  return Object.freeze({ kind: "localllm-speech-connector", status, transcribe });
}

export const SPEECH_CONNECTOR_AUDIO_LIMIT_BYTES = MAX_AUDIO_BYTES;
export const SPEECH_CONNECTOR_MEDIA_TYPES = Object.freeze(Object.keys(MEDIA_TYPES));
