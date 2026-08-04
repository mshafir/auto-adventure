import { getInterior } from "../core/gen/features/interior.js";
import type { StructureKind } from "../core/gen/features/patch.js";
import { invalidateSettlement, settlementBounds } from "../core/gen/features/settlement.js";
import type { Command } from "../core/rules/commands.js";
import type { Effect } from "../core/rules/effects.js";
import { containerContents, emptyMessage, isContainer, itemsStoredIn } from "../core/rules/loot.js";
import { reduce, type WorldProbe } from "../core/rules/reduce.js";
import { shopStock, tradeKind } from "../core/rules/shop.js";
import type { GameState } from "../core/rules/state.js";
import { EMPTY_SURROUNDINGS, type Surroundings } from "../core/rules/surroundings.js";
import { parseChunkKey, toChunk } from "../core/world/coords.js";
import { type MacroSite, sitesAround } from "../core/world/macro.js";
import type { SiteSpec } from "../core/world/spec.js";
import { ChunkManager } from "./chunk-manager.js";
import { createInteriorView } from "./interior-view.js";
import { NpcDirectory } from "./npc-directory.js";
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
	private readonly npcs: NpcDirectory;
	private readonly view: WorldView;
	private draining = false;
	private readonly queue: Effect[] = [];

	constructor(
		initial: GameState,
		private readonly services: EngineServices,
	) {
		this.state = initial;
		this.chunks = new ChunkManager({
			seed: initial.world.seed,
			...(services.specFor ? { specFor: services.specFor } : {}),
		});
		this.chunks.setDeltas(initial.deltas);
		this.npcs = new NpcDirectory(this.chunks, (siteId) => this.services.siteSpec?.(siteId));
		this.view = createWorldView({
			seed: initial.world.seed,
			chunkAt: (cx, cy) => this.chunks.get(cx, cy),
		});

		// The chunk the player stands in must exist before the first frame.
		const start = toChunk(initial.player.x, initial.player.y);
		this.chunks.prefetch(start, 1);
		this.populateNpcs(start);
	}

	getState = (): GameState => this.state;

	getChunks(): ChunkManager {
		return this.chunks;
	}

	getNpcs(): NpcDirectory {
		return this.npcs;
	}

	/** Derive NPC placements for every site reaching a position. */
	populateNpcs(cc: { cx: number; cy: number }): void {
		this.npcs.populate(sitesAround(this.state.world.seed, cc.cx, cc.cy));
	}

	/**
	 * Rebuild a settlement after its authored roster arrived.
	 *
	 * The patch cache, the chunks that stamped it and the people standing in it
	 * are all derived from the spec, so all three are dropped together and
	 * recomputed on the next read.
	 */
	rebuildSite(site: MacroSite): void {
		invalidateSettlement(this.state.world.seed, site.id);
		const dropped = this.chunks.invalidateRect(settlementBounds(site));
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
		return createInteriorView(
			getInterior(this.state.world.seed, inside.interiorId, inside.structure as StructureKind),
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
		const cc = toChunk(x, y);
		for (const site of sitesAround(this.state.world.seed, cc.cx, cc.cy, 1)) {
			if (Math.hypot(site.site.x - x, site.site.y - y) > site.radius) continue;
			// State first, because that is what persists; the director's own copy is
			// the fallback for the frame between a spec landing and being dispatched.
			const named =
				this.state.sites[String(site.id)]?.name ?? this.services.siteSpec?.(site.id)?.name;
			if (named) return named;
		}
		return undefined;
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
		for (const other of sitesAround(this.state.world.seed, site.mx, site.my, 2)) {
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
		return sitesAround(this.state.world.seed, cc.cx, cc.cy, 2).find((s) => s.id === siteId);
	}

	/**
	 * Item names a `have` objective could legitimately name.
	 *
	 * Three sources, and all three have to be here or an NPC gets refused a request
	 * the player could actually have satisfied: what is on sale, what the buildings
	 * here store, and what the player already carries. This is why "fetch me timber"
	 * is a legal errand in a milling town and an illegal one in a fishing village,
	 * without either the model or the resolver holding a catalogue of its own.
	 */
	private obtainableItems(site: MacroSite): string[] {
		const names = new Set<string>();

		for (const npc of this.npcs.atSite(site.id)) {
			const kind = tradeKind(npc.spec.role);
			if (!kind) continue;
			for (const item of shopStock(this.state.world.seed, site.id, npc.spec.slot, kind)) {
				names.add(item.name);
			}
		}

		// What is in the crates. Every building kind that stands here, not just the
		// ones with a shopkeeper in them.
		for (const building of this.npcs.buildingsAt(site)) {
			for (const name of itemsStoredIn(building.kind)) names.add(name);
		}

		for (const carried of this.state.inventory) names.add(carried.name);
		return [...names];
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
			npcAt: (x, y) => (inside ? undefined : this.npcs.at(x, y)),
			doorAt: (x, y) => {
				if (inside) return undefined;
				const building = this.chunks.doorAt(x, y);
				if (!building) return undefined;
				return {
					interiorId: building.interiorId,
					structure: building.kind,
					...(building.name ? { name: building.name } : {}),
				};
			},
			interiorEntrance: (interiorId) => {
				const building = this.findBuilding(interiorId);
				if (!building) return undefined;
				return getInterior(this.state.world.seed, interiorId, building.kind).entrance;
			},
			isExit: (x, y) => {
				if (!inside) return false;
				const interior = getInterior(
					this.state.world.seed,
					inside.interiorId,
					inside.structure as StructureKind,
				);
				// The one open door in the south wall is the way back out.
				return x === interior.entrance.x && y === interior.entrance.y + 1;
			},
			placeNameAt: (x, y) => this.placeNameAt(x, y),
			containerAt: (x, y) => {
				// Only interiors hold containers, which is also where the generator puts
				// them; a crate in an open field would have nowhere to belong to.
				if (!inside) return undefined;
				const view = this.getView();
				const decor = view.decorAt(x, y);
				if (!isContainer(decor)) return undefined;
				return {
					place: inside.interiorId,
					contents: containerContents(
						this.state.world.seed,
						inside.interiorId,
						x,
						y,
						decor,
						inside.structure,
					),
					emptyText: emptyMessage(decor),
				};
			},
		};

		const { state, effects } = reduce(this.state, command, probe);
		// The clock drives who is standing outside; check it before notifying so
		// the frame the player sees already has people in the right places.
		if (state.time.hour !== this.state.time.hour) this.npcs.setHour(state.time.hour);
		if (state !== this.state) {
			this.state = state;
			this.notify();
		}
		for (const effect of effects) this.queue.push(effect);
		this.drain();
	};

	/** Replace state wholesale. Used only by save loading. */
	hydrate(state: GameState): void {
		this.state = state;
		this.chunks.setDeltas(state.deltas);
		const here = toChunk(state.player.x, state.player.y);
		this.chunks.prefetch(here, 1);
		this.npcs.forgetAll();
		this.populateNpcs(here);
		this.notify();
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
