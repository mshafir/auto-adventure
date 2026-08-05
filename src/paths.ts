import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where the repository's own files are, from inside a module.
 *
 * Not `process.cwd()`. The game is started from the repo root, from `dist/`, from
 * a test's temporary directory and from whatever directory a player happens to be
 * standing in, and only one of those has the content beside it. Walking up from
 * this module's own URL answers the same way in every case.
 *
 * `src/paths.ts` and `dist/paths.js` are both one level under the root, which is
 * what makes a single `".."` correct for a source run and a compiled one alike.
 * It lives here rather than being repeated in each reader because getting the
 * count wrong does not fail loudly — it resolves to a directory that simply has
 * no packs in it, and the game starts with default names and says nothing.
 */
export function repoRoot(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

/**
 * Hand-editable content packs, committed.
 *
 * In the repository rather than under the player's home directory because these
 * are *source*: a pack decides what the people in a world are called and what
 * they trade in, and a change to one belongs in a diff where it can be read.
 */
export function packRoot(): string {
	return process.env.AUTO_ADVENTURE_PACKS?.trim() || join(repoRoot(), ".packs");
}

/**
 * Authored worlds, committed, for the same reason.
 *
 * `AUTO_ADVENTURE_SCENARIOS` redirects it, which is how the tests point at a
 * temporary directory now that this no longer hangs off `AUTO_ADVENTURE_HOME`.
 */
export function scenarioRoot(): string {
	return process.env.AUTO_ADVENTURE_SCENARIOS?.trim() || join(repoRoot(), ".scenarios");
}
