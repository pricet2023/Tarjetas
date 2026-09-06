/**
 * Waveform preparation, which is one line of maths and three ways to get it
 * silently wrong.
 *
 * `preprocessor_config.json` for this model sets `do_normalize: true`, so it
 * expects zero-mean, unit-variance input (§10.3). Skipping it does not throw —
 * the model simply gets quieter or louder audio than it was trained on and the
 * posteriors degrade, which would show up as the learner mispronouncing
 * everything.
 */

/** The `1e-7` HuggingFace's `Wav2Vec2FeatureExtractor` uses. Same denominator, same numbers. */
const EPSILON = 1e-7;

/**
 * The shortest input the model accepts: the feature extractor's convolution
 * stack has a 400-sample (25 ms) receptive field, and one frame is the least
 * it can produce. Below this ORT fails inside a `Conv` node with
 * `Invalid input shape: {1}`, which says nothing about the real problem —
 * measured, not assumed.
 */
export const MIN_SAMPLES = 400;

/**
 * Zero-mean, unit-variance, as a new array.
 *
 * Deliberately *not* peak normalisation: §10.6 measured a capture peaking at
 * 1.1298, so the peak is not a reliable scale, and dividing by it would put a
 * clipped frame in charge of the whole utterance's gain.
 *
 * Silence is the interesting case. A digitally silent buffer (which §10.6's
 * headless run really did produce) has σ = 0, and `σ + ε` keeps the division
 * finite: every sample comes back 0, the model sees silence, and the aligner
 * reports the terrible scores it should. That is a better failure than a
 * buffer of `NaN`, which would poison the posteriors without an error.
 */
export function normalizeWaveform(samples: Float32Array): Float32Array {
  if (samples.length < MIN_SAMPLES) {
    throw new Error(
      `Need at least ${MIN_SAMPLES} samples (25 ms) to score, got ${samples.length}. ` +
        "Nothing was recorded, or the endpoint trim cut everything away.",
    );
  }

  let sum = 0;
  for (const x of samples) {
    if (!Number.isFinite(x)) {
      throw new Error("Waveform contains a non-finite sample; the capture path is broken.");
    }
    sum += x;
  }
  const mean = sum / samples.length;

  let variance = 0;
  for (const x of samples) variance += (x - mean) ** 2;
  const sd = Math.sqrt(variance / samples.length);

  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) out[i] = (samples[i] - mean) / (sd + EPSILON);
  return out;
}
