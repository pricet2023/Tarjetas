#!/usr/bin/env node
// Measure what "native" looks like, per phoneme, so a learner's GOP can be a
// z-score instead of an uninterpretable number of nats (plan §4.6).
//
//   npm run stats:native -- --clips=250 --quota=70   # what the committed file was made with
//   npm run stats:native -- --dry-run                # coverage, without fetching audio
//
// Output: src/app/lib/phonology/native-stats.generated.ts — a generated TS
// module, not a migration (§Phase 5). It is ~24 rows, it has to be readable
// synchronously while scoring, and it versions with the algorithm rather than
// with the schema.
//
// **The corpus**, which is open decision 5 and took two attempts.
//
// Common Voice is gated on HuggingFace and 403s without a token (§10.5).
// Wikimedia Commons' Lingua Libre looked ideal — 19,127 Spanish words, one per
// file, ungated — and it is not: `upload.wikimedia.org` throttles bulk
// downloads of original files and answers a few hundred of them with
// `429 Too many requests - please contact noc@wikimedia.org to discuss a less
// disruptive approach`. That is a service asking not to be used this way, so
// this does not.
//
// What it uses instead is **FLEURS `es_419`** (Latin American Spanish, which
// is the dialect Phase 1 chose): read sentences at 16 kHz with normalised
// transcripts, CC BY 4.0, ungated, on a host that serves bulk data by design.
// The 255 MB split is fetched once into `.cache/`, resumably, and read from
// there; scoring still stops the moment the phone quotas are met. No audio is
// committed — only the derived per-phone statistics.
//
// **It must run the same model build the app runs** (§10.3): the app z-scores
// against these numbers, so a systematic quantization bias cancels only if
// both sides are q4f16. It therefore uses .models/ (npm run model:fetch) and
// drives `openSession` directly, exactly as the integration test does.

import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createGunzip } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cacheDir = resolve(root, ".cache", "native-stats");
const outPath = resolve(root, "src/app/lib/phonology/native-stats.generated.ts");

const USER_AGENT =
  "flash-cards-native-stats/0.1 (personal Spanish flashcard app; one-off statistics run)";

const FLEURS = "https://huggingface.co/datasets/google/fleurs/resolve/main/data/es_419";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = "true"] = a.replace(/^--/, "").split("=");
    return [k, v];
  }),
);
const option = (name, fallback) => (args[name] === undefined ? fallback : Number(args[name]));

/** The split to draw from. `dev` is the smallest at 255 MB, and it is streamed, not downloaded. */
const SPLIT = args.split ?? "dev";

/**
 * Ceiling on clips to score.
 *
 * A FLEURS sentence is 10–25 s and inference runs at ~0.9× realtime (§13.2),
 * so each one costs about its own length in wall clock — and yields ~100 phone
 * spans, where a single word yields eight. Sixty sentences is a quarter of an
 * hour and several thousand observations.
 */
const CLIPS = option("clips", 60);
/**
 * Observations wanted per phone, and the reason the run can stop early.
 *
 * Spanish text is mostly /a e o s n l/: by the time /ɲ/ has thirty
 * observations, /a/ has two thousand. So a clip is scored only while it still
 * adds something — once every phone has its quota the stream is abandoned
 * mid-archive, which is what keeps this to tens of megabytes instead of 255.
 */
const QUOTA = option("quota", 60);
/** Below this many observations a phone's percentile is noise; it falls back to the pooled stat. */
const MIN_OBSERVATIONS = option("min-observations", 30);
/**
 * Where the "a native would not do that" line sits: the 5th percentile of
 * native GOP for that phone, per §4.6.
 *
 * Empirical rather than Gaussian on purpose. GOP is bounded above (you cannot
 * beat the best rival by much) and has a long left tail, so it is skewed and
 * `mean - 1.64σ` is not the 5% point. The z-score is still reported, because
 * "2.4σ below native" is a sentence a person can read; it is just not what the
 * verdict is cut on.
 */
const FLAG_QUANTILE = 0.05;
/**
 * Clips whose mean GOP is below this are dropped before the statistics.
 *
 * A recording the model cannot explain at all — a truncated file, a transcript
 * that does not match the audio — is not evidence about how natives say /r/,
 * and one of them contributes a hundred bad spans. The cut is deliberately far
 * below where real clips sit (measured: a native sentence means about +5
 * nats), because this is a place the run could quietly bias itself towards
 * what the model already likes. It prints how many clips it removed, and the
 * distribution they came from, so that stays checkable.
 */
const CLIP_FLOOR = option("clip-floor", -4);


register(pathToFileURL(resolve(root, "scripts/ts-loader.mjs")).href);

async function main() {
  await mkdir(cacheDir, { recursive: true });
  // gop.ts imports the generated module, so it has to exist before the
  // pipeline can be imported at all — including on the very first run.
  if (!existsSync(outPath)) await writeFile(outPath, emit({ phones: {}, pooled: null, meta: stubMeta() }));

  const [{ g2p }, { scoreUtterance }, { decodeWav }, { trimToSpeech }, { openSession }, source] =
    await Promise.all([
      import("@/app/lib/phonology/g2p"),
      import("@/app/lib/phonology/gop"),
      import("@/app/lib/audio/wav"),
      import("@/app/lib/audio/trim"),
      import("@/app/lib/acoustic/session"),
      readFile(resolve(root, "src/app/lib/acoustic/model-source.json"), "utf8").then(JSON.parse),
    ]);

  const modelDir = resolve(root, ".models", source.id);
  if (!existsSync(resolve(modelDir, "model.onnx"))) {
    throw new Error(`No weights in ${modelDir}. Run \`npm run model:fetch\` first.`);
  }

  const transcripts = await loadTranscripts();
  console.log(`[stats] ${transcripts.size} ${SPLIT} sentences in FLEURS es_419`);

  if (args["dry-run"]) {
    // What the transcripts alone say about coverage, before a byte of audio is
    // fetched: how many sentences it takes to fill the quotas, if the audio
    // cooperates.
    // Same bookkeeping as the real run — a phone maps to its observations —
    // so `hungry` and `satisfied` decide identically here.
    const covered = new Map();
    let used = 0;
    for (const words of transcripts.values()) {
      const phones = phonesOf(words, g2p);
      if (!phones || !hungry(covered, phones)) continue;
      for (const phone of phones) covered.set(phone, [...(covered.get(phone) ?? []), 0]);
      used += 1;
      if (used >= CLIPS || satisfied(covered)) break;
    }
    console.log(
      `[stats] ${used} sentences would cover: ` +
        [...covered].sort(([, a], [, b]) => a.length - b.length).map(([p, v]) => `${p}:${v.length}`).join(" "),
    );
    return;
  }

  const session = await openSession({
    weights: await readFile(resolve(modelDir, "model.onnx")),
    vocab: JSON.parse(await readFile(resolve(modelDir, "vocab.json"), "utf8")),
    padToken: source.padToken,
    sampleRate: source.sampleRate,
  });

  /** phone -> every GOP observed for it. */
  const observations = new Map();
  /** Per-clip mean GOP, kept so the run can show where `CLIP_FLOOR` actually falls. */
  const clipMeans = [];
  const skipped = { transcript: 0, decode: 0, silent: 0, align: 0, floor: 0, sated: 0 };
  let scored = 0;

  const archive = await cachedArchive(`${FLEURS}/audio/${SPLIT}.tar.gz`);

  // The archive is read in order and abandoned the moment the quotas are met.
  // Each entry is one sentence, so this loop is "score until there is nothing
  // left to learn", not "read a whole corpus".
  for await (const clip of streamClips(archive)) {
    if (scored >= CLIPS) break;

    const words = transcripts.get(basename(clip.name));
    if (!words) {
      skipped.transcript += 1;
      continue;
    }
    const phones = phonesOf(words, g2p);
    if (!phones) {
      skipped.transcript += 1;
      continue;
    }
    if (!hungry(observations, phones)) {
      // Nothing in this sentence is still short of its quota — and inference
      // costs the sentence's own length, so skipping is the whole saving.
      skipped.sated += 1;
      if (satisfied(observations)) break;
      continue;
    }

    let samples;
    try {
      const wav = decodeWav(clip.bytes);
      samples = resampleTo16k(wav.samples, wav.sampleRate);
    } catch {
      skipped.decode += 1;
      continue;
    }
    // The same endpoint trim the app applies to a learner's recording (§14.5):
    // the reference distribution should be measured on the shape of input the
    // model will actually be handed.
    const trimmed = trimToSpeech(samples, { sampleRate: 16000 });
    if (!trimmed || trimmed.samples.length < 1600) {
      skipped.silent += 1;
      continue;
    }

    let scores;
    try {
      const logProbs = await session.infer(trimmed.samples, 16000);
      scores = scoreUtterance(logProbs, phones, {
        labels: session.labels,
        blank: session.blank,
        // Uncalibrated on purpose: these observations *are* the calibration,
        // and a half-written generated file must not feed back into the run.
        stats: {},
        pooled: null,
      });
    } catch {
      skipped.align += 1;
      continue;
    }

    const mean = scores.reduce((a, s) => a + s.gop, 0) / scores.length;
    if (!Number.isFinite(mean) || mean < CLIP_FLOOR) {
      skipped.floor += 1;
      continue;
    }
    for (const score of scores) {
      const seen = observations.get(score.phone) ?? [];
      seen.push(score.gop);
      observations.set(score.phone, seen);
    }
    clipMeans.push(mean);
    scored += 1;
    const seconds = (trimmed.samples.length / 16000).toFixed(1);
    process.stdout.write(
      `\r[stats] ${scored}/${CLIPS} sentences, ${[...observations.values()].reduce((a, v) => a + v.length, 0)} spans (last ${seconds}s)   `,
    );
  }
  process.stdout.write("\n");
  await session.release();

  const phones = {};
  const pool_ = [];
  for (const [phone, values] of [...observations].sort(([a], [b]) => a.localeCompare(b))) {
    pool_.push(...values);
    if (values.length < MIN_OBSERVATIONS) {
      console.log(`[stats] /${phone}/ has only ${values.length} observations — pooled fallback`);
      continue;
    }
    phones[phone] = summarise(values);
  }
  if (pool_.length === 0) throw new Error("No clips survived; nothing to write.");

  const meta = {
    model: source.id,
    generated: new Date().toISOString().slice(0, 10),
    clips: scored,
    spans: pool_.length,
    source: `google/fleurs es_419 (${SPLIT}), CC BY 4.0`,
  };
  await writeFile(outPath, emit({ phones, pooled: summarise(pool_), meta }));

  console.log(`[stats] ${scored} sentences, ${pool_.length} phone spans`);
  console.log(`[stats] skipped: ${JSON.stringify(skipped)}`);
  // Printed so `CLIP_FLOOR` can be set from evidence rather than taste: if the
  // floor is not well below the 5th percentile here, it is throwing away
  // accents rather than wreckage.
  console.log(
    `[stats] clip mean GOP: min ${fixed(Math.min(...clipMeans))}, ` +
      `p05 ${fixed(quantile(clipMeans, 0.05))}, median ${fixed(quantile(clipMeans, 0.5))}, ` +
      `max ${fixed(Math.max(...clipMeans))} (floor ${CLIP_FLOOR})`,
  );
  console.log(
    `[stats] observations per phone: ` +
      [...observations]
        .sort(([, a], [, b]) => a.length - b.length)
        .map(([phone, values]) => `${phone}:${values.length}`)
        .join(" "),
  );
  console.log(`[stats] wrote ${outPath}`);
}

/** Mean, σ and the flag percentile for one phone. */
function summarise(values) {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  // σ is floored: a phone every native nails (/a/) can come out near-constant,
  // and a z-score divided by ~0 would report thousands of standard deviations.
  const sd = Math.max(Math.sqrt(variance), 0.05);
  return { mean, sd, n, p05: quantile(values, FLAG_QUANTILE) };
}

function quantile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (sorted.length - 1) * fraction;
  const low = Math.floor(at);
  const high = Math.ceil(at);
  return sorted[low] + (sorted[high] - sorted[low]) * (at - low);
}

/**
 * `filename -> words`, from the split's TSV.
 *
 * Column 3 is FLEURS' *normalised* transcription — lowercase, no punctuation,
 * numbers spelled out — which is exactly what G2P wants and is the reason this
 * corpus needs no text cleaning of its own. Cached; it is 200 KB.
 */
async function loadTranscripts() {
  const cached = resolve(cacheDir, `fleurs-${SPLIT}.tsv`);
  let text;
  if (existsSync(cached)) {
    text = await readFile(cached, "utf8");
  } else {
    text = await (await politeFetch(`${FLEURS}/${SPLIT}.tsv`)).text();
    await writeFile(cached, text);
  }
  const transcripts = new Map();
  for (const line of text.split("\n")) {
    const [, file, , normalised] = line.split("\t");
    if (file && normalised) transcripts.set(file, normalised);
  }
  return transcripts;
}

/** The phones of a whole sentence, or `null` if any word is unpronounceable. */
function phonesOf(words, g2p) {
  try {
    // Word by word: there is no cross-word resyllabification in G2P (§11), and
    // there does not need to be — the aligner reads a flat phone sequence, and
    // *los amigos* has the same phones however it is syllabified.
    return g2pPhrase(words, g2p);
  } catch {
    return null;
  }
}

const g2pPhrase = (words, g2p) => words.split(/\s+/).filter(Boolean).flatMap((w) => g2p(w).phones);

/** Does this sentence contain anything still short of its quota? */
function hungry(observations, phones) {
  return phones.some((phone) => (observations.get(phone)?.length ?? 0) < QUOTA);
}

/** Every phone we have ever seen has its quota — nothing left to learn from this corpus. */
function satisfied(observations) {
  return observations.size > 0 && [...observations.values()].every((v) => v.length >= QUOTA);
}

const basename = (path) => path.slice(path.lastIndexOf("/") + 1);

/**
 * Read a local `.tar.gz` of clips, yielding one file at a time.
 *
 * Streamed rather than extracted because the caller stops early: it abandons
 * the loop once the phone quotas are met, and the rest of the archive is never
 * decompressed. Node has `zlib` and 512-byte tar headers are half a page of
 * parsing, so this needs no dependency.
 */
async function* streamClips(path) {
  const gunzip = createGunzip();
  const file = createReadStream(path);
  file.pipe(gunzip);

  let buffer = Buffer.alloc(0);
  let header = null;
  try {
    for await (const chunk of gunzip) {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      for (;;) {
        if (!header) {
          if (buffer.length < 512) break;
          const block = buffer.subarray(0, 512);
          buffer = buffer.subarray(512);
          const name = block.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
          if (name === "") continue; // the two zero blocks that end an archive
          const size = parseInt(block.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim(), 8);
          header = { name, size: Number.isFinite(size) ? size : 0, type: String.fromCharCode(block[156]) };
        }
        const padded = Math.ceil(header.size / 512) * 512;
        if (buffer.length < padded) break;
        const entry = header;
        const bytes = buffer.subarray(0, entry.size);
        buffer = buffer.subarray(padded);
        header = null;
        // "0" and NUL are both a plain file; directories and the PAX metadata
        // entries GNU tar writes are neither.
        if ((entry.type === "0" || entry.type === "\0") && entry.name.endsWith(".wav")) {
          yield { name: entry.name, bytes };
        }
      }
    }
  } finally {
    // The consumer breaks out of this loop as soon as it has what it needs;
    // without this the file keeps being read and inflated behind it.
    gunzip.destroy();
    file.destroy();
  }
}

/**
 * The split's audio archive, on disk, fetched once and resumed if interrupted.
 *
 * This used to inflate straight off the socket and abandon the connection once
 * the quotas were met, which is a genuinely better idea when a handful of
 * sentences will do. It is the wrong one here: filling every phone's quota
 * takes ~170 of the 408 dev sentences, so most of the archive is transferred
 * anyway — and a long-lived stream that is deliberately left half-read gets
 * dropped. A real run died on `UND_ERR_SOCKET: other side closed` after 22 MB,
 * forty sentences in, with nothing to show for the twenty minutes of inference
 * it had already done.
 *
 * So: fetch to `.cache/` with `Range` resume, then read from the file. The
 * download is interruptible without losing work, and the *second* run — the
 * one that happens whenever the model build changes and the stats have to be
 * regenerated against it (§10.3) — touches the network not at all.
 */
async function cachedArchive(url, attempts = 6) {
  const path = resolve(cacheDir, basename(url));
  if (existsSync(path)) {
    console.log(`[stats] archive cached at ${path}`);
    return path;
  }
  const partial = `${path}.part`;

  for (let attempt = 1; ; attempt += 1) {
    const have = existsSync(partial) ? (await stat(partial)).size : 0;
    try {
      const response = await fetch(url, {
        headers: {
          "user-agent": USER_AGENT,
          ...(have > 0 ? { range: `bytes=${have}-` } : {}),
        },
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      // A server that ignores `Range` answers 200 with the whole file, which
      // would append a second copy onto the first. Start again rather than
      // write a corrupt archive.
      if (have > 0 && response.status !== 206) {
        await rm(partial, { force: true });
        throw new Error("range request ignored; restarting the download");
      }

      const expected = have + Number(response.headers.get("content-length") ?? 0);
      let received = have;
      let shown = -1;
      const source = Readable.fromWeb(response.body);
      source.on("data", (chunk) => {
        received += chunk.length;
        const percent = expected > 0 ? Math.floor((received / expected) * 100 / 5) * 5 : -1;
        if (percent !== shown) {
          shown = percent;
          process.stdout.write(`\r[stats] archive ${percent}% (${(received / 1e6).toFixed(0)} MB)   `);
        }
      });

      await pipeline(source, createWriteStream(partial, { flags: have > 0 ? "a" : "w" }));
      process.stdout.write("\n");
      await rename(partial, path);
      return path;
    } catch (thrown) {
      if (attempt === attempts) throw thrown;
      const wait = Math.min(1000 * 2 ** attempt, 30_000);
      const at = existsSync(partial) ? (await stat(partial)).size : 0;
      process.stdout.write(
        `\n[stats] download interrupted at ${(at / 1e6).toFixed(0)} MB ` +
          `(${thrown.message}); resuming in ${Math.round(wait / 1000)}s\n`,
      );
      await sleep(wait);
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One request, with the manners Wikimedia asks for.
 *
 * Two of them are load-bearing and both were learned the hard way: without a
 * descriptive `User-Agent` the API answers **403**, and enumerating 19k files
 * flat out earns a **429** about ten pages in. So: back off, honour
 * `Retry-After`, and leave a gap between pages. This is a one-off script
 * hitting a donated service.
 */
async function politeFetch(url, attempts = 5) {
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(url, { headers: { "user-agent": USER_AGENT } });
    if (response.ok) return response;
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === attempts) {
      throw new Error(`${response.status} ${response.statusText} for ${url.slice(0, 90)}`);
    }
    // `Retry-After: 600` is what a burst of parallel downloads earns. Capped,
    // because a ten-minute stall in a foreground script reads as a hang — and
    // by the time the cap expires the burst window has usually moved on.
    const after = Number(response.headers.get("retry-after"));
    const suggested = Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * 2 ** attempt;
    const wait = Math.min(suggested, 60_000);
    process.stdout.write(`\n[stats] ${response.status}; waiting ${Math.round(wait / 1000)}s\n`);
    await sleep(wait);
  }
}

/**
 * Band-limited resample to 16 kHz.
 *
 * The browser hands this job to `OfflineAudioContext` (`resample.ts`), which
 * Node does not have, so here it is: a windowed-sinc interpolator, which is
 * what that context is doing internally. Dropping every third sample instead
 * would alias the 8–24 kHz band down into the speech being scored, and the
 * fricatives live up there.
 */
function resampleTo16k(samples, from, to = 16000) {
  if (from === to) return samples;
  const ratio = to / from;
  const out = new Float32Array(Math.max(1, Math.round(samples.length * ratio)));
  // Cut off at the lower of the two Nyquist limits, in input-rate cycles.
  const cutoff = Math.min(0.5, 0.5 * ratio);
  const half = Math.ceil(16 / (2 * cutoff)); // 16 zero crossings either side

  for (let i = 0; i < out.length; i += 1) {
    const centre = i / ratio;
    const first = Math.ceil(centre - half);
    const last = Math.floor(centre + half);
    let sum = 0;
    let weight = 0;
    for (let n = first; n <= last; n += 1) {
      const x = n - centre;
      const t = (x + half) / (2 * half);
      // Blackman window, so the stopband is deep enough not to fold noise back in.
      const window = 0.42 - 0.5 * Math.cos(2 * Math.PI * t) + 0.08 * Math.cos(4 * Math.PI * t);
      const arg = Math.PI * 2 * cutoff * x;
      const sinc = arg === 0 ? 1 : Math.sin(arg) / arg;
      const tap = sinc * window;
      // Zero outside the recording, not the nearest sample: clamping holds a
      // DC step under the filter and rings for a few milliseconds at each end,
      // which is a click right where the endpoint trim is looking for speech.
      const sample = n >= 0 && n < samples.length ? samples[n] : 0;
      sum += sample * tap;
      weight += tap;
    }
    out[i] = weight === 0 ? 0 : sum / weight;
  }
  return out;
}

const stubMeta = () => ({
  model: "(not generated yet)",
  generated: "—",
  clips: 0,
  spans: 0,
  source: "run `npm run stats:native`",
});

const round = (x) => Number(x.toFixed(4));
const fixed = (x) => x.toFixed(2);

function emit({ phones, pooled, meta }) {
  const rows = Object.entries(phones)
    .map(
      ([phone, s]) =>
        `  ${JSON.stringify(phone)}: { mean: ${round(s.mean)}, sd: ${round(s.sd)}, n: ${s.n}, p05: ${round(s.p05)} },`,
    )
    .join("\n");
  const pooledRow = pooled
    ? `{ mean: ${round(pooled.mean)}, sd: ${round(pooled.sd)}, n: ${pooled.n}, p05: ${round(pooled.p05)} }`
    : "{ mean: 0, sd: 1, n: 0, p05: -Infinity }";

  return `/**
 * GENERATED by scripts/gen-native-stats.mjs — do not edit.
 *
 *   npm run stats:native
 *
 * What native speech scores, per phone, under this exact model build. A
 * learner's GOP is meaningless on its own (§4.6): /a/ is distinctive and
 * always scores near 0, while /r/, /ɾ/ and /l/ crowd each other even for
 * natives. These are the numbers that turn a margin in nats into "2.4σ below
 * where natives sit", and \`p05\` is the line a verdict is cut on.
 *
 * Regenerate whenever the model build changes (\`model-source.json\`), or the
 * z-scores shift under the app: the quantization bias only cancels when the
 * reference and the runtime are the same weights (§10.3).
 *
 * Source: ${meta.source}
 * Model:  ${meta.model}
 * Corpus: ${meta.clips} clips, ${meta.spans} phone spans
 * Run:    ${meta.generated}
 */

import type { PhoneStat } from "./gop";

/** Per phone, for the phones with enough observations to be worth a distribution. */
export const NATIVE_GOP: Readonly<Record<string, PhoneStat>> = {
${rows}
};

/** Every span pooled, for a phone that did not make the cut. Better than no calibration. */
export const NATIVE_POOLED: PhoneStat = ${pooledRow};

export const NATIVE_STATS_META = ${JSON.stringify(meta, null, 2).replace(/\n/g, "\n")} as const;
`;
}

main().catch((error) => {
  console.error(`[stats] ${error.message}`);
  process.exitCode = 1;
});
