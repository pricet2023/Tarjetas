/**
 * Spanish grapheme-to-phoneme: spelling in, scored phones out.
 *
 * This is tractable in a few hundred lines with no pronunciation dictionary
 * because Spanish orthography is *shallow* — sound follows from spelling almost
 * one-to-one. English is deep (`through/though/rough/cough`) and would need a
 * lexicon; Spanish needs context rules and an exceptions list for `x` (§4.2).
 *
 * Dialect is Latin American, per the plan: **seseo** (`c` before *e/i*, and
 * `z`, are /s/ — so *casa* and *caza* are homophones, which is what we want)
 * and **yeísmo** (`ll` → /ʝ/, merged with `y`).
 *
 * Allophones are deliberately not distinguished. /b d g/ are emitted as stops
 * even between vowels where they are really the fricatives [β ð ɣ], and /n/ is
 * emitted before a velar where it is really [ŋ]. Splitting them would penalise
 * correct native speech (§4.1); `inventory.ts` re-admits the soft forms on the
 * model side, which is the right place for it.
 */

import { type Phone } from "./inventory";
import { assignStress } from "./stress";
import { syllabify, type Segment, type Syllable } from "./syllabify";

export interface Pronunciation {
  /** The normalised spelling this was derived from. */
  word: string;
  syllables: Syllable[];
  /** Every phone in order — the alignment target for Phase 2. */
  phones: Phone[];
  /** Index into `syllables` of the stressed one. */
  stressIndex: number;
}

/** Vowel letters, and whether each carries a written accent. */
const VOWEL_LETTERS: Readonly<Record<string, { phone: Phone; accented: boolean }>> = {
  a: { phone: "a", accented: false }, á: { phone: "a", accented: true },
  e: { phone: "e", accented: false }, é: { phone: "e", accented: true },
  i: { phone: "i", accented: false }, í: { phone: "i", accented: true },
  o: { phone: "o", accented: false }, ó: { phone: "o", accented: true },
  u: { phone: "u", accented: false }, ú: { phone: "u", accented: true },
  // ü appears only in güe/güi, where it is a pronounced /w/ rather than silent.
  ü: { phone: "u", accented: false },
};

/** The vowels that soften a preceding `c` or `g`. */
const FRONT_VOWELS = new Set(["e", "i", "é", "í"]);

/** Consonants with no context sensitivity at all. */
const PLAIN_CONSONANTS: Readonly<Record<string, Phone>> = {
  b: "b", d: "d", f: "f", k: "k", l: "l", m: "m", n: "n",
  p: "p", s: "s", t: "t", w: "w",
  ñ: "ɲ",
  v: "b", // /b/ and /v/ are one phoneme — the spelling distinction is not real
  z: "s", // seseo
  j: "x",
};

/**
 * `x` is the one genuinely irregular letter, so it gets a list.
 *
 * Default is /ks/ (*taxi*, *examen*). Word-initially it is /s/ (*xilófono*).
 * And in a set of mostly Nahuatl-derived place names it kept the old value of
 * the letter and is /x/ — the same sound as the `j` that *México* is
 * pronounced with and, in Spain, spelled with. This list is not exhaustive and
 * does not need to be; it is a lookup of last resort.
 */
const X_AS_JOTA: ReadonlySet<string> = new Set([
  "méxico", "mexicano", "mexicana", "mexicanos", "mexicanas",
  "oaxaca", "oaxaqueño", "oaxaqueña",
  "texas", "texano", "texana",
  "xavier", "ximena",
]);

/** Everything we are willing to ignore rather than reject. */
const IGNORED = /[\s'’\-–—.,;:!?¡¿()"«»]/;

const normalize = (word: string): string => word.trim().toLowerCase();

/**
 * Walk the letters, emitting phones.
 *
 * Digraphs are tested before single letters, which is what lets the rest of the
 * pipeline treat `ch ll rr qu` as one segment each — and is why `syllabify`
 * gets to say "one consonant between two vowels" and mean one array element.
 */
function toSegments(word: string): Segment[] {
  const out: Segment[] = [];
  const push = (phone: Phone, accented = false): void => {
    out.push({ phone, accented });
  };
  const previous = (): Phone | null => out.at(-1)?.phone ?? null;

  let i = 0;
  while (i < word.length) {
    const c = word[i];
    const next = word[i + 1] ?? "";
    const third = word[i + 2] ?? "";

    // --- digraphs, longest first ---------------------------------------
    if (c === "c" && next === "h") { push("tʃ"); i += 2; continue; }
    if (c === "l" && next === "l") { push("ʝ"); i += 2; continue; } // yeísmo
    if (c === "r" && next === "r") { push("r"); i += 2; continue; } // always a trill
    // The `u` of qu/gu is silent before a front vowel — but pronounced before
    // a back one, which is why *cuando* and *guapo* are not special cases.
    if (c === "q" && next === "u" && FRONT_VOWELS.has(third)) { push("k"); i += 2; continue; }
    if (c === "g" && next === "u" && FRONT_VOWELS.has(third)) { push("g"); i += 2; continue; }
    // The diaeresis exists precisely to un-silence it: *vergüenza*.
    if (c === "g" && next === "ü") { push("g"); push("u"); i += 2; continue; }

    // --- vowels ---------------------------------------------------------
    const vowel = VOWEL_LETTERS[c];
    if (vowel) { push(vowel.phone, vowel.accented); i += 1; continue; }

    // --- context-sensitive consonants ------------------------------------
    if (c === "c") { push(FRONT_VOWELS.has(next) ? "s" : "k"); i += 1; continue; }
    if (c === "g") { push(FRONT_VOWELS.has(next) ? "x" : "g"); i += 1; continue; }
    if (c === "h") { i += 1; continue; } // always silent (`ch` was taken above)

    if (c === "y") {
      // Consonant before a vowel (*yo*, *ayer*); otherwise the vowel /i/ —
      // which the syllabifier then usually turns into a glide (*hay* → /aj/).
      push(next && VOWEL_LETTERS[next] ? "ʝ" : "i");
      i += 1;
      continue;
    }

    if (c === "r") {
      // Trill word-initially and after n/l/s (*rosa*, *honra*, *alrededor*),
      // tap everywhere else. This is the distinction the whole project exists
      // to score, so it is a rule rather than a guess.
      const p = previous();
      const trill = p === null || p === "n" || p === "l" || p === "s";
      push(trill ? "r" : "ɾ");
      i += 1;
      continue;
    }

    if (c === "x") {
      if (X_AS_JOTA.has(word)) push("x");
      else if (out.length === 0) push("s");
      else { push("k"); push("s"); }
      i += 1;
      continue;
    }

    const plain = PLAIN_CONSONANTS[c];
    if (plain) { push(plain); i += 1; continue; }

    if (IGNORED.test(c)) { i += 1; continue; }
    throw new Error(`Can't pronounce "${word}": unexpected character "${c}".`);
  }
  return out;
}

/**
 * Convert one Spanish word to its phones, syllables and stress.
 *
 * Throws on input it cannot pronounce rather than returning a partial result —
 * a silently mis-derived target would mis-align every frame downstream and show
 * up as the learner's fault.
 */
export function g2p(word: string): Pronunciation {
  const normalized = normalize(word);
  const segments = toSegments(normalized);
  const syllables = assignStress(syllabify(segments), normalized);

  if (syllables.length === 0) {
    throw new Error(`Can't pronounce "${word}": no vowel to build a syllable on.`);
  }

  return {
    word: normalized,
    syllables,
    // Read the phones back off the syllables, not off `segments`: the weak
    // vowels only become glides once syllabification has decided which of them
    // lost the peak.
    phones: syllables.flatMap((s) => s.phones),
    stressIndex: syllables.findIndex((s) => s.stressed),
  };
}

/**
 * Convert a whole card face, which is usually a phrase rather than a word.
 *
 * Each word is pronounced independently. Spanish really does resyllabify across
 * word boundaries in connected speech (*los amigos* runs as /lo-sa-mi-gos/),
 * and that is **not** modelled here — the aligner sees the words' phones
 * concatenated, so a boundary is the one place its spans will be soft.
 */
export function g2pPhrase(phrase: string): Pronunciation[] {
  return normalize(phrase)
    .split(/\s+/)
    .filter((w) => w.replace(new RegExp(IGNORED, "g"), "") !== "")
    .map(g2p);
}
