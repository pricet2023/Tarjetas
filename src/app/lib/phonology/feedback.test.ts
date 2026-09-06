import { describe, expect, it } from "vitest";

import { diagnose, groupByWord, headline, meterOf } from "./feedback";
import { g2p, g2pPhrase } from "./g2p";
import { type PhoneScore } from "./gop";

/**
 * A score with everything defaulted to "fine", so each test states only the
 * thing it is about. Real `PhoneScore`s come out of `scorePhones`, which
 * `gop.test.ts` covers; nothing here is asserting how they are computed.
 */
const score = (phone: string, over: Partial<PhoneScore> = {}): PhoneScore => ({
  phone,
  start: 0,
  end: 1,
  gop: 5,
  rival: null,
  rivalLabel: "",
  z: 0,
  calibrated: true,
  verdict: "good",
  ...over,
});

const scoresFor = (words: { phones: readonly string[] }[]): PhoneScore[] =>
  words.flatMap((w) => w.phones.map((p) => score(p)));

describe("groupByWord", () => {
  it("puts each phone back in its own syllable", () => {
    const [casa] = g2pPhrase("casa");
    const grouped = groupByWord([casa], scoresFor([casa]));

    expect(grouped).toHaveLength(1);
    expect(grouped[0].word).toBe("casa");
    expect(grouped[0].syllables.map((s) => s.phones.map((p) => p.phone))).toEqual([
      ["k", "a"],
      ["s", "a"],
    ]);
  });

  it("carries the stressed syllable through", () => {
    const [murcielago] = g2pPhrase("murciélago");
    const grouped = groupByWord([murcielago], scoresFor([murcielago]));
    const stressed = grouped[0].syllables.filter((s) => s.stressed);

    expect(stressed).toHaveLength(1);
    // murciélago: mur-cié-la-go, stress written on the é.
    expect(stressed[0].phones.map((p) => p.phone)).toEqual(["s", "j", "e"]);
  });

  it("splits a phrase back into its words", () => {
    const words = g2pPhrase("el perro");
    const grouped = groupByWord(words, scoresFor(words));

    expect(grouped.map((w) => w.word)).toEqual(["el", "perro"]);
    expect(grouped[1].syllables.map((s) => s.phones.map((p) => p.phone))).toEqual([
      ["p", "e"],
      ["r", "o"],
    ]);
  });

  it("reports the weakest phone in each syllable", () => {
    const [perro] = g2pPhrase("perro");
    const scores = [
      score("p", { z: 0.4 }),
      score("e", { z: 1.1 }),
      score("r", { z: -3.2, verdict: "off", rival: "ɾ" }),
      score("o", { z: 0.2 }),
    ];
    const grouped = groupByWord([perro], scores);

    expect(grouped[0].syllables[0].worst?.phone).toBe("p");
    expect(grouped[0].syllables[1].worst?.phone).toBe("r");
  });

  it("falls back to the raw margin when nothing is calibrated", () => {
    const [casa] = g2pPhrase("casa");
    const scores = [
      score("k", { z: null, gop: 2 }),
      score("a", { z: null, gop: -1 }),
      score("s", { z: null, gop: 3 }),
      score("a", { z: null, gop: 4 }),
    ];

    expect(groupByWord([casa], scores)[0].syllables[0].worst?.phone).toBe("a");
  });

  it("refuses scores that are not this target's", () => {
    const [casa] = g2pPhrase("casa");
    // Silently accepting these would hang the /s/'s verdict off the /a/, and a
    // learner reading that has no way to tell it is the app that is wrong.
    expect(() => groupByWord([casa], [score("k")])).toThrow(/1 scores for 4 phones/);
  });
});

describe("diagnose", () => {
  it("says nothing about a clean phone", () => {
    expect(diagnose(score("r"))).toEqual({ message: "clean", hint: null });
  });

  it("names the tap/trill confusion — the whole point of the exercise", () => {
    const d = diagnose(score("r", { verdict: "off", rival: "ɾ", rivalLabel: "ɾ", z: -3.1 }));
    expect(d.message).toBe("that was a tap, not a trill");
    expect(d.hint).toMatch(/flutter/);
  });

  it("names it the other way round too", () => {
    expect(diagnose(score("ɾ", { verdict: "off", rival: "r", rivalLabel: "r" })).message).toBe(
      "that was a trill where one quick tap belongs",
    );
  });

  it("recognises a rival that is not a Spanish sound at all", () => {
    // §10.3: rivals are not restricted to our 24, and this is the case where
    // that is load-bearing — an English R has nowhere to land inside Spanish.
    const d = diagnose(score("r", { verdict: "off", rival: null, rivalLabel: "ɹ" }));
    expect(d.message).toBe("that was an English *r*");
    expect(d.hint).toMatch(/tongue tip/i);
  });

  it("falls back to the bare comparison for an unnamed pair", () => {
    expect(diagnose(score("s", { verdict: "off", rival: "f", rivalLabel: "f" })).message).toBe(
      "heard as /f/",
    );
  });

  it("says a phone simply didn't land when nothing won instead", () => {
    expect(diagnose(score("x", { verdict: "off", rival: null, rivalLabel: "" })).message).toBe(
      "/x/ didn't land",
    );
  });

  it("treats a near miss as a drift rather than a wrong sound", () => {
    const d = diagnose(score("w", { verdict: "close", rival: "u", rivalLabel: "u", z: -1.9 }));
    expect(d.message).toMatch(/nearly/);
    expect(d.message).toContain("/u/");
  });
});

describe("meterOf", () => {
  it("rises with the z-score and stays inside 0..1", () => {
    expect(meterOf(score("a", { z: -9 }))).toBe(0);
    expect(meterOf(score("a", { z: 9 }))).toBe(1);
    expect(meterOf(score("a", { z: 0 }))).toBeGreaterThan(meterOf(score("a", { z: -1 })));
  });

  it("reads full for an uncalibrated phone rather than empty", () => {
    // An uncalibrated build should look silent, not accusing.
    expect(meterOf(score("a", { z: null }))).toBe(1);
  });
});

describe("headline", () => {
  it("leads with the worst phone", () => {
    const worst = score("x", { verdict: "off", rival: "k", rivalLabel: "k", z: -2.8 });
    expect(headline(worst, 0.75)).toBe("/x/: that stopped like a /k/ instead of rasping.");
  });

  it("congratulates a clean attempt", () => {
    expect(headline(score("a"), 1)).toBe("Every sound landed.");
  });

  it("is honest about a merely-adequate one", () => {
    expect(headline(score("a"), 0.8)).toBe("Close — nothing badly wrong.");
  });

  it("copes with a card that produced no phones at all", () => {
    expect(headline(null, 0)).toMatch(/Close/);
  });
});

describe("the pieces fit together", () => {
  it("groups a real G2P word and diagnoses its trill", () => {
    const perro = g2p("perro");
    const scores = perro.phones.map((p) =>
      p === "r"
        ? score("r", { verdict: "off", rival: "ɾ", rivalLabel: "ɾ", z: -3.4, gop: -2.9 })
        : score(p),
    );
    const [word] = groupByWord([perro], scores);
    const worst = word.syllables.flatMap((s) => s.phones).reduce((a, b) => ((b.z ?? 0) < (a.z ?? 0) ? b : a));

    expect(headline(worst, 0.75)).toBe("/r/: that was a tap, not a trill.");
    expect(meterOf(worst)).toBeLessThan(0.1);
  });
});
