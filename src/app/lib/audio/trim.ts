/**
 * Energy endpointing: find where the speech is in a recording, and throw the
 * rest away.
 *
 * This exists because of how the aligner behaves, not because of tidiness.
 * Forced alignment has to place every phone of the target somewhere in the
 * frames it is given (§4.4), so 500 ms of room tone in front of the word is
 * 25 frames the path has to spend — and the cheapest way to spend them is on
 * the first phone. The learner then gets a bad /p/ they never said, and every
 * boundary after it is dragged along. Same at the tail.
 *
 * It is also the one part of the capture path that is pure arithmetic, so it
 * is the one part `jsdom` can test (§5: no `AudioContext` here). Everything
 * measured about the decision is in the constants below.
 */

/** Nothing in dB is allowed to be -Infinity; a digitally silent frame lands here. */
const DB_FLOOR = -120;

/**
 * Below this peak, the recording is not quiet — it is *empty*.
 *
 * -60 dBFS is a thousandth of full scale. §10.6's headless run really did
 * produce a buffer of exact zeros (macOS never granted TCC access), and that
 * is the case this catches: a dead or muted input, where the honest answer is
 * "I didn't hear anything" rather than a page of terrible phone scores.
 *
 * It is deliberately *absolute* even though everything else here is relative.
 * A relative test cannot tell silence from silence, because noise floor and
 * peak are then the same number. Real speech from a quiet mic survives: the
 * model sees zero-mean unit-variance audio (`normalize.ts`), so absolute level
 * does not affect the score, only this gate.
 */
const SILENT_PEAK_DB = -60;

/**
 * How far above the noise floor a frame has to be to count as speech: 6 dB, or
 * a quarter of the way up to the peak, whichever is more.
 *
 * The quarter is what handles a loud, clean recording (floor -70, peak -15 →
 * threshold -56, well under any real phoneme). The 6 dB minimum is what
 * handles a noisy one, where a proportional rule would put the threshold
 * inside the noise.
 */
const MARGIN_DB = 6;
const MARGIN_FRACTION = 0.25;

export interface TrimOptions {
  sampleRate: number;
  /** Analysis window. 20 ms is the model's own frame (§13.2, 49.4 fps). */
  frameMs: number;
  /** Window step. Half a frame, so an onset is located to ±10 ms. */
  hopMs: number;
  /**
   * Kept either side of the detected speech.
   *
   * Not politeness. A plosive is a *silence* followed by a burst — the closure
   * of the /p/ in *perro* has no energy at all — so the first frame over
   * threshold is already inside the phone, and cutting there removes the
   * evidence that it was a stop. 80 ms is four model frames.
   */
  padMs: number;
  /**
   * Frames in a row required before speech is declared to have started.
   *
   * A lip smack, a mouse click on the record button or a chair creak is one or
   * two frames. Three at a 10 ms hop is 40 ms of continuous sound, which no
   * click survives and no phoneme fails.
   */
  minRunFrames: number;
}

const DEFAULTS: Omit<TrimOptions, "sampleRate"> = {
  frameMs: 20,
  hopMs: 10,
  padMs: 80,
  minRunFrames: 3,
};

export interface Endpoints {
  /** First sample kept, padding included. */
  start: number;
  /** One past the last sample kept. */
  end: number;
  /** The estimated noise floor, dBFS. */
  floorDb: number;
  /** The loudest frame, dBFS. */
  peakDb: number;
  /** What a frame had to beat, dBFS. */
  thresholdDb: number;
}

/** Root-mean-square of one window, in dBFS. */
function rmsDb(samples: Float32Array, at: number, length: number): number {
  let sum = 0;
  const end = Math.min(at + length, samples.length);
  for (let i = at; i < end; i += 1) sum += samples[i] * samples[i];
  const n = end - at;
  if (n === 0) return DB_FLOOR;
  const rms = Math.sqrt(sum / n);
  return rms > 0 ? Math.max(DB_FLOOR, 20 * Math.log10(rms)) : DB_FLOOR;
}

/** Per-frame energy, dBFS, at the configured window and hop. Exported for tests and meters. */
export function frameEnergies(samples: Float32Array, options: Partial<TrimOptions> & { sampleRate: number }): number[] {
  const { sampleRate, frameMs, hopMs } = { ...DEFAULTS, ...options };
  const frame = Math.max(1, Math.round((frameMs / 1000) * sampleRate));
  const hop = Math.max(1, Math.round((hopMs / 1000) * sampleRate));
  const energies: number[] = [];
  for (let at = 0; at < samples.length; at += hop) energies.push(rmsDb(samples, at, frame));
  return energies;
}

/**
 * The 20th percentile frame, as the noise floor.
 *
 * Not the minimum: one anomalously dead frame (a buffer glitch, or the gap
 * inside a stop consonant) would put the floor 20 dB too low and the threshold
 * with it. Not the mean either, because on a short clip the speech dominates
 * the mean. A percentile assumes only that a fifth of the recording is not
 * speech, which is true of anything captured by pressing a button.
 */
function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const at = Math.min(sorted.length - 1, Math.max(0, Math.floor(fraction * sorted.length)));
  return sorted[at];
}

/**
 * Where the speech starts and ends, or `null` if there is none.
 *
 * `null` means "nothing was said", and the caller is expected to say so rather
 * than score it — an empty recording aligned against a target produces a
 * confident-looking page of failures that are the microphone's fault.
 */
export function findEndpoints(
  samples: Float32Array,
  options: Partial<TrimOptions> & { sampleRate: number },
): Endpoints | null {
  const { sampleRate, frameMs, hopMs, padMs, minRunFrames } = { ...DEFAULTS, ...options };
  if (samples.length === 0) return null;

  const energies = frameEnergies(samples, { sampleRate, frameMs, hopMs });
  const peakDb = Math.max(...energies);
  if (peakDb <= SILENT_PEAK_DB) return null;

  const floorDb = percentile(energies, 0.2);
  const thresholdDb = floorDb + Math.max(MARGIN_DB, (peakDb - floorDb) * MARGIN_FRACTION);

  const hop = Math.max(1, Math.round((hopMs / 1000) * sampleRate));
  const frame = Math.max(1, Math.round((frameMs / 1000) * sampleRate));
  const pad = Math.round((padMs / 1000) * sampleRate);

  // First and last *run* of `minRunFrames` frames over threshold. Runs, not
  // frames, so a click cannot anchor either end.
  let first = -1;
  let last = -1;
  let run = 0;
  for (let i = 0; i < energies.length; i += 1) {
    if (energies[i] > thresholdDb) {
      run += 1;
      if (run >= minRunFrames) {
        if (first < 0) first = i - run + 1;
        last = i;
      }
    } else {
      run = 0;
    }
  }

  // Loud enough to be speech, but never sustained: a recording that is *all*
  // speech has no noise floor to rise above, and so does one where the only
  // thing over threshold was a tap. Keeping everything is the safe answer —
  // the aligner copes with extra silence far better than with a missing
  // syllable, and this is exactly the case the padding is for.
  if (first < 0) return { start: 0, end: samples.length, floorDb, peakDb, thresholdDb };

  return {
    start: Math.max(0, first * hop - pad),
    end: Math.min(samples.length, last * hop + frame + pad),
    floorDb,
    peakDb,
    thresholdDb,
  };
}

export interface Trimmed {
  samples: Float32Array;
  endpoints: Endpoints;
}

/** `findEndpoints`, applied. A view is not enough: the buffer gets transferred to a Worker. */
export function trimToSpeech(
  samples: Float32Array,
  options: Partial<TrimOptions> & { sampleRate: number },
): Trimmed | null {
  const endpoints = findEndpoints(samples, options);
  if (!endpoints) return null;
  return { samples: samples.slice(endpoints.start, endpoints.end), endpoints };
}
