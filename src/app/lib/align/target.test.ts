import { describe, expect, it } from "vitest";

import { g2p } from "@/app/lib/phonology/g2p";

import { forcedAlign, type LogProbs } from "./ctc";
import { buildTarget } from "./target";

/**
 * A stand-in for the model's `vocab.json` — the labels these tests care about,
 * in an arbitrary order, with the blank first as `wav2vec2-xlsr-53-espeak-cv-ft`
 * has it. The real list is 392 long and mostly irrelevant here.
 */
const VOCAB = [
  "<pad>",
  "k", "a", "s", "e", "i", "o", "u", "p", "t", "d", "m", "n", "l",
  "r", "ɾ", "x", "ɡ", "j", "w", "b",
  // the allophones and dialect variants the inventory re-admits
  "β", "v", "ð", "ɣ", "θ", "ʎ", "ʝ", "ŋ", "aː", "eː", "ɛ",
  // one composite label
  "eɪ",
];

const rowsFor = (label: string, word: string, vocab = VOCAB): string[] => {
  const unit = buildTarget(g2p(word).phones, vocab).find((u) => u.label === label);
  if (!unit) throw new Error(`No /${label}/ in "${word}".`);
  return unit.rows.map((r) => vocab[r]);
};

describe("buildTarget", () => {
  it("turns a word's phones into one unit each, in order", () => {
    const target = buildTarget(g2p("casa").phones, VOCAB);
    expect(target.map((u) => u.label)).toEqual(["k", "a", "s", "a"]);
    // Rows are the model's labels, not ours: /s/ also answers to θ, and /a/
    // to the long `aː`. (`ä` is in the real vocabulary but not this one.)
    expect(target.map((u) => u.rows.map((r) => VOCAB[r]).join(" "))).toEqual([
      "k",
      "a aː",
      "s θ",
      "a aː",
    ]);
  });

  it("collapses allophones into the unit they belong to", () => {
    // The soft intervocalic forms. Without these a native saying *haba* with
    // a [β] scores as an error (§4.1, §10.2).
    expect(rowsFor("b", "haba")).toEqual(["b", "β", "v"]);
    expect(rowsFor("d", "nada")).toEqual(["d", "ð"]);
    expect(rowsFor("g", "hago")).toEqual(["ɡ", "ɣ"]);
    expect(rowsFor("n", "banco")).toEqual(["n", "ŋ"]);
  });

  it("accepts the Peninsular variants of the sounds we chose against", () => {
    // We emit seseo and yeísmo, but θ in *cielo* and ʎ in *llave* are dialect,
    // not error (plan §8, decision 6).
    expect(rowsFor("s", "cielo")).toContain("θ");
    expect(rowsFor("ʝ", "llave")).toContain("ʎ");
  });

  it("accepts vowel length and lax quality, which Spanish does not contrast", () => {
    // The espeak label set is multilingual; the model gave `iː` for the /e/ of
    // *pero* (§10.3).
    expect(rowsFor("e", "peso")).toEqual(["e", "eː", "ɛ"]);
  });

  it("ignores labels this model does not have", () => {
    const narrow = VOCAB.filter((l) => l !== "β" && l !== "v");
    expect(rowsFor("b", "haba", narrow)).toEqual(["b"]);
  });

  it("lets a falling diphthong's composite label count for both its units", () => {
    // *seis* comes back as `s eɪ s` — one label spanning two of our units, so
    // both accept it and share the frames it owns rather than one of them
    // asking for a label the model never emitted (see `inventory.ts`).
    const target = buildTarget(g2p("seis").phones, VOCAB);
    expect(target.map((u) => u.label)).toEqual(["s", "e", "j", "s"]);
    expect(target[1].rows.map((r) => VOCAB[r])).toContain("eɪ");
    expect(target[2].rows.map((r) => VOCAB[r])).toContain("eɪ");
  });

  it("only counts a composite label in the context it is composite of", () => {
    // An `eɪ` frame in *peso* is a genuine miss: there is no glide to explain
    // it. Same label, different verdict, which is why this is contextual.
    expect(rowsFor("e", "peso")).not.toContain("eɪ");
  });

  it("refuses a phone the model cannot emit", () => {
    // The trap: IPA ɡ is U+0261 and the ASCII g we type is not the same label.
    // A vocabulary carrying only the ASCII one must fail here rather than
    // align /g/ against nothing.
    const wrong = VOCAB.map((l) => (l === "ɡ" ? "g" : l)).filter((l) => l !== "ɣ");
    expect(() => buildTarget(g2p("hago").phones, wrong)).toThrow(/can't emit \/g\//);
    expect(() => buildTarget(g2p("hago").phones, wrong)).toThrow(/U\+0261/);
  });
});

describe("G2P through to alignment", () => {
  // No model and no audio: the posterior matrix is the decode §10.3 measured
  // for the native *perro* recording, written out by hand. The trill arrives
  // as two peaks with a blank-dominated dip between them — and that dip still
  // holds real /r/, which is what keeps the two peaks in one span.
  type Frame = string | Record<string, number>;

  const decode = (rhotic: "r" | "ɾ"): Frame[] => [
    "<pad>", "p", "e", "e", rhotic, { "<pad>": 60, [rhotic]: 30 }, rhotic, "o", "<pad>",
  ];

  const posterior = (frames: readonly Frame[]): LogProbs => {
    const V = VOCAB.length;
    const data = new Float32Array(frames.length * V);
    frames.forEach((frame, t) => {
      const named: Record<string, number> = typeof frame === "string" ? { [frame]: 40 } : frame;
      const weights = VOCAB.map((label) => named[label] ?? 1);
      const total = weights.reduce((a, b) => a + b, 0);
      weights.forEach((w, v) => {
        data[t * V + v] = Math.log(w / total);
      });
    });
    return { data, frames: frames.length, vocabSize: V };
  };

  it("aligns the trill the model spelled twice to the one phone we asked for", () => {
    const { phones } = g2p("perro");
    expect(phones.join("")).toBe("pero");

    const spans = forcedAlign(posterior(decode("r")), buildTarget(phones, VOCAB), { blank: 0 });
    expect(spans.map((s) => `${s.label}[${s.start},${s.end})`).join(" ")).toBe(
      "p[1,2) e[2,4) r[4,7) o[7,8)",
    );
  });

  it("scores the tap as a miss when the trill was asked for", () => {
    // *pero* and *perro* differ by one phone and this is the whole point of
    // the project: the tap is the trill's nearest rival (§10.3), so it aligns
    // to the same frames and the score is what separates them.
    const target = buildTarget(g2p("perro").phones, VOCAB);

    const trilled = forcedAlign(posterior(decode("r")), target, { blank: 0 })[2];
    const missed = forcedAlign(posterior(decode("ɾ")), target, { blank: 0 })[2];

    expect(missed.label).toBe("r");
    expect(missed.score).toBeLessThan(trilled.score - 2);
    // The span also shrinks: with no frame that looks like a trill, the path
    // gives what it can to the neighbours and keeps the minimum for /r/. So
    // duration is evidence too, and mostly of the same thing.
    expect(missed.end - missed.start).toBeLessThan(trilled.end - trilled.start);
  });
});
