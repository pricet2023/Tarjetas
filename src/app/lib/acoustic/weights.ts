/**
 * Getting 197 MB of weights onto the device once, and only once.
 *
 * The size is the price of plan A: there is no base-sized multilingual IPA CTC
 * model, so `model_q4f16.onnx` is the floor (§10.1). It is tolerable *only*
 * because this happens on first use and never again, which makes the Cache
 * API the load-bearing part of this file rather than a nicety.
 */

import { type AcousticSource } from "./protocol";

export type ProgressFn = (received: number, total: number) => void;

/**
 * Fetch the weights, from the cache when they are there.
 *
 * Falls back to a plain download wherever the Cache API is missing — Node,
 * `jsdom`, and any insecure origin, since `caches` is a secure-context API
 * (localhost counts, so the dev server is fine).
 */
export async function fetchWeights(
  source: AcousticSource,
  onProgress: ProgressFn = () => {},
): Promise<ArrayBuffer> {
  const store = typeof caches === "undefined" ? null : await caches.open(source.id);

  if (store) {
    const hit = await store.match(source.weights);
    if (hit) {
      const bytes = await hit.arrayBuffer();
      onProgress(bytes.byteLength, bytes.byteLength);
      return bytes;
    }
    // A different build's weights are dead the moment `id` changes, and they
    // are 197 MB of dead. Sweep them before adding another (§10.3 — the app
    // and Phase 5's native stats have to be generated with the *same* build,
    // so a build change must not leave the old one lying about).
    await Promise.all(
      (await caches.keys())
        .filter((name) => name !== source.id && name.startsWith(cachePrefix(source.id)))
        .map((name) => caches.delete(name)),
    );
  }

  const bytes = await download(source, onProgress);

  if (store) {
    try {
      await store.put(source.weights, new Response(bytes));
    } catch (error) {
      // Out of quota, or a private window. Scoring still works; the download
      // just happens again next time, so this must not be fatal.
      console.warn("[acoustic] could not cache the weights:", error);
    }
  }
  return bytes;
}

/** Everything up to the last `-`, so `…-q4f16` and `…-q4` are siblings. */
const cachePrefix = (id: string): string => id.slice(0, id.lastIndexOf("-") + 1) || id;

async function download(source: AcousticSource, onProgress: ProgressFn): Promise<ArrayBuffer> {
  const response = await fetch(source.weights);
  if (!response.ok) {
    throw new Error(
      `Couldn't download the pronunciation model (${response.status} ${response.statusText}).`,
    );
  }

  // HuggingFace answers the weights request with a redirect to a CDN that
  // does send a length, but the header is not guaranteed — hence the size in
  // `model-source.json`, so the progress bar is never a guess of 0%.
  const declared = Number(response.headers.get("content-length"));
  const total = Number.isFinite(declared) && declared > 0 ? declared : source.bytes;

  if (!response.body) return response.arrayBuffer();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onProgress(received, Math.max(total, received));
  }

  const bytes = new Uint8Array(received);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes.buffer;
}
