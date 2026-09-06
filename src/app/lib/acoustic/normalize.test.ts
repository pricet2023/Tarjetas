import { describe, expect, it } from "vitest";

import { MIN_SAMPLES, normalizeWaveform } from "./normalize";

const mean = (xs: Float32Array): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: Float32Array): number =>
  Math.sqrt(xs.reduce((a, b) => a + (b - mean(xs)) ** 2, 0) / xs.length);

const tone = (n: number, amplitude = 0.2, offset = 0): Float32Array =>
  Float32Array.from({ length: n }, (_, i) => offset + amplitude * Math.sin((i * 2 * Math.PI) / 40));

describe("normalizeWaveform", () => {
  it("centres and scales to what the model was trained on", () => {
    // `do_normalize: true` in the model's preprocessor config, so this is not
    // optional and getting it wrong is silent (§10.3).
    const out = normalizeWaveform(tone(1600));
    expect(mean(out)).toBeCloseTo(0, 5);
    expect(sd(out)).toBeCloseTo(1, 4);
  });

  it("removes a DC offset", () => {
    // A microphone with a bias would otherwise shift every frame.
    const out = normalizeWaveform(tone(1600, 0.2, 0.5));
    expect(mean(out)).toBeCloseTo(0, 5);
  });

  it("scales quiet and loud recordings to the same place", () => {
    const quiet = normalizeWaveform(tone(1600, 0.01));
    const loud = normalizeWaveform(tone(1600, 0.9));
    expect(sd(quiet)).toBeCloseTo(sd(loud), 4);
  });

  it("is not thrown off by a sample outside [-1, 1]", () => {
    // §10.6 measured a capture peaking at 1.1298. Peak normalisation would
    // let that one sample set the gain for the whole utterance.
    const clipped = tone(1600);
    clipped[7] = 1.13;
    const out = normalizeWaveform(clipped);
    expect(sd(out)).toBeCloseTo(1, 4);
    expect(Number.isFinite(out[7])).toBe(true);
  });

  it("turns digital silence into silence, not NaN", () => {
    // Which is what §10.6's headless capture actually produced. Zeros give
    // terrible scores, as they should; NaN would poison the posteriors with
    // no error anywhere.
    const out = normalizeWaveform(new Float32Array(1600));
    expect(out.every((x) => x === 0)).toBe(true);
  });

  it("does not modify its input", () => {
    const input = tone(1600, 0.2, 0.5);
    const before = Float32Array.from(input);
    normalizeWaveform(input);
    expect(input).toEqual(before);
  });

  it("refuses audio too short for one frame", () => {
    // The model's conv stack needs 400 samples; below that ORT fails deep
    // inside a Conv node with a message about shape {1}.
    expect(() => normalizeWaveform(tone(MIN_SAMPLES - 1))).toThrow(/at least 400 samples/);
    expect(() => normalizeWaveform(new Float32Array(0))).toThrow(/at least 400 samples/);
    expect(() => normalizeWaveform(tone(MIN_SAMPLES))).not.toThrow();
  });

  it("refuses a broken buffer", () => {
    const broken = tone(1600);
    broken[100] = Number.NaN;
    expect(() => normalizeWaveform(broken)).toThrow(/non-finite/);
  });
});
