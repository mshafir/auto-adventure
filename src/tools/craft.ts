/**
 * Build a scenario the game can play.
 *
 * ```
 * npm run craft -- new the-lantern-watch --premise "a beacon did not light"
 * npm run craft -- survey the-lantern-watch --reach "a walk"
 * npm run craft -- found the-lantern-watch --at -96,-32 --name "Salt Wick" ...
 * npm run craft -- check the-lantern-watch
 * ```
 *
 * Everything that must agree with the generated world goes through here rather than through
 * an editor, and that is the whole idea: a claim the world cannot support is a call that
 * fails, not a fault a player finds. Prose — what somebody says, what a card reads, what
 * `story.md` argues — is written directly, because nothing about it can disagree with a map.
 */

import { runCraft } from "../craft/cli.js";

const code = await runCraft(process.argv.slice(2));
process.exit(code);
