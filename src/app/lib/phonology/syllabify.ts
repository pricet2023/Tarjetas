/**
 * Syllable division, and the diphthong/hiatus decision that comes with it.
 *
 * This exists because stress lands on syllables, not on letters (plan §4.2),
 * and because a stressed vowel is longer and clearer — so a misplaced stress is
 * audible and worth scoring. Phase 7 also wants a per-syllable meter.
 *
 * It runs over *phones*, not letters, which is what makes it short: by this
 * point `ch ll rr qu` are already single segments, so "one consonant between
 * two vowels" is literally one array element.
 *
 * The hard part is not the consonants, it is vowel sequences. `i` and `u` are
 * weak and glue onto a neighbour to make one syllable (*tie-rra*) — unless the
 * weak vowel carries a written accent, when the glue fails and the same-looking
 * pattern is two syllables (*dí-a*).
 */

import {
  GLIDE_OF,
  STRONG_VOWELS,
  WEAK_VOWELS,
  isVowel,
  type Phone,
} from "./inventory";

/** One phone as G2P produced it. `accented` marks a written accent (á é í ó ú). */
export interface Segment {
  phone: Phone;
  accented: boolean;
}

export interface Syllable {
  onset: Phone[];
  /** Peak plus any glides, in spoken order — `[j, e]` for the *tie* of *tierra*. */
  nucleus: Phone[];
  coda: Phone[];
  /** Every phone of the syllable, onset through coda. */
  phones: Phone[];
  /** True when this syllable carries the word's stress. Set by `assignStress`. */
  stressed: boolean;
  /** True when a vowel here carried a written accent. Input to `assignStress`. */
  accented: boolean;
}

/**
 * Consonant pairs that refuse to be split, so both go to the onset:
 * *ha-blo*, not *hab-lo*. Obstruent + liquid, and nothing else — note that
 * `s` + consonant is **not** among them, which is why it is *es-tar* and never
 * *e-star*.
 *
 * The liquid is `ɾ` rather than `r`: a trill never appears in a cluster, since
 * the spellings that produce one (`rr`, and word-initial `r`) cannot occur
 * there. `tl` is included — it is an onset in Latin American Spanish
 * (*a-tlas*), unlike Peninsular.
 */
const ONSET_CLUSTERS: ReadonlySet<string> = new Set([
  "pɾ", "bɾ", "tɾ", "dɾ", "kɾ", "gɾ", "fɾ",
  "pl", "bl", "kl", "gl", "fl", "tl",
]);

const isWeak = (s: Segment): boolean => WEAK_VOWELS.has(s.phone);
const isStrong = (s: Segment): boolean => STRONG_VOWELS.has(s.phone);

/**
 * Do two adjacent vowels share a syllable?
 *
 * Only if at least one of them is an *unaccented* weak vowel. Two strong vowels
 * never merge (*le-er*, *ca-os*), and an accented weak vowel has been promoted
 * to a peak in its own right and will not glue (*dí-a*, *pa-ís*).
 */
const joins = (a: Segment, b: Segment): boolean =>
  (isWeak(a) && !a.accented) || (isWeak(b) && !b.accented);

/**
 * Which segment of a nucleus keeps the syllable peak; the others become glides.
 *
 * A strong vowel always wins. Failing that the nucleus is two weak vowels, and
 * Spanish gives the peak to the **second**: *ciu-dad* is /sju/ and *cui-dar* is
 * /kwi/, the mirror image of each other.
 */
const peakIndex = (nucleus: Segment[]): number => {
  const strong = nucleus.findIndex(isStrong);
  return strong === -1 ? nucleus.length - 1 : strong;
};

/** Split a run of adjacent vowels into one or more nuclei. */
function splitVowelRun(run: Segment[]): Segment[][] {
  const nuclei: Segment[][] = [];
  let i = 0;
  while (i < run.length) {
    const nucleus = [run[i]];
    // Cap at three: weak + strong + weak is a triphthong (*buey* → /bwej/) and
    // Spanish has nothing longer.
    while (nucleus.length < 3 && i + 1 < run.length && joins(run[i], run[i + 1])) {
      nucleus.push(run[i + 1]);
      i += 1;
    }
    nuclei.push(nucleus);
    i += 1;
  }
  return nuclei;
}

/** Turn a nucleus into phones: the peak stays a vowel, its neighbours glide. */
function nucleusPhones(nucleus: Segment[]): Phone[] {
  const peak = peakIndex(nucleus);
  return nucleus.map((s, k) => (k === peak ? s.phone : GLIDE_OF[s.phone] ?? s.phone));
}

/**
 * Divide the consonants sitting between two nuclei.
 *
 * The rule is "give the following syllable as much onset as Spanish allows":
 * one consonant always moves right, two split unless they are an inseparable
 * cluster, and longer runs keep only a final cluster together.
 */
function divide(cluster: Phone[]): { coda: Phone[]; onset: Phone[] } {
  if (cluster.length <= 1) return { coda: [], onset: cluster };
  const lastTwo = cluster.slice(-2).join("");
  const keepsTogether = ONSET_CLUSTERS.has(lastTwo);
  if (cluster.length === 2) {
    return keepsTogether ? { coda: [], onset: cluster } : { coda: [cluster[0]], onset: [cluster[1]] };
  }
  const split = keepsTogether ? cluster.length - 2 : cluster.length - 1;
  return { coda: cluster.slice(0, split), onset: cluster.slice(split) };
}

/**
 * Group a word's segments into syllables.
 *
 * Returns an empty array for a word with no vowel in it — there is no syllable
 * to hang the consonants on, and a caller that has one has a G2P bug rather
 * than an unusual word.
 */
export function syllabify(segments: Segment[]): Syllable[] {
  // Locate the vowel runs, and the consonant runs that separate them.
  const nuclei: { segs: Segment[]; onset: Phone[] }[] = [];
  let pendingConsonants: Phone[] = [];
  let i = 0;

  while (i < segments.length) {
    if (!isVowel(segments[i].phone)) {
      pendingConsonants.push(segments[i].phone);
      i += 1;
      continue;
    }
    const start = i;
    while (i < segments.length && isVowel(segments[i].phone)) i += 1;
    const run = segments.slice(start, i);

    for (const [k, nucleus] of splitVowelRun(run).entries()) {
      // Only the first nucleus of a run can claim the consonants before it; a
      // hiatus (*dí-a*) leaves the second one with no onset at all.
      nuclei.push({ segs: nucleus, onset: k === 0 ? pendingConsonants : [] });
      pendingConsonants = [];
    }
  }

  if (nuclei.length === 0) return [];

  const syllables: Syllable[] = nuclei.map(({ segs }) => ({
    onset: [],
    nucleus: nucleusPhones(segs),
    coda: [],
    phones: [],
    stressed: false,
    accented: segs.some((s) => s.accented),
  }));

  // Hand each collected consonant run to the syllables on either side of it.
  nuclei.forEach(({ onset }, k) => {
    if (k === 0) {
      syllables[0].onset = onset; // word-initial: all of it is onset
      return;
    }
    const { coda, onset: moved } = divide(onset);
    syllables[k - 1].coda = coda;
    syllables[k].onset = moved;
  });
  // Whatever trails the last vowel is that syllable's coda.
  syllables[syllables.length - 1].coda = pendingConsonants;

  for (const s of syllables) s.phones = [...s.onset, ...s.nucleus, ...s.coda];
  return syllables;
}
