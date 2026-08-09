/**
 * Write the baked default pack out as its JSON asset.
 *
 * ```
 * npm run pack:emit
 * ```
 *
 * The default lives in code so the pure generators need no filesystem, and as a file
 * so an author has a complete example to copy. A test asserts the two are identical,
 * which makes this the command that fixes it: change `core/content/default.ts`, run
 * this, commit both.
 *
 * The npm script runs the formatter over the result, and that is not tidiness: `lint`
 * checks the whole repository rather than `src/`, so an asset written by
 * `JSON.stringify` — which puts every two-element array on four lines — fails the build
 * every time this is regenerated. Formatting here means emitting and committing is the
 * whole procedure, with no second step to remember.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { packPath, packRoot } from "../content/load.js";
import { DEFAULT_PACK } from "../core/content/default.js";

mkdirSync(packRoot(), { recursive: true });
const path = packPath("default");
writeFileSync(path, `${JSON.stringify(DEFAULT_PACK, null, "\t")}\n`);
process.stdout.write(`wrote ${path}\n`);
