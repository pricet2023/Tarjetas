/**
 * The inference core: audio in, posterior matrix out.
 *
 * Deliberately free of `Worker`, `fetch` and the DOM. The Worker (`worker.ts`)
 * is message plumbing around this, and the Node-side tests and Phase 5's
 * `gen-native-stats` script drive it directly — which is the only way the
 * "assert real phone boundaries" test of §Phase 3 can exist at all, since
 * `jsdom` has neither `Worker` nor `AudioContext`.
 */

import * as ort from "onnxruntime-web/wasm";

import { logSoftmax, type LogProbs } from "@/app/lib/align/ctc";

import { normalizeWaveform } from "./normalize";
import { labelsByRow } from "./protocol";

export interface AcousticSession {
  /** Row-indexed model labels, for `buildTarget`. */
  readonly labels: string[];
  /** Row of the CTC blank, looked up by name. Pass to `forcedAlign`. */
  readonly blank: number;
  readonly vocabSize: number;
  /** The rate the samples must already be at. */
  readonly sampleRate: number;
  infer(samples: Float32Array, sampleRate: number): Promise<LogProbs & { data: Float32Array }>;
  release(): Promise<void>;
}

export interface SessionSpec {
  /**
   * The ONNX weights themselves.
   *
   * Bytes, never a path: this is the wasm-only ORT bundle (`onnxruntime-web/wasm`,
   * chosen so the build does not ship the 28 MB JSEP binary as well), and it
   * loads a model by `fetch`, so a filesystem path fails with
   * `Invalid URL`. Node callers read the file first — which is also what the
   * browser does, since the Cache API hands over an `ArrayBuffer`.
   */
  weights: ArrayBuffer | Uint8Array;
  /** Parsed `vocab.json` — `label -> row`. */
  vocab: Record<string, number>;
  padToken: string;
  sampleRate: number;
}

/**
 * Single-threaded on purpose.
 *
 * Multi-threaded wasm needs `SharedArrayBuffer`, which needs the page to be
 * cross-origin isolated (`COOP`/`COEP`) — headers the Vite dev server does not
 * send. Left at the default, ORT would try, fail, and fall back with a console
 * warning nobody reads. One thread is the honest configuration, and it is
 * what the ~0.9× realtime measurement in the plan's §13 was taken with.
 */
function configureRuntime(): void {
  ort.env.wasm.numThreads = 1;
  // We are already off the main thread; ORT's own proxy worker would be a
  // second hop for nothing.
  ort.env.wasm.proxy = false;
  ort.env.logLevel = "error";
}

export async function openSession({
  weights,
  vocab,
  padToken,
  sampleRate,
}: SessionSpec): Promise<AcousticSession> {
  configureRuntime();

  const labels = labelsByRow(vocab);
  const blank = vocab[padToken];
  if (blank === undefined) {
    throw new Error(
      `The vocabulary has no "${padToken}" to use as the CTC blank. ` +
        "Without it every frame's dominant label would be scored as a phone.",
    );
  }

  const session = await ort.InferenceSession.create(toBytes(weights), {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
  });

  // The graph takes `input_values` and nothing else — no `attention_mask`,
  // despite what `preprocessor_config.json` implies (§10.3). Assert it, so a
  // swapped model that wants a mask says so here instead of running on
  // garbage.
  if (session.inputNames.length !== 1 || session.inputNames[0] !== "input_values") {
    throw new Error(
      `Expected a model taking only "input_values", got [${session.inputNames.join(", ")}].`,
    );
  }

  let vocabSize = 0;

  const infer = async (
    samples: Float32Array,
    rate: number,
  ): Promise<LogProbs & { data: Float32Array }> => {
    if (rate !== sampleRate) {
      throw new Error(
        `The model wants ${sampleRate} Hz mono and got ${rate} Hz. Resample before scoring.`,
      );
    }
    const values = normalizeWaveform(samples);
    const output = await session.run({
      input_values: new ort.Tensor("float32", values, [1, values.length]),
    });
    const logits = output[session.outputNames[0]];
    const [batch, frames, V] = logits.dims as number[];
    if (batch !== 1 || logits.dims.length !== 3) {
      throw new Error(`Expected logits shaped [1, frames, labels], got [${logits.dims.join(", ")}].`);
    }
    if (V !== labels.length) {
      // The failure this guards against is using one espeak model's
      // `vocab.json` with another's weights. They are often the same file,
      // and when they are not every label is wrong by a silent offset.
      throw new Error(
        `The model emits ${V} labels but the vocabulary has ${labels.length}. They do not belong together.`,
      );
    }
    vocabSize = V;
    return logSoftmax(logits.data as Float32Array, frames, V);
  };

  return {
    labels,
    blank,
    sampleRate,
    get vocabSize() {
      return vocabSize || labels.length;
    },
    infer,
    release: () => session.release(),
  };
}

const toBytes = (weights: ArrayBuffer | Uint8Array): Uint8Array =>
  weights instanceof Uint8Array ? weights : new Uint8Array(weights);
