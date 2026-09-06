/**
 * Hardware rate in, 16 kHz out.
 *
 * The model accepts one rate and `session.ts` throws on anything else rather
 * than resampling, deliberately: audio at 48 kHz scored as if it were 16 kHz
 * is three times too fast, every formant is in the wrong place, and nothing
 * about the result looks broken (§13.6). So the conversion happens here, once,
 * and it is the last thing between the microphone and the aligner.
 *
 * `OfflineAudioContext` does it rather than a hand-rolled filter because the
 * browser already contains a good sample-rate converter — playing a buffer
 * declared at 48 kHz into a 16 kHz context runs it through the same
 * band-limited interpolation the audio graph uses everywhere else. A naive
 * "take every third sample" would alias the 8–24 kHz band straight down into
 * the speech we are scoring, and the fricatives are up there.
 */

/** Where the frames-to-samples arithmetic lives, so the tests can have it without Web Audio. */
export function resampledLength(length: number, from: number, to: number): number {
  return Math.max(1, Math.round((length * to) / from));
}

/**
 * Join the worklet's batches into one buffer.
 *
 * Pure, and separated from the capture path for that reason: this is where an
 * off-by-one loses the last 43 ms of an utterance, which is a whole syllable.
 */
export function spliceChunks(chunks: readonly Float32Array[]): Float32Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Float32Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/**
 * Resample to `to` Hz, mono.
 *
 * Returns a copy when the rates already match — the caller transfers the
 * result to a Worker, and handing back the input would neuter a buffer it
 * still holds.
 */
export async function resampleTo(
  samples: Float32Array,
  from: number,
  to: number,
): Promise<Float32Array> {
  if (samples.length === 0) return new Float32Array(0);
  if (from === to) return samples.slice();
  if (!(from > 0) || !(to > 0)) throw new Error(`Can't resample from ${from} Hz to ${to} Hz.`);

  const context = new OfflineAudioContext(1, resampledLength(samples.length, from, to), to);
  // `createBuffer` at the *source* rate is what triggers the conversion: the
  // node plays it at its declared rate into a context running at another.
  const buffer = context.createBuffer(1, samples.length, from);
  // `getChannelData().set()` rather than `copyToChannel()`: the latter is
  // typed for a `Float32Array` over a plain `ArrayBuffer`, and ours can come
  // off a transfer.
  buffer.getChannelData(0).set(samples);

  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  source.start();

  const rendered = await context.startRendering();
  // `getChannelData` hands back the context's own memory; copy before it is
  // transferred or reused.
  return rendered.getChannelData(0).slice();
}
