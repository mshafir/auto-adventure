import { createDialogueService } from "./ai/dialogue/dialogue.js";
import { Director } from "./ai/director/director.js";
import { logTelemetry } from "./ai/telemetry.js";
import { CONFIG, hasGatewayKey } from "./config.js";
import { resolveOverride } from "./content/load.js";
import { DEFAULT_PACK } from "./core/content/default.js";
import { isOverrideEmpty, mergePack, type PackOverride } from "./core/content/pack.js";
import { orderedBeats } from "./core/rules/arc.js";
import { cardSeen } from "./core/rules/card.js";
import { type OpeningInput, openingCard } from "./core/rules/opening.js";
import { bearingTo, compassWords } from "./core/rules/quest-map.js";
import { createInitialState, type GameState } from "./core/rules/state.js";
import { biomeDef } from "./core/world/biome.js";
import type { ScenarioBrief } from "./core/world/brief.js";
import { toChunk } from "./core/world/coords.js";
import { regionIdAt, sitesAround } from "./core/world/macro.js";
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

	// The pack resolves the same way and for the same reason: a world's names are
	// derived, so adopting a different pack mid-world would rename everybody already
	// met. A save's own override wins, then the artifact's, and only a world with
	// neither takes the offered one.
	const ownedContent = loaded?.content ?? choice.scenario?.content;
	const override = ownedContent ?? choice.content ?? resolveOfferedPack();
	const pack = mergePack(DEFAULT_PACK, override);
	if (override) {
		logger.info(`content pack "${pack.id}" (${ownedContent ? "the world's own" : "offered"})`);
	}

	// A save carries its own seed, so loading an existing world ignores the
	// configured one rather than regenerating the terrain under the player.
	const existing = loaded ?? newWorld(choice, brief, override);
	if (loaded)
		logger.info(
			`loaded world "${existing.world.name}" at ${existing.player.x},${existing.player.y}`,
		);

	const settled =
		override && !loaded?.content && !isOverrideEmpty(override)
			? { ...existing, content: override }
			: existing;
	const state = brief === settled.brief ? settled : { ...settled, brief };

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
		content: pack,
		onLore: (lore) => {
			host.engine?.dispatch({ t: "LoreLearned", lore });
			showOpening();
		},
		onRegion: (spec) => host.engine?.dispatch({ t: "RegionLearned", spec }),
		onSite: (spec, source) => host.engine?.dispatch({ t: "SiteLearned", spec, source }),
		onSiteChanged: (site) => host.engine?.rebuildSite(site),
	});

	// Trees come from the artifact rather than the save, so a resumed scenario needs
	// its file to still be there for authored conversation. Missing means canned
	// dialogue, which is a real conversation, not an error state.
	const trees = choice.scenario?.trees;
	const dialogue = createDialogueService({
		seed: state.world.seed,
		lore: () => director.getLore(),
		regionSpec: (regionId) => director.regionSpec(regionId),
		siteSpec: (siteId) => director.siteSpec(siteId),
		disabled: !live,
		...(trees ? { tree: (npcId: string) => trees[npcId] } : {}),
	});

	const engine = new GameEngine(
		state,
		createEffectRunner({
			saves,
			specFor: director.specFor,
			siteSpec: (siteId) => director.siteSpec(siteId),
			requestSpecs: (around) => director.request(around),
			content: pack,
			runDialogueTurn: dialogue.runDialogueTurn,
			summarizeNpc: dialogue.summarizeNpc,
		}),
	);
	host.engine = engine;

	/**
	 * Put the framing card up, as soon as there is anything worth framing with.
	 *
	 * Idempotent by construction: `ShowCard` is ignored once the card's id is in the
	 * flags, so this can be called from both paths below without either needing to
	 * know whether the other already fired — or whether this world was resumed from a
	 * save that had already read it.
	 */
	const showOpening = () => {
		const engine = host.engine;
		if (!engine || cardSeen(engine.getState().flags, "opening")) return;
		const now = engine.getState();
		const at = now.player;
		const region = director.regionSpec(regionIdAt(now.world.seed, at.x, at.y));
		const start = firstStop(now);
		const summary = engine.getChunks().summaryFor(toChunk(at.x, at.y).cx, toChunk(at.x, at.y).cy);
		engine.dispatch({
			t: "ApplyEffects",
			effects: [
				{
					t: "ShowCard",
					card: openingCard({
						lore: director.getLore(),
						...(region ? { region } : {}),
						...(engine.placeNameAt(at.x, at.y)
							? { placeName: engine.placeNameAt(at.x, at.y) as string }
							: {}),
						...(summary ? { landscape: biomeDef(summary.dominantBiome).name.toLowerCase() } : {}),
						...(now.brief ? { brief: now.brief } : {}),
						...(now.arc ? { arc: now.arc } : {}),
						...(start ? { start } : {}),
					}),
				},
			],
		});
	};

	// Kick the director once so the place the player wakes up in has a name before
	// they take their first step.
	director.request(toChunk(state.player.x, state.player.y));

	// With no model the lore and the region are already known, so the card is
	// complete now. With one, `getLore()` would answer with the deterministic
	// fallback and the card would describe a world the game is about to replace — so
	// it waits for `onLore`, which the director always fires, adopting its own
	// fallback if the call fails.
	if (!live || !hasGatewayKey()) showOpening();

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

/**
 * Where the story's first beat is, in terms a player can walk on.
 *
 * The card's most useful line and the one that was missing: a premise says what the
 * story is about and still leaves the player in a field with no idea which direction
 * anybody is. Resolved here rather than in `openingCard`, because it needs the world
 * — the site's position comes from `macroSite`, and its name from the artifact.
 *
 * Silent when the world has no arc. A live or procedural world has nobody in
 * particular waiting, and naming a town would be a promise nothing keeps.
 */
function firstStop(state: GameState): OpeningInput["start"] {
	const arc = state.arc;
	if (!arc || arc.beats.length === 0) return undefined;
	const beat = orderedBeats(arc)[0];
	if (!beat) return undefined;

	const spec = state.sites[String(beat.siteId)];
	if (!spec) return undefined;
	const person = spec.npcs.find((npc) => npc.slot === beat.npcSlot)?.name;

	// The site's position is not in the spec — `macroSite` is the only authority — so
	// the footprint around the player is swept for the matching id.
	const cc = toChunk(state.player.x, state.player.y);
	const site = sitesAround(state.world.seed, cc.cx, cc.cy, SITE_SEARCH_HALO).find(
		(candidate) => candidate.id === beat.siteId,
	);
	const bearing = site
		? bearingTo(state.player.x, state.player.y, site.site.x, site.site.y)
		: undefined;

	return {
		place: spec.name,
		...(person ? { person } : {}),
		...(bearing ? { bearing: compassWords(bearing.compass), distance: bearing.distance } : {}),
	};
}

/**
 * How far out to look for the first beat's site.
 *
 * A short scenario's footprint is four chunks across and a long one nine, so a halo
 * of six macro cells covers every bounded world the survey can produce. Cheap: a few
 * hundred `macroSite` calls, once, at startup.
 */
const SITE_SEARCH_HALO = 6;

/**
 * The pack named by the environment.
 *
 * Only consulted for a world that has none of its own, so `CONTENT_PACK` steers new
 * games without ever rewriting one already in progress. Read as an *override* rather
 * than as a merged pack, because what has to be persisted is what the author wrote.
 */
function resolveOfferedPack(): PackOverride | undefined {
	return resolveOverride(CONFIG.contentPack);
}

function newWorld(
	choice: LaunchChoice,
	brief: ScenarioBrief | undefined,
	content: PackOverride | undefined,
): GameState {
	if (choice.scenario) return newScenarioWorld(choice, choice.scenario, brief, content);

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
		content,
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
	content: PackOverride | undefined,
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
		content,
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
