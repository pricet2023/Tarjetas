// @vitest-environment node
/**
 * The first end-to-end proof: real native speech, the real quantized model,
 * and the Phase 1 + Phase 2 pipeline in between (plan §Phase 3).
 *
 * Node, not `jsdom`, because there is no `Worker` and no `AudioContext` here —
 * which is exactly why `session.ts` holds the inference and `worker.ts` holds
 * only the plumbing. What this test cannot cover is that plumbing: the Cache
 * API and `postMessage` are browser-only, and `model.test.ts` covers them
 * against a fake port.
 *
 * Skipped unless the weights are on disk (`npm run model:fetch`) — 197 MB is
 * not a test dependency. Everything else in `npm test` runs without it.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { forcedAlign, type PhoneSpan } from "@/app/lib/align/ctc";
import { buildTarget } from "@/app/lib/align/target";
import { g2p } from "@/app/lib/phonology/g2p";

import { readFixtureWav } from "./fixtures/read";
import { ACOUSTIC_SOURCE } from "./protocol";
import { openSession, type AcousticSession } from "./session";

const modelDir =
  process.env.FLASHCARDS_ACOUSTIC_MODEL_DIR ??
  resolve(process.cwd(), ".models", ACOUSTIC_SOURCE.id);
const weights = resolve(modelDir, "model.onnx");
const vocabPath = resolve(modelDir, "vocab.json");
const available = existsSync(weights) && existsSync(vocabPath);

const SLOW = 120_000;

describe.skipIf(!available)("the real acoustic model (needs `npm run model:fetch`)", () => {
  let session: AcousticSession;
  /** The native *perro* recording: 0.61 s, 16 kHz mono. See fixtures/NOTICE.md. */
  const clip = readFixtureWav("es-perro.wav");

  beforeAll(async () => {
    session = await openSession({
      // Bytes rather than a path — see `SessionSpec.weights`.
      weights: readFileSync(weights),
      vocab: JSON.parse(readFileSync(vocabPath, "utf8")),
      padToken: ACOUSTIC_SOURCE.padToken,
      sampleRate: ACOUSTIC_SOURCE.sampleRate,
    });
  }, SLOW);

  afterAll(async () => {
    await session?.release();
  });

  const greedy = (logProbs: { data: ArrayLike<number>; frames: number; vocabSize: number }): string[] =>
    Array.from({ length: logProbs.frames }, (_, t) => {
      let best = 0;
      for (let v = 1; v < logProbs.vocabSize; v += 1) {
        if (logProbs.data[t * logProbs.vocabSize + v] > logProbs.data[t * logProbs.vocabSize + best]) best = v;
      }
      return session.labels[best];
    });

  /** CTC collapse: drop repeats, then drop blanks (§4.4). */
  const collapse = (frames: string[]): string[] =>
    frames.filter((label, i) => i === 0 || label !== frames[i - 1]).filter((l) => l !== "<pad>");

  it("reads its label inventory from the model, blank included", () => {
    expect(session.labels).toHaveLength(392);
    expect(session.blank).toBe(0);
    expect(session.labels[session.blank]).toBe("<pad>");
    // The trap in §10.2, now a fact rather than a warning: the model's /g/ is
    // IPA ɡ (U+0261) and there is no ASCII "g" label at all, so a lookup on
    // the wrong codepoint would silently never match.
    expect(session.labels).toContain("ɡ");
    expect(session.labels).not.toContain("g");
    // Every unit the Phase 1 inventory scores is present (§10.2 verified this
    // from the label dump; this verifies it from the loaded model).
    for (const label of ["a", "e", "i", "o", "u", "p", "b", "t", "d", "k", "tʃ", "f", "s", "x", "m", "n", "ɲ", "l", "ɾ", "r", "ʝ", "j", "w"]) {
      expect(session.labels).toContain(label);
    }
  });

  it("turns 0.61 s of speech into a normalised posterior matrix at 50 fps", async () => {
    const logProbs = await session.infer(clip.samples, clip.sampleRate);

    // §4.3's assumption, measured: 20 ms per frame.
    expect(logProbs.frames).toBe(30);
    expect(logProbs.vocabSize).toBe(392);
    const fps = logProbs.frames / (clip.samples.length / clip.sampleRate);
    expect(fps).toBeGreaterThan(45);
    expect(fps).toBeLessThan(52);

    // Log-probabilities, not logits — Phase 5 subtracts these to get a margin.
    for (const t of [0, 15, 29]) {
      let total = 0;
      for (let v = 0; v < logProbs.vocabSize; v += 1) total += Math.exp(logProbs.data[t * 392 + v]);
      expect(total).toBeCloseTo(1, 4);
    }
  }, SLOW);

  it("decodes the fixture the way the Phase 0b spike did", async () => {
    // The §10.3 control, reproduced through the app's own code path rather
    // than a Python scratchpad: a native *perro* is `p e r r o`, with the
    // trill arriving as two peaks.
    const logProbs = await session.infer(clip.samples, clip.sampleRate);
    expect(collapse(greedy(logProbs)).join(" ")).toBe("p e r r o");
  }, SLOW);

  describe("through Phase 1 and Phase 2", () => {
    let spans: PhoneSpan[];
    let frameLabels: string[];

    beforeAll(async () => {
      const logProbs = await session.infer(clip.samples, clip.sampleRate);
      frameLabels = greedy(logProbs);
      spans = forcedAlign(
        logProbs,
        buildTarget(g2p("perro").phones, session.labels),
        { blank: session.blank },
      );
    }, SLOW);

    it("puts the phones in the right order, inside the recording", () => {
      expect(spans.map((s) => s.label)).toEqual(["p", "e", "r", "o"]);
      for (let i = 0; i < spans.length; i += 1) {
        expect(spans[i].start).toBeGreaterThanOrEqual(i === 0 ? 0 : spans[i - 1].end);
        expect(spans[i].end).toBeGreaterThan(spans[i].start);
        expect(spans[i].end).toBeLessThanOrEqual(30);
      }
    });

    it("lands each boundary where the model actually heard that phone", () => {
      // The real assertion of §Phase 3: not "it ran" but "the frames it chose
      // are the frames". Every span's own frames must contain at least one
      // frame the unrestricted model also called that phone — /r/ counting
      // its two peaks, and the vowels their own labels.
      for (const span of spans) {
        const inside = frameLabels.slice(span.start, span.end);
        const matches = inside.filter((label) => label === span.label || label === `${span.label}ː`);
        expect(matches.length, `${span.label} got ${inside.join(",")}`).toBeGreaterThan(0);
      }
    });

    it("puts the trill on one of its two peaks, not across both", () => {
      // Phase 2 showed the aligner *can* hold one span across a doubled peak,
      // and §12 claimed real audio would do it. Measured here, it does not:
      // the two `r` peaks (frames 12 and 18) are separated by frames where
      // the blank sits at -0.04 and /r/ at -3.41, so the cheapest legal path
      // takes the sharper peak and spends the rest in the blank state. See
      // §13 — this is the correction to §12, and it is why duration cannot be
      // read off this alignment.
      const r = spans[2];
      const peaks = frameLabels.flatMap((label, t) => (label === "r" ? [t] : []));
      expect(peaks.length).toBeGreaterThanOrEqual(2);
      expect(peaks).toContain(r.start);
      expect(r.end - r.start).toBe(1);
    });

    it("gives every phone exactly one frame, which is the model being peaky", () => {
      // Not a quirk of this clip: the blank is the argmax on 24 of 30 frames
      // and scores ~0 on most of them, so any frame handed to a phone costs
      // 8-10 nats. Max-likelihood Viterbi therefore keeps one frame per phone
      // (§4.4's peakiness, at full strength).
      //
      // The consequence is a real constraint on Phase 5, not a curiosity:
      // §4.5's "duration comes free with alignment" does not survive this
      // model. Every phone is 20 ms long here, whatever was said.
      const blankFrames = frameLabels.filter((label) => label === "<pad>").length;
      expect(blankFrames).toBeGreaterThan(frameLabels.length * 0.6);
      for (const span of spans) {
        expect(span.end - span.start, `${span.label} spanned more than a frame`).toBe(1);
      }
    });

    it("scores the phones that are there well", () => {
      // Native speech scored against the right target: nothing should look
      // like a mistake. Mean log P above ln(0.2) per frame.
      for (const span of spans) {
        expect(span.score, `${span.label} scored ${span.score.toFixed(2)}`).toBeGreaterThan(
          Math.log(0.2),
        );
      }
    });
  });

  it("hears the trill and not the tap — the whole point of the feature", async () => {
    // *pero* /ˈpe.ɾo/ and *perro* /ˈpe.ro/ differ by exactly one phone. Align
    // both targets to the same native *perro* recording: the trill must score
    // better than the tap, or none of the feedback this project promises is
    // possible (§10.3 saw the contrast in the decode; this checks it survives
    // alignment and scoring).
    const logProbs = await session.infer(clip.samples, clip.sampleRate);
    const align = (word: string): PhoneSpan[] =>
      forcedAlign(logProbs, buildTarget(g2p(word).phones, session.labels), {
        blank: session.blank,
      });

    const trill = align("perro")[2];
    const tap = align("pero")[2];

    expect(trill.label).toBe("r");
    expect(tap.label).toBe("ɾ");
    expect(trill.score).toBeGreaterThan(tap.score + 1);
  }, SLOW);

  it("scores a word that was not said far worse than the one that was", async () => {
    const logProbs = await session.infer(clip.samples, clip.sampleRate);
    const mean = (word: string): number => {
      const spans = forcedAlign(logProbs, buildTarget(g2p(word).phones, session.labels), {
        blank: session.blank,
      });
      return spans.reduce((total, s) => total + s.score, 0) / spans.length;
    };
    expect(mean("perro")).toBeGreaterThan(mean("casa") + 2);
  }, SLOW);

  it("refuses audio at the wrong rate rather than scoring it", async () => {
    // A 44.1 kHz buffer would be scored as if it were 16 kHz — three times
    // too fast, and every phone wrong with no error anywhere.
    await expect(session.infer(clip.samples, 44100)).rejects.toThrow(/16000 Hz mono/);
  });

  it("refuses audio too short for a single frame", async () => {
    await expect(session.infer(clip.samples.slice(0, 399), 16000)).rejects.toThrow(
      /at least 400 samples/,
    );
  });
});
