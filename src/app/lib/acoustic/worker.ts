/// <reference lib="webworker" />
/**
 * The acoustic model's Worker.
 *
 * Thin by design: fetch the weights (cached), open the session, and answer
 * `score` messages. All the inference lives in `session.ts` so that Node can
 * run it too; everything here is the browser wiring that Node cannot.
 *
 * It stays off the main thread because inference is roughly realtime — a
 * 2-second utterance took ~1.8 s in the §13 measurements — and a page that
 * blocks for that long during a card animation is unusable.
 */

// Vite rewrites this to a hashed asset URL, which is also what makes it work
// from inside a Worker chunk: ORT resolves the wasm binary relative to its own
// script otherwise, and there is no wasm file next to the bundle.
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import * as ort from "onnxruntime-web/wasm";

import { type AcousticRequest, type AcousticResponse, type AcousticSource } from "./protocol";
import { openSession, type AcousticSession } from "./session";
import { fetchWeights } from "./weights";

ort.env.wasm.wasmPaths = { wasm: wasmUrl };

const scope = self as unknown as DedicatedWorkerGlobalScope;
const send = (message: AcousticResponse, transfer: Transferable[] = []): void =>
  scope.postMessage(message, transfer);

let session: AcousticSession | null = null;
let loading: Promise<AcousticSession> | null = null;

async function load(source: AcousticSource): Promise<AcousticSession> {
  const [labels, weights] = await Promise.all([
    fetchLabels(source.labels),
    fetchWeights(source, (received, total) => send({ kind: "progress", received, total })),
  ]);
  return openSession({
    weights,
    vocab: labels,
    padToken: source.padToken,
    sampleRate: source.sampleRate,
  });
}

async function fetchLabels(url: string): Promise<Record<string, number>> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Couldn't download the model's labels (${response.status} ${response.statusText}).`);
  }
  return (await response.json()) as Record<string, number>;
}

const reason = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

scope.onmessage = async ({ data }: MessageEvent<AcousticRequest>) => {
  if (data.kind === "load") {
    try {
      // Idempotent: the UI may mount twice, and 197 MB is not a download to
      // start twice.
      loading ??= load(data.source);
      session = await loading;
      send({
        kind: "ready",
        labels: session.labels,
        blank: session.blank,
        vocabSize: session.vocabSize,
      });
    } catch (error) {
      loading = null;
      send({ kind: "failed", id: null, message: reason(error) });
    }
    return;
  }

  if (data.kind === "score") {
    try {
      if (!session) throw new Error("The pronunciation model isn't loaded yet.");
      const { data: logProbs, frames, vocabSize } = await session.infer(
        data.samples,
        data.sampleRate,
      );
      // Transferred, not copied: 100 frames × 392 labels is 157 KB per
      // attempt and the worker has no further use for it.
      send({ kind: "scored", id: data.id, logProbs, frames, vocabSize }, [logProbs.buffer]);
    } catch (error) {
      send({ kind: "failed", id: data.id, message: reason(error) });
    }
  }
};
