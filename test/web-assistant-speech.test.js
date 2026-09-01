import assert from "node:assert/strict";
import test from "node:test";

import { createAssistantSpeechPlayback } from "../src/web/assistant-speech.js";

class FakeUtterance {
  constructor(text) { this.text = text; }
}

test("uses a matching local system voice and exposes explicit stop without storing audio", () => {
  const calls = { cancel: 0, spoken: [] };
  const premium = { name: "Local English", lang: "en-US", localService: true };
  const synthesizer = {
    getVoices() {
      return [
        { name: "Remote English", lang: "en-US", localService: false },
        premium,
      ];
    },
    speak(utterance) { calls.spoken.push(utterance); },
    cancel() { calls.cancel += 1; },
  };
  const playback = createAssistantSpeechPlayback({
    speechSynthesis: synthesizer,
    utteranceConstructor: FakeUtterance,
    language: "en-US",
  });
  let ended = 0;
  assert.equal(playback.available, true);
  assert.equal(playback.speak("A useful assistant response.", { onEnd() { ended += 1; } }), true);
  assert.equal(playback.speaking, true);
  assert.equal(calls.spoken.length, 1);
  assert.equal(calls.spoken[0].text, "A useful assistant response.");
  assert.equal(calls.spoken[0].lang, "en-US");
  assert.equal(calls.spoken[0].rate, 1);
  assert.equal(calls.spoken[0].pitch, 1);
  assert.equal(calls.spoken[0].voice, premium);
  calls.spoken[0].onend();
  assert.equal(ended, 1);
  assert.equal(playback.speaking, false);
  assert.equal(playback.cancel(), true);
  assert.equal(calls.cancel, 2);
  assert.deepEqual(Object.keys(calls.spoken[0]).sort(), [
    "lang", "onend", "onerror", "pitch", "rate", "text", "voice",
  ]);
});

test("fails closed when system speech is absent or text is unsafe", () => {
  const unavailable = createAssistantSpeechPlayback({
    speechSynthesis: null,
    utteranceConstructor: undefined,
  });
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.speak("hello"), false);
  assert.equal(unavailable.cancel(), false);

  const available = createAssistantSpeechPlayback({
    speechSynthesis: { speak() {}, cancel() {}, getVoices() { return []; } },
    utteranceConstructor: FakeUtterance,
  });
  assert.throws(() => available.speak(""), /invalid/u);
  assert.throws(() => available.speak("unsafe\u0000text"), /invalid/u);
  assert.throws(() => available.speak("x", { onEnd: true }), /onEnd/u);
});
