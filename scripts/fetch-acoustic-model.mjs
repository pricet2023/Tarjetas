#!/usr/bin/env node
// Download the pronunciation model's weights and labels into .models/, which
// is gitignored — 197 MB does not belong in the repo.
//
// The browser does not need this: it fetches the same URLs itself and keeps
// them in the Cache API (see src/app/lib/acoustic/weights.ts). This exists for
// the things that run in Node — the gated integration test in
// src/app/lib/acoustic/session.integration.test.ts, and Phase 5's
// native-stats script, which has to use the *same build* the app runs or the
// z-scores shift under it.

import { createWriteStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = JSON.parse(
  await readFile(resolve(root, "src/app/lib/acoustic/model-source.json"), "utf8"),
);

export const modelDir = resolve(root, ".models", source.id);
const weightsPath = resolve(modelDir, "model.onnx");
const labelsPath = resolve(modelDir, "vocab.json");

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function sizeOf(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

async function main() {
  await mkdir(modelDir, { recursive: true });

  const have = await sizeOf(weightsPath);
  if (have === source.bytes) {
    console.log(`[model] ${weightsPath} already there (${mb(have)})`);
  } else {
    if (have) console.log(`[model] ${mb(have)} on disk but expected ${mb(source.bytes)} — refetching`);
    console.log(`[model] downloading ${mb(source.bytes)} from ${source.weights}`);
    const response = await fetch(source.weights);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);

    let received = 0;
    let shown = 0;
    const body = Readable.fromWeb(response.body);
    body.on("data", (chunk) => {
      received += chunk.length;
      const percent = Math.floor((received / source.bytes) * 100);
      if (percent >= shown + 5) {
        shown = percent;
        process.stdout.write(`\r[model] ${percent}% (${mb(received)})`);
      }
    });
    await pipeline(body, createWriteStream(weightsPath));
    process.stdout.write("\n");

    const written = await sizeOf(weightsPath);
    if (written !== source.bytes) {
      throw new Error(`downloaded ${written} bytes, expected ${source.bytes}`);
    }
  }

  const labels = await fetch(source.labels);
  if (!labels.ok) throw new Error(`labels: ${labels.status} ${labels.statusText}`);
  const vocab = await labels.json();
  await writeFile(labelsPath, JSON.stringify(vocab, null, 1));
  console.log(`[model] ${Object.keys(vocab).length} labels -> ${labelsPath}`);
  console.log(`[model] ready. Run: npm run test:model`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`[model] failed: ${error.message}`);
    process.exit(1);
  });
}
