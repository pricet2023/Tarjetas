/**
 * Fixture loading, in one place because two test files need the same clip.
 *
 * Node-only (`fs`), and only ever imported from tests. The path is resolved
 * from the working directory rather than `import.meta.url`, because under the
 * `jsdom` environment `import.meta.url` is an `http://` URL and
 * `fileURLToPath` refuses it.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { decodeWav, type Waveform } from "@/app/lib/audio/wav";

export const FIXTURE_DIR = "src/app/lib/acoustic/fixtures";

export const fixturePath = (name: string): string => resolve(process.cwd(), FIXTURE_DIR, name);

/** Read one of the committed WAVs. See NOTICE.md for provenance and licence. */
export function readFixtureWav(name: string): Waveform {
  return decodeWav(readFileSync(fixturePath(name)));
}
