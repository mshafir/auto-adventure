#!/usr/bin/env node
import { render } from "ink";
import { CONFIG, installGatewayKey } from "./config.js";
import type { LaunchChoice } from "./scenario/scenario.js";
import { buildSession } from "./session.js";
import App from "./ui/app.js";
import { pickLaunch } from "./ui/launcher/pick-launch.js";
import {
	cellPixelsWereMeasured,
	probePlan,
	probeTerminal,
	resolveTileMode,
} from "./ui/render/mode.js";
import { multiplexer } from "./ui/render/multiplexer.js";
import {
	endSynchronizedOutput,
	syncOutputEnabled,
	withSynchronizedOutput,
} from "./ui/render/sync-output.js";
import { bindEngine } from "./ui/store.js";
import { setTileMode } from "./ui/viewport.js";
import { logger } from "./utils/log.js";

const ALT_SCREEN_ON = "\u001B[?1049h";
const ALT_SCREEN_OFF = "\u001B[?1049l";
const CURSOR_SHOW = "\u001B[?25h";

/**
 * The shortest gap between two frames, in milliseconds.
 *
 * Thirty-three is thirty frames a second, against the twenty-odd milliseconds a
 * frame costs to draw — so a held key still leaves the process most of its time
 * for reading the keyboard and building ground. `FRAME_MS=0` renders on every
 * change, which is the old behaviour and the way to tell whether this is the thing
 * making something feel wrong.
 */
const FRAME_MS = (() => {
	const raw = Number(process.env.FRAME_MS);
	return Number.isFinite(raw) && raw >= 0 ? raw : 33;
})();

/**
 * Draw in the terminal's own scrollback instead of on a screen of our own.
 *
 * An escape hatch, and it exists to make one particular failure bisectable. "The
 * game does not render at all" is reported from inside multiplexers and remote
 * shells, and there are only two escapes the game leans on that an ordinary TUI
 * does not: the alternate screen buffer, and DEC 2026 synchronized updates on
 * every write. Between `NO_ALT_SCREEN=1` and `NO_SYNC_OUTPUT=1` a player can say
 * which of them their terminal choked on in two runs, rather than us guessing at
 * an emulator we cannot install.
 */
const ALT_SCREEN = process.env.NO_ALT_SCREEN !== "1" && process.env.NO_ALT_SCREEN !== "true";

function enterAltScreen(): () => void {
	if (!ALT_SCREEN) return () => {};
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

/**
 * Ask the terminal what it can do, then decide who draws the map.
 *
 * The order is the point, and it used to be the other way round: the cell size was
 * measured only once the mode was already known to be kitty, which was fine while
 * the mode came from an environment variable and is not now that the terminal's own
 * answer decides it.
 *
 * Both answers come from one probe in the window before Ink takes stdin, and this
 * is the only place either question can safely be asked — see `probeTerminal`.
 * The result is logged in full because a screenshot cannot tell you what the game
 * *thought* the terminal was, and a disagreement between the two is exactly the
 * kind of bug that reads as a rendering fault.
 */
async function chooseRenderer(): Promise<void> {
	const plan = probePlan();
	if (plan) {
		const probe = await probeTerminal(process.stdin, process.stdout, plan);
		logger.info(
			`terminal: cell ${probe.cell.width}x${probe.cell.height}px` +
				`${cellPixelsWereMeasured() ? "" : " (assumed; it did not say)"}, graphics ` +
				`${plan.graphics === false ? "not asked" : probe.graphics ? "yes" : "no answer"}`,
		);
	}
	const mode = resolveTileMode();
	// Pinned rather than left to be resolved lazily, so the answer the log reports
	// is provably the one the renderer used.
	setTileMode(mode.mode);
	logger.info(`renderer: ${mode.mode} — ${mode.because}`);
	// The two escapes that an ordinary TUI does not use, and so the two most likely
	// answers to "it does not render at all". Written down at startup because a
	// player who sees nothing has nothing else to report.
	const mux = multiplexer();
	logger.info(
		`terminal quirks: multiplexer ${mux?.name ?? "none"}, ` +
			`synchronized output ${syncOutputEnabled() ? "on" : "off"}, ` +
			`alternate screen ${ALT_SCREEN ? "on" : "off"}`,
	);
}

async function startGame() {
	// Before anything can ask whether a model is available. A key saved on the
	// options page lives in the player's settings, and the AI SDK only ever looks
	// in the environment — this is the one place that gap gets closed for a run
	// that starts with a key already stored.
	installGatewayKey();

	const choice = wantsLauncher() ? await pickLaunch() : choiceFromEnv();
	if (!choice) return;

	const session = buildSession(choice, { saveDebounceMs: CONFIG.saveDebounceMs });
	// Only the real game coalesces frames. A test or a screenshot dispatches and
	// then reads the frame, and a delayed one would be the frame from before.
	bindEngine(session.engine, { frameMs: FRAME_MS });

	await chooseRenderer();

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
