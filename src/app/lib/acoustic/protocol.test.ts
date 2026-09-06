import { describe, expect, it } from "vitest";

import { ACOUSTIC_SOURCE, labelsByRow } from "./protocol";

describe("labelsByRow", () => {
  it("orders labels by row, not by their order in the file", () => {
    // `vocab.json` is a label -> index object and its key order is arbitrary.
    // The aligner addresses labels by row, so this is the conversion that has
    // to be right or every label is off by however much.
    expect(labelsByRow({ b: 1, "<pad>": 0, c: 2 })).toEqual(["<pad>", "b", "c"]);
  });

  it("rejects a gap", () => {
    expect(() => labelsByRow({ a: 0, b: 2 })).toThrow(/outside a 2-label vocabulary/);
  });

  it("rejects two labels claiming one row", () => {
    expect(() => labelsByRow({ a: 0, b: 0 })).toThrow(/claimed by both/);
  });
});

describe("ACOUSTIC_SOURCE", () => {
  it("names the blank rather than its index", () => {
    // 0 for this model, 37 for the §10.4 fallback, and a wrong index is a
    // silent failure — so the index is always looked up, never written down.
    expect(ACOUSTIC_SOURCE.padToken).toBe("<pad>");
    expect(ACOUSTIC_SOURCE).not.toHaveProperty("blank");
  });

  it("is the q4f16 build of the espeak XLSR model, at 16 kHz", () => {
    // The build is part of the contract: §10.3 measured a ~0.3 nat GOP shift
    // between quantizations, so Phase 5's native stats must be generated with
    // whatever this says. The id doubles as the cache key.
    expect(ACOUSTIC_SOURCE.id).toContain("q4f16");
    expect(ACOUSTIC_SOURCE.weights).toContain("model_q4f16.onnx");
    expect(ACOUSTIC_SOURCE.weights).toContain("wav2vec2-xlsr-53-espeak-cv-ft");
    // Not the lv-60 sibling, which is English-pretrained and measurably worse
    // on Spanish (§10.1) while having the better-stocked ONNX repo.
    expect(ACOUSTIC_SOURCE.weights).not.toContain("lv-60");
    expect(ACOUSTIC_SOURCE.sampleRate).toBe(16000);
    expect(ACOUSTIC_SOURCE.bytes).toBe(196651670);
  });
});
