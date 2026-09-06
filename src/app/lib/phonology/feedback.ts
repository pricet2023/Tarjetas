/**
 * From `PhoneScore[]` to something a person can act on.
 *
 * §4.1 is the whole argument for this file: "72% correct" is unactionable and
 * "your /r/ was a tap, not a trill" is not. Phases 1–5 do the work that makes
 * the second sentence sayable — alignment says *which* frames were the /r/,
 * and GOP's rival says what won instead — so all that is left is to say it.
 *
 * Two jobs, both pure, both tested, neither touching React:
 *
 * 1. **Regroup.** The scorer returns a flat list in spoken order, because that
 *    is what the aligner produced. A learner reads syllables. `groupByWord`
 *    folds the flat list back onto the `Pronunciation[]` that G2P emitted,
 *    which is the only thing that knows where the syllable boundaries are.
 * 2. **Diagnose.** `diagnose` turns one score into a sentence, and where there
 *    is a specific mouth-shaped fix, into that too.
 *
 * The advice below is deliberately about *articulation* rather than about
 * scores. It is the half of this that is a Spanish teacher's judgement rather
 * than a measurement, and it is written down here so it can be argued with.
 */

import type { Pronunciation } from "./g2p";
import type { PhoneScore } from "./gop";

export interface SyllableFeedback {
  /** This syllable's phones, in spoken order, with their scores. */
  phones: PhoneScore[];
  stressed: boolean;
  /**
   * The weakest phone in the syllable — what a per-syllable meter reads.
   * `null` only for the degenerate empty syllable, which G2P cannot emit.
   */
  worst: PhoneScore | null;
}

export interface WordFeedback {
  /** The normalised spelling, as G2P read it. */
  word: string;
  syllables: SyllableFeedback[];
}

/**
 * Fold the scorer's flat list back onto the words and syllables it came from.
 *
 * `scores` must be the output of scoring `words.flatMap(w => w.phones)` — the
 * same phones, in the same order. Anything else is a caller bug that would
 * otherwise show up as feedback attached to the wrong syllable, which reads to
 * the learner as the app being wrong about their mouth.
 */
export function groupByWord(
  words: readonly Pronunciation[],
  scores: readonly PhoneScore[],
): WordFeedback[] {
  const expected = words.reduce((n, w) => n + w.phones.length, 0);
  if (expected !== scores.length) {
    throw new Error(
      `Got ${scores.length} scores for ${expected} phones. ` +
        "They must be the scores for exactly these words, in order.",
    );
  }

  let at = 0;
  return words.map((word) => ({
    word: word.word,
    syllables: word.syllables.map((syllable) => {
      const phones = scores.slice(at, at + syllable.phones.length);
      at += syllable.phones.length;
      return {
        phones,
        stressed: syllable.stressed,
        // Worst by z where there is one, by raw margin where there is not.
        // Mixing the two across a syllable is safe because a syllable's phones
        // are either all calibrated or all not — the stats are per build, not
        // per attempt.
        worst: phones.reduce<PhoneScore | null>(
          (a, b) => (a === null || rank(b) < rank(a) ? b : a),
          null,
        ),
      };
    }),
  }));
}

const rank = (s: PhoneScore): number => s.z ?? s.gop;

/**
 * How lit a meter for this phone should be, 0..1.
 *
 * **Display only.** It is a squashed z-score, not a probability and not an
 * accuracy: the range is chosen so that the native mean sits comfortably lit
 * and the flag line (§4.6, the 5th percentile, around -1.6σ) sits about a
 * fifth of the way up. A phone with no calibration at all reads full rather
 * than empty — an uncalibrated build should look silent, not accusing.
 */
export function meterOf(score: PhoneScore): number {
  if (score.z === null) return 1;
  return Math.min(1, Math.max(0, (score.z + 2.5) / 3.5));
}

export interface Diagnosis {
  /** What happened, in one clause. */
  message: string;
  /** How to fix it, when there is a specific fix. `null` for a clean phone. */
  hint: string | null;
}

/**
 * One phone's verdict as a sentence.
 *
 * The rival is what makes this diagnostic rather than merely negative, so it
 * is used wherever it is informative: a named pair first ("that was a tap, not
 * a trill"), then a rival outside Spanish ("that was an English r"), then the
 * bare comparison, and only then a generic miss.
 */
export function diagnose(score: PhoneScore): Diagnosis {
  const phone = score.phone;
  const hint = ARTICULATION[phone] ?? null;

  if (score.verdict === "good") {
    return { message: "clean", hint: null };
  }

  if (score.verdict === "close") {
    return {
      message: `nearly — /${phone}/ drifted towards /${score.rival ?? "?"}/`,
      hint: hint ?? "Close enough to be heard, but let it stay a glide rather than a full vowel.",
    };
  }

  const pair = score.rival ? CONFUSIONS[`${phone}>${score.rival}`] : undefined;
  if (pair) return { message: pair, hint };

  const foreign = FOREIGN_RIVALS[score.rivalLabel];
  if (foreign) return { message: `that was ${foreign}`, hint };

  if (score.rival) return { message: `heard as /${score.rival}/`, hint };

  return { message: `/${phone}/ didn't land`, hint };
}

/**
 * The named confusions — `target>rival`.
 *
 * Only pairs where the *pair itself* says something the generic "heard as /x/"
 * does not. The trill/tap row is the one this whole project was built to
 * print.
 */
const CONFUSIONS: Readonly<Record<string, string>> = {
  "r>ɾ": "that was a tap, not a trill",
  "ɾ>r": "that was a trill where one quick tap belongs",
  "r>l": "the trill came out as an /l/",
  "ɾ>l": "the tap came out as an /l/",
  "ɾ>d": "the tap came out as a /d/",
  "x>k": "that stopped like a /k/ instead of rasping",
  "x>g": "that stopped like a /g/ instead of rasping",
  "ɲ>n": "that was a plain /n/",
  "ʝ>i": "that stayed a vowel instead of becoming a consonant",
  "tʃ>ʃ": "that was the *sh* of “ship”, not the *ch* of “chip”",

  // Voicing, both ways. Spanish stops are unaspirated, so an English speaker's
  // aspirated /p t k/ often lands on the voiced neighbour and vice versa.
  "b>p": "that came out voiceless",
  "d>t": "that came out voiceless",
  "g>k": "that came out voiceless",
  "p>b": "that came out voiced",
  "t>d": "that came out voiced",
  "k>g": "that came out voiced",
};

/**
 * Model labels that are not units of ours, but *are* worth naming.
 *
 * §10.3 measured that the rivals stay phonetically sensible without
 * restricting them to Spanish, and this is where that pays: an English speaker
 * saying an English R produces `ɹ`, which is not a Spanish sound at all. "You
 * used an English r" is far more useful than "not quite".
 */
const FOREIGN_RIVALS: Readonly<Record<string, string>> = {
  "ɹ": "an English *r*",
  "ɻ": "an English *r*",
  "ʁ": "a French *r*",
  "ə": "a schwa — the vowel English puts in unstressed syllables",
  "ʌ": "an English *uh*",
  "æ": "the vowel of English “cat”",
  "z": "an English *z*",
  "ʃ": "the *sh* of “ship”",
  "ʒ": "the *s* of “measure”",
  "eɪ": "an English long *a* — the vowel glided instead of staying pure",
  "oʊ": "an English long *o* — the vowel glided instead of staying pure",
  "ɑ": "an English *ah*",
  "ŋ": "an *ng*",
};

/**
 * What to actually do with your mouth, per phone.
 *
 * Only the phones where an English speaker predictably goes wrong (§4.1) —
 * there is no advice worth reading for /m/. Note the three that are about
 * *softening*: Spanish /b d g/ between vowels are [β ð ɣ], which we score as
 * one unit with the stops (§4.1), so a hard English stop there is not marked
 * wrong. It is still worth saying, because it is most of what makes a learner
 * sound foreign while scoring fine.
 */
const ARTICULATION: Readonly<Record<string, string>> = {
  r: "Tongue tip resting light behind your top teeth, then push air until it flutters on its own — you can't force a trill, only let it happen.",
  "ɾ": "One flick of the tongue tip, the *dd* in “ladder”. Not a trill, and not an English *r*.",
  x: "Friction at the back of the throat, like the *ch* of “loch”. If your tongue is near the front you'll get an /h/.",
  "ɲ": "One sound, not *n* + *y*: the middle of the tongue goes flat against the roof of your mouth.",
  "ʝ": "English *y* in “yes”, but pressed closer so it buzzes a little.",
  b: "Never an English *v* — the lips do the work. Between vowels they should almost, but not quite, meet.",
  d: "Tongue tip on the back of your top teeth. Between vowels it softens all the way to the *th* of “this”.",
  g: "Between vowels this is a soft rasp, not a hard stop.",
  t: "Tongue on the *teeth*, not the ridge behind them, and no puff of air after it.",
  p: "No puff of air after it — hold your hand in front of your mouth and it shouldn't move.",
  k: "No puff of air after it.",
  l: "Light and forward, tongue tip up. Spanish has no dark *l* like the one in English “full”.",
  s: "A plain hiss, never a *z*, even between vowels.",
  a: "Short, open and steady. Spanish vowels don't glide.",
  e: "Short and steady — no glide towards /i/ the way English “say” does.",
  i: "Short and tight. English “ee” is longer than this.",
  o: "Short and rounded — no glide towards /u/ the way English “go” does.",
  u: "Short, rounded, and further back than English “oo”.",
  j: "A glide, not a full vowel: pass through it on the way to the next sound.",
  w: "A glide, not a full vowel: pass through it on the way to the next sound.",
};

/**
 * The single line a card's result leads with.
 *
 * The worst phone, because that is the one thing worth changing before the
 * next attempt — a list of six mediocre phones is a report, not coaching.
 */
export function headline(worst: PhoneScore | null, score: number): string {
  if (!worst || worst.verdict === "good") {
    return score >= 1 ? "Every sound landed." : "Close — nothing badly wrong.";
  }
  const { message } = diagnose(worst);
  return `/${worst.phone}/: ${message}.`;
}
