const MAXIMUM_TEXT_BYTES = 64 * 1024;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const encoder = new TextEncoder();

function languageTag(value) {
  if (typeof value !== "string") return "en-US";
  const normalized = value.trim();
  return /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(normalized) ? normalized : "en-US";
}

function preferredVoice(synthesizer, language) {
  let voices;
  try { voices = synthesizer.getVoices?.(); }
  catch { return undefined; }
  if (!Array.isArray(voices)) return undefined;
  const requested = language.toLowerCase();
  const base = requested.split("-", 1)[0];
  return voices.find((voice) => voice?.localService === true && String(voice.lang).toLowerCase() === requested)
    ?? voices.find((voice) => voice?.localService === true && String(voice.lang).toLowerCase().split("-", 1)[0] === base)
    ?? voices.find((voice) => String(voice?.lang).toLowerCase() === requested)
    ?? voices.find((voice) => String(voice?.lang).toLowerCase().split("-", 1)[0] === base);
}

export function createAssistantSpeechPlayback({
  speechSynthesis = globalThis.speechSynthesis,
  utteranceConstructor = globalThis.SpeechSynthesisUtterance,
  language = globalThis.navigator?.language,
} = {}) {
  const available = speechSynthesis !== null && typeof speechSynthesis === "object"
    && typeof speechSynthesis.speak === "function" && typeof speechSynthesis.cancel === "function"
    && typeof utteranceConstructor === "function";
  let active = null;

  function cancel() {
    active = null;
    if (!available) return false;
    try { speechSynthesis.cancel(); }
    catch { return false; }
    return true;
  }

  function speak(value, { onEnd } = {}) {
    if (!available) return false;
    if (onEnd !== undefined && typeof onEnd !== "function") throw new TypeError("onEnd must be a function");
    const text = typeof value === "string" ? value.trim() : "";
    if (!text || encoder.encode(text).byteLength > MAXIMUM_TEXT_BYTES || CONTROL.test(text)) {
      throw new TypeError("assistant speech text is invalid");
    }
    cancel();
    const utterance = new utteranceConstructor(text);
    const selectedLanguage = languageTag(language);
    utterance.lang = selectedLanguage;
    utterance.rate = 1;
    utterance.pitch = 1;
    const voice = preferredVoice(speechSynthesis, selectedLanguage);
    if (voice !== undefined) utterance.voice = voice;
    const operation = { utterance };
    active = operation;
    const finish = () => {
      if (active !== operation) return;
      active = null;
      onEnd?.();
    };
    utterance.onend = finish;
    utterance.onerror = finish;
    try { speechSynthesis.speak(utterance); }
    catch (error) {
      active = null;
      throw error;
    }
    return true;
  }

  return Object.freeze({
    available,
    speak,
    cancel,
    get speaking() { return active !== null; },
  });
}
