/**
 * The scored phone inventory, and the seam between our symbols and the
 * acoustic model's labels.
 *
 * Two separate alphabets meet here on purpose. G2P emits *our* symbols — the
 * ~24 units we are willing to give feedback on — while the model emits its own
 * 392-label espeak inventory. `MODEL_LABELS` is the only place the two are
 * related, so swapping the model is a one-table change (see the plan, §Phase 1).
 *
 * The mapping is many-to-one, and that is the point. Several model labels
 * collapse into one scored unit because they are allophones — ways the *same*
 * phoneme comes out in context that no native speaker hears as different. Score
 * them apart and we penalise correct Spanish (plan §4.1).
 */

/**
 * The units we score. Latin American: seseo (no /θ/) and yeísmo (`ll` → /ʝ/).
 *
 * `g` is deliberately ASCII here, not IPA `ɡ` (U+0261). Our symbols are ours to
 * choose and ASCII is far less error-prone to type; the IPA form appears only
 * in `MODEL_LABELS`. Conflating the two is a silent failure — a lookup on the
 * wrong codepoint misses and every /g/ scores as an error.
 */
export const PHONES = [
  // vowels
  "a", "e", "i", "o", "u",
  // glides (a weak vowel that lost the syllable peak to its neighbour)
  "j", "w",
  // consonants
  "p", "b", "t", "d", "k", "g", "tʃ", "f", "s", "x",
  "m", "n", "ɲ", "l", "ɾ", "r", "ʝ",
] as const;

export type Phone = (typeof PHONES)[number];

const set = <T extends Phone>(...xs: T[]): ReadonlySet<Phone> => new Set<Phone>(xs);

export const VOWELS = set("a", "e", "i", "o", "u");
/** `a e o` — always carry the syllable peak. */
export const STRONG_VOWELS = set("a", "e", "o");
/** `i u` — glue onto a neighbouring vowel to make one syllable, unless accented. */
export const WEAK_VOWELS = set("i", "u");
export const GLIDES = set("j", "w");

/** The glide each weak vowel becomes when it loses the peak. */
export const GLIDE_OF: Readonly<Partial<Record<Phone, Phone>>> = { i: "j", u: "w" };

export const isVowel = (p: Phone): boolean => VOWELS.has(p);
export const isConsonant = (p: Phone): boolean => !VOWELS.has(p) && !GLIDES.has(p);

/**
 * Our symbol → the model labels that count as it. The first entry is canonical.
 *
 * Verified against the label dump in the plan, §10.2 — every one of these
 * strings is a real label in `wav2vec2-xlsr-53-espeak-cv-ft`'s 392-label
 * inventory. Four kinds of entry beyond the plain 1:1 hit:
 *
 * 1. **Allophones** (plan §4.1). `β ð ɣ` are the soft intervocalic forms of
 *    /b d g/ and the model does emit them; `ŋ` is /n/ before a velar. Without
 *    these, a correctly-spoken *haba* aligns to `b` while the model is
 *    confidently saying `β`, and the score collapses on good speech.
 * 2. **Vowel length.** Spanish has no phonemic length, but the espeak set is
 *    multilingual and carries `aː eː iː oː uː` — the model gave `iː` for the
 *    /e/ of *pero*. Merge them, or a correct vowel reads as a miss.
 * 3. **Vowel quality.** `ɛ ɪ ɔ ʊ` are the lax neighbours of `e i o u`, freely
 *    used in unstressed Spanish syllables.
 * 4. **Dialect** (plan §8, decision 6). We chose seseo and yeísmo, so G2P emits
 *    `s` and `ʝ` — but a speaker who says `θ` in *cielo* or `ʎ` in *llave* is
 *    being Peninsular, not wrong. Same argument as the allophones above.
 */
export const MODEL_LABELS: Readonly<Record<Phone, readonly string[]>> = {
  a: ["a", "aː", "ä"],
  e: ["e", "eː", "ɛ"],
  i: ["i", "iː", "ɪ"],
  o: ["o", "oː", "ɔ"],
  u: ["u", "uː", "ʊ"],

  j: ["j"],
  w: ["w"],

  p: ["p"],
  b: ["b", "β", "v"], //  /b/ and /v/ are one phoneme; spelling suggests otherwise
  t: ["t"],
  d: ["d", "ð"],
  k: ["k"],
  g: ["ɡ", "ɣ"], // U+0261 SCRIPT G, *not* ASCII "g" — see PHONES above
  "tʃ": ["tʃ"],
  f: ["f"],
  s: ["s", "θ"], // seseo: θ accepted so Peninsular speech is not marked wrong
  x: ["x", "χ", "h"], // [h] is the everyday Caribbean/Latin American realisation
  m: ["m"],
  n: ["n", "ŋ"],
  "ɲ": ["ɲ"],
  l: ["l"],
  "ɾ": ["ɾ"],
  r: ["r"],
  "ʝ": ["ʝ", "ʎ"], // yeísmo: ʎ accepted for the same reason as θ above
};

/**
 * Reverse of `MODEL_LABELS`, for turning a model frame's argmax back into a
 * scored unit. Labels absent from this map — the espeak set's tone-marked CJK
 * entries and its `?? S X dZ` fallback debris — are not ours and stay unmapped.
 */
export const MODEL_LABEL_TO_PHONE: ReadonlyMap<string, Phone> = new Map(
  PHONES.flatMap((p) => MODEL_LABELS[p].map((label) => [label, p] as const)),
);

/**
 * Glides are where our symbols and the model's stop lining up 1:1, and the
 * mismatch belongs to the aligner and the scorer rather than to this table.
 * Two measured cases, both from cross-checking G2P against real decodes:
 *
 * - **Falling diphthongs get a composite label.** *causa* came back as
 *   `k aɪ s ʌ` and *seis* as `s eɪ s`, never `a j` / `e j` — so one model label
 *   can span two of our units, which Phase 2's state expansion must allow for.
 * - **A glide may surface as its full vowel.** For *muy* we emit `m w i` and
 *   the model gave `m uː i`, i.e. `u` where we asked for `w`.
 *
 * Deliberately *not* fixed by adding `u`/`i` to the `w`/`j` rows: that would
 * make `MODEL_LABEL_TO_PHONE` ambiguous, and answering "what sound was that?"
 * unambiguously matters more than papering over a near-miss. Phase 5 should
 * score a glide/vowel confusion as close, not as an error.
 */
export const COMPOSITE_MODEL_LABELS: Readonly<Record<string, readonly Phone[]>> = {
  "aɪ": ["a", "j"],
  "eɪ": ["e", "j"],
  "ɔɪ": ["o", "j"],
  "aʊ": ["a", "w"],
  "oʊ": ["o", "w"],
};
