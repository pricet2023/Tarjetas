// @vitest-environment node
/**
 * The Phase 5 claim, on real speech: a native trill scores like a native
 * trill, and the same audio scored as if a tap had been asked for does not.
 *
 * §13.3 measured 4.7 nats between /r/ and /ɾ/ on the same frame of this clip,
 * and this is that measurement turned into an assertion — through the app's
 * own G2P, aligner, GOP and generated native statistics, rather than a
 * scratchpad. Node, because there is no `Worker` or `AudioContext` here; the
 * weights come from `npm run model:fetch` and the test skips without them, so
 * `npm test` stays a 6-second run for everyone else.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readFixtureWav } from "@/app/lib/acoustic/fixtures/read";
import { ACOUSTIC_SOURCE } from "@/app/lib/acoustic/protocol";
import { openSession, type AcousticSession } from "@/app/lib/acoustic/session";
import { type LogProbs } from "@/app/lib/align/ctc";

import { g2p } from "./g2p";
import { scorePhones, scoreUtterance, summarise } from "./gop";
import { buildTarget } from "@/app/lib/align/target";
import { forcedAlign } from "@/app/lib/align/ctc";
import { NATIVE_GOP, NATIVE_STATS_META } from "./native-stats.generated";

const modelDir =
  process.env.FLASHCARDS_ACOUSTIC_MODEL_DIR ??
  resolve(process.cwd(), ".models", ACOUSTIC_SOURCE.id);
const weights = resolve(modelDir, "model.onnx");
const vocabPath = resolve(modelDir, "vocab.json");
const available = existsSync(weights) && existsSync(vocabPath);

const SLOW = 120_000;

describe.skipIf(!available)("GOP on real speech (needs `npm run model:fetch`)", () => {
  let session: AcousticSession;
  let logProbs: LogProbs;
  /** The native *perro* of §13.3, 0.61 s at 16 kHz. See fixtures/NOTICE.md. */
  const clip = readFixtureWav("es-perro.wav");

  beforeAll(async () => {
    session = await openSession({
      weights: readFileSync(weights),
      vocab: JSON.parse(readFileSync(vocabPath, "utf8")),
      padToken: ACOUSTIC_SOURCE.padToken,
      sampleRate: ACOUSTIC_SOURCE.sampleRate,
    });
    logProbs = await session.infer(clip.samples, clip.sampleRate);
  }, SLOW);

  afterAll(async () => {
    await session?.release();
  });

  const score = (word: string) =>
    scoreUtterance(logProbs, g2p(word).phones, { labels: session.labels, blank: session.blank });

  it("passes a native speaker on every phone", () => {
    const scores = score("perro");
    expect(scores.map((s) => s.phone)).toEqual(["p", "e", "r", "o"]);
    expect(scores.map((s) => s.verdict)).toEqual(["good", "good", "good", "good"]);
    // Positive, because the target is not in its own rival set — the
    // deviation from Witt & Young documented at the top of gop.ts.
    expect(scores.every((s) => s.gop > 0)).toBe(true);
    expect(summarise(scores).score).toBe(1);
  });

  it("fails the same audio when a tap was asked for", () => {
    // *pero* against a recording of *perro*: one phone different, and it is
    // the phone this whole project exists for.
    const scores = score("pero");
    const tap = scores.find((s) => s.phone === "ɾ")!;
    expect(tap.verdict).toBe("off");
    expect(tap.rival).toBe("r");
    expect(summarise(scores).worst?.phone).toBe("ɾ");
    // The other three phones are the same audio and still fine, so the
    // credit assignment §4.7 needs is real: one phone is blamed, not the word.
    expect(scores.filter((s) => s.verdict === "good")).toHaveLength(3);
  });

  it("separates the trill from the tap by nats, not by rounding", () => {
    const trill = score("perro").find((s) => s.phone === "r")!;
    const tap = score("pero").find((s) => s.phone === "ɾ")!;
    // §13.3 measured 4.7 nats between the two on this frame.
    expect(trill.gop - tap.gop).toBeGreaterThan(3);
    expect(trill.z! - tap.z!).toBeGreaterThan(3);
  });

  it("is calibrated against native speech for every phone in the fixture", () => {
    // A phone falling back to the pooled distribution is a gap in the corpus,
    // not a bug — but not for phones this common.
    expect(score("perro").every((s) => s.calibrated)).toBe(true);
    expect(NATIVE_STATS_META.model).toBe(ACOUSTIC_SOURCE.id);
    expect(NATIVE_STATS_META.clips).toBeGreaterThan(100);
  });

  it("scores the aligner's own target, composites included", () => {
    // `scorePhones` is handed the target `forcedAlign` used, not a rebuilt
    // one; passing a different target is the mistake it refuses (§12).
    const phones = g2p("perro").phones;
    const target = buildTarget(phones, session.labels);
    const spans = forcedAlign(logProbs, target, { blank: session.blank });
    const direct = scorePhones(logProbs, spans, target, {
      labels: session.labels,
      blank: session.blank,
    });
    expect(direct.map((s) => s.gop)).toEqual(score("perro").map((s) => s.gop));
  });

  it("keeps the native distribution honest about its own spread", () => {
    // Every phone the corpus covered has a real σ and a percentile below its
    // mean; a zero σ would make every z-score infinite.
    for (const [phone, stat] of Object.entries(NATIVE_GOP)) {
      expect(stat.sd, phone).toBeGreaterThan(0);
      expect(stat.p05, phone).toBeLessThan(stat.mean);
      expect(stat.n, phone).toBeGreaterThanOrEqual(30);
    }
  });
});
