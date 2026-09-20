#!/usr/bin/env node
// Entry point for the pronunciation scorer (plan §19).
//
//   npm run scorer          # or `node server/run.mjs`
//
// A `.mjs` wrapper for the same reason `gen-native-stats.mjs` is one: the
// service imports the app's TypeScript directly — `session.ts`, `protocol.ts`
// — and Node needs `scripts/ts-loader.mjs` registered before any of it is
// resolved, which cannot happen from inside the module graph it is teaching
// Node to resolve.
//
// Importing the app's own source rather than a built copy is the point. The
// browser and the box must run the *same* inference, because the z-scores in
// `native-stats.generated.ts` are calibrated against one build (§19.3); a
// separately-maintained server implementation is exactly the drift that would
// make every verdict quietly wrong.

import { existsSync } from "node:fs";
import { register } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Dev convenience. In production systemd supplies the environment, and there
// is no .env on the box.
const envFile = resolve(root, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

register(pathToFileURL(resolve(root, "scripts/ts-loader.mjs")).href);

const { start, configFromEnv, hasWeights } = await import("./scorer.ts");

const config = configFromEnv();

// Not an error, and specifically not a non-zero exit: `npm run dev` runs this
// beside Vite under `--kill-others-on-fail`, and a checkout that has never
// fetched the 197 MB of weights must still be able to start the app. The
// client falls back to the on-device path on its own when no scorer answers.
if (!hasWeights(config)) {
  console.warn(
    `[scorer] no weights in ${config.modelDir} — not starting.\n` +
      "[scorer] run `npm run model:fetch` if you want to develop against the scorer.",
  );
  process.exit(0);
}

// Fail visibly rather than serving 500s: without weights there is nothing this
// process can usefully do, and systemd restarting it is the right answer.
const stop = await start(config).catch((error) => {
  console.error(`[scorer] ${error.message}`);
  process.exit(1);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    console.log(`[scorer] ${signal}, draining`);
    // Stop accepting, let in-flight scoring finish, release the session.
    stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
