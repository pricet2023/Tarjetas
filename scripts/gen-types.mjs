#!/usr/bin/env node
// Generate src/types/database.types.ts from the local Supabase schema.

import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const cwd = process.cwd();
const outDir = resolve(cwd, "src", "types");
const out = resolve(outDir, "database.types.ts");
mkdirSync(outDir, { recursive: true });

const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
const args = ["supabase", "gen", "types", "typescript", "--local"];

console.log(`[gen-types] ${npxCmd} ${args.join(" ")}`);

const stream = createWriteStream(out);
const child = spawn(npxCmd, args, {
  cwd,
  stdio: ["ignore", "pipe", "inherit"],
  env: process.env,
  shell: process.platform === "win32",
});

child.stdout.pipe(stream);

child.on("exit", (code, signal) => {
  stream.close();
  if (code === 0) {
    console.log(`[gen-types] written to ${out}`);
    process.exit(0);
  }
  console.error(`[gen-types] failed (code=${code}, signal=${signal})`);
  process.exit(code ?? 1);
});
