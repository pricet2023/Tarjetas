import { describe, expect, it } from "vitest";

import { type LogProbs, type PhoneSpan, type TargetUnit } from "@/app/lib/align/ctc";

import { g2p } from "./g2p";
import { scorePhones, scoreUtterance, summarise, type NativeStats, type PhoneStat } from "./gop";

/**
 * A stand-in vocabulary of *real* model labels — `gop.ts` reads
 * `inventory.ts`'s table, so `β` really has to be the soft /b/ and `ɹ` really
 * has to be a label that belongs to no unit of ours.
 *
 * The matrices are hand-built, as in `ctc.test.ts`: an assertion here is about
 * the scoring and nothing else.
 */
const VOCAB = ["<pad>", "p", "e", "r", "ɾ", "o", "a", "s", "k", "b", "β", "ɹ", "w", "u", "i", "j", "l", "x"];
const BLANK = 0;

const at = (label: string): number => {
  const i = VOCAB.indexOf(label);
  if (i < 0) throw new Error(`Test vocabulary has no "${label}".`);
  return i;
};

/** One frame, as unnormalised weights per label; everything unnamed keeps a floor. */
function frame(weights: Record<string, number>): number[] {
  const raw = VOCAB.map((label) => weights[label] ?? 0.001);
  const total = raw.reduce((a, b) => a + b, 0);
  return raw.map((w) => Math.log(w / total));
}

const posterior = (frames: Record<string, number>[]): LogProbs => ({
  data: frames.flatMap(frame),
  frames: frames.length,
  vocabSize: VOCAB.length,
});

const unit = (label: string, ...labels: string[]): TargetUnit => ({
  label,
  rows: (labels.length ? labels : [label]).map(at),
});

const span = (label: string, start: number, end: number): PhoneSpan => ({
  label,
  start,
  end,
  score: 0, // not read by the scorer; the aligner's own mean log P
});

const stat = (over: Partial<PhoneStat> = {}): PhoneStat => ({ mean: -1, sd: 1, n: 100, p05: -3, ...over });
const options = (stats: NativeStats = {}, pooled: PhoneStat | null = null) => ({
  labels: VOCAB,
  blank: BLANK,
  stats,
  pooled,
});

describe("scorePhones", () => {
  it("scores a phone the model is sure about at about zero", () => {
    // GOP is a margin, not a probability: "nothing explained these frames
    // better than /r/ did" is 0 (§4.5).
    const logProbs = posterior([{ r: 0.9, "ɾ": 0.05 }]);
    const [score] = scorePhones(logProbs, [span("r", 0, 1)], [unit("r")], options());
    expect(score.gop).toBeCloseTo(Math.log(0.9 / 0.05), 1);
    expect(score.gop).toBeGreaterThan(2);
    expect(score.rival).toBe("ɾ");
  });

  it("names the rival that beat it", () => {
    // The tap for the trill: the diagnosis this project exists to give.
    const logProbs = posterior([{ "ɾ": 0.8, r: 0.05 }]);
    const [score] = scorePhones(logProbs, [span("r", 0, 1)], [unit("r")], options());
    expect(score.gop).toBeLessThan(-2);
    expect(score.rival).toBe("ɾ");
    expect(score.rivalLabel).toBe("ɾ");
  });

  it("excludes the blank from the rivals", () => {
    // §10.3's trap, and §13.3 measured it on real native speech: `<pad>` is
    // the argmax on 24 of 30 frames. A rival set containing it would measure
    // how peaky the frame is, not how the phone was said — this /r/ would come
    // back as a failure.
    const logProbs = posterior([{ "<pad>": 0.9, r: 0.08, "ɾ": 0.001 }]);
    const [score] = scorePhones(logProbs, [span("r", 0, 1)], [unit("r")], options());
    expect(score.rival).not.toBe(null);
    expect(score.rivalLabel).not.toBe("<pad>");
    expect(score.gop).toBeGreaterThan(0);
  });

  it("counts allophones as the phone, not as rivals to it", () => {
    // A native saying *haba* with a soft [β] has made no mistake (§4.1), so
    // P(/b/) is P(b) + P(β) — and β must not then also compete with itself.
    const logProbs = posterior([{ b: 0.45, "β": 0.45, p: 0.05 }]);
    const [score] = scorePhones(logProbs, [span("b", 0, 1)], [unit("b", "b", "β")], options());
    expect(score.gop).toBeCloseTo(Math.log(0.9 / 0.05), 1);
    expect(score.rival).toBe("p");
  });

  it("catches a sound that is not Spanish at all", () => {
    // A learner's English R decodes as `ɹ`, which is not one of our 24 units.
    // Restrict the rivals to Spanish and this scores *well*, because nothing
    // Spanish explained it either — so the rival set is the whole inventory.
    const logProbs = posterior([{ "ɹ": 0.85, r: 0.05, "ɾ": 0.02 }]);
    const [score] = scorePhones(logProbs, [span("r", 0, 1)], [unit("r")], options({ r: stat({ p05: -1 }) }));
    expect(score.rival).toBe(null);
    expect(score.rivalLabel).toBe("ɹ");
    expect(score.gop).toBeLessThan(-2);
    expect(score.verdict).toBe("off");
  });

  it("takes one rival for the whole span, not one per frame", () => {
    // Three frames, each losing to a different sound, must not produce a
    // diagnosis of "you said /ɾ/ then /l/ then /ɾ/" — the feedback has to be
    // sayable.
    const logProbs = posterior([
      { "ɾ": 0.6, r: 0.2, l: 0.1 },
      { l: 0.6, r: 0.2, "ɾ": 0.1 },
      { "ɾ": 0.6, r: 0.2, l: 0.1 },
    ]);
    const [score] = scorePhones(logProbs, [span("r", 0, 3)], [unit("r")], options());
    expect(score.rival).toBe("ɾ");
    expect(score.gop).toBeLessThan(0);
  });

  it("normalises by span length, so a long phone is not punished", () => {
    const one = posterior([{ r: 0.9, "ɾ": 0.05 }]);
    const four = posterior(Array.from({ length: 4 }, () => ({ r: 0.9, "ɾ": 0.05 })));
    const short = scorePhones(one, [span("r", 0, 1)], [unit("r")], options())[0];
    const long = scorePhones(four, [span("r", 0, 4)], [unit("r")], options())[0];
    expect(long.gop).toBeCloseTo(short.gop, 6);
  });

  it("scores against the composite rows the aligner actually used", () => {
    // `buildTarget` lets `eɪ` count as our /e/ when a /j/ follows (§12), and
    // scoring against a rebuilt target without it would mark a correct *seis*
    // wrong. The scorer is handed the aligner's own target for that reason.
    const vocab = [...VOCAB, "eɪ"];
    const logProbs = {
      data: [vocab.map((l) => Math.log((l === "eɪ" ? 0.9 : 0.001) / 1.02))].flat(),
      frames: 1,
      vocabSize: vocab.length,
    };
    const target: TargetUnit[] = [{ label: "e", rows: [vocab.indexOf("e"), vocab.indexOf("eɪ")] }];
    const [score] = scorePhones(logProbs, [span("e", 0, 1)], target, {
      labels: vocab,
      blank: BLANK,
      stats: {},
      pooled: null,
    });
    expect(score.gop).toBeGreaterThan(0);
  });

  it("refuses spans that did not come from this target", () => {
    expect(() =>
      scorePhones(posterior([{ r: 0.9 }]), [span("r", 0, 1)], [unit("r"), unit("o")], options()),
    ).toThrow(/spans for 2 target phones/);
  });
});

describe("calibration", () => {
  const logProbs = posterior([{ "ɾ": 0.5, r: 0.3 }]); // gop ≈ -0.51

  it("reports a z-score against the phone's own native distribution", () => {
    const [score] = scorePhones(
      logProbs,
      [span("r", 0, 1)],
      [unit("r")],
      options({ r: stat({ mean: -0.1, sd: 0.2, p05: -0.4 }) }),
    );
    expect(score.z).toBeCloseTo((score.gop - -0.1) / 0.2, 6);
    expect(score.calibrated).toBe(true);
  });

  it("cuts the verdict on the measured 5th percentile, not on the z", () => {
    // GOP is skewed, so `mean - 1.64σ` and the real 5% point disagree. This
    // phone is 2σ below the mean but inside what natives do.
    const generous = stat({ mean: -0.1, sd: 0.2, p05: -2 });
    const [inside] = scorePhones(logProbs, [span("r", 0, 1)], [unit("r")], options({ r: generous }));
    expect(inside.z).toBeLessThan(-1.64);
    expect(inside.verdict).toBe("good");

    const strict = stat({ mean: -0.1, sd: 5, p05: -0.4 });
    const [outside] = scorePhones(logProbs, [span("r", 0, 1)], [unit("r")], options({ r: strict }));
    expect(outside.z).toBeGreaterThan(-1.64);
    expect(outside.verdict).toBe("off");
  });

  it("falls back to the pooled distribution, and says that it did", () => {
    const [score] = scorePhones(
      logProbs,
      [span("r", 0, 1)],
      [unit("r")],
      options({}, stat({ mean: -0.2, sd: 0.5, p05: -0.4 })),
    );
    expect(score.calibrated).toBe(false);
    expect(score.z).not.toBeNull();
    expect(score.verdict).toBe("off");
  });

  it("says nothing at all when there is no calibration", () => {
    // An uncalibrated build must not invent a verdict out of a margin in nats
    // that nothing has made comparable.
    const [score] = scorePhones(logProbs, [span("r", 0, 1)], [unit("r")], options());
    expect(score.z).toBeNull();
    expect(score.verdict).toBe("good");
  });

  it("calls a glide heard as its own vowel close, not wrong", () => {
    // We emit /w/ for *muy* and the model answered `uː` (inventory.ts). The
    // tap/trill contrast is pointedly not on that list.
    const wu = posterior([{ u: 0.6, w: 0.2 }]);
    const [near] = scorePhones(wu, [span("w", 0, 1)], [unit("w")], options({ w: stat({ p05: -0.1 }) }));
    expect(near.rival).toBe("u");
    expect(near.verdict).toBe("close");

    const tap = posterior([{ "ɾ": 0.6, r: 0.2 }]);
    const [wrong] = scorePhones(tap, [span("r", 0, 1)], [unit("r")], options({ r: stat({ p05: -0.1 }) }));
    expect(wrong.verdict).toBe("off");
  });
});

describe("scoreUtterance", () => {
  it("runs G2P's phones through alignment and scoring in one call", () => {
    // *paso*: four clean frames, one per phone, with a blank between each —
    // the peaky shape §13.3 measured on real speech.
    const logProbs = posterior([
      { "<pad>": 0.9 },
      { p: 0.9 },
      { "<pad>": 0.9 },
      { a: 0.9 },
      { "<pad>": 0.9 },
      { s: 0.9 },
      { "<pad>": 0.9 },
      { o: 0.9 },
      { "<pad>": 0.9 },
    ]);
    const scores = scoreUtterance(logProbs, g2p("paso").phones, options({}, stat()));
    expect(scores.map((s) => s.phone)).toEqual(["p", "a", "s", "o"]);
    expect(scores.every((s) => s.verdict === "good")).toBe(true);
    expect(scores.every((s) => s.gop > 0)).toBe(true);
  });

  it("finds the one bad phone in a good word", () => {
    // The credit assignment §4.7 needs: three phones fine, one replaced.
    const logProbs = posterior([
      { p: 0.9 },
      { "<pad>": 0.9 },
      { e: 0.9 },
      { "<pad>": 0.9 },
      { "ɾ": 0.85, r: 0.02 },
      { "<pad>": 0.9 },
      { o: 0.9 },
    ]);
    const scores = scoreUtterance(logProbs, g2p("perro").phones, options({ r: stat({ p05: -0.5 }) }));
    const bad = scores.filter((s) => s.verdict !== "good");
    expect(bad).toHaveLength(1);
    expect(bad[0].phone).toBe("r");
    expect(bad[0].rival).toBe("ɾ");
  });
});

describe("summarise", () => {
  const score = (phone: string, verdict: "good" | "close" | "off", z: number) =>
    ({ phone, start: 0, end: 1, gop: z, rival: null, rivalLabel: "", z, calibrated: true, verdict }) as const;

  it("is a share of phones, not a mean of z-scores", () => {
    // One catastrophic /x/ should not be averaged away by nine easy vowels.
    const scores = [score("a", "good", 0), score("x", "off", -9), score("w", "close", -2)];
    expect(summarise(scores).score).toBeCloseTo((1 + 0 + 0.5) / 3, 6);
  });

  it("points at the worst phone", () => {
    const scores = [score("a", "good", -0.2), score("x", "off", -4), score("r", "off", -2)];
    expect(summarise(scores).worst?.phone).toBe("x");
  });

  it("has an answer for an empty attempt", () => {
    expect(summarise([])).toEqual({ score: 0, worst: null });
  });
});
