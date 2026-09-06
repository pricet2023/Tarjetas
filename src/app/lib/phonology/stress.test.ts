import { describe, expect, it } from "vitest";

import { assignStress } from "./stress";
import { syllabify, type Segment } from "./syllabify";
import type { Phone } from "./inventory";

const seg = (phones: Phone[], accentAt = -1): Segment[] =>
  phones.map((phone, i) => ({ phone, accented: i === accentAt }));

/** Index of the stressed syllable, for a hand-built word. */
const stressed = (phones: Phone[], word: string, accentAt = -1): number =>
  assignStress(syllabify(seg(phones, accentAt)), word).findIndex((s) => s.stressed);

describe("assignStress", () => {
  it("puts stress on the second-to-last syllable of a vowel-final word", () => {
    expect(stressed(["a", "b", "l", "o"], "hablo")).toBe(0); // HA-blo
  });

  it("puts stress on the last syllable of a consonant-final word", () => {
    expect(stressed(["x", "u", "g", "a", "ɾ"], "jugar")).toBe(1); // ju-GAR
  });

  it("treats final n and s like a vowel", () => {
    expect(stressed(["k", "a", "n", "t", "a", "n"], "cantan")).toBe(0); // CAN-tan
    expect(stressed(["k", "a", "s", "a", "s"], "casas")).toBe(0); // CA-sas
  });

  it("lets a written accent override the default", () => {
    expect(stressed(["a", "b", "l", "o"], "habló", 3)).toBe(1); // ha-BLÓ
    expect(stressed(["a", "b", "i", "l"], "hábil", 0)).toBe(0); // HÁ-bil
  });

  it("reads the default rule off the final letter, not the final sound", () => {
    // Paraguay ends in a vowel *sound* but a consonant *letter*, and it is the
    // letter that decides: Pa-ra-GUAY, not Pa-RA-guay.
    expect(stressed(["p", "a", "ɾ", "a", "g", "u", "a", "i"], "paraguay")).toBe(2);
  });

  it("stresses the only syllable of a monosyllable", () => {
    expect(stressed(["a", "i"], "hay")).toBe(0);
    expect(stressed(["s", "o", "l"], "sol")).toBe(0);
  });

  it("marks exactly one syllable", () => {
    const syllables = assignStress(syllabify(seg(["m", "u", "ɾ", "s", "i", "e", "l", "a", "g", "o"], 5)), "murciélago");
    expect(syllables.filter((s) => s.stressed)).toHaveLength(1);
  });

  it("is a no-op on an empty word", () => {
    expect(assignStress([], "")).toEqual([]);
  });
});
