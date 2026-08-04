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
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { packPath, packRoot } from "../content/load.js";
import { DEFAULT_PACK } from "../core/content/default.js";

mkdirSync(packRoot(), { recursive: true });
const path = packPath("default");
writeFileSync(path, `${JSON.stringify(DEFAULT_PACK, null, "\t")}\n`);
process.stdout.write(`wrote ${path}\n`);
