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
import { placementIndex, placementSlot, type ResolvedPlacement } from "../core/rules/placement.js";
import { reduce, type WorldProbe } from "../core/rules/reduce.js";
import type { GameState } from "../core/rules/state.js";
import { EMPTY_SURROUNDINGS, type Surroundings } from "../core/rules/surroundings.js";
import { parseChunkKey, toChunk } from "../core/world/coords.js";
import { type MacroSite, regionIdAt, sitesAround } from "../core/world/macro.js";
import { type WorldSeed, worldSeed } from "../core/world/recipe.js";
import type { SiteSpec } from "../core/world/spec.js";
import { logger } from "../utils/log.js";
import { ChunkManager } from "./chunk-manager.js";
import { InteriorPeople } from "./interior-people.js";
import { createInteriorView } from "./interior-view.js";
import { NpcDirectory, type PlacedNpc } from "./npc-directory.js";
import { resolvePlacements } from "./placements.js";
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
}

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
	/** Authored items, by the tile they sit on. Rebuilt on `hydrate`. */
	private placements: Map<string, ResolvedPlacement>;
	private draining = false;
	private readonly queue: Effect[] = [];

	constructor(
		initial: GameState,
		private readonly services: EngineServices,
	) {
		this.state = initial;
		this.world = worldSeed(initial.world.seed, initial.world.recipe);
		this.barriers = barrierIndex(initial.barriers);
		this.placements = this.resolvePlaced(initial);
		this.chunks = new ChunkManager({
			world: this.world,
			...(services.specFor ? { specFor: services.specFor } : {}),
			...(initial.world.bounds ? { bounds: initial.world.bounds } : {}),
			...(initial.barriers?.length ? { barriers: barrierTiles(initial.barriers) } : {}),
		});
		this.chunks.setDeltas(initial.deltas);
		this.npcs = new NpcDirectory(this.chunks, (siteId) => this.services.siteSpec?.(siteId));
		this.npcs.setGate((npc) => evaluate(npc.requires, this.state));
		this.residents = new InteriorPeople(initial.world.seed, services.content);
		this.view = createWorldView({
			seed: initial.world.seed,
			chunkAt: (cx, cy) => this.chunks.get(cx, cy),
		});

		// The chunk the player stands in must exist before the first frame.
		const start = toChunk(initial.player.x, initial.player.y);
		this.chunks.prefetch(start, 1);
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
		const resident = this.residents.at(inside.interiorId, inside.structure, x, y);
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
		if (isResidentId(id)) {
			const inside = this.state.player.inside;
			if (!inside) return undefined;
			const resident = this.residents.byId(inside.interiorId, inside.structure, id);
			return resident ? this.asPlaced(resident, inside) : undefined;
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
		this.populateNpcs(toChunk(this.state.player.x, this.state.player.y));
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
		const cc = toChunk(this.state.player.x, this.state.player.y);
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
				evaluate(entry.placement.requires, this.state) &&
				!this.state.flags[lootKey(entry.interiorId, entry.x, entry.y)],
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
				// Residents live on the ground floor. Upstairs is a different grid that
				// happens to share coordinates, and the same household standing in the
				// same spots on every storey reads as a haunting.
				if ((inside.level ?? 0) !== 0) return undefined;
				return this.residents.at(inside.interiorId, inside.structure, x, y);
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
			searchableAt: (x, y) => {
				const view = this.getView();

				// An authored item wins over whatever the generator would have put here.
				// Consulted first so a placement inherits the whole of the search path —
				// the same `lootKey` for having-been-taken, the same notice, and therefore
				// the same `have` objective resolution — rather than needing its own verb.
				const placed = this.placementAt(inside?.interiorId, x, y);
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
		if (state !== this.state) {
			const gated = gateInputsChanged(this.state, state);
			this.state = state;
			// After the assignment, because the gate predicate reads `this.state` live,
			// and before notifying, so the frame the player sees on the step that brought
			// somebody on already has them standing in it.
			if (gated) this.npcs.recheckGate();
			this.notify();
		}
		for (const effect of effects) this.queue.push(effect);
		this.drain();
	};

	/** Replace state wholesale. Used only by save loading. */
	hydrate(state: GameState): void {
		this.state = state;
		this.barriers = barrierIndex(state.barriers);
		this.placements = this.resolvePlaced(state);
		this.chunks.setDeltas(state.deltas);
		const here = toChunk(state.player.x, state.player.y);
		this.chunks.prefetch(here, 1);
		this.npcs.forgetAll();
		this.populateNpcs(here);
		// `populate` re-derives rosters from the specs; the gate has to be asked again
		// against the loaded state or a save resumed mid-story would show everybody.
		this.npcs.recheckGate();
		this.notify();
	}

	/**
	 * The authored item on this tile, as something searchable.
	 *
	 * Returns nothing when the placement's own condition is unmet, which is what makes
	 * "the body is in the millrace, after the flood" expressible: searching the
	 * millrace beforehand falls through to the ordinary ground and reports what is
	 * actually there, rather than reporting nothing-yet.
	 *
	 * Keyed with `lootKey`, so being taken is recorded by the flag that already exists
	 * for emptying a container — nothing about placements needs its own persistence.
	 */
	private placementAt(interiorId: number | undefined, x: number, y: number) {
		const entry = this.placements.get(placementSlot(interiorId, x, y));
		if (!entry) return undefined;
		if (!evaluate(entry.placement.requires, this.state)) return undefined;

		const item = entry.placement.item;
		return {
			key: lootKey(interiorId, x, y),
			contents: [{ ...item, quantity: item.quantity ?? 1 }],
			emptyText: entry.placement.emptyText ?? "There is nothing more here.",
		};
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
		const interiorId = this.state.player.inside?.interiorId;
		return this.availablePlacements().filter(
			(entry) => entry.placement.showDecor && entry.interiorId === interiorId,
		);
	}

	/** Locate a building by its interior id, searching the resident chunks. */
	private findBuilding(interiorId: number) {
		const centre = toChunk(this.state.player.x, this.state.player.y);
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
