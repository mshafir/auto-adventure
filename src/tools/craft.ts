/**
 * Build a scenario the game can play.
 *
 * ```
 * npm run craft -- new the-drowned-abbey --premise "an abbey goes under"
 * npm run craft -- survey the-drowned-abbey
 * npm run craft -- claim the-drowned-abbey --site 4213455557 --name "Wenthollow" ...
 * npm run craft -- check the-drowned-abbey
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
