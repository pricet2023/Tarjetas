import { describe, expect, it } from "vitest";

import { resampledLength, spliceChunks } from "./resample";

// `resampleTo` itself needs `OfflineAudioContext`, which `jsdom` does not have
// (§5) — it is covered by the browser run recorded in the plan's §14. The
// arithmetic around it is here, because that is where a lost syllable hides.

describe("spliceChunks", () => {
  it("joins the worklet's batches in order", () => {
    const out = spliceChunks([Float32Array.of(1, 2), Float32Array.of(3), Float32Array.of(4, 5, 6)]);
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("keeps a short final batch", () => {
    // The tail of an utterance is a partial buffer, flushed on stop. Dropping
    // it silently truncates the last syllable of every recording.
    const out = spliceChunks([new Float32Array(2048).fill(0.5), Float32Array.of(0.25)]);
    expect(out.length).toBe(2049);
    expect(out[2048]).toBe(0.25);
  });

  it("handles nothing at all", () => {
    expect(spliceChunks([]).length).toBe(0);
    expect(spliceChunks([new Float32Array(0)]).length).toBe(0);
  });
});

describe("resampledLength", () => {
  it("converts 48 kHz to 16 kHz", () => {
    expect(resampledLength(48000, 48000, 16000)).toBe(16000);
    expect(resampledLength(92672, 48000, 16000)).toBe(30891); // §10.6's measured capture
  });

  it("never asks for a zero-length render", () => {
    // `OfflineAudioContext` throws on length 0, and a stray one-sample buffer
    // is a plausible thing to arrive at the end of a stopped stream.
    expect(resampledLength(1, 48000, 16000)).toBe(1);
    expect(resampledLength(0, 48000, 16000)).toBe(1);
  });
});
