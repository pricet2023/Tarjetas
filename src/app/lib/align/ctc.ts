/**
 * CTC forced alignment: which frames were which phone.
 *
 * The input is ~50 frames per second of label distributions from the acoustic
 * model, plus the phones G2P says the learner *should* have said. The question
 * is not "what was said?" — that is a search over every possible label
 * sequence — but the much easier "given that it was /k a s a/, *when* did each
 * part happen?" (plan §4.4). Dynamic programming answers it in
 * `O(frames × states)`: about 900 cells for *casa*.
 *
 * Everything here is pure and dependency-free, and every test builds its own
 * posterior matrix by hand, so a bug in Phase 3's model plumbing can never be
 * mistaken for a bug in the algorithm. That is the whole reason this phase
 * comes before any audio.
 *
 * Two things the result unlocks, and why the effort is worth it:
 *
 * - **Scoring.** Knowing the frames for a phone is what lets Phase 5 ask
 *   whether that stretch sounded like an /r/ (GOP, §4.5).
 * - **Credit assignment.** When an attempt is bad, alignment says *which*
 *   sound was at fault, which is what makes the per-phoneme learner model in
 *   §4.7 identifiable at all.
 */

/**
 * The acoustic model's output: one log-probability distribution per frame.
 *
 * Flat and frame-major, matching the `[1, frames, vocab]` tensor an ONNX
 * `Wav2Vec2ForCTC` hands back — frame `t`'s row starts at `t * vocabSize`, so
 * label `v` at frame `t` is `data[t * vocabSize + v]`.
 *
 * Log *probabilities*, not raw logits — see `logSoftmax`. The alignment itself
 * is indifferent (a per-frame constant shifts every state in a column equally
 * and cannot change which path wins) but `PhoneSpan.score` is only readable if
 * the rows are normalised.
 */
export interface LogProbs {
  readonly data: ArrayLike<number>;
  readonly frames: number;
  readonly vocabSize: number;
}

/**
 * One phone of the alignment target.
 *
 * `rows` is many-to-one on purpose: the model has 392 labels and we score ~24
 * units, so several of its rows can count as one of ours. Their probabilities
 * are summed — which is what the allophone collapse in §4.1 actually *is*
 * numerically. P(/b/) is P(`b`) + P(`β`), because a native saying *haba* with
 * a soft [β] has not made a mistake.
 *
 * Build these with `buildTarget` rather than by hand; it owns the inventory.
 */
export interface TargetUnit {
  /** What to report — our symbol (`"r"`), not the model's label. */
  readonly label: string;
  /** Vocab rows counting as this unit. Summed. Must not include the blank. */
  readonly rows: readonly number[];
}

/** The frames one target phone claimed, and how well they matched it. */
export interface PhoneSpan {
  label: string;
  /** First frame of the span. */
  start: number;
  /** One past the last frame, so `end - start` is the duration in frames. */
  end: number;
  /**
   * Mean per-frame `log P(label | frame)` over `[start, end)`.
   *
   * Raw evidence, not yet a verdict: it is not comparable across phonemes
   * (§4.6), and a CTC model is peaky, so a long span can dip here purely
   * because the model went blank in the middle of a sound it was sure about.
   * Phase 5 thresholds the *margin* over the best non-blank rival, per §10.3.
   */
  score: number;
}

export interface AlignOptions {
  /**
   * Index of the CTC blank ("no new phone here", §4.4).
   *
   * No default, deliberately. It is 0 for `wav2vec2-xlsr-53-espeak-cv-ft`
   * (`<pad>`, from `pad_token_id`) but 37 for the §10.4 fallback model, and
   * getting it wrong fails silently — the aligner would treat some real phone
   * as the blank and quietly mis-align everything. Read it from the model's
   * config and pass it in.
   */
  readonly blank: number;
}

const NEG_INF = Number.NEGATIVE_INFINITY;

/**
 * `log Σ exp(x)` over a chosen subset of one frame's row, max-shifted so a
 * confident model's very negative logs cannot underflow to zero.
 */
function logSumExpRows(
  data: ArrayLike<number>,
  offset: number,
  rows: readonly number[],
): number {
  let max = NEG_INF;
  for (const r of rows) {
    const v = data[offset + r];
    if (v > max) max = v;
  }
  if (max === NEG_INF) return NEG_INF;
  let sum = 0;
  for (const r of rows) sum += Math.exp(data[offset + r] - max);
  // A single row is the common case and comes back exactly: max + log 1.
  return max + Math.log(sum);
}

/**
 * Align `target` to `logProbs`, returning one span per target phone in order.
 *
 * The recursion is Viterbi — `max` over the paths into each cell, giving the
 * single best alignment. Not the forward algorithm's `log Σ exp`, which gives
 * the total probability of *all* alignments and no path to read off (§4.4).
 *
 * The state space is the target interleaved with blanks, `∅ k ∅ a ∅ s ∅ a ∅`,
 * and a path may only stay, advance one state, or skip a blank between two
 * *different* phones. Frames the winning path spends in a blank state belong
 * to no span, so consecutive spans need not touch.
 *
 * Throws rather than returning a degraded alignment: a silently mis-aligned
 * target reads back as the learner's mistake, which is the worst possible
 * failure for this feature.
 */
export function forcedAlign(
  logProbs: LogProbs,
  target: readonly TargetUnit[],
  { blank }: AlignOptions,
): PhoneSpan[] {
  const { data, frames: T, vocabSize: V } = logProbs;
  const n = target.length;

  if (!Number.isInteger(T) || T <= 0) {
    throw new Error(`Nothing to align: the posterior matrix has ${T} frames.`);
  }
  if (!Number.isInteger(V) || V <= 0 || data.length !== T * V) {
    throw new Error(
      `Posterior matrix is ${data.length} values, but ${T} frames × ${V} labels needs ${T * V}.`,
    );
  }
  if (n === 0) throw new Error("Nothing to align against: the target has no phones.");
  if (!Number.isInteger(blank) || blank < 0 || blank >= V) {
    throw new Error(`Blank index ${blank} is not a label in a ${V}-label vocabulary.`);
  }

  for (const [i, unit] of target.entries()) {
    if (unit.rows.length === 0) {
      throw new Error(
        `Target phone ${i} (/${unit.label}/) has no model labels, so no frame can match it. ` +
          "Check the inventory's mapping — a lookup on the wrong codepoint (ASCII \"g\" for IPA \"ɡ\") looks exactly like this.",
      );
    }
    for (const r of unit.rows) {
      if (!Number.isInteger(r) || r < 0 || r >= V) {
        throw new Error(`Target phone ${i} (/${unit.label}/) uses row ${r}, outside a ${V}-label vocabulary.`);
      }
      if (r === blank) {
        throw new Error(
          `Target phone ${i} (/${unit.label}/) counts the blank (row ${blank}) as itself, which would match every silent frame.`,
        );
      }
    }
  }

  // A legal path needs one frame per phone, plus a frame for the blank that
  // has to sit between two identical neighbours (see `canSkipBlank`).
  let minimum = n;
  for (let i = 1; i < n; i += 1) if (target[i].label === target[i - 1].label) minimum += 1;
  if (T < minimum) {
    throw new Error(
      `Can't align ${n} phones (${target.map((u) => u.label).join(" ")}) to ${T} frames: ` +
        `at least ${minimum} are needed, one per phone plus a blank between each repeated pair. ` +
        "Either the recording is shorter than the words or the target is not what was said.",
    );
  }

  // Per-frame log P(unit) — the allophone sum, hoisted out of the DP.
  const emit = new Float64Array(T * n);
  for (let t = 0; t < T; t += 1) {
    const offset = t * V;
    for (let i = 0; i < n; i += 1) emit[t * n + i] = logSumExpRows(data, offset, target[i].rows);
  }

  // `∅ u0 ∅ u1 … ∅`: even states are the blank, odd state s is unit (s-1)/2.
  const S = 2 * n + 1;
  const stateEmit = (s: number, t: number): number =>
    s % 2 === 0 ? data[t * V + blank] : emit[t * n + (s - 1) / 2];

  /**
   * A path may jump straight from one phone to the next, skipping the blank
   * between them — but only when they are *different* phones. Two identical
   * neighbours with no blank between them would collapse back into one under
   * the CTC rule, so the blank is what makes a genuine repeat expressible
   * (§4.4). Allowing the skip here is the classic silent mis-alignment of
   * every word with a doubled sound.
   */
  const canSkipBlank = (s: number): boolean =>
    s >= 3 && s % 2 === 1 && target[(s - 1) / 2].label !== target[(s - 3) / 2].label;

  const best = new Float64Array(T * S).fill(NEG_INF);
  const cameFrom = new Int32Array(T * S).fill(-1);

  // Only the leading blank and the first phone can own frame 0.
  best[0] = stateEmit(0, 0);
  best[1] = stateEmit(1, 0);

  for (let t = 1; t < T; t += 1) {
    const now = t * S;
    const before = now - S;
    for (let s = 0; s < S; s += 1) {
      let from = s;
      let score = best[before + s]; // stay: the phone continues
      if (s >= 1 && best[before + s - 1] > score) {
        score = best[before + s - 1]; // advance one state
        from = s - 1;
      }
      if (canSkipBlank(s) && best[before + s - 2] > score) {
        score = best[before + s - 2];
        from = s - 2;
      }
      if (score === NEG_INF) continue; // unreachable this early
      best[now + s] = score + stateEmit(s, t);
      cameFrom[now + s] = from;
    }
  }

  // The path must have finished the last phone: it ends either in that phone
  // or in the trailing blank.
  const last = (T - 1) * S;
  let state = best[last + S - 1] >= best[last + S - 2] ? S - 1 : S - 2;
  if (best[last + state] === NEG_INF) {
    throw new Error(
      `No legal alignment of ${target.map((u) => u.label).join(" ")} to ${T} frames — ` +
        "every path through the posterior matrix has zero probability.",
    );
  }

  const states = new Int32Array(T);
  for (let t = T - 1; t >= 0; t -= 1) {
    states[t] = state;
    state = cameFrom[t * S + state];
  }

  // Runs of the same state are one span. Unit states are entered once and
  // never re-entered, so a phone's frames are always contiguous.
  const spans: PhoneSpan[] = [];
  for (let t = 0; t < T; ) {
    const s = states[t];
    let end = t + 1;
    while (end < T && states[end] === s) end += 1;
    if (s % 2 === 1) {
      const i = (s - 1) / 2;
      let sum = 0;
      for (let f = t; f < end; f += 1) sum += emit[f * n + i];
      spans.push({ label: target[i].label, start: t, end, score: sum / (end - t) });
    }
    t = end;
  }
  return spans;
}

/**
 * Normalise raw model output into `LogProbs`.
 *
 * A CTC head emits unnormalised logits; `log P` is what §4.5 subtracts to get
 * a GOP margin and what makes `PhoneSpan.score` mean anything. Max-shifted per
 * frame, so the exponentials cannot overflow.
 */
export function logSoftmax(
  logits: ArrayLike<number>,
  frames: number,
  vocabSize: number,
): LogProbs & { data: Float32Array } {
  if (logits.length !== frames * vocabSize) {
    throw new Error(
      `Logits are ${logits.length} values, but ${frames} frames × ${vocabSize} labels needs ${frames * vocabSize}.`,
    );
  }
  const data = new Float32Array(frames * vocabSize);
  for (let t = 0; t < frames; t += 1) {
    const offset = t * vocabSize;
    let max = NEG_INF;
    for (let v = 0; v < vocabSize; v += 1) {
      const x = logits[offset + v];
      if (x > max) max = x;
    }
    let sum = 0;
    for (let v = 0; v < vocabSize; v += 1) sum += Math.exp(logits[offset + v] - max);
    const logZ = max + Math.log(sum);
    for (let v = 0; v < vocabSize; v += 1) data[offset + v] = logits[offset + v] - logZ;
  }
  return { data, frames, vocabSize };
}
