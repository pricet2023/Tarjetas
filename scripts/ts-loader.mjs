// A ~30-line ESM loader so a plain `.mjs` script can import the app's source.
//
// Node 24 strips TypeScript types by itself, which covers most of the gap, but
// two things still need help:
//
//   1. the `@/app/...` path aliases, which live in vite.config.ts and
//      tsconfig.json and mean nothing to Node's resolver;
//   2. extensionless relative imports (`./normalize`), which TypeScript allows
//      and Node's ESM resolver does not — plus `.json` imports written without
//      an import attribute.
//
// The alternative was bundling the pipeline with esbuild before running it,
// which is more moving parts for the same result. Registered by
// `gen-native-stats.mjs`; nothing else uses it yet.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const src = pathToFileURL(resolvePath(dirname(fileURLToPath(import.meta.url)), "..", "src")).href;

export async function resolve(specifier, context, next) {
  const aliased = specifier.startsWith("@/") ? `${src}/${specifier.slice(2)}` : specifier;
  const isLocal = aliased.startsWith(".") || aliased.startsWith("file:") || aliased.startsWith(src);
  if (!isLocal) return next(aliased, context);

  const url = aliased.startsWith(".") ? new URL(aliased, context.parentURL).href : aliased;
  if (!/\.(ts|tsx|js|mjs|json)$/.test(url)) {
    for (const extension of [".ts", ".tsx", ".js", "/index.ts"]) {
      if (existsSync(fileURLToPath(url + extension))) return next(url + extension, context);
    }
  }
  return next(url, context);
}

export async function load(url, context, next) {
  if (url.endsWith(".json")) {
    // `import source from "./model-source.json"` has no import attribute in
    // the app's source, because Vite does not need one.
    const text = await readFile(fileURLToPath(url), "utf8");
    return { format: "module", shortCircuit: true, source: `export default ${text};` };
  }
  return next(url, context);
}
