/**
 * Phones in, alignment target out — the seam between Phase 1's symbols and
 * whatever the acoustic model happens to call things.
 *
 * G2P emits our ~24 scored units; the model emits its own 392 labels. This
 * turns the first into the second using `inventory.ts`'s table and the model's
 * own `vocab.json`, so swapping the model stays a one-table change (§Phase 1)
 * and the aligner itself never learns a label string.
 *
 * It is also where the two mismatches recorded at the bottom of `inventory.ts`
 * get resolved, since both are the aligner's problem rather than G2P's.
 */

import {
  COMPOSITE_MODEL_LABELS,
  MODEL_LABELS,
  type Phone,
} from "@/app/lib/phonology/inventory";

import { type TargetUnit } from "./ctc";

/**
 * Build the alignment target for a phone sequence.
 *
 * `vocab` is the model's label list, index-aligned with its output rows — read
 * it from the model's `vocab.json` rather than retyping it, per §10.2.
 *
 * Throws when a phone has no label at all. That is not a recoverable
 * situation: aligning a target with a phone the model can never emit would
 * push every later frame out of place and read back as the learner's mistake.
 * It is also exactly what the ASCII-`g`-for-IPA-`ɡ` trap looks like, so the
 * message says so.
 */
export function buildTarget(
  phones: readonly Phone[],
  vocab: readonly string[],
): TargetUnit[] {
  const row = new Map<string, number>();
  // First occurrence wins; a duplicated label in a vocab dump is debris.
  vocab.forEach((label, index) => {
    if (!row.has(label)) row.set(label, index);
  });

  const rows = phones.map((phone) => {
    const found = MODEL_LABELS[phone].map((l) => row.get(l)).filter((r) => r !== undefined);
    if (found.length === 0) {
      throw new Error(
        `The model can't emit /${phone}/: none of its labels (${MODEL_LABELS[phone].join(" ")}) ` +
          "are in the vocabulary. If the phone looks right, check the codepoints — " +
          "IPA \"ɡ\" (U+0261) and ASCII \"g\" are different labels and the mismatch is silent.",
      );
    }
    return new Set(found);
  });

  // A falling diphthong can arrive as a *single* composite label covering two
  // of our units — *causa* decodes as `k aɪ s ʌ`, never `k a j s a`. Let both
  // units accept that label so the frames it owns are shared between them
  // instead of stranding whichever unit asked for it and lost.
  //
  // Only in context: `aɪ` counts as our /a/ when the next phone is the /j/ it
  // is half of, and not in *casa*, where an `aɪ` frame is a genuine miss.
  for (const [label, units] of Object.entries(COMPOSITE_MODEL_LABELS)) {
    const index = row.get(label);
    if (index === undefined) continue;
    for (let i = 0; i + units.length <= phones.length; i += 1) {
      if (units.every((u, k) => phones[i + k] === u)) {
        for (let k = 0; k < units.length; k += 1) rows[i + k].add(index);
      }
    }
  }

  return phones.map((label, i) => ({ label, rows: [...rows[i]].sort((a, b) => a - b) }));
}
