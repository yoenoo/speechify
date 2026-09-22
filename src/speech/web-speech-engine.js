/**
 * `Reader` engine backed by the platform speech synthesiser exposed through
 * `window.speechSynthesis`.
 *
 * In Electron this is Chromium's Web Speech API, which forwards to the OS voice
 * service: SAPI on Windows, NSSpeechSynthesizer on macOS, speech-dispatcher on
 * Linux. The adapter exists to keep that API's rough edges — asynchronous voice
 * lists, the long-utterance timeout, the cancel/speak race — out of the reader.
 */

const KEEPALIVE_INTERVAL_MS = 9000;
const CANCEL_SETTLE_MS = 16;

export class WebSpeechEngine {
  #synth;
  #keepalive = null;
  #userPaused = false;
  #pendingSpeak = [];
  #flushTimer = null;

  constructor(synth = globalThis.speechSynthesis) {
    this.#synth = synth;
  }

  static isAvailable(synth = globalThis.speechSynthesis) {
    return Boolean(synth) && typeof globalThis.SpeechSynthesisUtterance === 'function';
  }

  /**
   * Voices arrive asynchronously on every platform and, on Linux, may never
   * arrive at all when speech-dispatcher is not installed — so this resolves
   * with an empty list rather than hanging.
   */
  listVoices({ timeoutMs = 2000 } = {}) {
    return new Promise((resolve) => {
      const immediate = this.#synth?.getVoices() ?? [];
      if (immediate.length > 0) {
        resolve(immediate);
        return;
      }

      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.#synth?.removeEventListener?.('voiceschanged', onChange);
        clearTimeout(timer);
        resolve(this.#synth?.getVoices() ?? []);
      };

      const onChange = () => finish();
      const timer = setTimeout(finish, timeoutMs);
      this.#synth?.addEventListener?.('voiceschanged', onChange);
    });
  }

  speak({ text, rate = 1, pitch = 1, volume = 1, voice = null, onStart, onBoundary, onEnd, onError }) {
    const utterance = new globalThis.SpeechSynthesisUtterance(text);
    utterance.rate = rate;
    utterance.pitch = pitch;
    utterance.volume = volume;
    if (voice?.lang) utterance.lang = voice.lang;

    // A voice can go stale when the OS voice list changes under us, and
    // assigning one then throws. Losing the preferred voice is a far better
    // outcome than an exception that silently ends playback, so fall back to
    // the language alone and let the platform choose.
    if (voice) {
      try {
        utterance.voice = voice;
      } catch {
        /* keep utterance.lang and let the engine pick */
      }
    }

    utterance.onstart = () => {
      this.#startKeepalive();
      onStart?.();
    };
    utterance.onboundary = (event) => {
      // Only word boundaries move the highlight; sentence boundaries would just
      // repeat what `onStart` already told us.
      if (event.name && event.name !== 'word') return;
      onBoundary?.({ charIndex: event.charIndex ?? 0, charLength: event.charLength ?? 0 });
    };
    utterance.onend = () => {
      if (!this.isSpeaking()) this.#stopKeepalive();
      onEnd?.();
    };
    utterance.onerror = (event) => {
      if (!this.isSpeaking()) this.#stopKeepalive();
      onError?.({ error: event.error, message: event.message });
    };

    // Chromium drops utterances queued in the same task as a `cancel()`, so a
    // speak that closely follows one is deferred by a tick.
    this.#pendingSpeak.push(utterance);
    this.#scheduleFlush();
  }

  #scheduleFlush() {
    if (this.#flushTimer !== null) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      const queued = this.#pendingSpeak;
      this.#pendingSpeak = [];
      for (const utterance of queued) this.#synth.speak(utterance);
    }, CANCEL_SETTLE_MS);
  }

  cancel() {
    this.#pendingSpeak = [];
    if (this.#flushTimer !== null) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    this.#userPaused = false;
    this.#stopKeepalive();
    this.#synth.cancel();
  }

  pause() {
    this.#userPaused = true;
    this.#stopKeepalive();
    this.#synth.pause();
  }

  resume() {
    this.#userPaused = false;
    this.#synth.resume();
    this.#startKeepalive();
  }

  isSpeaking() {
    return Boolean(this.#synth?.speaking) || this.#pendingSpeak.length > 0;
  }

  isPaused() {
    return Boolean(this.#synth?.paused) || this.#userPaused;
  }

  /**
   * Chromium stops speaking after roughly fifteen seconds unless the queue is
   * nudged. Sentences are short enough that this rarely bites, but a long one
   * at a slow rate can cross the threshold mid-word.
   */
  #startKeepalive() {
    if (this.#keepalive !== null) return;
    this.#keepalive = setInterval(() => {
      if (this.#userPaused || !this.#synth.speaking) return;
      this.#synth.pause();
      this.#synth.resume();
    }, KEEPALIVE_INTERVAL_MS);
  }

  #stopKeepalive() {
    if (this.#keepalive !== null) {
      clearInterval(this.#keepalive);
      this.#keepalive = null;
    }
  }
}
