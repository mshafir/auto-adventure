import { createDialogueService } from "./ai/dialogue/dialogue.js";
import { Director } from "./ai/director/director.js";
import { logTelemetry } from "./ai/telemetry.js";
import { hasGatewayKey } from "./config.js";
import { createInitialState, type GameState } from "./core/rules/state.js";
import type { ScenarioBrief } from "./core/world/brief.js";
import { toChunk } from "./core/world/coords.js";
import type { SpecSource } from "./core/world/spec.js";
import { createEffectRunner } from "./engine/effect-runner.js";
import { GameEngine } from "./engine/engine.js";
import { findSpawn } from "./engine/spawn.js";
import { SaveRepository } from "./persist/save-repo.js";
import type { ScenarioArtifact } from "./scenario/artifact.js";
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

	// Resolved before the world is built, because a world can arrive already
	// briefed from two directions — a save, or an artifact whose content was
	// *written* to that brief — and in both cases the offer loses.
	const owned = loaded?.brief ?? choice.scenario?.brief;
	const { brief, ignored } = resolveBrief(owned, choice.brief);
	if (ignored) logger.warn("this world already has a brief; the offered one is ignored");
	if (brief) logger.info(`brief (${owned ? "the world's own" : "offered"})`, brief);

	// A save carries its own seed, so loading an existing world ignores the
	// configured one rather than regenerating the terrain under the player.
	const existing = loaded ?? newWorld(choice, brief);
	if (loaded)
		logger.info(
			`loaded world "${existing.world.name}" at ${existing.player.x},${existing.player.y}`,
		);

	const state = brief === existing.brief ? existing : { ...existing, brief };

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

function newWorld(choice: LaunchChoice, brief: ScenarioBrief | undefined): GameState {
	if (choice.scenario) return newScenarioWorld(choice, choice.scenario, brief);

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
		brief,
	);
}

/**
 * Open a world that is already written.
 *
 * The specs go straight into the state the engine starts from, which is what
 * makes prebuilt different in kind rather than in degree: they are not "arriving
 * early", they are simply there, so the first frame the player sees is the
 * authored town. Marked `llm` because that is what they are, and recording them as
 * sources is also what tells the director they are settled — a fallback must never
 * overwrite an authored roster.
 */
function newScenarioWorld(
	choice: LaunchChoice,
	artifact: ScenarioArtifact,
	brief: ScenarioBrief | undefined,
): GameState {
	logger.info(
		`new world "${choice.worldId}" from scenario "${artifact.id}" seed ${artifact.seed}, spawn ${artifact.spawn.x},${artifact.spawn.y}`,
	);
	const specSources: Record<string, SpecSource> = {};
	for (const key of Object.keys(artifact.sites)) specSources[key] = "llm";

	const base = createInitialState(
		{
			id: choice.worldId,
			name: artifact.title,
			seed: artifact.seed,
			createdAt: new Date().toISOString(),
			bounds: artifact.bounds,
			scenarioId: artifact.id,
		},
		artifact.spawn,
		brief,
	);
	return {
		...base,
		lore: artifact.lore,
		regions: artifact.regions,
		sites: artifact.sites,
		specSources,
		...(artifact.arc ? { arc: artifact.arc } : {}),
	};
}
