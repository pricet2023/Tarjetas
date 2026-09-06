import { describe, expect, it } from "vitest";

import { forcedAlign, logSoftmax, type LogProbs, type PhoneSpan, type TargetUnit } from "./ctc";

/**
 * A stand-in vocabulary. Real alignment reads the model's `vocab.json`; here
 * the point is that the matrix is *hand-built*, so an assertion about spans is
 * an assertion about the algorithm and nothing else (plan §Phase 2).
 */
const VOCAB = ["∅", "k", "a", "s", "e", "o", "p", "r", "ɾ", "n", "b", "β", "l", "t", "i", "g"];
const BLANK = 0;

const at = (label: string): number => {
  const i = VOCAB.indexOf(label);
  if (i < 0) throw new Error(`Test vocabulary has no "${label}".`);
  return i;
};

/** One target phone per label, no allophones — the plain case. */
const targetOf = (labels: string): TargetUnit[] =>
  labels.split(" ").map((label) => ({ label, rows: [at(label)] }));

type Frame = string | Record<string, number>;

/**
 * Build a posterior matrix a frame at a time.
 *
 * A frame given as a label name puts ~0.9 on it and spreads the rest; a frame
 * given as weights sets them explicitly (unnormalised, anything unnamed keeps
 * the floor). So `["∅", "k", "k", "a"]` reads as "silence, two frames of k,
 * one of a" and that is exactly what the aligner should recover.
 */
function posterior(frames: readonly Frame[], vocab: readonly string[] = VOCAB): LogProbs {
  const V = vocab.length;
  const data = new Float32Array(frames.length * V);
  frames.forEach((frame, t) => {
    const named: Record<string, number> = typeof frame === "string" ? { [frame]: 99 } : frame;
    for (const label of Object.keys(named)) {
      if (!vocab.includes(label)) throw new Error(`Test vocabulary has no "${label}".`);
    }
    const weights = vocab.map((label) => named[label] ?? 1);
    const total = weights.reduce((a, b) => a + b, 0);
    weights.forEach((w, v) => {
      data[t * V + v] = Math.log(w / total);
    });
  });
  return { data, frames: frames.length, vocabSize: V };
}

/** `k[1,3) a[3,6)` — compact enough to assert on in one line. */
const shape = (spans: PhoneSpan[]): string =>
  spans.map((s) => `${s.label}[${s.start},${s.end})`).join(" ");

const align = (frames: readonly Frame[], labels: string): PhoneSpan[] =>
  forcedAlign(posterior(frames), targetOf(labels), { blank: BLANK });

describe("forcedAlign", () => {
  it("recovers the frames of each phone", () => {
    // The worked example from §4.4, and the decode the real model gave for
    // *casa* in §10.3.
    const spans = align(["∅", "k", "k", "a", "a", "a", "s", "s", "a", "a", "∅"], "k a s a");
    expect(shape(spans)).toBe("k[1,3) a[3,6) s[6,8) a[8,10)");
  });

  it("leaves blank frames out of every span", () => {
    // Frames 0 and 10 above are silence. They belong to no phone, so spans do
    // not tile the recording — Phase 5 must not assume they do.
    const spans = align(["∅", "k", "a", "∅", "s", "a", "∅"], "k a s a");
    expect(shape(spans)).toBe("k[1,2) a[2,3) s[4,5) a[5,6)");
  });

  it("does not assume phones are the same length", () => {
    // A held vowel against a short stop. Duration comes free with alignment
    // and is independent evidence (§4.5) — a correct vowel held 400 ms is
    // still wrong.
    const spans = align(["k", "a", "a", "a", "a", "a", "s", "∅", "a"], "k a s a");
    expect(shape(spans)).toBe("k[0,1) a[1,6) s[6,7) a[8,9)");
    expect(spans[1].end - spans[1].start).toBe(5);
  });

  it("orders spans by the target, never overlapping", () => {
    const spans = align(
      ["∅", "g", "i", "i", "t", "a", "a", "r", "r", "a", "∅"],
      "g i t a r a",
    );
    expect(spans.map((s) => s.label)).toEqual(["g", "i", "t", "a", "r", "a"]);
    for (let i = 1; i < spans.length; i += 1) {
      expect(spans[i].start).toBeGreaterThanOrEqual(spans[i - 1].end);
      expect(spans[i].end).toBeGreaterThan(spans[i].start);
    }
  });

  describe("the score", () => {
    it("is the mean log-probability over the span's frames", () => {
      const spans = align([{ a: 1 }, { a: 3 }], "a");
      expect(spans[0].start).toBe(0);
      expect(spans[0].end).toBe(2);
      // Floor weight 1 on 16 labels: flat 1/16, then 3 against 15 floors.
      const expected = (Math.log(1 / 16) + Math.log(3 / 18)) / 2;
      expect(spans[0].score).toBeCloseTo(expected, 5);
    });

    it("is high where the model agreed and low where it did not", () => {
      const [good] = align(["a"], "a");
      const [bad] = align(["s"], "a");
      expect(good.score).toBeGreaterThan(Math.log(0.5));
      expect(bad.score).toBeLessThan(Math.log(0.05));
    });
  });

  describe("adjacent repeated phones", () => {
    // The rule that silently mis-aligns every word with a doubled sound if you
    // get it wrong (§4.4): the blank between two identical labels may not be
    // skipped, because it is the only thing that keeps them from collapsing
    // into one.
    it("keeps them apart when a blank frame separates them", () => {
      const spans = align(["n", "n", "∅", "n", "n"], "n n");
      expect(shape(spans)).toBe("n[0,2) n[3,5)");
    });

    it("spends a frame on the blank even when the model never emitted one", () => {
      // Three confident frames of n, two target phones. The path cannot merge
      // them, so the middle frame goes to the blank state and belongs to
      // neither span. Merging would give a single n[0,3) — that is the bug.
      const spans = align(["n", "n", "n"], "n n");
      expect(shape(spans)).toBe("n[0,1) n[2,3)");
    });

    it("needs the extra frame the blank costs", () => {
      expect(() => align(["n", "n"], "n n")).toThrow(/at least 3/);
    });

    it("still skips the blank between two different phones", () => {
      // Same frame count, but /n l/ is expressible without a blank.
      expect(shape(align(["n", "l"], "n l"))).toBe("n[0,1) l[1,2)");
    });
  });

  it("folds a doubled model peak back into one span when the dip has evidence in it", () => {
    // Measured in §11: *perro* is `p e r o` to us but `p e r r o` to the
    // model — one trill arriving as two CTC peaks with a blank between them,
    // because the model is peaky (§4.4), not because there are two phones.
    // With a single /r/ in the target the path can only hold one span, and it
    // stretches across both peaks *provided* the dip between them keeps real
    // /r/ mass, as here.
    //
    // On the real clip it does not — §13 measured the dip at `<pad>:-0.04`
    // against `r:-3.41`, so the aligner takes the sharper peak and leaves the
    // other in the blank state. Both behaviours are this same rule; which one
    // you get is decided by the posterior, not by the code.
    const spans = align(["p", "e", "r", { "∅": 60, r: 30 }, "r", "o"], "p e r o");
    expect(shape(spans)).toBe("p[0,1) e[1,2) r[2,5) o[5,6)");
    // The dip is real and shows up in the raw mean, which is why Phase 5
    // thresholds the margin over the best *non-blank* rival instead (§10.3).
    expect(spans[2].score).toBeLessThan(spans[0].score);
  });

  it("sums the labels of one scored unit, so allophones do not cost anything", () => {
    // *haba*: the model confidently says `β` where we asked for /b/. Scoring
    // the soft form apart would penalise correct native Spanish (§4.1), so the
    // unit's rows are summed.
    const frames: Frame[] = ["a", "β", "β", "a"];
    const collapsed: TargetUnit[] = [
      { label: "a", rows: [at("a")] },
      { label: "b", rows: [at("b"), at("β")] },
      { label: "a", rows: [at("a")] },
    ];
    const strict: TargetUnit[] = collapsed.map((u) =>
      u.label === "b" ? { label: "b", rows: [at("b")] } : u,
    );

    const [, softB] = forcedAlign(posterior(frames), collapsed, { blank: BLANK });
    const [, hardB] = forcedAlign(posterior(frames), strict, { blank: BLANK });

    expect(shape([softB])).toBe("b[1,3)");
    expect(softB.score).toBeGreaterThan(Math.log(0.5));
    expect(hardB.score).toBeLessThan(Math.log(0.05));
  });

  describe("degenerate input", () => {
    it("still returns one span per phone when every frame is blank", () => {
      // Silence, or a recording the endpoint trim mangled. There is no
      // alignment worth having, but the target must still come back whole and
      // in order, with scores bad enough for Phase 5 to reject.
      const spans = align(["∅", "∅", "∅", "∅", "∅", "∅"], "k a");
      expect(spans.map((s) => s.label)).toEqual(["k", "a"]);
      for (const span of spans) {
        expect(span.end - span.start).toBe(1);
        expect(span.score).toBeLessThan(Math.log(0.05));
      }
      expect(spans[0].end).toBeLessThanOrEqual(spans[1].start);
    });

    it("aligns a one-frame recording to a one-phone target", () => {
      expect(shape(align(["k"], "k"))).toBe("k[0,1)");
    });
  });

  describe("refuses to guess", () => {
    it("when the target is longer than the recording", () => {
      // Fail loudly: a target squeezed into too few frames would come back
      // mis-aligned and read as the learner's mistake.
      expect(() => align(["k", "a", "s"], "k a s a")).toThrow(/at least 4/);
    });

    it("when there are no frames", () => {
      expect(() =>
        forcedAlign({ data: [], frames: 0, vocabSize: 16 }, targetOf("k"), { blank: BLANK }),
      ).toThrow(/no.*frames|0 frames/);
    });

    it("when the matrix is not frames × labels", () => {
      expect(() =>
        forcedAlign({ data: new Float32Array(30), frames: 3, vocabSize: 16 }, targetOf("k"), {
          blank: BLANK,
        }),
      ).toThrow(/48/);
    });

    it("when the target is empty", () => {
      expect(() => forcedAlign(posterior(["k"]), [], { blank: BLANK })).toThrow(/no phones/);
    });

    it("when a phone has no model label — the ɡ codepoint trap", () => {
      expect(() =>
        forcedAlign(posterior(["k"]), [{ label: "g", rows: [] }], { blank: BLANK }),
      ).toThrow(/no model labels/);
    });

    it("when a row is outside the vocabulary", () => {
      expect(() =>
        forcedAlign(posterior(["k"]), [{ label: "k", rows: [99] }], { blank: BLANK }),
      ).toThrow(/outside a 16-label vocabulary/);
    });

    it("when a phone counts the blank as itself", () => {
      // Would match every silent frame and quietly inflate the score.
      expect(() =>
        forcedAlign(posterior(["k"]), [{ label: "k", rows: [at("k"), BLANK] }], { blank: BLANK }),
      ).toThrow(/counts the blank/);
    });

    it("when the blank index is not a label", () => {
      // 0 here, 37 in the fallback model of §10.4 — model-specific, and a
      // silent failure if wrong, so it is never defaulted.
      expect(() => forcedAlign(posterior(["k"]), targetOf("k"), { blank: 16 })).toThrow(
        /not a label/,
      );
    });
  });
});

describe("logSoftmax", () => {
  it("normalises each frame", () => {
    const out = logSoftmax([1, 2, 3, 0, 0, 0], 2, 3);
    for (let t = 0; t < 2; t += 1) {
      let sum = 0;
      for (let v = 0; v < 3; v += 1) sum += Math.exp(out.data[t * 3 + v]);
      expect(sum).toBeCloseTo(1, 6);
    }
  });

  it("survives logits large enough to overflow exp", () => {
    const out = logSoftmax([1000, 999, -1000], 1, 3);
    expect(out.data[0]).toBeCloseTo(-Math.log(1 + Math.exp(-1)), 6);
    expect(Number.isFinite(out.data[2])).toBe(true);
  });

  it("does not move the alignment it feeds", () => {
    // A per-frame constant shifts every state in a column equally, so it
    // cannot change which path wins. Normalising is for the *scores*.
    const logits = [3, 0, 0, 0, 3, 0, 0, 0, 3];
    const shifted = logits.map((x, i) => x + [10, -7, 4][Math.floor(i / 3)]);
    const target: TargetUnit[] = [
      { label: "b", rows: [1] },
      { label: "c", rows: [2] },
    ];
    const one = forcedAlign(logSoftmax(logits, 3, 3), target, { blank: 0 });
    const other = forcedAlign(logSoftmax(shifted, 3, 3), target, { blank: 0 });
    expect(shape(other)).toBe(shape(one));
  });

  it("refuses a length that is not frames × labels", () => {
    expect(() => logSoftmax([1, 2, 3], 2, 3)).toThrow(/needs 6/);
  });
});
