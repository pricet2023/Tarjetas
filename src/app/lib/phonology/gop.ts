/**
 * Goodness of Pronunciation: from "which frames were the /r/" to "was it one".
 *
 * Alignment (Phase 2) says where each phone is. This asks how well it was
 * said, and the answer has to be a *comparison* rather than a probability
 * (§4.5). `P(/r/) = 0.4` means nothing on its own; it is excellent if every
 * rival scored under 0.1 and wrong if tapped /ɾ/ scored 0.55:
 *
 * ```
 * GOP(p) = log P(p | frames) - max log P(q | frames)
 *                              q != p
 * ```
 *
 * **One deviation from the textbook, and it changes the sign.** Witt & Young
 * take the max over *all* labels including the target, so GOP is ≤ 0 and a
 * correct phone scores exactly 0. That throws away the whole good half of the
 * scale: every clean phone looks identical, and a z-score has nothing to work
 * with. Excluding the target from its own rival set makes a confident hit
 * *positive* — measured at +3 to +5 nats on native clips, against -3 for a tap
 * heard where a trill was wanted — and keeps the resolution where the
 * calibration needs it.
 *
 * Two layers sit on top of that, and both exist because a raw GOP is not
 * comparable across phonemes — /a/ is distinctive and always scores well,
 * while /r/, /ɾ/ and /l/ crowd each other even for natives (§4.6):
 *
 * 1. **A z-score against native speech.** `native-stats.generated.ts` holds a
 *    per-phone mean and σ measured on FLEURS es_419 read speech with the same
 *    model build the app runs. "Your /x/ sits 2.4σ below where natives sit" is
 *    a sentence; "-3.1 nats" is not.
 * 2. **A rival worth naming.** Because we know *which* phone won instead, the
 *    feedback can be diagnostic — "you said /ɾ/, wanted /r/" — which is the
 *    whole reason this project aligns instead of transcribing (§4.7).
 *
 * The second normalisation §4.6 describes, against the learner's own earlier
 * recordings, is deliberately not here: it needs history, which is
 * `phone_state` in Phase 6.
 */

import { forcedAlign, type LogProbs, type PhoneSpan, type TargetUnit } from "@/app/lib/align/ctc";
import { buildTarget } from "@/app/lib/align/target";

import { MODEL_LABELS, PHONES, type Phone } from "./inventory";
import { NATIVE_GOP, NATIVE_POOLED } from "./native-stats.generated";

/** One phone's GOP distribution over native speech. */
export interface PhoneStat {
  /** Mean GOP, nats per frame. Near 0 for a phone natives nail; more negative for a crowded one. */
  mean: number;
  /** Standard deviation. Never 0 — the generator floors it, or the z-score divides by nothing. */
  sd: number;
  /** How many native spans went into it. */
  n: number;
  /** The 5th percentile of native GOP for this phone: the line a verdict is cut on. */
  p05: number;
}

export type NativeStats = Readonly<Record<string, PhoneStat>>;

/**
 * Where the line sits: below the 5th percentile of native speech for that
 * phone, which is `PhoneStat.p05` in the generated stats.
 *
 * **A design choice, not a measurement** (§4.6, open decision 4). There is no
 * validation set — nobody has labelled these attempts — so the honest way to
 * pick a threshold is against the native distribution: "flag what fewer than
 * one native in twenty would produce". Nag more by moving `FLAG_QUANTILE` in
 * the generator and regenerating.
 *
 * The percentile is *measured* rather than taken as `mean - 1.64σ`, because
 * GOP is not Gaussian: it is bounded above (you cannot beat the best rival by
 * much) with a long left tail, so the two disagree — and the empirical one is
 * the one that means what it says. `z` is still reported, because "2.4σ below
 * native" is a sentence a person can read.
 *
 * This constant is only the fallback for a phone that has no native stats at
 * all, i.e. an uncalibrated build.
 */
export const FLAG_Z = -1.64;

/**
 * Confusions that are wrong but not *a different sound*.
 *
 * Only the glide/vowel pairs, and only because the model genuinely wavers on
 * them: we emit /w/ for *muy* and it answered `uː` (the note at the bottom of
 * `inventory.ts`). Telling a learner they said the wrong sound there would be
 * a lie about their mouth.
 *
 * /ɾ/ and /r/ are pointedly **not** here. That contrast is the feature.
 */
const NEAR_MISS: Readonly<Record<string, Phone>> = { j: "i", i: "j", w: "u", u: "w" };

export type Verdict = "good" | "close" | "off";

export interface PhoneScore {
  /** Our symbol, as G2P emitted it. */
  phone: string;
  /** Frames this phone owned, from the alignment. */
  start: number;
  end: number;
  /**
   * Mean per-frame margin over the best rival, in nats.
   *
   * Positive is good and bigger is better — the target is not in its own rival
   * set, so this is how much better it explained the frames than anything else
   * could. Native speech measures around +5; a tap heard where a trill was
   * wanted measures about -3. Not comparable across phones (§4.6): use `z`.
   */
  gop: number;
  /** The rival, as one of our units when it is one. */
  rival: string | null;
  /** The rival's raw model label — `ɹ` for an English R, which is not one of our units. */
  rivalLabel: string;
  /** Standard deviations from native, or `null` when this phone has no native stats. */
  z: number | null;
  /** False when `z` came from the pooled fallback rather than this phone's own stats. */
  calibrated: boolean;
  verdict: Verdict;
}

export interface ScoreOptions {
  /** The model's row-indexed labels, as `model.score()` returns them. */
  labels: readonly string[];
  /** The CTC blank's row. Excluded from the rival set — see below. */
  blank: number;
  /** Per-phone native distribution. Defaults to the generated one. */
  stats?: NativeStats;
  /**
   * What to fall back to for a phone the corpus barely saw. Defaults to the
   * generated pooled distribution; pass `null` to score raw, which is what the
   * generator itself does — those observations *are* the calibration.
   */
  pooled?: PhoneStat | null;
}

/**
 * Score an aligned utterance.
 *
 * `target` must be the same `TargetUnit[]` that produced `spans`, not a
 * rebuilt one: `buildTarget` adds composite labels in context (`eɪ` counts as
 * our /e/ when a /j/ follows), and scoring against rows the aligner did not
 * use would mark a correct *seis* wrong.
 */
export function scorePhones(
  logProbs: LogProbs,
  spans: readonly PhoneSpan[],
  target: readonly TargetUnit[],
  { labels, blank, stats = NATIVE_GOP, pooled = NATIVE_POOLED }: ScoreOptions,
): PhoneScore[] {
  if (spans.length !== target.length) {
    throw new Error(
      `Got ${spans.length} spans for ${target.length} target phones. ` +
        "They must be the aligner's own output for this target.",
    );
  }
  const rivals = rivalSets(labels, logProbs.vocabSize, blank);

  return spans.map((span, i) => {
    const own = new Set(target[i].rows);
    const mine = sumOverSpan(logProbs, span, target[i].rows);

    // The best *other* explanation of the same frames. Every candidate is
    // evaluated over the whole span rather than frame by frame, so the answer
    // is one rival for the phone instead of a different one per frame — which
    // is what makes it sayable: "you said /ɾ/".
    let bestScore = Number.NEGATIVE_INFINITY;
    let best: RivalSet | null = null;
    for (const rival of rivals) {
      const rows = rival.rows.filter((r) => !own.has(r));
      if (rows.length === 0) continue;
      const score = sumOverSpan(logProbs, span, rows);
      if (score > bestScore) {
        bestScore = score;
        best = rival;
      }
    }

    const frames = span.end - span.start;
    const gop = best ? (mine - bestScore) / frames : 0;
    // A phone with no distribution of its own falls back to every native span
    // pooled — a blunt instrument, but better calibrated than nothing.
    const stat = stats[span.label];
    const against = stat ?? (pooled && pooled.n > 0 ? pooled : null);
    const z = against ? (gop - against.mean) / against.sd : null;

    return {
      phone: span.label,
      start: span.start,
      end: span.end,
      gop,
      rival: best?.phone ?? null,
      rivalLabel: best?.label ?? "",
      z,
      calibrated: stat !== undefined,
      verdict: verdictOf(span.label, gop, z, against, best?.phone ?? null),
    };
  });
}

/** `g2p(word).phones` in, scored phones out — the whole of Phases 1, 2 and 5 in one call. */
export function scoreUtterance(
  logProbs: LogProbs,
  phones: readonly Phone[],
  options: ScoreOptions,
): PhoneScore[] {
  const target = buildTarget(phones, options.labels);
  const spans = forcedAlign(logProbs, target, { blank: options.blank });
  return scorePhones(logProbs, spans, target, options);
}

/**
 * One number for the whole attempt, for `card_reviews.score` (Phase 6).
 *
 * A share of phones, not a mean of z-scores: one catastrophic /x/ should not
 * be averaged away by nine easy vowels, and a z-mean is not a quantity anyone
 * can interpret. A near miss counts half. This is a *display and logging*
 * number — the calibration that matters is per phone, and `phone_scores` keeps
 * all of it.
 */
/**
 * What `summarise().score` has to reach for the attempt to count as known —
 * which is what reaches `card_reviews.knew`, and therefore the scheduler.
 *
 * **A design choice, like `FLAG_Z`, and calibrated the same way.** The flag
 * line is the 5th percentile of native speech per phone, so a native trips it
 * about one phone in twenty by construction; a ten-phone sentence would then
 * fail a native roughly two attempts in five if a single flag were
 * disqualifying. Requiring four fifths of the phones instead leaves a native
 * comfortably clear while still failing the case this exists to catch — one
 * genuinely wrong sound in a short word, which is a quarter of *perro*.
 */
export const PASS_SCORE = 0.8;

export function summarise(scores: readonly PhoneScore[]): { score: number; worst: PhoneScore | null } {
  if (scores.length === 0) return { score: 0, worst: null };
  const credit = scores.reduce(
    (total, s) => total + (s.verdict === "good" ? 1 : s.verdict === "close" ? 0.5 : 0),
    0,
  );
  const worst = scores.reduce((a, b) => ((b.z ?? b.gop) < (a.z ?? a.gop) ? b : a));
  return { score: credit / scores.length, worst };
}

function verdictOf(
  phone: string,
  gop: number,
  z: number | null,
  against: PhoneStat | null,
  rival: string | null,
): Verdict {
  // No stats at all (an uncalibrated build, or the generator has never been
  // run): say nothing rather than invent a verdict from a margin in nats that
  // nothing has made comparable.
  if (!against || z === null) return "good";
  const flagged = Number.isFinite(against.p05) ? gop < against.p05 : z < FLAG_Z;
  if (!flagged) return "good";
  return NEAR_MISS[phone] === rival ? "close" : "off";
}

interface RivalSet {
  /** Our unit, when the candidate is one of ours. */
  phone: string | null;
  /** What to show: our symbol, or the raw model label. */
  label: string;
  rows: number[];
}

/**
 * Every hypothesis that competes with the target, collapsed the way we score.
 *
 * Two halves, and the second one matters more than it looks:
 *
 * - **Our 24 units**, each summed over its own rows, so a rival /b/ is
 *   `b + β + v` rather than three weak candidates that individually lose to
 *   the target (§4.1).
 * - **Every other label in the model's inventory, individually.** A learner
 *   saying an English R produces `ɹ`, which is not one of our units at all —
 *   restrict the rivals to Spanish and that attempt scores *well*, because
 *   nothing Spanish explained it either. §10.3 found the unrestricted rivals
 *   phonetically sensible on native speech; this is the case where they are
 *   load-bearing.
 *
 * **The blank is excluded**, which is the §10.3 trap and the reason this
 * function takes it as an argument. `<pad>` is the argmax on 24 of 30 frames
 * of a *native* recording (§13.3), so a rival set containing it would measure
 * peakiness rather than pronunciation.
 */
function rivalSets(labels: readonly string[], vocabSize: number, blank: number): RivalSet[] {
  const row = new Map<string, number>();
  labels.forEach((label, index) => {
    if (!row.has(label)) row.set(label, index);
  });

  const sets: RivalSet[] = [];
  const claimed = new Set<number>([blank]);

  for (const phone of PHONES) {
    const rows = MODEL_LABELS[phone]
      .map((label) => row.get(label))
      .filter((r): r is number => r !== undefined);
    for (const r of rows) claimed.add(r);
    if (rows.length > 0) sets.push({ phone, label: phone, rows });
  }

  for (let r = 0; r < vocabSize; r += 1) {
    if (claimed.has(r)) continue;
    sets.push({ phone: null, label: labels[r] ?? `#${r}`, rows: [r] });
  }
  return sets;
}

/** `log Σ exp` over `rows`, summed across the span's frames. Max-shifted per frame. */
function sumOverSpan(logProbs: LogProbs, span: PhoneSpan, rows: readonly number[]): number {
  const { data, vocabSize } = logProbs;
  let total = 0;
  for (let t = span.start; t < span.end; t += 1) {
    const offset = t * vocabSize;
    let max = Number.NEGATIVE_INFINITY;
    for (const r of rows) {
      const v = data[offset + r];
      if (v > max) max = v;
    }
    if (max === Number.NEGATIVE_INFINITY) return Number.NEGATIVE_INFINITY;
    let sum = 0;
    for (const r of rows) sum += Math.exp(data[offset + r] - max);
    total += max + Math.log(sum);
  }
  return total;
}
