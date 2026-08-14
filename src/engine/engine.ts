import { DEFAULT_PACK } from "../core/content/default.js";
import type { ContentPack } from "../core/content/pack.js";
import { getComplex, getInterior } from "../core/gen/features/interior.js";
import type { StructureKind } from "../core/gen/features/patch.js";
import { featureBounds, invalidateFeature } from "../core/gen/features/registry.js";
import { isResidentId, type Resident } from "../core/gen/features/residents.js";
import { schedulesRun } from "../core/rules/clock.js";
import type { Command } from "../core/rules/commands.js";
import { evaluate } from "../core/rules/condition.js";
import type { Effect } from "../core/rules/effects.js";
import { forageAt, forageKey, isForageable, pickedOverMessage } from "../core/rules/forage.js";
import { type Barrier, barrierIndex, barrierTiles } from "../core/rules/lock.js";
import { containerContents, emptyMessage, isContainer, lootKey } from "../core/rules/loot.js";
import { obtainableItems } from "../core/rules/obtainable.js";
import {
	placementIndex,
	placementSlot,
	type ResolvedPlacement,
	takenKey,
} from "../core/rules/placement.js";
import { reduce, type WorldProbe } from "../core/rules/reduce.js";
import type { StagedScene } from "../core/rules/scene.js";
import { type Sign, signBoard, signIndex, signTiles } from "../core/rules/signage.js";
import { type GameState, worldAnchor } from "../core/rules/state.js";
import { EMPTY_SURROUNDINGS, type Surroundings } from "../core/rules/surroundings.js";
import { type ChunkKey, chunkKey, parseChunkKey, toChunk } from "../core/world/coords.js";
import { type MacroSite, regionIdAt, sitesAround, sitesInside } from "../core/world/macro.js";
import { type WorldSeed, worldSeed } from "../core/world/recipe.js";
import { npcId as makeNpcId, type SiteSpec } from "../core/world/spec.js";
import {
	composeScenario,
	enteredPhaseIds,
	type Phase,
	type ScenarioContent,
} from "../scenario/phase.js";
import { logger } from "../utils/log.js";
import { resolveBarriers } from "./barriers.js";
import { ChunkManager } from "./chunk-manager.js";
import { type AuthoredResident, InteriorPeople } from "./interior-people.js";
import { createInteriorView } from "./interior-view.js";
import { NpcDirectory, type PlacedNpc } from "./npc-directory.js";
import { approaches, resolvePlacements } from "./placements.js";
import { stageScene } from "./scene-staging.js";
import { createWorldView, type WorldView } from "./world-view.js";

export interface EngineServices {
	/** Performs one effect. May dispatch follow-up commands. */
	runEffect(effect: Effect, engine: GameEngine): void | Promise<void>;
	/**
	 * The authored settlement roster for a site, if one is known.
	 *
	 * Called inside chunk generation, so it must be synchronous and cheap. The
	 * director resolves specs in the background and returns undefined until one
	 * lands, which is what keeps a model call off the movement path.
	 */
	specFor?: (
		site: MacroSite,
	) => import("../core/gen/features/settlement.js").SettlementSpec | undefined;
	/** The authored description of a site, used to place its people. */
	siteSpec?: (siteId: number) => SiteSpec | undefined;
	/** The flavour tables this world's residents are named and described from. */
	content?: ContentPack;
	/**
	 * The world as its first chapter, and the chapters that come after it.
	 *
	 * Held here rather than in `GameState` because they are *content*, not progress: which
	 * chapter the player is in is derived from the flags after every command, so nothing about
	 * it is worth writing down. That is what lets a phase file be corrected while a save is in
	 * flight — the save records what the player did, and the chapter follows from it.
	 *
	 * Absent for a live or procedural world, and for a scenario with only one chapter.
	 */
	base?: ScenarioContent;
	phases?: readonly Phase[];
}

/**
 * Chunks built around the player before the first frame is drawn.
 *
 * Deliberately smaller than the radius a step prefetches: this one is paid for
 * up front, while the world is opening and there is nothing to look at yet.
 */
const OPENING_RADIUS = 1;

/**
 * The single writer.
 *
 * `dispatch` is synchronous end to end: reduce, notify, queue effects. Nothing
 * here awaits and nothing here takes a lock. The previous design guarded state
 * with a `locked` boolean that it read, tested, and only *then* set — so a
 * second keypress arriving in the same tick sailed straight through it, and a
 * save taken mid-action rehydrated `locked: true` and wedged the game
 * permanently. A synchronous reducer removes the need for the guard entirely.
 */
export class GameEngine {
	private state: GameState;
	private readonly listeners = new Set<() => void>();
	private readonly chunks: ChunkManager;
	/**
	 * The seed and the generation recipe together.
	 *
	 * Built once, because the recipe is part of what the world is and cannot change
	 * during play — the same reason the bounds are read once in the constructor.
	 */
	private readonly world: WorldSeed;
	private readonly npcs: NpcDirectory;
	private readonly residents: InteriorPeople;
	private readonly view: WorldView;
	/**
	 * Gates, by the tile they stand on.
	 *
	 * Indexed rather than scanned because the reducer asks about the tile ahead on
	 * every single step. Rebuilt on `hydrate`, since a loaded save carries its own
	 * list — nothing else can change it during play.
	 */
	private barriers: Map<string, Barrier>;
	/**
	 * Signposts, by the tile the post stands on. Rebuilt on `hydrate`.
	 *
	 * Indexed for the same reason the gates are: the describe path asks about the tile in
	 * front of the player on every keypress, and a scan of the list would be a scan per
	 * frame.
	 */
	private signs: Map<string, Sign>;
	/**
	 * Site positions, swept lazily and never invalidated.
	 *
	 * Safe to keep for the life of the session because it is a function of the seed and the
	 * recipe, neither of which can change during play — the same reason `world` is built
	 * once in the constructor. Lazy because a world with no signposts must not pay for the
	 * sweep at all.
	 */
	private sitePositions?: Map<number, MacroSite>;
	/** Authored items, by the tile they sit on. Rebuilt on `hydrate`. */
	private placements: Map<string, ResolvedPlacement>;
	/**
	 * Which chapters are in force, as their joined ids.
	 *
	 * Composition runs after every command, so the cheap thing has to be the *check*. When
	 * this string is unchanged there is nothing to recompose and nothing to re-index.
	 */
	private entered = "";
	/** Staged scenes, by id. Cached because staging sweeps for sites and builds settlements. */
	private readonly staged = new Map<string, StagedScene | undefined>();
	private draining = false;
	private readonly queue: Effect[] = [];

	constructor(
		initial: GameState,
		private readonly services: EngineServices,
	) {
		this.state = initial;
		this.world = worldSeed(initial.world.seed, initial.world.recipe);
		this.barriers = barrierIndex(initial.barriers);
		this.signs = signIndex(initial.signs);
		this.placements = this.resolvePlaced(initial);
		this.chunks = new ChunkManager({
			world: this.world,
			...(services.specFor ? { specFor: services.specFor } : {}),
			...(initial.world.bounds ? { bounds: initial.world.bounds } : {}),
			...(initial.barriers?.length ? { barriers: barrierTiles(initial.barriers) } : {}),
			...(initial.signs?.length ? { signs: signTiles(initial.signs) } : {}),
			// The base chapter's authored ground. Later chapters change it through
			// `setTerraform`, which invalidates what it has to; this is the world as the player
			// first finds it, and it has to be in place before the opening chunks are built.
			...(services.base?.terraform.length ? { terraform: services.base.terraform } : {}),
		});
		this.chunks.setDeltas(initial.deltas);
		this.npcs = new NpcDirectory(this.chunks, (siteId) => this.services.siteSpec?.(siteId));
		this.npcs.setGate((npc) => evaluate(npc.requires, this.state));
		this.residents = new InteriorPeople(
			initial.world.seed,
			services.content,
			(interiorId, level) => this.authoredInside(interiorId, level),
			(interiorId, level) => this.approachesInside(interiorId, level),
		);
		this.view = createWorldView({
			seed: initial.world.seed,
			chunkAt: (cx, cy) => this.chunks.get(cx, cy),
			// So the memo inside the view lets go of a chunk the manager has dropped. Without it
			// the first tile read after a chapter relays the ground comes from the copy that was
			// just thrown away.
			revision: () => this.chunks.revision,
		});

		// The chunk the player stands in must exist before the first frame.
		const start = toChunk(worldAnchor(initial.player).x, worldAnchor(initial.player).y);
		this.chunks.prefetch(start, OPENING_RADIUS);
		this.markPrefetched(start, OPENING_RADIUS);
		this.populateNpcs(start);
	}

	/**
	 * Work out where the authored items actually are.
	 *
	 * Run when the world opens and again on a save load, because a `site` placement is
	 * resolved against generated geometry rather than being stored — so the answer is
	 * derived, not persisted, and the only thing that survives is whether the item has
	 * been taken.
	 *
	 * An unresolvable placement is logged rather than thrown. The world still plays,
	 * and refusing to open it over one missing chest would be a worse trade than a
	 * loud line in the log — the offline validator is where this is meant to be caught.
	 */
	private resolvePlaced(state: GameState): Map<string, ResolvedPlacement> {
		const { resolved, unresolved } = resolvePlacements(state.placements, {
			world: this.world,
			siteSpec: (siteId) => state.sites[String(siteId)] ?? this.services.siteSpec?.(siteId),
			...(state.world.bounds ? { bounds: state.world.bounds } : {}),
		});
		for (const problem of unresolved) {
			logger.warn(`placement ${problem.id} could not be placed: ${problem.reason}`);
		}
		return placementIndex(resolved);
	}

	getState = (): GameState => this.state;

	/**
	 * Where the player is in the world, which indoors is the doorstep they came in by.
	 *
	 * Every chunk-space question goes through here. Asking `player.x/y` directly is
	 * right only while the player is outdoors, and wrong in a way that looks like
	 * nothing at all: the interior grid is small and near the origin, so the answer is
	 * a real chunk somewhere out in the wilderness rather than an error.
	 */
	private anchor(): { readonly x: number; readonly y: number } {
		return worldAnchor(this.state.player);
	}

	getChunks(): ChunkManager {
		return this.chunks;
	}

	getNpcs(): NpcDirectory {
		return this.npcs;
	}

	getResidents(): InteriorPeople {
		return this.residents;
	}

	/**
	 * Whoever is standing on a tile, indoors or out.
	 *
	 * One question with one answer, because every caller — the reducer deciding
	 * whether a step is a conversation, the renderer drawing a glyph, the examine
	 * verb — wants "who is here", not "who is here, and also which of two indexes
	 * should I have asked". Indoors the position is interior-local, so the building
	 * the player is in decides which roster is consulted.
	 */
	personAt(x: number, y: number): PlacedNpc | undefined {
		const inside = this.state.player.inside;
		if (!inside) return this.npcs.at(x, y);
		const resident = this.residents.at(
			inside.interiorId,
			inside.structure,
			x,
			y,
			inside.level ?? 0,
		);
		return resident ? this.asPlaced(resident, inside) : undefined;
	}

	/**
	 * Resolve anyone the player could be talking to, by id.
	 *
	 * A resident is only resolvable while the player is in their building, which is
	 * also the only time a conversation with one can be open — walking out ends it,
	 * because the panel closes with the step.
	 */
	personById(id: string): PlacedNpc | undefined {
		const inside = this.state.player.inside;
		if (isResidentId(id)) {
			if (!inside) return undefined;
			const resident = this.residents.byId(
				inside.interiorId,
				inside.structure,
				id,
				inside.level ?? 0,
			);
			return resident ? this.asPlaced(resident, inside) : undefined;
		}
		// A site-slot id belongs to somebody the scenario wrote, and they may be standing
		// in a room rather than in the street — in which case the outdoor directory has
		// never heard of them. Asked in this order because the room is the specific case:
		// the directory is where everyone else is, and it answers for the rest.
		if (inside) {
			const resident = this.residents.byId(
				inside.interiorId,
				inside.structure,
				id,
				inside.level ?? 0,
			);
			if (resident) return this.asPlaced(resident, inside);
		}
		return this.npcs.byNpcId(id);
	}

	/**
	 * Present a resident as an ordinary NPC.
	 *
	 * Everything downstream of "who is this" — the dialogue prompt, the shop stock,
	 * the memory record, the examine line — already speaks `PlacedNpc`, and a
	 * resident differs from one in exactly two ways: their position is interior-local,
	 * and their site has to be looked up rather than being what placed them. Filling
	 * those in here means none of those call sites need a second code path, which is
	 * what makes a conversation with somebody's cooper work without touching the
	 * dialogue layer at all.
	 *
	 * The site comes from the doorway. Indoors the player's own coordinates are
	 * interior-local, so asking which settlement covers them would answer about a
	 * town near the world origin — the same trap `reduce` documents for place names.
	 */
	private asPlaced(
		resident: Resident,
		inside: NonNullable<GameState["player"]["inside"]>,
	): PlacedNpc {
		const site = this.siteAt(inside.returnX, inside.returnY);
		const station = { x: resident.x, y: resident.y };
		return {
			id: resident.id,
			name: resident.name,
			role: resident.role,
			glyph: resident.glyph,
			x: resident.x,
			y: resident.y,
			siteId: site?.id ?? 0,
			regionId: site?.regionId ?? regionIdAt(this.state.world.seed, inside.returnX, inside.returnY),
			spec: resident.spec,
			// Indoors there is no schedule: a house is where these people already are,
			// and the hour moving on must not remove them from the only room they have.
			stations: {
				dawn: station,
				morning: station,
				afternoon: station,
				dusk: station,
				evening: station,
				night: station,
			},
		};
	}

	/** The settlement covering a world position. */
	private siteAt(x: number, y: number): MacroSite | undefined {
		const cc = toChunk(x, y);
		return sitesAround(this.world, cc.cx, cc.cy, 1).find(
			(site) => Math.hypot(site.site.x - x, site.site.y - y) <= site.radius,
		);
	}

	/** Derive NPC placements for every site reaching a position. */
	populateNpcs(cc: { cx: number; cy: number }): void {
		this.npcs.populate(sitesAround(this.world, cc.cx, cc.cy));
	}

	/**
	 * Record a square of chunks as seen, having just built them.
	 *
	 * A step's prefetch goes through the effect runner, which reports every chunk it
	 * builds back as `ChunkReady` and so gets this for free. Opening a world and
	 * loading a save do not — they build their chunks directly, before there is a
	 * queue to drain — and the minimap drew the result as a donut: the ring the first
	 * step prefetched appeared, and the ring built at open, inside it, stayed dark
	 * forever, because nothing had ever said it existed.
	 *
	 * Marks the whole square rather than only what `prefetch` reports as newly built,
	 * which is what lets this heal a save that already has the hole in it — on a
	 * reload the chunks are usually built already and `prefetch` would report none.
	 */
	private markPrefetched(cc: { cx: number; cy: number }, radius: number): void {
		const seen = new Set(this.state.discovered);
		const fresh: ChunkKey[] = [];
		for (let dy = -radius; dy <= radius; dy++) {
			for (let dx = -radius; dx <= radius; dx++) {
				const key = chunkKey(cc.cx + dx, cc.cy + dy);
				if (!seen.has(key)) fresh.push(key);
			}
		}
		if (fresh.length === 0) return;
		this.state = { ...this.state, discovered: [...this.state.discovered, ...fresh] };
	}

	/**
	 * Rebuild a settlement after its authored roster arrived.
	 *
	 * The patch cache, the chunks that stamped it and the people standing in it
	 * are all derived from the spec, so all three are dropped together and
	 * recomputed on the next read.
	 */
	rebuildSite(site: MacroSite): void {
		invalidateFeature(this.world, site.id);
		const dropped = this.chunks.invalidateRect(featureBounds(site, this.world));
		this.npcs.forget(site.id);
		for (const key of dropped) {
			const cc = parseChunkKey(key);
			this.chunks.ensure(cc.cx, cc.cy);
		}
		this.populateNpcs(toChunk(this.anchor().x, this.anchor().y));
		this.notify();
	}

	/**
	 * The view the player is currently in.
	 *
	 * Everything above the engine — rendering, collision, field of view — works
	 * against whichever view this returns, so being indoors needs no special
	 * cases anywhere else.
	 */
	getView(): WorldView {
		const inside = this.state.player.inside;
		if (!inside) return this.view;
		return createInteriorView(this.levelAt(inside));
	}

	/** The storey the player is standing on, defaulting to the ground floor. */
	private levelAt(inside: NonNullable<GameState["player"]["inside"]>) {
		return getInterior(
			this.state.world.seed,
			inside.interiorId,
			inside.structure as StructureKind,
			inside.level ?? 0,
		);
	}

	getWorldView(): WorldView {
		return this.view;
	}

	/**
	 * The settlement covering a position, by name.
	 *
	 * Asked by the reducer to resolve `reach` objectives, and by the UI for the
	 * place label. Sites, not chunks: a town straddling four chunks is one place
	 * with one name.
	 */
	placeNameAt(x: number, y: number): string | undefined {
		const site = this.siteAt(x, y);
		if (!site) return undefined;
		// State first, because that is what persists; the director's own copy is
		// the fallback for the frame between a spec landing and being dispatched.
		return this.state.sites[String(site.id)]?.name ?? this.services.siteSpec?.(site.id)?.name;
	}

	/**
	 * What actually exists around a site, for the dialogue layer to be honest about.
	 *
	 * Assembled from the generator's own output — the buildings it placed, the
	 * roster it filled, the sites in the macro graph — so an NPC is describing the
	 * world rather than imagining one, and the action boundary has something real to
	 * resolve quest targets against.
	 */
	surroundingsFor(siteId: number): Surroundings {
		const site = this.siteById(siteId);
		if (!site) return EMPTY_SURROUNDINGS;

		const buildings = this.npcs.buildingsAt(site).map((building) => ({
			name: building.name ?? building.kind,
			kind: building.kind,
		}));

		const people = this.npcs.atSite(siteId).map((npc) => ({
			name: npc.spec.name,
			role: npc.spec.role,
		}));

		// Neighbouring places, but only ones that have been named: an unnamed site is
		// one the director has not reached yet, and sending the player to a place with
		// no name is no better than sending them to an invented one.
		const places: string[] = [];
		for (const other of sitesAround(this.world, site.mx, site.my, 2)) {
			if (other.id === siteId) continue;
			const named =
				this.state.sites[String(other.id)]?.name ?? this.services.siteSpec?.(other.id)?.name;
			if (named) places.push(named);
		}

		return {
			place: this.state.sites[String(siteId)]?.name ?? this.services.siteSpec?.(siteId)?.name,
			buildings,
			people,
			places,
			items: this.obtainableItems(site),
		};
	}

	private siteById(siteId: number): MacroSite | undefined {
		const cc = toChunk(this.anchor().x, this.anchor().y);
		// The player is standing in or beside the site they are talking to someone in,
		// so a small ring around them always contains it.
		return sitesAround(this.world, cc.cx, cc.cy, 2).find((s) => s.id === siteId);
	}

	/**
	 * Item names a `have` objective could legitimately name.
	 *
	 * The judgement itself lives in `core/rules/obtainable.ts`, so the offline
	 * scenario validator asks the identical question rather than approximating it.
	 * This is only the adapter that hands it the live rosters, the player's pockets
	 * and the chunks that happen to be resident.
	 */
	private obtainableItems(site: MacroSite): string[] {
		return obtainableItems({
			seed: this.state.world.seed,
			siteId: site.id,
			// The world's own tables, not the built-in ones. `validate.ts` resolves the
			// same pack the same way, which is what keeps the offline answer and the live
			// one from being two different answers.
			goods: (this.services.content ?? DEFAULT_PACK).goods,
			people: this.npcs
				.atSite(site.id)
				.map((npc) => ({ role: npc.spec.role, slot: npc.spec.slot })),
			buildings: this.npcs
				.buildingsAt(site)
				.map((building) => ({ interiorId: building.interiorId, kind: building.kind })),
			ground: {
				centre: site.site,
				radius: site.radius,
				// Only ground in resident chunks counts, so this never promises a field
				// the player would have to generate to find.
				terrainAt: (x, y) => (this.view.isLoaded(x, y) ? this.view.terrainAt(x, y) : undefined),
			},
			emptied: (interiorId, x, y) => Boolean(this.state.flags[lootKey(interiorId, x, y)]),
			// Every authored item still where it was put, wherever in the world that is.
			// A placement is a definite thing in a definite place and being sent across a
			// finite world for one is normal, so this is deliberately not scoped to the
			// site the conversation is happening in.
			placed: this.availablePlacements().map((entry) => entry.placement.item.name),
			carried: this.state.inventory.map((entry) => entry.name),
		});
	}

	/** Authored items whose conditions are met and which nobody has taken yet. */
	private availablePlacements(): ResolvedPlacement[] {
		return [...this.placements.values()].filter(
			(entry) =>
				evaluate(entry.placement.requires, this.state) && !this.state.flags[takenKey(entry.id)],
		);
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	dispatch = (command: Command): void => {
		const view = this.getView();
		const inside = this.state.player.inside;

		const probe: WorldProbe = {
			isPassable: (x, y) => view.isPassable(x, y),
			isLoaded: (x, y) => view.isLoaded(x, y),
			npcAt: (x, y) => {
				if (!inside) return this.npcs.at(x, y);
				// Every storey, not only the ground floor. This used to bail above level 0
				// because the roster ignored the level and would have answered with the
				// ground floor's household standing in the same spots on every storey —
				// but the *renderer* asked a different function that had no such guard, so
				// upstairs was drawn full of people who could be walked through and could
				// not be spoken to. Two paths, one of them patched.
				return this.residents.at(inside.interiorId, inside.structure, x, y, inside.level ?? 0);
			},
			doorAt: (x, y) => {
				if (inside) return undefined;
				const building = this.chunks.doorAt(x, y);
				if (!building) return undefined;
				return {
					interiorId: building.interiorId,
					structure: building.kind,
					...(building.name ? { name: building.name } : {}),
					...(building.lock ? { lock: building.lock } : {}),
				};
			},
			barrierAt: (x, y) => (inside ? undefined : this.barriers.get(`${x},${y}`)),
			interiorEntrance: (interiorId) => {
				const building = this.findBuilding(interiorId);
				if (!building) return undefined;
				return getInterior(this.state.world.seed, interiorId, building.kind).entrance;
			},
			portalAt: (x, y) => {
				if (!inside) return undefined;
				const level = inside.level ?? 0;
				const here = this.levelAt(inside);

				// The one open door in the south wall is the way back out, and only on the
				// level the outside door opens onto.
				if (level === 0 && x === here.entrance.x && y === here.entrance.y + 1) {
					return { kind: "exit" };
				}

				const portal = here.portals.find((p) => p.x === x && p.y === y);
				if (!portal) return undefined;
				const levels = getComplex(
					this.state.world.seed,
					inside.interiorId,
					inside.structure as StructureKind,
				);
				const arriving = levels[portal.to];
				if (!arriving) return undefined;

				// Land on the flight that points back here. It is passable and it is where
				// the stairs come out, and standing on a tile is not the same as walking
				// onto it — so arriving does not immediately send the player back.
				const landing = arriving.portals.find((p) => p.to === level);
				const at = landing ?? arriving.entrance;
				return { kind: "level", level: portal.to, x: at.x, y: at.y };
			},
			placeNameAt: (x, y) => this.placeNameAt(x, y),
			stagedScene: (id) => this.stagedScene(id),
			searchableAt: (x, y) => {
				const view = this.getView();

				// An authored item wins over whatever the generator would have put here.
				// Consulted first so a placement inherits the whole of the search path —
				// the same `lootKey` for having-been-taken, the same notice, and therefore
				// the same `have` objective resolution — rather than needing its own verb.
				const placed = this.placementAt(inside?.interiorId, x, y, inside?.level ?? 0);
				if (placed) return placed;

				// Indoors: the crates the generator furnished the room with.
				if (inside) {
					const decor = view.decorAt(x, y);
					if (!isContainer(decor)) return undefined;
					const level = inside.level ?? 0;
					return {
						key: lootKey(inside.interiorId, x, y, level),
						contents: containerContents(
							this.state.world.seed,
							inside.interiorId,
							x,
							y,
							decor,
							inside.structure,
							level,
						),
						emptyText: emptyMessage(decor),
					};
				}

				// Outdoors: the ground itself. Crops, forest floor, marsh and the rest
				// were scenery the player could walk up to and had no way to touch, which
				// is why an errand to gather from them could never be satisfied.
				const terrain = view.terrainAt(x, y);
				if (!isForageable(terrain)) return undefined;
				return {
					key: forageKey(x, y),
					contents: forageAt(this.state.world.seed, x, y, terrain),
					emptyText: pickedOverMessage(terrain),
				};
			},
		};

		const { state, effects } = reduce(this.state, command, probe);
		// The clock drives who is standing outside; check it before notifying so
		// the frame the player sees already has people in the right places. A world with
		// schedules turned off leaves everybody at their work station — the same thing
		// `asPlaced` already does for the people indoors, who have only one room to be in.
		if (state.time.hour !== this.state.time.hour && schedulesRun(state.world.time)) {
			this.npcs.setHour(state.time.hour);
		}
		// A gate that has just been unbarred, patched into the chunks already on screen
		// rather than by dropping them — see `applyAddedDeltas`.
		if (state.deltas !== this.state.deltas) this.chunks.applyAddedDeltas(state.deltas);
		// The chapter may have turned as a result of this command — the scene's last step sets
		// the flag a phase watches. Recomposed *after* the reducer rather than before, so the
		// flags it reads are the ones the command just wrote.
		const composed = this.recompose(state);
		if (composed !== this.state) {
			const gated = gateInputsChanged(this.state, composed);
			this.state = composed;
			// After the assignment, because the gate predicate reads `this.state` live,
			// and before notifying, so the frame the player sees on the step that brought
			// somebody on already has them standing in it.
			if (gated) {
				this.npcs.recheckGate();
				// Somebody authored into a room is gated the same way, and their roster is
				// cached — so without this they arrive only after the building is evicted.
				this.residents.clear();
			}
			this.notify();
		}
		for (const effect of effects) this.queue.push(effect);
		this.drain();
	};

	/** Replace state wholesale. Used only by save loading. */
	hydrate(state: GameState): void {
		// The chapter is derived from the flags, so a save resumed after a turning point has to
		// be recomposed before anything reads it — otherwise the world opens in chapter one with
		// the flags of chapter two, which is a world whose story has already happened in it.
		this.entered = "";
		this.staged.clear();
		this.state = this.recompose(state);
		state = this.state;
		this.barriers = barrierIndex(state.barriers);
		this.signs = signIndex(state.signs);
		this.placements = this.resolvePlaced(state);
		this.chunks.setDeltas(state.deltas);
		const here = toChunk(worldAnchor(state.player).x, worldAnchor(state.player).y);
		this.chunks.prefetch(here, OPENING_RADIUS);
		this.markPrefetched(here, OPENING_RADIUS);
		this.npcs.forgetAll();
		this.populateNpcs(here);
		// `populate` re-derives rosters from the specs; the gate has to be asked again
		// against the loaded state or a save resumed mid-story would show everybody.
		this.npcs.recheckGate();
		this.residents.clear();
		this.notify();
	}

	/**
	 * A scene with its points resolved and its walks pathfound, staged once.
	 *
	 * Cached because staging sweeps the bounded world for a site and builds its settlement,
	 * and the reducer asks for the staged scene on *every frame* of a cutscene. Cached even
	 * when staging failed — a scene that could not be staged will not stage on the next frame
	 * either, and re-deriving the same failure sixty times a second would put the sweep on the
	 * frame path.
	 *
	 * A failure is logged and returned as undefined, which the reducer reads as "do not open
	 * this". The trigger is then left unfired, so a corrected scenario plays the scene next
	 * time rather than having silently skipped it.
	 */
	private stagedScene(id: string): StagedScene | undefined {
		if (this.staged.has(id)) return this.staged.get(id);

		const scene = this.state.scenes?.[id];
		const bounds = this.state.world.bounds;
		if (!scene || !bounds) {
			if (!scene) logger.warn(`scene "${id}" was asked for and this world has none`);
			this.staged.set(id, undefined);
			return undefined;
		}

		const { staged, problems } = stageScene(scene, {
			world: this.world,
			bounds,
			siteSpec: (siteId) => this.state.sites[String(siteId)] ?? this.services.siteSpec?.(siteId),
			isPassable: (x, y) => this.view.isPassable(x, y),
			player: { x: this.state.player.x, y: this.state.player.y },
			npcAt: (npcId) => {
				const found = this.npcs.byNpcId(npcId);
				return found ? { x: found.x, y: found.y } : undefined;
			},
		});
		for (const problem of problems) logger.warn(`scene "${id}" cannot be staged: ${problem}`);
		this.staged.set(id, staged);
		return staged;
	}

	/**
	 * Lay the chapters that are now in force over the base world.
	 *
	 * Returns the state unchanged — by identity — when the set of entered chapters has not
	 * moved, which is almost every command. That identity matters: the caller only re-indexes
	 * and only notifies when something actually came back different.
	 *
	 * Everything derived from the composed content is rebuilt here rather than left to drift:
	 * the gate and sign indexes, the resolved placements, and the authored ground. A chapter
	 * that lays a road has to invalidate the chunks it crosses, because a stamped tile cannot
	 * be un-stamped from a chunk already carrying it.
	 */
	private recompose(state: GameState): GameState {
		const phases = this.services.phases;
		const base = this.services.base;
		if (!phases?.length || !base) return state;

		const entered = enteredPhaseIds(phases, state).join(",");
		if (entered === this.entered) return state;
		this.entered = entered;

		const content = composeScenario(base, phases, state);
		// Gates are authored by site-and-anchor and resolved against the built settlement, the
		// same way placements are — so a chapter that adds one has to resolve it here rather
		// than handing the reducer a span it cannot read.
		const { resolved: barriers, unresolved } = resolveBarriers(content.barriers, {
			world: this.world,
			...(state.world.bounds ? { bounds: state.world.bounds } : {}),
		});
		for (const problem of unresolved) {
			logger.warn(`gate ${problem.id} is nowhere: ${problem.reason}`);
		}

		const next: GameState = {
			...state,
			sites: content.sites,
			...(content.placements.length > 0 ? { placements: content.placements } : {}),
			...(content.signs.length > 0 ? { signs: content.signs } : {}),
			...(barriers.length > 0 ? { barriers } : {}),
			...(content.triggers.length > 0 ? { triggers: content.triggers } : {}),
			...(content.arc ? { arc: content.arc } : {}),
			...(Object.keys(content.scenes).length > 0 ? { scenes: content.scenes } : {}),
		};

		this.barriers = barrierIndex(next.barriers);
		this.signs = signIndex(next.signs);
		this.placements = this.resolvePlaced(next);
		// A chapter can replace a conversation or take one away, so a scene staged against the
		// old chapter may name somebody who is no longer standing there.
		this.staged.clear();

		const dropped = this.chunks.setTerraform(content.terraform);
		if (dropped.length > 0) {
			// Rebuild what was dropped before anything reads it, so the frame the chapter turns on
			// does not show a hole where the ground used to be.
			for (const key of dropped) {
				const { cx, cy } = parseChunkKey(key);
				this.chunks.ensure(cx, cy);
			}
		}
		// The roster is derived from the site specs, which a chapter may have replaced.
		this.npcs.forgetAll();
		this.populateNpcs(toChunk(worldAnchor(next.player).x, worldAnchor(next.player).y));
		this.npcs.recheckGate();
		this.residents.clear();

		logger.info(`chapter now: ${entered || "the opening"}`);
		return next;
	}

	/**
	 * The authored item on this tile, as something searchable.
	 *
	 * Returns nothing when the placement's own condition is unmet, which is what makes
	 * "the body is in the millrace, after the flood" expressible: searching the
	 * millrace beforehand falls through to the ordinary ground and reports what is
	 * actually there, rather than reporting nothing-yet.
	 *
	 * Keyed with `takenKey`, which is the placement's own id: sharing the container's
	 * flag meant a shelf searched before the story put anything in it counted as having
	 * been through the thing that was not there yet.
	 */
	private placementAt(interiorId: number | undefined, x: number, y: number, level = 0) {
		const entry = this.placements.get(placementSlot(interiorId, x, y, level));
		if (!entry) return undefined;
		if (!evaluate(entry.placement.requires, this.state)) return undefined;

		const item = entry.placement.item;
		return {
			key: takenKey(entry.id),
			contents: [{ ...item, quantity: item.quantity ?? 1 }],
			emptyText: entry.placement.emptyText ?? "There is nothing more here.",
		};
	}

	/**
	 * What the signpost on this tile says, worked out now rather than stored.
	 *
	 * Composed per call, which costs a handful of subtractions and buys the property the
	 * whole feature rests on: an arm names a site, and the direction and the distance come
	 * from where that site actually is. Nothing here can disagree with the map, because
	 * there is no second copy of the answer to disagree with it.
	 *
	 * Indoors always answers nothing. Interior coordinates are their own small grid near
	 * the origin, so a tile inside a house would otherwise collide with a signpost
	 * standing at those world coordinates out in the country — the same class of bug
	 * `worldAnchor` exists to prevent.
	 */
	signAt(x: number, y: number): string | undefined {
		if (this.state.player.inside) return undefined;
		const sign = this.signs.get(`${x},${y}`);
		if (!sign) return undefined;
		const text = signBoard(sign, {
			nameOf: (siteId) => this.siteName(siteId),
			positionOf: (siteId) => this.sitePosition(siteId),
		});
		return text.length > 0 ? text : undefined;
	}

	/**
	 * What a place is called, for a board to paint on itself.
	 *
	 * The authored spec first and the generated roster second, because a scenario's own
	 * name for a town is the one the player will hear people say. `shortName` in
	 * preference to the full one: a signpost is two lines of a panel, and "Cull's Weighing
	 * Station on the Thornwick Road" spends both of them on one arm.
	 */
	private siteName(siteId: number): string | undefined {
		const spec = this.state.sites[String(siteId)] ?? this.services.siteSpec?.(siteId);
		return spec?.shortName ?? spec?.name;
	}

	/**
	 * Where a place is, by id.
	 *
	 * Swept once and kept, because a site's position is a pure function of its macro cell
	 * and nothing indexes it the other way round. Only a bounded world can be swept, which
	 * is the same limit signposts already have: they are a scenario feature, and a
	 * scenario is finite by construction.
	 */
	private sitePosition(siteId: number): { readonly x: number; readonly y: number } | undefined {
		const bounds = this.state.world.bounds;
		if (!bounds) return undefined;
		this.sitePositions ??= sitesInside(this.world, bounds);
		return this.sitePositions.get(siteId)?.site;
	}

	/**
	 * The authored item standing on a tile, for the line that describes what you face.
	 *
	 * Public because the one thing the player needs to know about an item lying in the
	 * open is that it can be picked up, and the faced-tile description is where the game
	 * says so about everything else — a container, a patch of crops, a door.
	 */
	placedAt(x: number, y: number): ResolvedPlacement | undefined {
		const inside = this.state.player.inside;
		const entry = this.placements.get(placementSlot(inside?.interiorId, x, y, inside?.level ?? 0));
		if (!entry) return undefined;
		return evaluate(entry.placement.requires, this.state) ? entry : undefined;
	}

	/**
	 * Authored items asking to be drawn, on the grid the player is currently looking at.
	 *
	 * Filtered per call rather than precomputed, because both filters move during play:
	 * a placement can be gated on the story, and one that has been taken must stop
	 * being drawn. A scenario has a handful of these, so per-frame is cheaper than any
	 * cache would be to keep honest.
	 */
	markedPlacements(): readonly ResolvedPlacement[] {
		const inside = this.state.player.inside;
		const interiorId = inside?.interiorId;
		const level = inside ? (inside.level ?? 0) : 0;
		return this.availablePlacements().filter(
			(entry) =>
				entry.placement.showDecor &&
				entry.interiorId === interiorId &&
				// A storey is its own grid, so a mark from the floor below would be drawn
				// at coordinates that mean something entirely different up here.
				(entry.level ?? 0) === level,
		);
	}

	/**
	 * The scenario's own people standing in one room.
	 *
	 * Everything an author could write stood in the street, because that is where the
	 * anchors are — so a locked door led to an empty box and a cave with three levels
	 * under it was scenery. There was already an indoor cast with ids, memory, dialogue
	 * and rendering; what was missing was a way for a scenario to put somebody into it.
	 *
	 * Ground floor only, on purpose: that is the storey the outside door opens onto, so
	 * it is the one a beat can promise the player will reach. Their id stays the site's
	 * own `npc:<siteId>:<slot>`, which is what lets a beat anchored to them, a dialogue
	 * tree written for them and a `talk` objective naming them all work unchanged.
	 */
	private authoredInside(interiorId: number, level: number): readonly AuthoredResident[] {
		if (level !== 0) return [];
		const building = this.findBuilding(interiorId);
		if (!building) return [];
		const site = this.siteAt(building.door.x, building.door.y);
		if (!site) return [];
		const spec = this.state.sites[String(site.id)] ?? this.services.siteSpec?.(site.id);
		if (!spec) return [];

		const here = building.name?.toLowerCase();
		return (
			spec.npcs
				.filter((npc) => npc.indoors)
				.filter((npc) => !npc.structureName || npc.structureName.toLowerCase() === here)
				// Gated exactly as an outdoor person is: absent, not standing elsewhere.
				.filter((npc) => evaluate(npc.requires, this.state))
				.map((npc) => ({ id: makeNpcId(site.id, npc.slot), spec: npc }))
		);
	}

	/**
	 * One way up to each authored item in a room, kept clear of the household.
	 *
	 * Searching is a faced gesture, so an item with every neighbour occupied cannot be
	 * reached at all — and the shipped scenario's axe sat in a crate against a wall with
	 * a crate on either side of it, visible, marked, and impossible. The resolver now
	 * prefers the most approachable container; this stops the filler undoing that.
	 */
	private approachesInside(
		interiorId: number,
		level: number,
	): readonly { readonly x: number; readonly y: number }[] {
		const building = this.findBuilding(interiorId);
		if (!building) return [];
		const interior = getInterior(this.state.world.seed, interiorId, building.kind, level);
		const clear: { x: number; y: number }[] = [];
		for (const entry of this.placements.values()) {
			if (entry.interiorId !== interiorId || (entry.level ?? 0) !== level) continue;
			const way = approaches(interior, entry.x, entry.y)[0];
			if (way) clear.push(way);
		}
		return clear;
	}

	/** Locate a building by its interior id, searching the resident chunks. */
	private findBuilding(interiorId: number) {
		const centre = toChunk(this.anchor().x, this.anchor().y);
		for (let dy = -1; dy <= 1; dy++) {
			for (let dx = -1; dx <= 1; dx++) {
				const found = this.chunks
					.buildingsIn(centre.cx + dx, centre.cy + dy)
					.find((b) => b.interiorId === interiorId);
				if (found) return found;
			}
		}
		return undefined;
	}

	private drain(): void {
		// Guard against an effect that dispatches, which would otherwise recurse
		// into drain and process the queue out of order.
		if (this.draining) return;
		this.draining = true;
		try {
			while (this.queue.length > 0) {
				const effect = this.queue.shift() as Effect;
				const result = this.services.runEffect(effect, this);
				if (result && typeof result.then === "function") {
					result.catch((error: unknown) => {
						this.dispatch({
							t: "Error",
							scope: effect.t,
							message: error instanceof Error ? error.message : String(error),
						});
					});
				}
			}
		} finally {
			this.draining = false;
		}
	}

	private notify(): void {
		for (const listener of this.listeners) listener();
	}
}

/**
 * Whether anything a person's presence could depend on has moved.
 *
 * A cheap identity comparison over the five slices a {@link Condition} can read,
 * rather than re-asking the gate after every keypress. Movement is the overwhelming
 * majority of commands and touches none of these, so the common case costs five
 * reference comparisons and nothing else.
 *
 * `time` is the one that changes on almost every step, and it is deliberately
 * included: an `hour` condition is a legitimate way to say somebody keeps night
 * hours. It is guarded on the hour rather than the tick, because a condition cannot
 * see minutes.
 */
function gateInputsChanged(before: GameState, after: GameState): boolean {
	return (
		before.flags !== after.flags ||
		before.inventory !== after.inventory ||
		before.quests !== after.quests ||
		before.npcs !== after.npcs ||
		before.reputation !== after.reputation ||
		before.time.hour !== after.time.hour
	);
}
