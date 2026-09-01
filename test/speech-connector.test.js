import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SpeechConnectorError,
  createSpeechConnector
} from '../src/speech-connector.js';

const TOKEN = 'speech-connector-token-000000000001';

function jsonResponse(value, { status = 200, cacheControl = 'no-store' } = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': cacheControl
    }
  });
}

function statusEnvelope() {
  return {
    schema: 'localllm/speech-status/v1',
    enabled: true,
    state: 'cold',
    model_loaded: false,
    accepted_media_types: ['audio/mp4', 'audio/webm'],
    maximum_audio_bytes: 12 * 1024 * 1024,
    maximum_duration_seconds: 180,
    persistence: 'transient-until-transcribed',
    fault: null
  };
}

test('requires an exact private speech route and a distinct rotating credential provider', () => {
  for (const baseUrl of [
    'https://127.0.0.1:18023/api/speech',
    'http://localhost:18023/api/speech',
    'http://127.0.0.1:80/api/speech',
    'http://127.0.0.1:18023/api/speech/',
    'http://127.0.0.1:18023/api/speech?token=x'
  ]) {
    assert.throws(() => createSpeechConnector({
      baseUrl,
      credentialProvider: async () => TOKEN
    }), /exact private/u);
  }
});

test('reads no-store status and transcribes multipart audio into a bounded public envelope', async () => {
  const calls = [];
  const connector = createSpeechConnector({
    baseUrl: 'http://127.0.0.1:18023/api/speech',
    credentialProvider: async () => TOKEN,
    async fetchImpl(url, init) {
      calls.push({ url, init });
      if (url.endsWith('/status')) return jsonResponse(statusEnvelope());
      assert.equal(url, 'http://127.0.0.1:18023/api/speech/transcriptions');
      assert.equal(init.method, 'POST');
      assert.equal(init.body instanceof FormData, true);
      assert.equal(init.body.get('file') instanceof Blob, true);
      assert.equal(init.body.get('file').type, 'audio/mp4');
      assert.equal(init.body.get('language'), 'auto');
      return jsonResponse({
        schema: 'localllm/speech-transcription/v1',
        text: 'Voice input works.',
        language: 'en',
        language_probability: 0.98,
        duration_seconds: 1.5,
        audio_retained: false
      });
    }
  });
  const signal = new AbortController().signal;
  assert.deepEqual(await connector.status({ signal }), {
    enabled: true,
    state: 'cold',
    modelLoaded: false,
    acceptedMediaTypes: ['audio/mp4', 'audio/webm'],
    maximumAudioBytes: 8 * 1024 * 1024,
    maximumDurationSeconds: 180
  });
  assert.deepEqual(await connector.transcribe({
    mediaType: 'audio/mp4',
    audio: new Uint8Array([1, 2, 3, 4]),
    language: 'auto',
    signal
  }), {
    text: 'Voice input works.',
    language: 'en',
    languageProbability: 0.98,
    durationSeconds: 1.5,
    audioRetained: false
  });
  assert.equal(calls.length, 2);
  assert.equal(calls.every(({ init }) => init.headers.authorization === `Bearer ${TOKEN}`), true);
  assert.equal(calls.every(({ init }) => init.cache === 'no-store' && init.redirect === 'error'), true);
});

test('fails closed on cacheable, malformed, busy, and credential responses', async () => {
  for (const [fetchImpl, code] of [
    [async () => jsonResponse(statusEnvelope(), { cacheControl: 'private' }), 'SPEECH_RESPONSE_INVALID'],
    [async () => jsonResponse({ nope: true }), 'SPEECH_RESPONSE_INVALID'],
    [async () => jsonResponse({}, { status: 429 }), 'SPEECH_BUSY']
  ]) {
    const connector = createSpeechConnector({
      baseUrl: 'http://127.0.0.1:18023/api/speech',
      credentialProvider: async () => TOKEN,
      fetchImpl
    });
    await assert.rejects(
      connector.status({ signal: new AbortController().signal }),
      (error) => error instanceof SpeechConnectorError && error.code === code
    );
  }

  const missing = createSpeechConnector({
    baseUrl: 'http://127.0.0.1:18023/api/speech',
    credentialProvider: async () => '',
    fetchImpl: async () => jsonResponse(statusEnvelope())
  });
  await assert.rejects(
    missing.status({ signal: new AbortController().signal }),
    (error) => error instanceof SpeechConnectorError && error.code === 'SPEECH_CREDENTIAL_INVALID'
  );
});
