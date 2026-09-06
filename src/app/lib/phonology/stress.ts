/**
 * Which syllable carries the word's stress.
 *
 * Worth scoring because a stressed Spanish vowel is longer and clearer than an
 * unstressed one, so putting it in the wrong place is audible (plan §4.2) —
 * *hablo* and *habló* are different words and sound it.
 *
 * Three rules, in order, and the first that applies wins.
 */

import type { Syllable } from "./syllabify";

/**
 * The letters that make a word "vowel-final" for the default rule. `y` is
 * pointedly **not** here: orthographically it is a consonant, so *Paraguay*
 * takes final stress even though it ends in a vowel *sound*. Reading this off
 * the phones instead of the letters gets that word wrong.
 */
const VOWEL_LETTERS = new Set([..."aeiouáéíóúü"]);

/** Letters that, like a final vowel, pull the stress back one syllable. */
const RETRACTING_CONSONANTS = new Set(["n", "s"]);

/**
 * Mark the stressed syllable, mutating and returning the array.
 *
 * `word` must be the normalised spelling, because the default rule is stated
 * over the final *letter* rather than the final sound.
 */
export function assignStress(syllables: Syllable[], word: string): Syllable[] {
  if (syllables.length === 0) return syllables;

  const stressed = stressIndex(syllables, word);
  syllables.forEach((s, i) => {
    s.stressed = i === stressed;
  });
  return syllables;
}

function stressIndex(syllables: Syllable[], word: string): number {
  // 1. A written accent is explicit and overrides everything.
  const accented = syllables.findIndex((s) => s.accented);
  if (accented !== -1) return accented;

  // 2. A monosyllable has nowhere else to put it.
  if (syllables.length === 1) return 0;

  // 3. Otherwise: second-to-last if the word ends in a vowel, `n` or `s`;
  //    last if it ends in any other consonant.
  const last = word[word.length - 1] ?? "";
  const retracts = VOWEL_LETTERS.has(last) || RETRACTING_CONSONANTS.has(last);
  return retracts ? syllables.length - 2 : syllables.length - 1;
}
