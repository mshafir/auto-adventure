import { createDialogueService } from "./ai/dialogue/dialogue.js";
import { Director } from "./ai/director/director.js";
import { logTelemetry } from "./ai/telemetry.js";
import { hasGatewayKey } from "./config.js";
import { createInitialState, type GameState } from "./core/rules/state.js";
import type { ScenarioBrief } from "./core/world/brief.js";
import { toChunk } from "./core/world/coords.js";
import { createEffectRunner } from "./engine/effect-runner.js";
import { GameEngine } from "./engine/engine.js";
import { findSpawn } from "./engine/spawn.js";
import { SaveRepository } from "./persist/save-repo.js";
import { type Flavour, type LaunchChoice, usesLiveModel } from "./scenario/scenario.js";
import { logger } from "./utils/log.js";

/**
 * Everything a running game needs, assembled but not yet rendered.
 *
 * This used to be the body of `startGame`, which meant the only way to exercise
 * any of it was to launch the TUI — and a terminal is not a test harness. The
 * brief-adoption rule below is the kind of thing that was invisible as a result:
 * it warned that every briefed *new* world was ignoring its own brief, and only a
 * scripted run of the real binary caught it.
 */
export interface Session {
	readonly engine: GameEngine;
	readonly saves: SaveRepository;
	readonly state: GameState;
	readonly flavour: Flavour;
	/** Flush saves and report telemetry. Idempotent. */
	readonly dispose: () => void;
}

export interface SessionOptions {
	readonly saveDebounceMs?: number;
}

export class MissingSaveError extends Error {
	constructor(worldId: string) {
		super(`no save named "${worldId}"`);
		this.name = "MissingSaveError";
	}
}

/**
 * Resolve which brief a world runs with.
 *
 * A world's brief belongs to the world, like its seed. Replacing one mid-world
 * would leave the model arguing with the lore it already wrote, and the regions
 * named before the change reading as a different setting to those named after. A
 * world that never had one still adopts the offered brief, which is how an
 * unbriefed save gets steered without being restarted.
 */
export function resolveBrief(
	saved: ScenarioBrief | undefined,
	offered: ScenarioBrief | undefined,
): { readonly brief: ScenarioBrief | undefined; readonly ignored: boolean } {
	if (saved) return { brief: saved, ignored: offered !== undefined };
	return { brief: offered, ignored: false };
}

export function buildSession(choice: LaunchChoice, options: SessionOptions = {}): Session {
	const saves = new SaveRepository(options.saveDebounceMs ?? 2000);
	const loaded = saves.load(choice.worldId);
	if (!loaded && choice.mustExist) throw new MissingSaveError(choice.worldId);

	// A save carries its own seed, so loading an existing world ignores the
	// configured one rather than regenerating the terrain under the player.
	const existing = loaded ?? newWorld(choice);
	if (loaded)
		logger.info(
			`loaded world "${existing.world.name}" at ${existing.player.x},${existing.player.y}`,
		);

	// Read from `loaded`, not `existing`: a new world's brief *is* the offered one,
	// so testing `existing` reports that every briefed new world is ignoring it.
	const { brief, ignored } = resolveBrief(loaded?.brief, choice.brief);
	if (ignored) logger.warn("this world already has a brief; the offered one is ignored");
	const state = brief === existing.brief ? existing : { ...existing, brief };
	if (brief) logger.info(`brief (${loaded?.brief ? "from save" : "offered"})`, brief);

	const live = usesLiveModel(choice.flavour);
	if (!live) logger.info(`director disabled (${choice.flavour}); world names are procedural`);
	else if (!hasGatewayKey())
		logger.warn("AI_GATEWAY_API_KEY is not set; falling back to procedural names");

	// The director and the engine each need the other: the engine asks the director
	// for rosters during chunk generation, and the director reports what it learned
	// by dispatching. Tying the knot with a late binding keeps the dependency
	// one-way at the type level — the director never sees the engine, only four
	// callbacks.
	const host: { engine?: GameEngine } = {};
	const director = new Director({
		seed: state.world.seed,
		...(state.brief ? { brief: state.brief } : {}),
		...(state.lore ? { lore: state.lore } : {}),
		regions: state.regions,
		sites: state.sites,
		sources: state.specSources,
		disabled: !live,
		onLore: (lore) => host.engine?.dispatch({ t: "LoreLearned", lore }),
		onRegion: (spec) => host.engine?.dispatch({ t: "RegionLearned", spec }),
		onSite: (spec, source) => host.engine?.dispatch({ t: "SiteLearned", spec, source }),
		onSiteChanged: (site) => host.engine?.rebuildSite(site),
	});

	const dialogue = createDialogueService({
		seed: state.world.seed,
		lore: () => director.getLore(),
		regionSpec: (regionId) => director.regionSpec(regionId),
		siteSpec: (siteId) => director.siteSpec(siteId),
		disabled: !live,
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

	// Kick the director once so the place the player wakes up in has a name before
	// they take their first step.
	director.request(toChunk(state.player.x, state.player.y));

	let disposed = false;
	return {
		engine,
		saves,
		state,
		flavour: choice.flavour,
		dispose: () => {
			if (disposed) return;
			disposed = true;
			saves.dispose();
			logTelemetry();
		},
	};
}

function newWorld(choice: LaunchChoice): GameState {
	const spawn = findSpawn(choice.seed);
	logger.info(
		`new world "${choice.worldId}" seed ${choice.seed}, spawn ${spawn.x},${spawn.y}, ${choice.flavour}`,
	);
	return createInitialState(
		{
			id: choice.worldId,
			name: choice.worldId,
			seed: choice.seed,
			createdAt: new Date().toISOString(),
		},
		spawn,
		choice.brief,
	);
}
