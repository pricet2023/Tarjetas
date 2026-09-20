/**
 * The scorer service: the same `session.ts`, on a machine with memory to spare.
 *
 * It is deliberately the thinnest possible thing that can hold 197 MB of
 * weights resident. Audio in, posterior matrix out — no alignment, no GOP, no
 * phonology. All of that stays in the browser where it already is, tested,
 * and where `native-stats.generated.ts` lives, so there is exactly one
 * implementation of the scoring and this box cannot drift from it (§19.2).
 *
 * ```
 * GET  /health              → 200, unauthenticated, for systemd and the tunnel
 * GET  /model               → RemoteModelInfo
 * POST /score?rate=16000    → Float32LE samples in, Float32LE log-probs out
 * ```
 *
 * Run it with `node server/run.mjs` — that entry registers the same
 * `scripts/ts-loader.mjs` the generators use, which is what lets a service
 * import the app's TypeScript unbuilt.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as ort from "onnxruntime-web/wasm";

import {
  ACOUSTIC_SOURCE,
  FRAMES_HEADER,
  VOCAB_HEADER,
  type RemoteModelInfo,
} from "@/app/lib/acoustic/protocol";
import { openSession, type AcousticSession } from "@/app/lib/acoustic/session";

import { Unauthorized, createVerifier, type Verifier } from "./auth";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 30 seconds of 16 kHz float32.
 *
 * The recorder cuts an attempt long before this, so anything approaching the
 * cap is not a learner — it is someone who found the endpoint. The check is on
 * the stream rather than after it, so a large body is dropped rather than
 * buffered.
 */
const MAX_BODY_BYTES = 30 * 16_000 * 4;

export interface ScorerConfig {
  port: number;
  host: string;
  modelDir: string;
  numThreads: number;
  /** Origins allowed to call this, for the browser's benefit. `*` for none set. */
  allowedOrigins: string[];
  supabaseUrl?: string;
  jwtSecret?: string;
  allowAnonymous: boolean;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ScorerConfig {
  return {
    port: Number(env.SCORER_PORT ?? 8787),
    host: env.SCORER_HOST ?? "127.0.0.1",
    modelDir: env.SCORER_MODEL_DIR ?? resolve(root, ".models", ACOUSTIC_SOURCE.id),
    // One thread, and measured rather than assumed (§19.4).
    //
    // The plan was to take the four cores the Always Free shape has. ORT's
    // *threaded* wasm build cannot start under Node: it builds its workers
    // from a URL it then fetches, and Node's `fetch` does not do `file:`, so
    // every configuration — `wasmBinary`, `wasmPaths`, both — fails identically
    // with `no available backend found. ERR: [wasm] TypeError: fetch failed`.
    // Supplying the binary fixes the *main* module's lookup and not the
    // workers'.
    //
    // So this stays 1, and the box is not faster than a laptop — 1.25 s per
    // second of audio here, and an A1 core is slower than this one. The point
    // of the scorer is that the 197 MB lives somewhere other than a phone;
    // speed is what `onnxruntime-node` would buy, and it costs a
    // `stats:native` regeneration because it is a different EP (§19.3).
    numThreads: Number(env.SCORER_THREADS ?? 1),
    allowedOrigins: (env.SCORER_ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean),
    supabaseUrl: env.SUPABASE_URL,
    jwtSecret: env.SUPABASE_JWT_SECRET,
    allowAnonymous: env.SCORER_ALLOW_ANONYMOUS === "1",
  };
}

export async function start(config: ScorerConfig): Promise<() => Promise<void>> {
  const verify = createVerifier({
    supabaseUrl: config.supabaseUrl,
    jwtSecret: config.jwtSecret,
    allowAnonymous: config.allowAnonymous,
  });

  const session = await openModel(config);
  const info: RemoteModelInfo = {
    id: ACOUSTIC_SOURCE.id,
    labels: session.labels,
    blank: session.blank,
    vocabSize: session.vocabSize,
    sampleRate: session.sampleRate,
  };

  const server = createServer((request, response) => {
    handle(request, response, { config, session, info, verify }).catch((thrown) => {
      // Nothing below should reach here; if it does, the connection still has
      // to be answered or the client waits for its 30-second timeout.
      console.error("[scorer] unhandled:", thrown);
      if (!response.headersSent) fail(response, 500, "The pronunciation scorer broke.", config);
      else response.end();
    });
  });

  await new Promise<void>((ready) => server.listen(config.port, config.host, ready));
  console.log(
    `[scorer] ${ACOUSTIC_SOURCE.id} on http://${config.host}:${config.port} ` +
      `(${config.numThreads} thread${config.numThreads === 1 ? "" : "s"}, ` +
      `${config.allowAnonymous ? "UNAUTHENTICATED" : "authenticated"})`,
  );

  return async () => {
    await new Promise<void>((closed) => server.close(() => closed()));
    await session.release();
  };
}

interface Context {
  config: ScorerConfig;
  session: AcousticSession;
  info: RemoteModelInfo;
  verify: Verifier;
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  context: Context,
): Promise<void> {
  const { config, info, verify } = context;
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (request.method === "OPTIONS") {
    response.writeHead(204, cors(request, config)).end();
    return;
  }

  // Unauthenticated on purpose: systemd's readiness check and the tunnel's
  // health probe have no token, and this leaks nothing.
  if (url.pathname === "/health") {
    response.writeHead(200, { "Content-Type": "application/json", ...cors(request, config) });
    response.end(JSON.stringify({ ok: true, id: info.id }));
    return;
  }

  let user: string;
  try {
    user = await verify(request.headers.authorization);
  } catch (thrown) {
    const message = thrown instanceof Unauthorized ? thrown.message : "Not allowed.";
    if (!(thrown instanceof Unauthorized)) console.error("[scorer] verifier:", thrown);
    fail(response, 401, message, config, request);
    return;
  }

  if (url.pathname === "/model" && request.method === "GET") {
    response.writeHead(200, { "Content-Type": "application/json", ...cors(request, config) });
    response.end(JSON.stringify(info));
    return;
  }

  if (url.pathname === "/score" && request.method === "POST") {
    await score(request, response, context, url, user);
    return;
  }

  fail(response, 404, "No such endpoint.", config, request);
}

async function score(
  request: IncomingMessage,
  response: ServerResponse,
  { config, session, info }: Context,
  url: URL,
  user: string,
): Promise<void> {
  const rate = Number(url.searchParams.get("rate") ?? info.sampleRate);
  if (rate !== info.sampleRate) {
    fail(
      response,
      400,
      `The model wants ${info.sampleRate} Hz mono and got ${rate} Hz. Resample before scoring.`,
      config,
      request,
    );
    return;
  }

  let body: Buffer;
  try {
    body = await read(request);
  } catch (thrown) {
    fail(response, 413, thrown instanceof Error ? thrown.message : "That attempt was too long.", config, request);
    return;
  }

  if (body.byteLength === 0 || body.byteLength % 4 !== 0) {
    fail(response, 400, "That attempt wasn't a float32 waveform.", config, request);
    return;
  }

  // A copy into an aligned buffer. Node hands out `Buffer`s that are views
  // into a shared pool at an arbitrary offset, and `Float32Array` needs a
  // multiple of 4 — so roughly three times in four, wrapping it directly
  // throws "start offset of Float32Array should be a multiple of 4".
  const samples = new Float32Array(
    body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  );

  const started = performance.now();
  try {
    // Serialised: one `InferenceSession`, and ORT does not promise that
    // concurrent `run`s on one session are safe. Two people studying at once
    // is the normal case here, so this is not theoretical.
    const { data, frames, vocabSize } = await queue(() => session.infer(samples, rate));
    response.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(data.byteLength),
      [FRAMES_HEADER]: String(frames),
      [VOCAB_HEADER]: String(vocabSize),
      ...cors(request, config),
    });
    response.end(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    console.log(
      `[scorer] ${user.slice(0, 8)} ${(samples.length / rate).toFixed(2)}s ` +
        `-> ${frames} frames in ${Math.round(performance.now() - started)}ms`,
    );
  } catch (thrown) {
    // `normalizeWaveform` throws the "too short" message, which is written for
    // a learner and should reach one.
    const message = thrown instanceof Error ? thrown.message : "That attempt couldn't be scored.";
    fail(response, 422, message, config, request);
  }
}

/** One at a time, in arrival order. */
let tail: Promise<unknown> = Promise.resolve();
function queue<T>(work: () => Promise<T>): Promise<T> {
  const run = tail.then(work, work);
  tail = run.catch(() => undefined);
  return run;
}

function read(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve_, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_BODY_BYTES) {
        request.destroy();
        reject(new Error("That attempt was too long to score."));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve_(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

/**
 * CORS, narrowly.
 *
 * The deployed app is on Vercel and the scorer is on a tunnel hostname, so
 * they are cross-origin and the browser will ask. `SCORER_ALLOWED_ORIGINS`
 * lists who may — unset means same-origin only, which is the dev case where
 * Vite proxies and no CORS happens at all.
 */
function cors(request: IncomingMessage, config: ScorerConfig): Record<string, string> {
  const origin = request.headers.origin;
  if (!origin || !config.allowedOrigins.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Expose-Headers": `${FRAMES_HEADER}, ${VOCAB_HEADER}`,
    "Access-Control-Max-Age": "86400",
  };
}

function fail(
  response: ServerResponse,
  status: number,
  error: string,
  config: ScorerConfig,
  request?: IncomingMessage,
): void {
  response.writeHead(status, {
    "Content-Type": "application/json",
    ...(request ? cors(request, config) : {}),
  });
  response.end(JSON.stringify({ error }));
}

/**
 * Whether this box has the weights.
 *
 * Separate from `openModel` so `run.mjs` can tell "not set up for scoring"
 * from "broken", and skip rather than fail. `npm run dev` runs the scorer
 * beside Vite under `--kill-others-on-fail`, and a laptop that has never run
 * `npm run model:fetch` must still be able to start the app — the same reason
 * `gop.integration.test.ts` skips silently without `.models/`.
 */
export function hasWeights(config: ScorerConfig): boolean {
  return (
    existsSync(resolve(config.modelDir, "model.onnx")) &&
    existsSync(resolve(config.modelDir, "vocab.json"))
  );
}

async function openModel(config: ScorerConfig): Promise<AcousticSession> {
  const weights = resolve(config.modelDir, "model.onnx");
  const vocab = resolve(config.modelDir, "vocab.json");
  if (!hasWeights(config)) {
    throw new Error(
      `No weights in ${config.modelDir}. Run \`npm run model:fetch\` first — the scorer ` +
        "reads the same .models/ directory the integration tests and stats:native do.",
    );
  }

  // The Node half of what `worker.ts` does for the browser.
  //
  // ORT locates its wasm binary by `fetch`, which in a browser Vite answers
  // with a hashed asset URL. Node's `fetch` does not do `file:`, so the same
  // lookup fails with a bare "fetch failed" and no indication of what it was
  // reaching for. Handing over the bytes skips the lookup entirely.
  const require_ = createRequire(import.meta.url);
  ort.env.wasm.wasmBinary = await readFile(
    require_.resolve("onnxruntime-web/ort-wasm-simd-threaded.wasm"),
  );

  const started = performance.now();
  const session = await openSession({
    weights: await readFile(weights),
    vocab: JSON.parse(await readFile(vocab, "utf8")),
    padToken: ACOUSTIC_SOURCE.padToken,
    sampleRate: ACOUSTIC_SOURCE.sampleRate,
    numThreads: config.numThreads,
  });
  console.log(`[scorer] weights resident in ${Math.round(performance.now() - started)}ms`);
  return session;
}
