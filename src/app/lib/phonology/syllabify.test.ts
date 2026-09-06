import { describe, expect, it } from "vitest";

import type { Phone } from "./inventory";
import { syllabify, type Segment } from "./syllabify";

/** Build segments by hand, optionally accenting one, to test in isolation. */
const seg = (phones: Phone[], accentAt = -1): Segment[] =>
  phones.map((phone, i) => ({ phone, accented: i === accentAt }));

/** Render syllables as `a-blo` so failures are readable. */
const shape = (segments: Segment[]): string =>
  syllabify(segments).map((s) => s.phones.join("")).join("-");

describe("syllabify", () => {
  describe("consonants between vowels", () => {
    it("gives a lone consonant to the following syllable", () => {
      expect(shape(seg(["k", "a", "s", "a"]))).toBe("ka-sa");
    });

    it("splits a pair that is not a cluster", () => {
      // mur-cié... — ɾ closes the first syllable rather than joining the s.
      expect(shape(seg(["a", "ɾ", "s", "a"]))).toBe("aɾ-sa");
    });

    it("keeps an obstruent+liquid cluster together", () => {
      // ha-blo, not hab-lo.
      expect(shape(seg(["a", "b", "l", "o"]))).toBe("a-blo");
      expect(shape(seg(["a", "t", "ɾ", "a"]))).toBe("a-tɾa");
    });

    it("does not treat s+consonant as a cluster", () => {
      // es-tar, never e-star: this is why Spanish speakers say "eh-spanish".
      expect(shape(seg(["e", "s", "t", "a"]))).toBe("es-ta");
    });

    it("keeps only the final cluster of a three-consonant run", () => {
      expect(shape(seg(["e", "n", "t", "ɾ", "a"]))).toBe("en-tɾa");
      expect(shape(seg(["a", "l", "g", "o", "s"]))).toBe("al-gos");
    });

    it("puts everything before the first vowel in the onset", () => {
      expect(shape(seg(["t", "ɾ", "e", "s"]))).toBe("tɾes");
    });
  });

  describe("vowel sequences — the hard part", () => {
    it("merges an unaccented weak vowel into its neighbour", () => {
      // tie-rra: one syllable, with i demoted to the glide j.
      expect(shape(seg(["t", "i", "e", "r", "a"]))).toBe("tje-ra");
    });

    it("splits the same pattern when the weak vowel is accented", () => {
      // dí-a: the written accent is what makes this two syllables, not one.
      expect(shape(seg(["d", "i", "a"], 1))).toBe("di-a");
    });

    it("never merges two strong vowels", () => {
      expect(shape(seg(["l", "e", "e", "ɾ"]))).toBe("le-eɾ");
    });

    it("gives the peak to the second of two weak vowels", () => {
      // ciu-dad is /sju/ and cui-dar is /kwi/ — mirror images.
      expect(shape(seg(["s", "i", "u", "d"]))).toBe("sjud");
      expect(shape(seg(["k", "u", "i", "d"]))).toBe("kwid");
    });

    it("builds a triphthong from weak+strong+weak", () => {
      expect(shape(seg(["b", "u", "e", "i"]))).toBe("bwej");
    });

    it("leaves the second half of a hiatus with no onset", () => {
      const syllables = syllabify(seg(["d", "i", "a"], 1));
      expect(syllables[1].onset).toEqual([]);
      expect(syllables[1].nucleus).toEqual(["a"]);
    });
  });

  it("reports onset, nucleus and coda separately", () => {
    const [first] = syllabify(seg(["t", "i", "e", "r", "a"]));
    expect(first).toMatchObject({ onset: ["t"], nucleus: ["j", "e"], coda: [] });
  });

  it("marks the syllable holding a written accent", () => {
    const syllables = syllabify(seg(["a", "b", "l", "o"], 3));
    expect(syllables.map((s) => s.accented)).toEqual([false, true]);
  });

  it("returns nothing for a word with no vowel", () => {
    expect(syllabify(seg(["s", "t"]))).toEqual([]);
  });
});
