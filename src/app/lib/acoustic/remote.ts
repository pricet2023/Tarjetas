/**
 * The other implementation of `AcousticModel`: the same inference, on a box.
 *
 * Interchangeable with `loadAcousticModel` by construction — same interface,
 * same `{ logProbs, labels, blank }` out — so everything downstream (the
 * aligner, GOP, the feedback wording, `usePronunciation`) cannot tell which
 * one it got. That is the whole reason this was cheap to add: `protocol.ts`
 * was already written as a seam.
 *
 * What it is *for* is memory, not speed (§19.1). The weights are 197 MB
 * resident and the cold download peaks at roughly twice that, which a 3–4 GB
 * Android device does not survive — the tab is killed and the feature simply
 * does not exist on that phone. Moving the residency to a machine with 24 GB
 * is the point; the wall-clock win from four wasm threads is a side effect.
 *
 * Wire format, per `server/scorer.ts`:
 *
 * ```
 * GET  /model                → RemoteModelInfo as JSON
 * POST /score?rate=16000     → body: Float32LE samples
 *                              out:  Float32LE log-probs, shape in headers
 * ```
 *
 * Binary both ways because base64 would add a third to a 157 KB matrix for
 * nothing, and JSON numbers would add rather more than that.
 */

import { type LogProbs } from "@/app/lib/align/ctc";

import { type AcousticModel, type AcousticScore } from "./model";
import {
  ACOUSTIC_SOURCE,
  FRAMES_HEADER,
  VOCAB_HEADER,
  type AcousticSource,
  type RemoteModelInfo,
} from "./protocol";

export interface RemoteOptions {
  /**
   * Where the scorer is.
   *
   * Relative by default (`/api/scorer`), which is what makes dev and
   * production the same code path: Vite proxies it to `127.0.0.1:8787`, and
   * the deployed app has `VITE_SCORER_URL` pointing at the tunnel hostname.
   */
  baseUrl?: string;
  /**
   * The bearer token, fetched per request rather than captured once — a study
   * session outlives an access token, and a stale one 401s halfway through.
   */
  authorization?: () => Promise<string | null>;
  /** Injected by tests; `jsdom` has `fetch` but not a scorer to point it at. */
  fetchImpl?: typeof fetch;
  /** Expected build, asserted against what the server reports. */
  source?: AcousticSource;
  /** Per-request ceiling. A box that has gone away must not hang the card. */
  timeoutMs?: number;
}

const DEFAULT_BASE = "/api/scorer";
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Both sides send raw `Float32Array` buffers, which are platform-endian.
 *
 * Every platform this app runs on is little-endian, so byte-swapping on every
 * request would be 157 KB of pointless work. Assert the assumption instead of
 * documenting it — on a big-endian client this fails loudly here rather than
 * scoring confident nonsense.
 */
const LITTLE_ENDIAN = new Uint8Array(Uint16Array.of(1).buffer)[0] === 1;

export async function loadRemoteAcousticModel({
  baseUrl = DEFAULT_BASE,
  authorization,
  fetchImpl = globalThis.fetch.bind(globalThis),
  source = ACOUSTIC_SOURCE,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: RemoteOptions = {}): Promise<AcousticModel> {
  if (!LITTLE_ENDIAN) {
    throw new Error("The pronunciation scorer needs a little-endian client.");
  }

  const base = baseUrl.replace(/\/$/, "");
  const closed = new AbortController();

  const headers = async (extra: HeadersInit = {}): Promise<Headers> => {
    const built = new Headers(extra);
    const token = await authorization?.();
    if (token) built.set("Authorization", `Bearer ${token}`);
    return built;
  };

  /**
   * One `AbortSignal` that fires on either the timeout or `close()`.
   *
   * Both matter: the timeout is the box being unreachable, and the close is
   * the learner leaving the card mid-score, which happens constantly.
   */
  const signal = (): AbortSignal =>
    AbortSignal.any([closed.signal, AbortSignal.timeout(timeoutMs)]);

  const described = await send(fetchImpl, `${base}/model`, {
    headers: await headers(),
    signal: signal(),
  });
  const info = (await described.json()) as RemoteModelInfo;

  // The same guard `openSession` applies locally, applied across the wire. A
  // server running yesterday's build would return labels that align fine and
  // score against the wrong `native-stats.generated.ts` (§19.3).
  if (info.id !== source.id) {
    throw new Error(
      `The pronunciation scorer is running "${info.id}" but this app expects "${source.id}". ` +
        "They would not score the same, so nothing is being scored.",
    );
  }
  if (info.blank < 0 || info.blank >= info.labels.length) {
    throw new Error(`The scorer reported a CTC blank at row ${info.blank}, outside its own labels.`);
  }

  return {
    labels: info.labels,
    blank: info.blank,
    sampleRate: info.sampleRate,

    async score(samples: Float32Array, sampleRate = info.sampleRate): Promise<AcousticScore> {
      if (sampleRate !== info.sampleRate) {
        throw new Error(
          `The model wants ${info.sampleRate} Hz mono and got ${sampleRate} Hz. Resample before scoring.`,
        );
      }
      // A copy, for the same reason `model.ts` copies before transferring:
      // Phase 7 keeps the audio to play back, and `samples` may be a view
      // over a larger recording buffer rather than the whole of one.
      const body = samples.slice();
      const url = `${base}/score?rate=${sampleRate}`;

      const response = await send(
        fetchImpl,
        url,
        {
          method: "POST",
          headers: await headers({ "Content-Type": "application/octet-stream" }),
          body,
          signal: signal(),
        },
      );

      const frames = Number(response.headers.get(FRAMES_HEADER));
      const vocabSize = Number(response.headers.get(VOCAB_HEADER));
      const buffer = await response.arrayBuffer();

      if (!Number.isInteger(frames) || !Number.isInteger(vocabSize) || frames <= 0) {
        throw new Error("The pronunciation scorer returned a matrix with no shape.");
      }
      if (buffer.byteLength !== frames * vocabSize * 4) {
        throw new Error(
          `The scorer said ${frames}×${vocabSize} log-probs and sent ${buffer.byteLength} bytes.`,
        );
      }
      if (vocabSize !== info.labels.length) {
        throw new Error(
          `The scorer emits ${vocabSize} labels but reported ${info.labels.length}. They do not belong together.`,
        );
      }

      const logProbs: LogProbs = { data: new Float32Array(buffer), frames, vocabSize };
      return { logProbs, labels: info.labels, blank: info.blank };
    },

    close() {
      closed.abort(new Error("The pronunciation model was closed."));
    },
  };
}

/**
 * `fetch`, with the failure modes turned into sentences a learner can read.
 *
 * The repo convention is that this layer throws `Error` with a renderable
 * message rather than returning a tuple, so every branch below ends in one.
 */
async function send(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (thrown) {
    if (thrown instanceof DOMException && thrown.name === "TimeoutError") {
      throw new Error("The pronunciation scorer didn't answer in time.");
    }
    if (thrown instanceof DOMException && thrown.name === "AbortError") {
      throw new Error("The pronunciation model was closed.");
    }
    throw new Error("Couldn't reach the pronunciation scorer.");
  }

  if (response.ok) return response;

  if (response.status === 401 || response.status === 403) {
    throw new Error("You need to be signed in to score pronunciation.");
  }
  throw new Error(await explain(response));
}

/** The server's own message when it sent one, its status line when it didn't. */
async function explain(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error) return body.error;
  } catch {
    // Not JSON. The status line is all there is.
  }
  return `The pronunciation scorer failed (${response.status} ${response.statusText}).`;
}
