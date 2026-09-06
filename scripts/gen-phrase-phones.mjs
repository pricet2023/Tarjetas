#!/usr/bin/env node
// Run the app's own G2P over every card face in the deck and emit the result
// as a migration, so `study_deck` can weight a pronunciation prompt by the
// sounds in it (014).
//
//   npm run db:phones          # after a db:reset, before the next one
//
// Output: supabase/migrations/015_seed_phrase_phones.sql — a generated file,
// the same shape as 005 (word frequencies) and 011 (the seed deck). Rerun it;
// do not edit it.
//
// **Why a migration rather than a client backfill.** The point of 014 is cold
// start: a card the learner has never pronounced should already be known to be
// hard, because /r/ and /x/ are hard in every word that contains them. A cache
// that fills in as cards are studied has the phones for exactly the cards that
// no longer need the prediction.
//
// **Where the phrases come from.** The local database, not 011_seed_cards.sql.
// Parsing a megabyte of generated SQL string literals to recover the values is
// possible and brittle — a first attempt came back with 3,463 of the 3,479
// cards and no indication which sixteen were wrong. The deck is deterministic
// given 011, so reading it back after a reset is the same data with none of
// the guessing. It does mean this runs *after* `npm run db:reset` and its
// output is picked up by the next one, which is why it is its own command.
//
// **Why the app's real G2P** rather than a re-implementation: it is the same
// function that will build the alignment target at scoring time
// (`g2pPhrase` -> `buildTarget` -> `forcedAlign`). A second implementation
// that disagreed would weight cards by phones the scorer never looks for.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { register } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outPath = resolve(root, "supabase/migrations/015_seed_phrase_phones.sql");

/** Bumped when a G2P rule changes, so 014's `g2p_version` can find stale rows. */
const G2P_VERSION = 1;

register(pathToFileURL(resolve(root, "scripts/ts-loader.mjs")).href);

async function main() {
  const { g2pPhrase } = await import("@/app/lib/phonology/g2p");

  const phrases = deckPhrases();
  console.log(`[phones] ${phrases.length} distinct card faces in the deck`);

  const rows = [];
  const failed = [];
  for (const phrase of phrases) {
    try {
      const phones = g2pPhrase(phrase).flatMap((word) => word.phones);
      if (phones.length === 0) throw new Error("no phones");
      rows.push({ phrase, phones });
    } catch (thrown) {
      // Not fatal, and not silent. A card G2P refuses is one the app will also
      // refuse to score (§11); it simply keeps 010's flat unseen urgency.
      failed.push(`${phrase} — ${thrown.message}`);
    }
  }

  if (rows.length === 0) throw new Error("G2P produced nothing; refusing to write an empty migration.");
  // The same guard `gen-seed-cards.py` puts in front of its conjugations: a
  // library or rule change that breaks most of the deck should stop here
  // rather than quietly emit a migration that weights nothing.
  const coverage = rows.length / phrases.length;
  if (coverage < 0.95) {
    throw new Error(
      `G2P only covered ${(coverage * 100).toFixed(1)}% of the deck ` +
        `(${failed.length} refused). That is a rule regression, not a deck of odd cards.`,
    );
  }

  await writeFile(outPath, emit(rows, phrases.length, failed));
  console.log(`[phones] ${rows.length} phrases, ${failed.length} refused`);
  for (const line of failed.slice(0, 10)) console.log(`[phones]   skipped: ${line}`);
  if (failed.length > 10) console.log(`[phones]   ...and ${failed.length - 10} more`);
  console.log(`[phones] wrote ${outPath}`);
}

/**
 * Every distinct `spanish` in the deck, ordered, straight out of the local DB.
 *
 * Through `psql` inside the Supabase container rather than a Postgres client,
 * so this needs no dependency the app does not already have — the same
 * shell-out-to-the-CLI move `gen-types.mjs` makes. `-A -t` gives unaligned,
 * untitled output, and the record separator is ASCII RS (0x1e) rather than a
 * newline: a card face is free-text a person typed, and splitting on anything
 * that could occur inside one would quietly cut a phrase in half.
 */
function deckPhrases() {
  const sql = "select distinct spanish from public.cards order by spanish";
  let out;
  try {
    out = execFileSync(
      "docker",
      [
        "exec", "-i", containerName(),
        "psql", "-U", "postgres", "-d", "postgres",
        "-A", "-t", "-R", RS, "-c", sql,
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (thrown) {
    throw new Error(
      "Couldn't read the deck. Is the local stack up? `npm run db:start`, then " +
        `\`npm run db:reset\`.\n${thrown.message}`,
    );
  }
  return out.split(RS).map((phrase) => phrase.trim()).filter(Boolean);
}

/** ASCII RECORD SEPARATOR — see `deckPhrases`. */
const RS = "\u001e";

/** The db container's name, which Supabase derives from the project id. */
function containerName() {
  const config = resolve(root, "supabase", "config.toml");
  const id = /^\s*project_id\s*=\s*"([^"]+)"/m.exec(readFileSync(config, "utf8"))?.[1];
  if (!id) throw new Error(`No project_id in ${config}`);
  return `supabase_db_${id}`;
}

const quote = (value) => `'${value.replace(/'/g, "''")}'`;
const array = (phones) => `array[${phones.map(quote).join(",")}]::text[]`;

function emit(rows, total, failed) {
  const header = `-- ---------------------------------------------------------------------------
-- The seed deck's card faces, in phonemes.
--
-- GENERATED FILE — do not edit by hand. Regenerate with:
--     npm run db:phones
--
-- ${rows.length} of ${total} distinct card faces, produced by the app's own
-- \`g2pPhrase\` (src/app/lib/phonology/g2p.ts) at version ${G2P_VERSION}.
-- ${failed.length} face${failed.length === 1 ? "" : "s"} G2P refused to pronounce, which the app
-- would also refuse to score; those keep the flat unseen urgency 010 gives
-- every other new card.
--
-- What this is *for* is 014: with the phonemes of a card face in the database,
-- a pronunciation prompt that has never been attempted can still be weighted
-- by how well the learner says the sounds in it. See that migration's header.
--
-- \`on conflict\` rather than a plain insert: a face the client has already
-- filled in is the same derivation from the same text, and the client's row is
-- no less current than this one.
-- ---------------------------------------------------------------------------

`;

  // Chunked, for the same reason 011 and 005 are: one statement per 500 rows
  // keeps any single line short enough for psql and the parser's stack shallow.
  const statements = [];
  for (let at = 0; at < rows.length; at += 500) {
    const values = rows
      .slice(at, at + 500)
      .map((r) => `(${quote(r.phrase)},${array(r.phones)},${G2P_VERSION})`)
      .join(",");
    statements.push(
      `insert into public.phrase_phones (phrase, phones, g2p_version) values ${values}\n` +
        `on conflict (phrase) do nothing;\n`,
    );
  }
  return header + statements.join("\n");
}

main().catch((error) => {
  console.error(`[phones] ${error.message}`);
  process.exit(1);
});
