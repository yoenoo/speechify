import test from 'node:test';
import assert from 'node:assert/strict';
import { Reader } from '../src/speech/reader.js';

/**
 * Stands in for a speech synthesiser: records what was queued and lets a test
 * decide when each utterance starts, reports a word, ends or fails.
 */
class FakeEngine {
  queue = [];
  cancels = 0;
  paused = false;

  speak(utterance) {
    this.queue.push({ ...utterance, started: false, done: false });
  }

  cancel() {
    this.cancels++;
    this.queue = this.queue.filter((u) => u.started && !u.done);
    for (const utterance of this.queue) utterance.onError?.({ error: 'interrupted' });
    this.queue = [];
    this.paused = false;
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
  }

  isSpeaking() {
    return this.queue.some((u) => u.started && !u.done);
  }

  isPaused() {
    return this.paused;
  }

  // -- test controls -------------------------------------------------------
  get pending() {
    return this.queue.filter((u) => !u.done);
  }

  startNext() {
    const utterance = this.pending.find((u) => !u.started);
    utterance.started = true;
    utterance.onStart();
    return utterance;
  }

  finish(utterance) {
    utterance.done = true;
    utterance.onEnd();
  }

  /** Run one utterance start-to-finish, the common case. */
  speakOne() {
    const utterance = this.startNext();
    this.finish(utterance);
    return utterance;
  }
}

function makeUnits(count) {
  return Array.from({ length: count }, (_, i) => ({
    pageIndex: Math.floor(i / 2),
    start: i * 10,
    end: i * 10 + 8,
    text: `Sentence ${i}.`,
  }));
}

function setup(count = 5) {
  const engine = new FakeEngine();
  const reader = new Reader(engine, { rate: 1 });
  const events = [];
  for (const name of ['unit', 'word', 'state', 'end', 'error', 'stall']) {
    reader.on(name, (payload) => events.push({ name, ...payload }));
  }
  reader.setUnits(makeUnits(count));
  return { engine, reader, events };
}

test('play queues the current unit plus a lookahead', () => {
  const { engine, reader } = setup();
  reader.play();
  assert.equal(engine.pending.length, 2, 'one in flight, one queued ahead');
  assert.equal(engine.pending[0].text, 'Sentence 0.');
  assert.equal(engine.pending[1].text, 'Sentence 1.');
  assert.equal(reader.state, 'playing');
});

test('the highlight follows the engine, not the queue', () => {
  const { engine, reader, events } = setup();
  reader.play();

  // Unit 1 is already queued, but until the engine starts it the current unit
  // must still be 0.
  assert.equal(reader.index, 0);

  const first = engine.startNext();
  assert.equal(reader.index, 0);
  engine.finish(first);
  engine.startNext();
  assert.equal(reader.index, 1);

  const units = events.filter((e) => e.name === 'unit').map((e) => e.index);
  assert.deepEqual(units, [0, 0, 1]);
});

test('playback advances through every unit and then ends', () => {
  const { engine, reader, events } = setup(4);
  reader.play();
  for (let i = 0; i < 4; i++) engine.speakOne();

  assert.equal(reader.state, 'idle');
  assert.equal(events.filter((e) => e.name === 'end').length, 1);
  assert.deepEqual(
    events.filter((e) => e.name === 'unit').map((e) => e.index),
    [0, 0, 1, 2, 3]
  );
});

test('word boundaries are reported only for the unit actually speaking', () => {
  const { engine, reader, events } = setup();
  reader.play();
  const first = engine.startNext();
  const [, queued] = engine.queue;

  first.onBoundary({ charIndex: 9, charLength: 1 });
  queued.onBoundary({ charIndex: 3, charLength: 4 }); // not current: ignored

  const words = events.filter((e) => e.name === 'word');
  assert.equal(words.length, 1);
  assert.equal(words[0].index, 0);
  assert.equal(words[0].charIndex, 9);
});

test('pause and resume do not lose the position', () => {
  const { engine, reader } = setup();
  reader.play();
  engine.startNext();
  const cancelsBefore = engine.cancels;

  reader.pause();
  assert.equal(reader.state, 'paused');
  assert.equal(engine.isPaused(), true);
  assert.equal(engine.cancels, cancelsBefore, 'pausing must not cancel the queue');
  assert.equal(engine.pending.length, 2, 'the queued lookahead survives a pause');

  reader.resume();
  assert.equal(reader.state, 'playing');
  assert.equal(engine.isPaused(), false);
  assert.equal(reader.index, 0);
});

test('toggle cycles play, pause, resume', () => {
  const { engine, reader } = setup();
  reader.toggle();
  assert.equal(reader.state, 'playing');
  engine.startNext();
  reader.toggle();
  assert.equal(reader.state, 'paused');
  reader.toggle();
  assert.equal(reader.state, 'playing');
});

test('next and previous restart playback at the new unit', () => {
  const { engine, reader } = setup();
  reader.play();
  engine.speakOne();
  engine.startNext();
  assert.equal(reader.index, 1);

  const cancelsBefore = engine.cancels;
  reader.next();
  assert.equal(reader.index, 2);
  assert.ok(engine.cancels > cancelsBefore, 'the stale queue must be dropped');
  assert.equal(engine.pending[0].text, 'Sentence 2.');
  assert.equal(reader.state, 'playing');

  reader.previous();
  assert.equal(reader.index, 1);
  assert.equal(engine.pending[0].text, 'Sentence 1.');
});

test('seeking while stopped moves the highlight without speaking', () => {
  const { engine, reader } = setup();
  reader.next();
  assert.equal(reader.index, 1);
  assert.equal(reader.state, 'idle');
  assert.equal(engine.pending.length, 0);
});

test('navigation clamps at both ends', () => {
  const { reader } = setup(3);
  reader.previous();
  assert.equal(reader.index, 0);
  reader.play(99);
  assert.equal(reader.index, 2);
});

test('stale callbacks from a cancelled utterance are ignored', () => {
  const { engine, reader, events } = setup();
  reader.play();
  const first = engine.startNext();

  reader.play(3); // cancels everything queued

  first.onBoundary({ charIndex: 2, charLength: 3 });
  first.onEnd();

  assert.equal(reader.index, 3, 'a stale end must not advance the reader');
  assert.equal(events.filter((e) => e.name === 'word').length, 0);
  assert.equal(events.filter((e) => e.name === 'end').length, 0);
});

test('an engine error skips the unit rather than stalling', () => {
  const { engine, reader, events } = setup();
  reader.play();
  const first = engine.startNext();
  first.onError({ error: 'synthesis-failed' });

  assert.equal(events.filter((e) => e.name === 'error').length, 1);
  assert.equal(reader.index, 1);
  assert.equal(reader.state, 'playing');
});

test('a cancellation error is not surfaced as a failure', () => {
  const { engine, reader, events } = setup();
  reader.play();
  engine.startNext();
  reader.stop();

  assert.equal(events.filter((e) => e.name === 'error').length, 0);
  assert.equal(reader.state, 'idle');
});

test('changing the rate respeaks the current sentence', () => {
  const { engine, reader } = setup();
  reader.play();
  engine.speakOne();
  engine.startNext();
  assert.equal(reader.index, 1);

  reader.updateSettings({ rate: 1.75 });

  assert.equal(reader.index, 1, 'the position survives a settings change');
  assert.equal(engine.pending[0].text, 'Sentence 1.');
  assert.equal(engine.pending[0].rate, 1.75);
});

test('changing settings while idle does not start playback', () => {
  const { engine, reader } = setup();
  reader.updateSettings({ rate: 2 });
  assert.equal(reader.state, 'idle');
  assert.equal(engine.pending.length, 0);
});

test('setUnits stops playback and rewinds', () => {
  const { engine, reader } = setup();
  reader.play(2);
  engine.startNext();
  reader.setUnits(makeUnits(2));
  assert.equal(reader.state, 'idle');
  assert.equal(reader.index, 0);
  assert.equal(engine.pending.length, 0);
});

test('jumping straight to a distant sentence speaks that sentence first', () => {
  // A regression test for a real bug: play() computed the queue's resume
  // point from the *old* position instead of the target, so jumping far ahead
  // (e.g. tapping a sentence near the end of the page) silently re-spoke every
  // sentence in between, starting from wherever playback last left off,
  // before ever reaching the one that was actually requested.
  const { engine, reader } = setup(20);
  reader.play(0);
  engine.speakOne(); // advances the engine past sentence 0

  reader.play(15);
  const first = engine.startNext();

  assert.equal(first.text, 'Sentence 15.', `expected to jump straight to 15, engine got "${first.text}"`);
  assert.equal(reader.index, 15);
});

test('play() from a stopped state queues only the target and its lookahead', () => {
  const { engine, reader } = setup(10);
  reader.play(7);
  assert.deepEqual(
    engine.pending.map((u) => u.text),
    ['Sentence 7.', 'Sentence 8.'],
    'no earlier sentences should have been queued'
  );
});
