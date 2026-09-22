/**
 * Playback controller: owns "which unit is being spoken right now".
 *
 * Deliberately free of DOM and of any particular speech API — it drives an
 * injected engine (see `web-speech-engine.js`) and emits events that the view
 * layer turns into highlights and scrolling. That keeps the tricky part, the
 * bookkeeping around cancellation and queueing, testable with a fake engine.
 */

const LOOKAHEAD = 1; // utterances queued past the current one, to avoid gaps
const WATCHDOG_INTERVAL_MS = 1500;
const MAX_RETRIES_PER_UNIT = 1;

export class Reader {
  #engine;
  #units = [];
  #listeners = new Map();

  #state = 'idle'; // 'idle' | 'playing' | 'paused'
  #index = 0; // unit currently being spoken (or about to be)
  #queuedTo = -1; // highest unit index handed to the engine
  #generation = 0; // bumped on every cancel, to ignore stale callbacks
  #retries = 0;
  #watchdog = null;

  constructor(engine, { rate = 1, pitch = 1, volume = 1, voice = null } = {}) {
    this.#engine = engine;
    this.settings = { rate, pitch, volume, voice };
  }

  get state() {
    return this.#state;
  }

  get index() {
    return this.#index;
  }

  get units() {
    return this.#units;
  }

  get currentUnit() {
    return this.#units[this.#index] ?? null;
  }

  on(event, listener) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
    this.#listeners.get(event).add(listener);
    return () => this.#listeners.get(event)?.delete(listener);
  }

  #emit(event, payload) {
    for (const listener of this.#listeners.get(event) ?? []) listener(payload);
  }

  /** Replace the document being read. Stops playback. */
  setUnits(units) {
    this.stop();
    this.#units = units;
    this.#index = 0;
  }

  play(index = this.#index) {
    if (this.#units.length === 0) return;

    const target = clampIndex(index, this.#units.length);
    if (this.#state === 'paused' && target === this.#index) {
      this.resume();
      return;
    }

    this.#cancel();
    this.#index = target;
    this.#retries = 0;
    this.#setState('playing');
    this.#emit('unit', { index: this.#index, unit: this.currentUnit });
    this.#fillQueue();
    this.#startWatchdog();
  }

  pause() {
    if (this.#state !== 'playing') return;
    this.#engine.pause();
    this.#setState('paused');
  }

  resume() {
    if (this.#state !== 'paused') return;
    this.#engine.resume();
    this.#setState('playing');
  }

  toggle() {
    if (this.#state === 'playing') this.pause();
    else if (this.#state === 'paused') this.resume();
    else this.play();
  }

  stop() {
    this.#cancel();
    this.#setState('idle');
  }

  next() {
    this.#jump(this.#index + 1);
  }

  previous() {
    this.#jump(this.#index - 1);
  }

  #jump(index) {
    if (this.#units.length === 0) return;
    const target = clampIndex(index, this.#units.length);
    const wasPlaying = this.#state === 'playing';

    this.#cancel();
    this.#index = target;
    this.#emit('unit', { index: target, unit: this.currentUnit });

    if (wasPlaying) this.play(target);
    else this.#setState(this.#state === 'paused' ? 'idle' : this.#state);
  }

  /**
   * Apply new voice settings. Rate and voice are baked into an utterance when
   * it is created, so a change mid-sentence can only take effect by respeaking
   * the current unit.
   */
  updateSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    this.#emit('settings', { settings: this.settings });
    if (this.#state === 'playing') this.play(this.#index);
  }

  #setState(state) {
    if (this.#state === state) return;
    this.#state = state;
    if (state !== 'playing') this.#stopWatchdog();
    this.#emit('state', { state });
  }

  #cancel() {
    this.#generation++;
    this.#queuedTo = this.#index - 1;
    this.#engine.cancel();
    this.#stopWatchdog();
  }

  /** Hand the engine the current unit plus a small lookahead. */
  #fillQueue() {
    const generation = this.#generation;
    while (
      this.#queuedTo < this.#index + LOOKAHEAD &&
      this.#queuedTo + 1 < this.#units.length
    ) {
      const index = ++this.#queuedTo;
      this.#speak(index, generation);
    }
  }

  #speak(index, generation) {
    const unit = this.#units[index];
    const isStale = () => generation !== this.#generation;

    this.#engine.speak({
      text: unit.text,
      rate: this.settings.rate,
      pitch: this.settings.pitch,
      volume: this.settings.volume,
      voice: this.settings.voice,

      onStart: () => {
        if (isStale()) return;
        // The engine decides when a queued utterance actually begins, so this
        // — not the queueing order — is what the highlight follows.
        this.#index = index;
        this.#retries = 0;
        this.#emit('unit', { index, unit });
        this.#fillQueue();
      },

      onBoundary: ({ charIndex, charLength }) => {
        if (isStale() || index !== this.#index) return;
        this.#emit('word', { index, unit, charIndex, charLength });
      },

      onEnd: () => {
        if (isStale()) return;
        if (index >= this.#units.length - 1) {
          this.#setState('idle');
          this.#emit('end', { index });
          return;
        }
        this.#fillQueue();
      },

      onError: (error) => {
        if (isStale()) return;
        // "interrupted"/"canceled" are the engine acknowledging our own cancel.
        if (error?.error === 'interrupted' || error?.error === 'canceled') return;
        this.#emit('error', { index, unit, error });
        this.#recover(index);
      },
    });
  }

  /** Skip past a unit the engine refused, rather than stalling the document. */
  #recover(index) {
    if (this.#state !== 'playing') return;
    if (index >= this.#units.length - 1) {
      this.stop();
      this.#emit('end', { index });
      return;
    }
    this.play(index + 1);
  }

  #startWatchdog() {
    this.#stopWatchdog();
    if (typeof setInterval !== 'function') return;
    this.#watchdog = setInterval(() => this.#checkForSilence(), WATCHDOG_INTERVAL_MS);
    this.#watchdog.unref?.();
  }

  #stopWatchdog() {
    if (this.#watchdog !== null) {
      clearInterval(this.#watchdog);
      this.#watchdog = null;
    }
  }

  /**
   * Browser speech engines occasionally drop a queued utterance without firing
   * `end` or `error` — the document simply goes quiet. Notice it and resume
   * instead of leaving a stale highlight on screen forever.
   */
  #checkForSilence() {
    if (this.#state !== 'playing') return;
    if (this.#engine.isSpeaking() || this.#engine.isPaused()) return;

    if (this.#retries < MAX_RETRIES_PER_UNIT) {
      this.#retries++;
      this.#emit('stall', { index: this.#index, attempt: this.#retries });
      this.play(this.#index);
    } else {
      this.#retries = 0;
      if (this.#index >= this.#units.length - 1) {
        this.stop();
        this.#emit('end', { index: this.#index });
      } else {
        this.play(this.#index + 1);
      }
    }
  }
}

function clampIndex(index, length) {
  return Math.min(Math.max(index, 0), Math.max(length - 1, 0));
}
