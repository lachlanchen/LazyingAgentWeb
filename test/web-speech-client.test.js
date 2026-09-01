import assert from "node:assert/strict";
import test from "node:test";

import {
  BROWSER_SPEECH_LIMITS,
  SpeechBrowserClient,
  SpeechBrowserProtocolError,
  SpeechBrowserTransportError,
} from "../src/web/speech-client.js";

const CSRF = "c".repeat(43);
const RELEASE = "voice-release-1";

function response(value, {
  status = 200,
  cacheControl = "no-store, private",
  release = RELEASE,
  contentType = "application/json; charset=utf-8",
} = {}) {
  return new Response(typeof value === "string" ? value : JSON.stringify(value), {
    status,
    headers: {
      "content-type": contentType,
      "cache-control": cacheControl,
      "x-lazying-agent-release": release,
    },
  });
}

function transcription() {
  return {
    transcription: {
      text: "Voice input works.",
      language: "en",
      languageProbability: 0.99,
      durationSeconds: 1.25,
      audioRetained: false,
    },
  };
}

test("sends bounded voice only to the pinned same-origin route and returns editable text", async () => {
  const calls = [];
  const client = new SpeechBrowserClient({
    baseUrl: "https://llm.test/workspace",
    csrfToken: () => CSRF,
    releaseId: RELEASE,
    async fetchImpl(url, init) {
      calls.push({ url, init });
      return response(transcription());
    },
  });
  const result = await client.transcribe(new Blob([
    new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]),
  ], { type: "audio/mp4;codecs=mp4a.40.2" }));
  assert.deepEqual(result, transcription().transcription);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://llm.test/api/voice/transcribe");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.credentials, "same-origin");
  assert.equal(calls[0].init.cache, "no-store");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.headers.get("x-csrf-token"), CSRF);
  assert.equal(calls[0].init.headers.get("x-lazying-agent-release"), RELEASE);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    mediaType: "audio/mp4",
    data: "UklGRgECAwQ=",
    language: "auto",
  });
  assert.equal(Object.isFrozen(result), true);
});

test("fails locally before fetch for missing session, unsupported media, and oversized audio", async () => {
  let calls = 0;
  const client = new SpeechBrowserClient({
    baseUrl: "https://llm.test",
    csrfToken: () => "",
    fetchImpl: async () => { calls += 1; return response(transcription(), { release: undefined }); },
  });
  await assert.rejects(
    client.transcribe(new Blob([new Uint8Array([1])], { type: "audio/mp4" })),
    (error) => error instanceof SpeechBrowserTransportError && error.code === "authentication_required",
  );
  await assert.rejects(
    client.transcribe(new Blob([new Uint8Array([1])], { type: "audio/aac" })),
    TypeError,
  );
  await assert.rejects(
    client.transcribe(new Blob([new Uint8Array(BROWSER_SPEECH_LIMITS.audioBytes + 1)], { type: "audio/mp4" })),
    TypeError,
  );
  assert.equal(calls, 0);
});

test("preserves server release replacement and rejects cacheable or malformed success", async () => {
  for (const [reply, predicate] of [
    [response(transcription(), { release: "voice-release-2" }),
      (error) => error instanceof SpeechBrowserTransportError
        && error.code === "client_release_mismatch" && error.serverRelease === "voice-release-2"],
    [response(transcription(), { cacheControl: "private" }),
      (error) => error instanceof SpeechBrowserProtocolError],
    [response("not-json"),
      (error) => error instanceof SpeechBrowserProtocolError],
    [response({ transcription: { ...transcription().transcription, audioRetained: true } }),
      (error) => error instanceof SpeechBrowserProtocolError],
  ]) {
    const client = new SpeechBrowserClient({
      baseUrl: "https://llm.test",
      csrfToken: () => CSRF,
      releaseId: RELEASE,
      fetchImpl: async () => reply,
    });
    await assert.rejects(
      client.transcribe(new Blob([new Uint8Array([1])], { type: "audio/webm" })),
      predicate,
    );
  }
});

test("maps bounded server refusal without reflecting its message", async () => {
  const client = new SpeechBrowserClient({
    baseUrl: "https://llm.test",
    csrfToken: () => CSRF,
    releaseId: RELEASE,
    fetchImpl: async () => response({
      error: { code: "speech_busy", message: "private upstream detail" },
    }, { status: 429 }),
  });
  await assert.rejects(
    client.transcribe(new Blob([new Uint8Array([1])], { type: "audio/ogg" })),
    (error) => error instanceof SpeechBrowserTransportError
      && error.code === "speech_busy" && error.status === 429 && error.retryable === true
      && !error.message.includes("private upstream detail"),
  );
});
