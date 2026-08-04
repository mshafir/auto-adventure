#!/usr/bin/env node
import { render } from "ink";
import { CONFIG } from "./config.js";
import type { LaunchChoice } from "./scenario/scenario.js";
import { buildSession } from "./session.js";
import App from "./ui/app.js";
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
 * What the bare `npm start` path launches.
 *
 * Resumes the configured slot if it exists and creates it otherwise, which is the
 * behaviour every invocation had before there was anything to choose between.
 */
function choiceFromEnv(): LaunchChoice {
	return {
		worldId: CONFIG.worldName,
		seed: CONFIG.seed,
		flavour: CONFIG.noAi ? "procedural" : "live",
		...(CONFIG.brief ? { brief: CONFIG.brief } : {}),
	};
}

async function startGame() {
	const session = buildSession(choiceFromEnv(), { saveDebounceMs: CONFIG.saveDebounceMs });
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
