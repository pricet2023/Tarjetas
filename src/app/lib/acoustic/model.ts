/**
 * The main thread's handle on the acoustic model.
 *
 * The whole public surface of Phase 3 is here, and it is the shape §Phase 3
 * asked for: give it a `Float32Array` of 16 kHz mono audio, get back
 * `{ logProbs, labels }` — exactly the two arguments the aligner and
 * `buildTarget` need, and nothing about ONNX, wasm or message passing.
 *
 * ```ts
 * const model = await loadAcousticModel({ onProgress });
 * const { logProbs, labels, blank } = await model.score(samples);
 * const spans = forcedAlign(logProbs, buildTarget(g2p(word).phones, labels), { blank });
 * ```
 *
 * Errors arrive as thrown `Error`s with a message a page can render, per the
 * repo's API convention — the worker's `failed` messages are turned back into
 * exceptions here rather than surfacing as a result object.
 */

import { type LogProbs } from "@/app/lib/align/ctc";

import {
  ACOUSTIC_SOURCE,
  type AcousticPort,
  type AcousticResponse,
  type AcousticSource,
} from "./protocol";

export interface AcousticScore {
  /** Per-frame log-probabilities over the model's labels. */
  logProbs: LogProbs;
  /** Row-indexed labels, for `buildTarget`. */
  labels: readonly string[];
  /** The CTC blank's row, for `forcedAlign`. */
  blank: number;
}

export interface AcousticModel {
  readonly labels: readonly string[];
  readonly blank: number;
  /** The rate `samples` must already be at — Phase 4 resamples to it. */
  readonly sampleRate: number;
  score(samples: Float32Array, sampleRate?: number): Promise<AcousticScore>;
  close(): void;
}

export interface LoadOptions {
  source?: AcousticSource;
  /** Called while the weights download. Not called on a cache hit beyond the final 100%. */
  onProgress?: (received: number, total: number) => void;
  /**
   * The worker to talk to. Injected by tests — `jsdom` has no `Worker`, and
   * the plumbing (correlating replies, turning failures into exceptions) is
   * worth testing without one.
   */
  port?: AcousticPort;
}

const defaultPort = (): AcousticPort =>
  new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }) as AcousticPort;

export async function loadAcousticModel({
  source = ACOUSTIC_SOURCE,
  onProgress,
  port = defaultPort(),
}: LoadOptions = {}): Promise<AcousticModel> {
  const pending = new Map<number, { resolve: (score: AcousticScore) => void; reject: (error: Error) => void }>();
  let ready: { labels: string[]; blank: number } | null = null;
  let nextId = 1;

  const failAll = (message: string): void => {
    const error = new Error(message);
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };

  const loaded = new Promise<{ labels: string[]; blank: number }>((resolve, reject) => {
    port.addEventListener("message", ({ data }: MessageEvent<AcousticResponse>) => {
      switch (data.kind) {
        case "progress":
          onProgress?.(data.received, data.total);
          return;
        case "ready":
          ready = { labels: data.labels, blank: data.blank };
          resolve(ready);
          return;
        case "scored": {
          const waiting = pending.get(data.id);
          pending.delete(data.id);
          waiting?.resolve({
            logProbs: { data: data.logProbs, frames: data.frames, vocabSize: data.vocabSize },
            labels: ready?.labels ?? [],
            blank: ready?.blank ?? -1,
          });
          return;
        }
        case "failed":
          // `id: null` means the failure was the load itself, so there is no
          // one attempt to blame and nothing will ever work.
          if (data.id === null) {
            reject(new Error(data.message));
            failAll(data.message);
            return;
          }
          pending.get(data.id)?.reject(new Error(data.message));
          pending.delete(data.id);
      }
    });

    port.addEventListener("error", () => {
      const message = "The pronunciation model crashed. Reload the page to try again.";
      reject(new Error(message));
      failAll(message);
    });
  });

  port.postMessage({ kind: "load", source });
  const { labels, blank } = await loaded;

  return {
    labels,
    blank,
    sampleRate: source.sampleRate,
    score(samples, sampleRate = source.sampleRate) {
      const id = nextId;
      nextId += 1;
      // A copy, so the transfer that follows cannot neuter the caller's
      // buffer — Phase 7 wants to keep the audio around to play back. 2
      // seconds of 16 kHz float32 is 128 KB, which is cheaper than the bug.
      const owned = samples.slice();
      return new Promise<AcousticScore>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        port.postMessage({ kind: "score", id, samples: owned, sampleRate }, [owned.buffer]);
      });
    },
    close() {
      failAll("The pronunciation model was closed.");
      port.terminate();
    },
  };
}
