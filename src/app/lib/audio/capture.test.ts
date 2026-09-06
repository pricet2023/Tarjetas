import { describe, expect, it } from "vitest";

import { constraintWarnings, MIC_CONSTRAINTS } from "./capture";

// The rest of `capture.ts` is `getUserMedia`, an `AudioContext` and an
// AudioWorklet, none of which exist in `jsdom` (§5) — it is covered by the
// headless browser run in the plan's §14. The constraint readback is pure, and
// it is the part §10.6 says not to trust the browser about.

describe("MIC_CONSTRAINTS", () => {
  it("switches off all three DSP stages", () => {
    // Noise suppression gates quiet fricatives — /s/ and /x/, the sounds being
    // scored — and AGC moves the level under Phase 5's calibration. The
    // browser defaults are all `true`.
    expect(MIC_CONSTRAINTS.echoCancellation).toBe(false);
    expect(MIC_CONSTRAINTS.noiseSuppression).toBe(false);
    expect(MIC_CONSTRAINTS.autoGainControl).toBe(false);
    expect(MIC_CONSTRAINTS.channelCount).toBe(1);
  });
});

describe("constraintWarnings", () => {
  it("says nothing when the device did as it was asked", () => {
    expect(
      constraintWarnings({
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      }),
    ).toEqual([]);
  });

  it("catches the channel count being ignored", () => {
    // Measured on Chrome's fake capture device in §10.6, and again in §14:
    // the constraint object is a request, not a guarantee.
    expect(constraintWarnings({ channelCount: 2 })).toEqual([
      "Mic gave 2 channels, not 1; downmixing.",
    ]);
  });

  it("catches DSP that stayed on", () => {
    const warnings = constraintWarnings({ noiseSuppression: true, autoGainControl: true });
    expect(warnings).toHaveLength(2);
    expect(warnings.join(" ")).toMatch(/noiseSuppression.*autoGainControl/);
  });

  it("does not complain about settings the browser declines to report", () => {
    // Absent is not the same as wrong: Firefox reports far less than Chrome,
    // and a warning per missing key would make the real ones invisible.
    expect(constraintWarnings({})).toEqual([]);
  });
});
