/**
 * The capture path, end to end: microphone → batches → 16 kHz → trimmed
 * `Float32Array`, which is exactly what `model.score()` takes (§13.6).
 *
 * ```ts
 * const recorder = createRecorder();
 * await recorder.arm();                       // once, on entering the deck
 * recorder.start();                           // on press
 * const { samples } = await recorder.stop();  // on release
 * const { logProbs, labels, blank } = await model.score(samples);
 * ```
 *
 * Every browser API it needs is injected with a real default, the same trick
 * `loadAcousticModel`'s `port` uses: `jsdom` has neither `AudioContext` nor
 * `getUserMedia` (§5), and the sequencing here — what happens to a batch that
 * arrives before `start`, what the length cap does, which failure produces
 * which message — is worth testing without a browser. `capture.ts` and
 * `resample.ts` hold the parts that genuinely cannot be.
 */

import { MIN_SAMPLES } from "@/app/lib/acoustic/normalize";
import { ACOUSTIC_SOURCE } from "@/app/lib/acoustic/protocol";

import { openMicrophone, type Microphone } from "./capture";
import { resampleTo, spliceChunks } from "./resample";
import { trimToSpeech, type Endpoints } from "./trim";

/**
 * Hard ceiling on one attempt.
 *
 * A card is a word or a short phrase, and inference runs at ~0.9× realtime
 * (§13.2), so 15 seconds of held-down button would be a 13-second wait for a
 * score. It also bounds the buffer: 15 s at 48 kHz is 2.9 MB.
 */
const MAX_SECONDS = 15;

export type RecorderState = "idle" | "arming" | "ready" | "recording" | "processing";

export interface Recording {
  /** 16 kHz mono, endpoint-trimmed. This is what gets scored. */
  samples: Float32Array;
  /** 16 kHz mono, untrimmed — Phase 7 plays this back, so the learner hears what the model heard. */
  full: Float32Array;
  sampleRate: number;
  /** Duration of `samples`. */
  durationMs: number;
  /** Duration of `full`, so "you hesitated for a second" is visible. */
  capturedMs: number;
  endpoints: Endpoints;
  /** True if the attempt ran into `MAX_SECONDS` and was cut. */
  truncated: boolean;
  /** Constraint readback from `capture.ts` (§10.6). */
  warnings: readonly string[];
}

export interface Recorder {
  readonly state: RecorderState;
  /**
   * Most recent batch peak, 0..~1.
   *
   * A ref, not state, and for the reason `FlashCard` keeps its drag offset in
   * one: this updates every ~43 ms, and a `setState` per batch re-renders the
   * whole card 23 times a second while the learner is mid-word. The meter
   * reads it from a `requestAnimationFrame` loop and writes the DOM directly.
   */
  readonly level: { current: number };
  readonly warnings: readonly string[];
  /** Open the mic. Call once, from a user gesture. Idempotent. */
  arm(): Promise<void>;
  start(): void;
  stop(): Promise<Recording>;
  /** Throw the attempt away and go back to `ready`, mic still open. */
  cancel(): void;
  close(): Promise<void>;
  onStateChange(listener: (state: RecorderState) => void): () => void;
}

export interface RecorderDeps {
  openMic: () => Promise<Microphone>;
  resample: (samples: Float32Array, from: number, to: number) => Promise<Float32Array>;
  targetRate: number;
  maxSeconds: number;
}

export function createRecorder(deps: Partial<RecorderDeps> = {}): Recorder {
  const {
    openMic = openMicrophone,
    resample = resampleTo,
    targetRate = ACOUSTIC_SOURCE.sampleRate,
    maxSeconds = MAX_SECONDS,
  } = deps;

  let mic: Microphone | null = null;
  let arming: Promise<void> | null = null;
  let unsubscribe: (() => void) | null = null;
  let state: RecorderState = "idle";
  let chunks: Float32Array[] = [];
  let captured = 0;
  let recording = false;
  let truncated = false;

  const level = { current: 0 };
  const listeners = new Set<(state: RecorderState) => void>();

  const setState = (next: RecorderState): void => {
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener(state);
  };

  const collect = (batch: { samples: Float32Array; peak: number }): void => {
    level.current = batch.peak;
    if (!recording) return;
    const room = Math.floor(maxSeconds * (mic?.sampleRate ?? targetRate)) - captured;
    if (room <= 0) {
      truncated = true;
      return;
    }
    const kept = batch.samples.length <= room ? batch.samples : batch.samples.subarray(0, room);
    if (kept.length < batch.samples.length) truncated = true;
    chunks.push(kept);
    captured += kept.length;
  };

  return {
    get state() {
      return state;
    },
    level,
    get warnings() {
      return mic?.warnings ?? [];
    },

    arm() {
      if (mic) return Promise.resolve();
      // Two mounts under `StrictMode`, or an impatient double-click, must not
      // open two streams — the second one lights the recording indicator and
      // is never closed.
      arming ??= (async () => {
        setState("arming");
        try {
          const opened = await openMic();
          mic = opened;
          unsubscribe = opened.onBatch(collect);
          setState("ready");
        } catch (error) {
          setState("idle");
          throw error;
        } finally {
          arming = null;
        }
      })();
      return arming;
    },

    start() {
      if (!mic) throw new Error("The microphone isn't open yet.");
      if (state === "processing") throw new Error("Still scoring the last attempt.");
      chunks = [];
      captured = 0;
      truncated = false;
      recording = true;
      setState("recording");
      // Up to one batch of audio from *before* this call is still in the
      // worklet and will arrive in a moment. That is a feature: it catches a
      // learner who starts speaking on the way to the button, and `trim.ts`
      // removes it if they didn't.
    },

    async stop() {
      if (!mic) throw new Error("The microphone isn't open yet.");
      if (state === "processing") throw new Error("Still finishing the last attempt.");
      if (!recording) throw new Error("Nothing is being recorded.");
      setState("processing");
      const source = mic;
      try {
        // The tail of the utterance is sitting in a partial batch; without
        // this the recording ends up to 43 ms short, which is a whole
        // consonant.
        //
        // `recording` stays true across the flush on purpose — the flushed
        // batch arrives through `collect` like any other, and clearing the
        // flag first drops exactly the samples this call exists to fetch.
        try {
          await source.flush();
        } finally {
          recording = false;
        }
        const raw = spliceChunks(chunks);
        chunks = [];
        const full = await resample(raw, source.sampleRate, targetRate);
        const trimmed = trimToSpeech(full, { sampleRate: targetRate });
        if (!trimmed || trimmed.samples.length < MIN_SAMPLES) {
          throw new Error("I didn't hear anything — check the mic and try again.");
        }
        return {
          samples: trimmed.samples,
          full,
          sampleRate: targetRate,
          durationMs: (trimmed.samples.length / targetRate) * 1000,
          capturedMs: (full.length / targetRate) * 1000,
          endpoints: trimmed.endpoints,
          truncated,
          warnings: source.warnings,
        };
      } finally {
        // Back to `ready` either way: a failed attempt leaves the mic open and
        // the learner able to press record again immediately.
        setState(mic ? "ready" : "idle");
      }
    },

    cancel() {
      recording = false;
      chunks = [];
      captured = 0;
      truncated = false;
      if (mic) setState("ready");
    },

    async close() {
      recording = false;
      chunks = [];
      captured = 0;
      unsubscribe?.();
      unsubscribe = null;
      const open = mic;
      mic = null;
      level.current = 0;
      setState("idle");
      await open?.close();
    },

    onStateChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
