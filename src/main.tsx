#!/usr/bin/env node
import { render } from "ink";
import { CONFIG } from "./config.js";
import type { LaunchChoice } from "./scenario/scenario.js";
import { buildSession } from "./session.js";
import App from "./ui/app.js";
import { pickLaunch } from "./ui/launcher/pick-launch.js";
import { endSynchronizedOutput, withSynchronizedOutput } from "./ui/render/sync-output.js";
import { bindEngine } from "./ui/store.js";
import { logger } from "./utils/log.js";

const ALT_SCREEN_ON = "\u001B[?1049h";
const ALT_SCREEN_OFF = "\u001B[?1049l";
const CURSOR_SHOW = "\u001B[?25h";

function enterAltScreen(): () => void {
	process.stdout.write(ALT_SCREEN_ON);
	let restored = false;
	return () => {
		if (restored) return;
		restored = true;
		process.stdout.write(ALT_SCREEN_OFF + CURSOR_SHOW);
	};
}

/**
 * Resume the configured slot, creating it if absent.
 *
 * The behaviour every invocation had before there was anything to choose between,
 * kept for the two cases where a menu is wrong: a named slot, which means the
 * caller already knows which world it wants, and no terminal to draw a menu on.
 */
function choiceFromEnv(): LaunchChoice {
	return {
		worldId: CONFIG.worldName,
		seed: CONFIG.seed,
		flavour: CONFIG.noAi ? "procedural" : "live",
		...(CONFIG.brief ? { brief: CONFIG.brief } : {}),
	};
}

function wantsLauncher(): boolean {
	if (CONFIG.worldNameExplicit) return false;
	// Ink cannot read keys without a TTY, so a piped or redirected run would hang
	// on a menu nobody can answer.
	return Boolean(process.stdin.isTTY);
}

async function startGame() {
	const choice = wantsLauncher() ? await pickLaunch() : choiceFromEnv();
	if (!choice) return;

	const session = buildSession(choice, { saveDebounceMs: CONFIG.saveDebounceMs });
	bindEngine(session.engine);

	const restoreScreen = enterAltScreen();
	const shutdown = (code: number) => {
		session.dispose();
		endSynchronizedOutput();
		restoreScreen();
		process.exit(code);
	};
	process.on("SIGINT", () => shutdown(0));
	process.on("SIGTERM", () => shutdown(0));

	try {
		// Every frame goes out as one synchronized update, so the terminal never
		// shows the gap between Ink erasing the old output and writing the new.
		const { waitUntilExit } = render(<App />, {
			exitOnCtrlC: true,
			stdout: withSynchronizedOutput(process.stdout),
		});
		await waitUntilExit();
	} finally {
		session.dispose();
		endSynchronizedOutput();
		restoreScreen();
	}
}

process.on("unhandledRejection", (reason) => {
	logger.error("unhandled rejection", reason);
});
process.on("uncaughtException", (error) => {
	logger.error("uncaught exception", error);
	// Leave synchronized mode first: a terminal still holding an unpresented frame
	// looks like a hang rather than a crash.
	endSynchronizedOutput();
	process.stdout.write(ALT_SCREEN_OFF + CURSOR_SHOW);
	process.exit(1);
});

startGame().catch((error) => {
	logger.error("failed to start", error);
	endSynchronizedOutput();
	process.stdout.write(ALT_SCREEN_OFF + CURSOR_SHOW);
	process.exit(1);
});
