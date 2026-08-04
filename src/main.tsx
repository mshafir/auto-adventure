#!/usr/bin/env node
import { render } from "ink";
import { createDialogueService } from "./ai/dialogue/dialogue.js";
import { Director } from "./ai/director/director.js";
import { logTelemetry } from "./ai/telemetry.js";
import { CONFIG, hasGatewayKey } from "./config.js";
import { createInitialState, type GameState } from "./core/rules/state.js";
import { toChunk } from "./core/world/coords.js";
import { createEffectRunner } from "./engine/effect-runner.js";
import { GameEngine } from "./engine/engine.js";
import { findSpawn } from "./engine/spawn.js";
import { SaveRepository } from "./persist/save-repo.js";
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

function newWorld(): GameState {
	const spawn = findSpawn(CONFIG.seed);
	logger.info(`new world "${CONFIG.worldName}" seed ${CONFIG.seed}, spawn ${spawn.x},${spawn.y}`);
	return createInitialState(
		{
			id: CONFIG.worldName,
			name: CONFIG.worldName,
			seed: CONFIG.seed,
			createdAt: new Date().toISOString(),
		},
		spawn,
		CONFIG.brief,
	);
}

async function startGame() {
	const saves = new SaveRepository(CONFIG.saveDebounceMs);

	const loaded = saves.load(CONFIG.worldName);
	// A save carries its own seed, so loading an existing world ignores the
	// configured one rather than regenerating the terrain under the player.
	const existing = loaded ?? newWorld();
	if (loaded)
		logger.info(
			`loaded world "${existing.world.name}" at ${existing.player.x},${existing.player.y}`,
		);

	// A world's brief belongs to the world, like its seed. Replacing one mid-world
	// would leave the model arguing with the lore it already wrote, and the regions
	// named before the change reading as a different setting to those named after.
	// A world that never had one still adopts the configured brief, which is how an
	// unbriefed save gets steered without being restarted.
	//
	// The guard reads `loaded`, not `existing`: a new world's brief *is* the
	// configured one, so testing `existing` warned that every briefed new world was
	// ignoring the brief it had just been given.
	if (loaded?.brief && CONFIG.brief)
		logger.warn("this world already has a brief; the configured one is ignored");
	const brief = existing.brief ?? CONFIG.brief;
	const state = brief === existing.brief ? existing : { ...existing, brief };
	// The effective brief, whatever it came from — the one thing worth being able
	// to read back when a world does not come out the way it was asked for.
	if (brief)
		logger.info(brief === CONFIG.brief ? "brief (configured)" : "brief (from save)", brief);

	// The director and the engine each need the other: the engine asks the
	// director for rosters during chunk generation, and the director reports what
	// it learned by dispatching. Tying the knot with a late binding keeps the
	// dependency one-way at the type level — the director never sees the engine,
	// only three callbacks.
	const host: { engine?: GameEngine } = {};
	const director = new Director({
		seed: state.world.seed,
		...(state.brief ? { brief: state.brief } : {}),
		...(state.lore ? { lore: state.lore } : {}),
		regions: state.regions,
		sites: state.sites,
		sources: state.specSources,
		disabled: CONFIG.noAi,
		onLore: (lore) => host.engine?.dispatch({ t: "LoreLearned", lore }),
		onRegion: (spec) => host.engine?.dispatch({ t: "RegionLearned", spec }),
		onSite: (spec, source) => host.engine?.dispatch({ t: "SiteLearned", spec, source }),
		onSiteChanged: (site) => host.engine?.rebuildSite(site),
	});

	if (CONFIG.noAi) logger.info("director disabled (NO_AI); world names are procedural");
	else if (!hasGatewayKey())
		logger.warn("AI_GATEWAY_API_KEY is not set; falling back to procedural names");

	const dialogue = createDialogueService({
		seed: state.world.seed,
		lore: () => director.getLore(),
		regionSpec: (regionId) => director.regionSpec(regionId),
		siteSpec: (siteId) => director.siteSpec(siteId),
		disabled: CONFIG.noAi,
	});

	const engine = new GameEngine(
		state,
		createEffectRunner({
			saves,
			specFor: director.specFor,
			siteSpec: (siteId) => director.siteSpec(siteId),
			requestSpecs: (around) => director.request(around),
			runDialogueTurn: dialogue.runDialogueTurn,
			summarizeNpc: dialogue.summarizeNpc,
		}),
	);
	host.engine = engine;
	bindEngine(engine);

	// Kick the director once at startup so the place the player wakes up in has a
	// name before they take their first step.
	director.request(toChunk(state.player.x, state.player.y));

	const restoreScreen = enterAltScreen();
	const shutdown = (code: number) => {
		saves.dispose();
		logTelemetry();
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
		saves.dispose();
		logTelemetry();
		endSynchronizedOutput();
		restoreScreen();
	}
}

process.on("unhandledRejection", (reason) => {
	logger.error("unhandled rejection", reason);
});
process.on("uncaughtException", (error) => {
	logger.error("uncaught exception", error);
	// Leave synchronized mode first: a terminal still holding an unpresented
	// frame looks like a hang rather than a crash.
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
