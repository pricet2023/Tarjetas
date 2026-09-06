import { describe, expect, it, vi } from "vitest";

import type { Batch, Microphone } from "./capture";
import { createRecorder, type RecorderState } from "./recorder";

const RATE = 16000;

/**
 * A microphone that is a function call.
 *
 * The real one needs `getUserMedia`, an `AudioContext` and an AudioWorklet,
 * none of which exist in `jsdom` (§5) — but the sequencing around it is where
 * the bugs are, so the seam is injected exactly like `loadAcousticModel`'s
 * `port`.
 */
function fakeMic(overrides: Partial<Microphone> = {}) {
  const listeners = new Set<(batch: Batch) => void>();
  const mic = {
    sampleRate: RATE,
    settings: {} as MediaTrackSettings,
    warnings: [] as readonly string[],
    onBatch(listener: (batch: Batch) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    flush: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    ...overrides,
  };
  const emit = (samples: Float32Array, reason: Batch["reason"] = "full"): void => {
    let peak = 0;
    for (const x of samples) peak = Math.max(peak, Math.abs(x));
    for (const listener of listeners) listener({ samples, peak, reason });
  };
  return { mic: mic as Microphone & typeof mic, emit, listeners };
}

/** Identity resampler: the fake mic already runs at 16 kHz, so this only records the call. */
const passthrough = vi.fn(async (samples: Float32Array) => samples.slice());

function noise(length: number, amplitude: number, seed = 1): Float32Array {
  let state = seed;
  return Float32Array.from({ length }, () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return ((state / 2147483648) * 2 - 1) * amplitude;
  });
}

const ms = (n: number): number => Math.round((n / 1000) * RATE);

/** Room tone, a burst, room tone — in 2048-sample batches, the way the worklet posts them. */
function batches(samples: Float32Array, size = 2048): Float32Array[] {
  const out: Float32Array[] = [];
  for (let at = 0; at < samples.length; at += size) out.push(samples.slice(at, at + size));
  return out;
}

function utterance(): Float32Array {
  const samples = noise(ms(1400), 0.001);
  for (let i = ms(400); i < ms(1000); i += 1) samples[i] += 0.3 * Math.sin((i * 2 * Math.PI * 200) / RATE);
  return samples;
}

describe("createRecorder", () => {
  it("walks idle -> arming -> ready -> recording -> processing -> ready", async () => {
    const { mic, emit } = fakeMic();
    const recorder = createRecorder({ openMic: async () => mic, resample: passthrough });
    const seen: RecorderState[] = [];
    recorder.onStateChange((s) => seen.push(s));

    expect(recorder.state).toBe("idle");
    await recorder.arm();
    recorder.start();
    for (const batch of batches(utterance())) emit(batch);
    await recorder.stop();

    expect(seen).toEqual(["arming", "ready", "recording", "processing", "ready"]);
  });

  it("opens the microphone once, however many times it is armed", async () => {
    // `StrictMode` mounts twice and a learner double-clicks. A second stream
    // lights the recording indicator and nothing ever closes it.
    const { mic } = fakeMic();
    const openMic = vi.fn(async () => mic);
    const recorder = createRecorder({ openMic, resample: passthrough });
    await Promise.all([recorder.arm(), recorder.arm()]);
    await recorder.arm();
    expect(openMic).toHaveBeenCalledTimes(1);
  });

  it("goes back to idle when the mic is refused, and says why", async () => {
    const recorder = createRecorder({
      openMic: async () => {
        throw new Error("Microphone access was blocked. Allow it for this site and try again.");
      },
    });
    await expect(recorder.arm()).rejects.toThrow(/blocked/);
    expect(recorder.state).toBe("idle");
    // And it can be retried, rather than being wedged in `arming`.
    const { mic } = fakeMic();
    await createRecorder({ openMic: async () => mic }).arm();
  });

  it("refuses to start or stop before the mic is open", async () => {
    const recorder = createRecorder({ openMic: async () => fakeMic().mic });
    expect(() => recorder.start()).toThrow(/isn't open/);
    await expect(recorder.stop()).rejects.toThrow(/isn't open/);
  });

  it("keeps only the batches between start and stop", async () => {
    const { mic, emit } = fakeMic();
    const recorder = createRecorder({ openMic: async () => mic, resample: passthrough });
    await recorder.arm();

    // Streaming before the button is pressed — the mic is open the whole time
    // the deck is (see capture.ts), so this is the normal case, not an edge.
    emit(noise(4096, 0.5));
    recorder.start();
    const spoken = utterance();
    for (const batch of batches(spoken)) emit(batch);
    const recording = await recorder.stop();

    expect(recording.full.length).toBe(spoken.length);
  });

  it("flushes the worklet's partial batch before reading the recording", async () => {
    // Without it the last ~43 ms never arrives, and that is a whole consonant.
    const { mic, emit } = fakeMic();
    mic.flush = vi.fn(async () => emit(noise(700, 0.3), "flush"));
    const recorder = createRecorder({ openMic: async () => mic, resample: passthrough });
    await recorder.arm();
    recorder.start();
    for (const batch of batches(utterance())) emit(batch);
    const recording = await recorder.stop();

    expect(mic.flush).toHaveBeenCalledTimes(1);
    expect(recording.full.length).toBe(utterance().length + 700);
  });

  it("trims the room tone but keeps the whole take for playback", async () => {
    const { mic, emit } = fakeMic();
    const recorder = createRecorder({ openMic: async () => mic, resample: passthrough });
    await recorder.arm();
    recorder.start();
    for (const batch of batches(utterance())) emit(batch);
    const recording = await recorder.stop();

    expect(recording.sampleRate).toBe(RATE);
    expect(recording.samples.length).toBeLessThan(recording.full.length);
    expect(recording.capturedMs).toBeCloseTo(1400, 0);
    // Speech runs 400-1000 ms, plus 80 ms of padding either side.
    expect(recording.durationMs).toBeGreaterThan(600);
    expect(recording.durationMs).toBeLessThan(800);
    expect(recording.endpoints.start).toBeGreaterThan(0);
  });

  it("resamples from the hardware rate to the model's", async () => {
    // The session throws on anything but 16 kHz rather than resampling
    // (§13.6), so this is the only place the conversion can happen.
    const { mic, emit } = fakeMic({ sampleRate: 48000 });
    const resample = vi.fn(async () => utterance());
    const recorder = createRecorder({ openMic: async () => mic, resample });
    await recorder.arm();
    recorder.start();
    emit(noise(4096, 0.3));
    await recorder.stop();

    expect(resample).toHaveBeenCalledWith(expect.any(Float32Array), 48000, 16000);
  });

  it("says so when nothing was recorded", async () => {
    // Digital silence is what §10.6's headless capture produced, and a page of
    // failed phonemes would blame the learner for a dead microphone.
    const { mic, emit } = fakeMic();
    const recorder = createRecorder({ openMic: async () => mic, resample: passthrough });
    await recorder.arm();
    recorder.start();
    emit(new Float32Array(8192));
    await expect(recorder.stop()).rejects.toThrow(/didn't hear anything/);
    // Still armed: the learner presses record again, they don't reload.
    expect(recorder.state).toBe("ready");
  });

  it("says so when the take is shorter than the model's floor", async () => {
    // Below 400 samples ORT fails inside a Conv node with `Invalid input
    // shape: {1}` (§13.2), which tells the learner nothing.
    const { mic, emit } = fakeMic();
    const recorder = createRecorder({ openMic: async () => mic, resample: passthrough });
    await recorder.arm();
    recorder.start();
    emit(noise(200, 0.4));
    await expect(recorder.stop()).rejects.toThrow(/didn't hear anything/);
  });

  it("caps a runaway take and admits it was cut", async () => {
    const { mic, emit } = fakeMic();
    const recorder = createRecorder({
      openMic: async () => mic,
      resample: passthrough,
      maxSeconds: 0.5,
    });
    await recorder.arm();
    recorder.start();
    for (const batch of batches(noise(ms(2000), 0.3), 4096)) emit(batch);
    const recording = await recorder.stop();

    expect(recording.truncated).toBe(true);
    expect(recording.full.length).toBe(ms(500));
  });

  it("does not claim a take was truncated when it wasn't", async () => {
    const { mic, emit } = fakeMic();
    const recorder = createRecorder({ openMic: async () => mic, resample: passthrough });
    await recorder.arm();
    recorder.start();
    for (const batch of batches(utterance())) emit(batch);
    expect((await recorder.stop()).truncated).toBe(false);
  });

  it("throws the attempt away on cancel", async () => {
    const { mic, emit } = fakeMic();
    const recorder = createRecorder({ openMic: async () => mic, resample: passthrough });
    await recorder.arm();
    recorder.start();
    for (const batch of batches(utterance())) emit(batch);
    recorder.cancel();

    expect(recorder.state).toBe("ready");
    await expect(recorder.stop()).rejects.toThrow(/Nothing is being recorded/);

    // And the next take starts empty rather than inheriting the abandoned one.
    recorder.start();
    for (const batch of batches(utterance())) emit(batch);
    expect((await recorder.stop()).full.length).toBe(utterance().length);
  });

  it("tracks the level whether or not it is recording", async () => {
    // The meter is how a learner knows the mic works before they commit to an
    // attempt, so it cannot wait for `start`.
    const { mic, emit } = fakeMic();
    const recorder = createRecorder({ openMic: async () => mic, resample: passthrough });
    await recorder.arm();
    expect(recorder.level.current).toBe(0);
    emit(noise(2048, 0.4));
    expect(recorder.level.current).toBeGreaterThan(0.2);
  });

  it("closes the stream and stops listening", async () => {
    const { mic, emit, listeners } = fakeMic();
    const recorder = createRecorder({ openMic: async () => mic, resample: passthrough });
    await recorder.arm();
    await recorder.close();

    expect(mic.close).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
    expect(recorder.state).toBe("idle");
    // A batch in flight when the deck was left must not resurrect anything.
    emit(noise(2048, 0.4));
    expect(recorder.level.current).toBe(0);
  });

  it("passes the constraint readback through to the recording", async () => {
    // §10.6: the mic can silently ignore `channelCount: 1`, and a strange
    // score months from now is much easier to explain with this attached.
    const { mic, emit } = fakeMic({ warnings: ["Mic gave 2 channels, not 1; downmixing."] });
    const recorder = createRecorder({ openMic: async () => mic, resample: passthrough });
    await recorder.arm();
    expect(recorder.warnings).toHaveLength(1);
    recorder.start();
    for (const batch of batches(utterance())) emit(batch);
    expect((await recorder.stop()).warnings).toEqual(mic.warnings);
  });
});
