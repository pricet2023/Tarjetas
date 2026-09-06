import { describe, expect, it } from "vitest";

import { releaseSpeed } from "@/components/FlashCard";

/**
 * `releaseSpeed` decides whether a short, fast flick counts as an answer, so
 * the direction and the averaging window both matter: a drag that reverses
 * before release must not be read as a flick the way it went out.
 */
describe("releaseSpeed", () => {
  it("is zero without two samples to compare", () => {
    expect(releaseSpeed([])).toBe(0);
    expect(releaseSpeed([{ x: 10, t: 0 }])).toBe(0);
  });

  it("is zero when no time passed, rather than infinite", () => {
    expect(releaseSpeed([{ x: 0, t: 5 }, { x: 40, t: 5 }])).toBe(0);
  });

  it("measures px/ms over the samples", () => {
    expect(releaseSpeed([{ x: 0, t: 0 }, { x: 30, t: 50 }])).toBeCloseTo(0.6);
  });

  it("is signed, so a reversal reads as movement the other way", () => {
    expect(releaseSpeed([{ x: 100, t: 0 }, { x: 40, t: 40 }])).toBeCloseTo(-1.5);
  });

  it("ignores samples older than the window, so a pause doesn't damp a flick", () => {
    // Still for 400ms, then 40px in the last 20ms: that's a flick, and
    // averaging over the whole gesture would have hidden it.
    const samples = [
      { x: 0, t: 0 },
      { x: 0, t: 200 },
      { x: 0, t: 400 },
      { x: 20, t: 410 },
      { x: 40, t: 420 },
    ];
    expect(releaseSpeed(samples)).toBeCloseTo(2);
  });
});
