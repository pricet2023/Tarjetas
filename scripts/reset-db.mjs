#!/usr/bin/env node
// Wipe the local DB, re-run migrations, regenerate types.

import { execSync } from "node:child_process";

const log = (msg) => console.log(`[reset-db] ${msg}`);

function probe(cmd) {
  try {
    execSync(cmd, { stdio: ["pipe", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

const run = (cmd) => execSync(cmd, { stdio: "inherit" });

if (!probe("docker info")) {
  console.error("[reset-db] Docker is not running. Start Docker Desktop and try again.");
  process.exit(1);
}

if (!probe("npx supabase status")) {
  log("Starting Supabase...");
  run("npx supabase start");
}

log("Resetting database (re-runs every migration)...");
run("npx supabase db reset");

log("Regenerating database types...");
run("npm run db:types");

log("Done.");
