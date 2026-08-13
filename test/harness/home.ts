import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

/**
 * A home directory of its own, for every test file.
 *
 * Not tidiness. `readSettings()` resolves `AUTO_ADVENTURE_HOME` on every call and falls back to
 * the *developer's own* `~/.auto-adventure`, so a machine where somebody has saved a gateway key
 * through the options page runs the suite with a key in scope. `hasGatewayKey()` consults the
 * settings file as well as the environment and says yes; the AI SDK reads `AI_GATEWAY_API_KEY`
 * out of `process.env` and nothing else, and nobody calls `installGatewayKey()` in a test — so
 * every guarded call went out for real, came back "Unauthenticated request to AI Gateway", and
 * was retried ten times with backoff.
 *
 * The symptom was not a failure. It was a suite that took twenty minutes instead of two, with a
 * different handful of tests timing out each run, on a machine where nothing had changed except
 * that a key had been typed into the game a day earlier. Found by reading `log.txt` after a live
 * authoring run and noticing the gateway warnings were timestamped during a *test* run.
 *
 * Saves live under the same root, so this also stops a test writing a world into the player's
 * Continue list — which several of them are careful to prevent one file at a time, and now do
 * not have to be.
 *
 * The environment variable is deliberately left alone: `AI_GATEWAY_API_KEY=… npm test` is how
 * somebody asks for the live catalogue check, and that has to keep working.
 */
const home = mkdtempSync(join(tmpdir(), "auto-adventure-test-home-"));
process.env.AUTO_ADVENTURE_HOME = home;

afterAll(() => {
	rmSync(home, { recursive: true, force: true });
});
