import { describe, expect, it } from "vitest";

import { findEndpoints, frameEnergies, trimToSpeech } from "./trim";

const RATE = 16000;
const ms = (n: number): number => Math.round((n / 1000) * RATE);

/** Uniform noise at a given amplitude, deterministic so a failure is reproducible. */
function noise(length: number, amplitude: number, seed = 1): Float32Array {
  let state = seed;
  return Float32Array.from({ length }, () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return ((state / 2147483648) * 2 - 1) * amplitude;
  });
}

/** Room tone, then a burst, then room tone. The shape of every real capture. */
function utterance({
  leadMs = 400,
  speechMs = 600,
  tailMs = 400,
  floor = 0.001,
  level = 0.3,
}: Partial<Record<"leadMs" | "speechMs" | "tailMs" | "floor" | "level", number>> = {}): Float32Array {
  const samples = noise(ms(leadMs + speechMs + tailMs), floor);
  for (let i = ms(leadMs); i < ms(leadMs + speechMs); i += 1) {
    samples[i] += level * Math.sin((i * 2 * Math.PI * 200) / RATE);
  }
  return samples;
}

describe("frameEnergies", () => {
  it("measures in dBFS at the model's own frame rate", () => {
    // 20 ms frames on a 10 ms hop, so 1 s of audio is ~100 windows.
    const energies = frameEnergies(new Float32Array(RATE), { sampleRate: RATE });
    expect(energies.length).toBe(100);
    // Digital silence must be a finite number, not -Infinity: it is fed
    // straight into a percentile and a subtraction.
    expect(energies.every(Number.isFinite)).toBe(true);
  });

  it("puts a full-scale tone near 0 dB and a quiet one far below it", () => {
    const loud = frameEnergies(noise(RATE, 1), { sampleRate: RATE });
    const quiet = frameEnergies(noise(RATE, 0.01), { sampleRate: RATE });
    expect(Math.max(...loud)).toBeGreaterThan(-8);
    expect(Math.max(...quiet)).toBeLessThan(-35);
  });
});

describe("findEndpoints", () => {
  it("finds the speech inside the room tone", () => {
    const endpoints = findEndpoints(utterance(), { sampleRate: RATE })!;
    expect(endpoints).not.toBeNull();
    // Onset at 400 ms, offset at 1000 ms, 80 ms of padding either side. Allow
    // a frame of slop at each edge — the window is 20 ms wide.
    expect(endpoints.start).toBeGreaterThan(ms(400 - 80 - 25));
    expect(endpoints.start).toBeLessThan(ms(400));
    expect(endpoints.end).toBeGreaterThan(ms(1000));
    expect(endpoints.end).toBeLessThan(ms(1000 + 80 + 25));
  });

  it("keeps the padding, because a plosive's closure is silence", () => {
    // The /p/ in perro is a gap then a burst: cutting at the first frame over
    // threshold removes the evidence that it was a stop at all.
    const endpoints = findEndpoints(utterance({ leadMs: 400 }), { sampleRate: RATE })!;
    expect(ms(400) - endpoints.start).toBeGreaterThanOrEqual(ms(60));
  });

  it("returns null for digital silence", () => {
    // §10.6's headless capture really did produce exactly this.
    expect(findEndpoints(new Float32Array(RATE), { sampleRate: RATE })).toBeNull();
  });

  it("returns null for a dead mic that is only dither", () => {
    // -60 dBFS peak is a muted input, not a quiet speaker.
    expect(findEndpoints(noise(RATE, 0.0005), { sampleRate: RATE })).toBeNull();
  });

  it("keeps everything when the whole clip is speech", () => {
    // No noise floor to rise above. Extra audio costs the aligner a little;
    // a missing syllable costs it the answer.
    const all = noise(RATE, 0.3);
    const endpoints = findEndpoints(all, { sampleRate: RATE })!;
    expect(endpoints.start).toBe(0);
    expect(endpoints.end).toBe(all.length);
  });

  it("ignores a click that never becomes speech", () => {
    // One 10 ms tap in the middle of room tone: over threshold, under the
    // three-frame run, so it must not anchor an endpoint.
    const samples = noise(ms(1000), 0.001);
    for (let i = ms(500); i < ms(510); i += 1) samples[i] = 0.5;
    const endpoints = findEndpoints(samples, { sampleRate: RATE })!;
    expect(endpoints.start).toBe(0);
    expect(endpoints.end).toBe(samples.length);
  });

  it("still finds quiet speech, because the threshold is relative", () => {
    // A learner well off the mic. The model normalises level away (§10.3), so
    // this must not be treated as silence.
    const endpoints = findEndpoints(utterance({ floor: 0.0002, level: 0.01 }), {
      sampleRate: RATE,
    })!;
    expect(endpoints).not.toBeNull();
    expect(endpoints.start).toBeLessThan(ms(400));
    expect(endpoints.end).toBeGreaterThan(ms(1000));
  });

  it("does not run off either end of the buffer", () => {
    // Speech that starts in the first frame and runs to the last: the padding
    // would otherwise index outside the array.
    const endpoints = findEndpoints(noise(ms(300), 0.4), { sampleRate: RATE })!;
    expect(endpoints.start).toBe(0);
    expect(endpoints.end).toBe(ms(300));
  });

  it("has nothing to say about an empty buffer", () => {
    expect(findEndpoints(new Float32Array(0), { sampleRate: RATE })).toBeNull();
  });
});

describe("trimToSpeech", () => {
  it("returns a copy, not a view", () => {
    // The result is transferred to the Worker; a view would neuter the
    // recording the UI keeps for playback.
    const source = utterance();
    const trimmed = trimToSpeech(source, { sampleRate: RATE })!;
    expect(trimmed.samples.buffer).not.toBe(source.buffer);
    expect(trimmed.samples.length).toBe(trimmed.endpoints.end - trimmed.endpoints.start);
    expect(trimmed.samples.length).toBeLessThan(source.length);
  });

  it("is null exactly when there was nothing to hear", () => {
    expect(trimToSpeech(new Float32Array(RATE), { sampleRate: RATE })).toBeNull();
  });
});
