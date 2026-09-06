import { describe, expect, it } from "vitest";

import { g2p, g2pPhrase } from "./g2p";

/** `muɾ-ˈsje-la-go` — syllables split on `-`, stress marked IPA-style with ˈ. */
const shape = (word: string): string =>
  g2p(word)
    .syllables.map((s) => (s.stressed ? `ˈ${s.phones.join("")}` : s.phones.join("")))
    .join("-");

const phones = (word: string): string => g2p(word).phones.join("");

describe("g2p", () => {
  // The verify list from the plan, §Phase 1. Each row is here because it is
  // the smallest word that can go wrong in one specific way.
  const table: [word: string, expected: string, why: string][] = [
    ["casa", "ˈka-sa", "the baseline"],
    ["murciélago", "muɾ-ˈsje-la-go", "four syllables, accent, and a c before i"],

    ["tierra", "ˈtje-ra", "unaccented weak vowel glues into a diphthong"],
    ["día", "ˈdi-a", "the same letters, accented, are two syllables"],

    ["perro", "ˈpe-ro", "rr is a trill"],
    ["pero", "ˈpe-ɾo", "a single r between vowels is a tap"],

    ["cielo", "ˈsje-lo", "c before i is /s/ under seseo"],
    ["como", "ˈko-mo", "c before o is /k/"],

    ["queso", "ˈke-so", "the u of qu is silent"],
    ["guitarra", "gi-ˈta-ra", "the u of gu is silent, and rr is still a trill"],
    ["jugar", "xu-ˈgaɾ", "j is /x/, and a consonant-final word takes final stress"],

    ["hay", "ˈaj", "word-final y is the vowel i, then glides"],
    ["muy", "ˈmwi", "two weak vowels: the second keeps the peak"],

    ["hablo", "ˈa-blo", "h is silent and bl will not split"],
    ["habló", "a-ˈblo", "the accent moves the stress and nothing else"],
    ["hábil", "ˈa-bil", "without the accent this would be ha-BIL"],
  ];

  for (const [word, expected, why] of table) {
    it(`${word} → ${expected} (${why})`, () => {
      expect(shape(word)).toBe(expected);
    });
  }

  describe("the tap/trill distinction", () => {
    // The one contrast the whole project exists to score, so it gets its own
    // block rather than a single row.
    it("trills word-initially", () => expect(phones("rosa")).toBe("rosa"));
    it("trills after n, l and s", () => {
      expect(phones("honra")).toBe("onra");
      expect(phones("alrededor")).toBe("alrededoɾ");
      expect(phones("israel")).toBe("israel");
    });
    it("taps between vowels and in a cluster", () => {
      expect(phones("caro")).toBe("kaɾo");
      expect(phones("tres")).toBe("tɾes");
    });
    it("taps word-finally", () => expect(phones("hablar")).toBe("ablaɾ"));
  });

  describe("dialect", () => {
    it("makes casa and caza homophones (seseo)", () => {
      expect(phones("caza")).toBe(phones("casa"));
    });
    it("merges ll and y (yeísmo)", () => {
      expect(phones("llave")).toBe("ʝabe");
      expect(phones("yo")).toBe("ʝo");
    });
    it("merges b and v", () => {
      expect(phones("vaca")).toBe("baka");
      expect(phones("tuvo")).toBe(phones("tubo"));
    });
    it("emits stops, not the soft allophones, between vowels", () => {
      // [β ð ɣ] are real but not separately scored — inventory.ts re-admits
      // them on the model side instead.
      expect(phones("haba")).toBe("aba");
      expect(phones("nada")).toBe("nada");
      expect(phones("lago")).toBe("lago");
    });
  });

  describe("context-sensitive letters", () => {
    it("softens g before e and i", () => {
      expect(phones("gente")).toBe("xente");
      expect(phones("gato")).toBe("gato");
    });
    it("un-silences the u of gu with a diaeresis", () => {
      expect(shape("vergüenza")).toBe("beɾ-ˈgwen-sa");
      expect(shape("guerra")).toBe("ˈge-ra");
    });
    it("keeps the u of gu and cu audible before a back vowel", () => {
      expect(phones("guapo")).toBe("gwapo");
      expect(phones("cuando")).toBe("kwando");
    });
    it("drops h everywhere but ch", () => {
      expect(phones("hola")).toBe("ola");
      expect(phones("chico")).toBe("tʃiko");
    });
  });

  describe("x, which is irregular", () => {
    it("is /ks/ by default", () => expect(shape("taxi")).toBe("ˈtak-si"));
    it("is /s/ word-initially", () => expect(phones("xilófono")).toBe("silofono"));
    it("is /x/ in the words that kept the old value", () => {
      expect(shape("méxico")).toBe("ˈme-xi-ko");
    });
  });

  describe("hiatus and diphthong", () => {
    it("splits two strong vowels", () => expect(shape("leer")).toBe("le-ˈeɾ"));
    it("splits an accented weak vowel", () => expect(shape("país")).toBe("pa-ˈis"));
    it("builds a triphthong", () => expect(shape("buey")).toBe("ˈbwej"));
    it("handles the ciudad/cuidar mirror", () => {
      expect(shape("ciudad")).toBe("sju-ˈdad");
      expect(shape("cuidar")).toBe("kwi-ˈdaɾ");
    });
  });

  describe("failure", () => {
    it("throws rather than mis-pronouncing an unexpected character", () => {
      // A silently wrong target would mis-align every frame downstream and read
      // as the learner's mistake.
      expect(() => g2p("café☕")).toThrow(/unexpected character/);
    });
    it("throws on a word with no vowel", () => {
      expect(() => g2p("psst")).toThrow(/no vowel/);
    });
    it("ignores punctuation and case", () => {
      expect(phones("¿Cómo?")).toBe(phones("como"));
    });
  });

  describe("g2pPhrase", () => {
    it("pronounces each word independently", () => {
      expect(g2pPhrase("la casa roja").map((p) => p.phones.join(""))).toEqual([
        "la", "kasa", "roxa",
      ]);
    });
    it("ignores extra whitespace", () => {
      expect(g2pPhrase("  el   perro ")).toHaveLength(2);
    });
  });
});
