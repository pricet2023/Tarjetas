import { describe, expect, it } from "vitest";

import {
  MODEL_LABELS,
  MODEL_LABEL_TO_PHONE,
  PHONES,
  type Phone,
} from "./inventory";

describe("inventory", () => {
  it("is the 24 scored units the plan specifies", () => {
    expect(PHONES).toHaveLength(24);
    expect(new Set(PHONES).size).toBe(24);
  });

  it("gives every scored unit at least one model label", () => {
    for (const p of PHONES) expect(MODEL_LABELS[p].length).toBeGreaterThan(0);
  });

  it("never maps one model label to two different units", () => {
    // The reverse map silently keeps the last writer, so a duplicate here would
    // not throw — it would just make one phone unreachable from the model side.
    const seen = new Map<string, Phone>();
    for (const p of PHONES) {
      for (const label of MODEL_LABELS[p]) {
        expect(seen.has(label), `"${label}" claimed by ${seen.get(label)} and ${p}`).toBe(false);
        seen.set(label, p);
      }
    }
  });

  it("spells /g/ with IPA U+0261 on the model side and ASCII on ours", () => {
    // The trap from the plan, §10.2: these two look identical in a terminal and
    // a lookup on the wrong one misses silently, scoring every /g/ as an error.
    expect(MODEL_LABELS.g[0]).toBe("ɡ");
    expect(MODEL_LABELS.g[0]).not.toBe("g");
    expect(PHONES).toContain("g");
    expect(MODEL_LABEL_TO_PHONE.get("ɡ")).toBe("g");
    expect(MODEL_LABEL_TO_PHONE.get("g")).toBeUndefined();
  });

  it("folds the allophones back onto their phoneme", () => {
    // Without these, correct native speech scores as an error: the model says
    // [β] for the b of *haba* and we would be listening for [b]. Plan §4.1.
    expect(MODEL_LABEL_TO_PHONE.get("β")).toBe("b");
    expect(MODEL_LABEL_TO_PHONE.get("ð")).toBe("d");
    expect(MODEL_LABEL_TO_PHONE.get("ɣ")).toBe("g");
    expect(MODEL_LABEL_TO_PHONE.get("ŋ")).toBe("n");
  });

  it("folds vowel length away, since Spanish has none", () => {
    expect(MODEL_LABEL_TO_PHONE.get("iː")).toBe("i");
    expect(MODEL_LABEL_TO_PHONE.get("eː")).toBe("e");
  });

  it("accepts the Peninsular variants of the two dialect choices", () => {
    expect(MODEL_LABEL_TO_PHONE.get("θ")).toBe("s"); // seseo
    expect(MODEL_LABEL_TO_PHONE.get("ʎ")).toBe("ʝ"); // yeísmo
  });

  it("keeps the tap and the trill apart", () => {
    // This distinction is the feature. Merging it deletes the project.
    expect(MODEL_LABEL_TO_PHONE.get("ɾ")).toBe("ɾ");
    expect(MODEL_LABEL_TO_PHONE.get("r")).toBe("r");
  });

  it("leaves the espeak set's non-Spanish labels unmapped", () => {
    for (const junk of ["??", "S", "dZ", "ɑ5", "onɡ5", "<pad>"]) {
      expect(MODEL_LABEL_TO_PHONE.get(junk)).toBeUndefined();
    }
  });
});
