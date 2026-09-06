/**
 * The acoustic model's wire contract — the one seam between the app and
 * whatever is actually doing the inference.
 *
 * Everything about the model lives behind these four message types: the app
 * hands over a `Float32Array` of 16 kHz mono audio and gets back a posterior
 * matrix and the label list to interpret it with. Same idea as `Provider` in
 * `supabase/functions/translate/provider.ts` one layer out — swapping
 * `wav2vec2-xlsr-53-espeak-cv-ft` for the §10.4 fallback should touch
 * `model-source.json`, `inventory.ts`'s label table, and nothing else.
 *
 * Why a Worker and not an edge function: the plan's §3 rejects the server for
 * good reasons, but the practical one is measured — inference is ~0.9× realtime
 * on the wasm backend, so a 2-second utterance occupies a thread for ~1.8
 * seconds. On the main thread that is 90 dropped frames and a locked-up card.
 */

import source from "./model-source.json";

/** Where the weights and labels come from, and how to read them. */
export interface AcousticSource {
  /** Cache key. Change it when the build changes, or stale weights survive. */
  id: string;
  /** The ONNX weights. */
  weights: string;
  /** `vocab.json` — a `label -> row index` object. */
  labels: string;
  /** Expected download size, for progress when the server sends no length. */
  bytes: number;
  /** The only rate the model accepts. Resampling is the caller's job. */
  sampleRate: number;
  /**
   * The CTC blank's *name*, not its index.
   *
   * The index is model-specific — 0 here, 37 for the §10.4 fallback — and a
   * wrong one fails silently, so it is always looked up in the label list
   * rather than written down (plan §7, §10.2).
   */
  padToken: string;
}

export const ACOUSTIC_SOURCE: AcousticSource = source;

/** Sent to the worker. */
export type AcousticRequest =
  | { kind: "load"; source: AcousticSource }
  | { kind: "score"; id: number; samples: Float32Array; sampleRate: number };

/** Sent back by the worker. */
export type AcousticResponse =
  | { kind: "progress"; received: number; total: number }
  | { kind: "ready"; labels: string[]; blank: number; vocabSize: number }
  | { kind: "scored"; id: number; logProbs: Float32Array; frames: number; vocabSize: number }
  | { kind: "failed"; id: number | null; message: string };

/**
 * The subset of `Worker` the client uses.
 *
 * Named so a test can pass a plain object instead: `jsdom` has no `Worker`,
 * and none of the message plumbing needs a real one to be worth testing.
 */
export interface AcousticPort {
  postMessage(message: AcousticRequest, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent<AcousticResponse>) => void): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
  terminate(): void;
}

/**
 * Turn `vocab.json` into a row-indexed label array.
 *
 * The aligner addresses labels by row, so this has to be dense and in order —
 * `Object.keys` order is insertion order in the file, which is *not* index
 * order. Gaps are a corrupt vocabulary and throw rather than shifting every
 * label by one.
 */
export function labelsByRow(vocab: Record<string, number>): string[] {
  const entries = Object.entries(vocab);
  const labels = new Array<string>(entries.length);
  for (const [label, row] of entries) {
    if (!Number.isInteger(row) || row < 0 || row >= entries.length) {
      throw new Error(`Label "${label}" has row ${row}, outside a ${entries.length}-label vocabulary.`);
    }
    if (labels[row] !== undefined) {
      throw new Error(`Row ${row} is claimed by both "${labels[row]}" and "${label}".`);
    }
    labels[row] = label;
  }
  return labels;
}
