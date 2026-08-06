import type { Anchor, BuildingPlacement } from "../core/gen/features/patch.js";
import { TFlag } from "../core/tiles/flags.js";
import { CHUNK } from "../core/world/coords.js";
import type { MacroSite } from "../core/world/macro.js";
import { type NpcSpec, npcId, type SiteSpec } from "../core/world/spec.js";
import { type TimeOfDay, timeOfDay } from "../core/world/weather.js";
import type { ChunkManager } from "./chunk-manager.js";

export interface PlacedNpc {
	readonly id: string;
	readonly name: string;
	readonly role: string;
	readonly glyph: string;
	/** Where they are *now*. Recomputed when the time of day changes. */
	x: number;
	y: number;
	readonly siteId: number;
	readonly regionId: number;
	readonly spec: NpcSpec;
	/**
	 * Where they are at each part of the day.
	 *
	 * Every bucket is filled. A missing one removes that person from the world for
	 * those hours — not indoors, since placement is in world coordinates and an
	 * interior is its own space, but nowhere at all.
	 */
	readonly stations: Readonly<Partial<Record<TimeOfDay, { x: number; y: number }>>>;
}

/**
 * Where the people are.
 *
 * NPC positions are not stored: they are derived from the site's spec and the
 * anchors the settlement generator emitted, both of which are deterministic. So
 * an NPC's id — `npc:{siteId}:{slot}` — is stable across eviction, reload and
 * regeneration, which is the precondition for their memory meaning anything.
 *
 * Everyone stands outdoors. Placing them inside would need a per-interior
 * entity layer, and a shopkeeper on their own doorstep is both easier to find
 * and easier to draw.
 */
export class NpcDirectory {
	private readonly roster = new Map<number, PlacedNpc[]>();
	private readonly byChunk = new Map<string, PlacedNpc[]>();
	private readonly byId = new Map<string, PlacedNpc>();
	/**
	 * Sites placed before all of their ground existed.
	 *
	 * A roster is derived from the anchors the settlement generator emitted, so one
	 * derived while some of the site's chunks were missing is a guess — at the limit,
	 * a guess that nobody lives there. Without this set that guess was cached as a
	 * decision and `populate` skipped the site forever, which is how a fully authored
	 * town could be permanently deserted. Cleared once the site has been derived from
	 * its whole footprint, so a settled roster is never disturbed again.
	 */
	private readonly provisional = new Set<number>();
	private bucket: TimeOfDay = "morning";
	/**
	 * Whether a person's own conditions are currently met.
	 *
	 * A predicate rather than the state itself, so this class stays ignorant of
	 * `GameState` — it already derives everything from specs and anchors, and giving
	 * it the whole state would invite it to start reading other things. Defaults to
	 * "everybody is here", which is every procedural and live world: gating is an
	 * authored-cast feature, and a directory nobody has gated behaves exactly as it
	 * did before this existed.
	 */
	private gate: (npc: NpcSpec) => boolean = () => true;
	/**
	 * Bumped whenever placements change.
	 *
	 * The directory is mutable and derived from specs that arrive asynchronously,
	 * so nothing about its identity tells a memo that its answers changed. This is
	 * what the render layer keys on.
	 */
	revision = 0;

	constructor(
		private readonly chunks: ChunkManager,
		private readonly specFor: (siteId: number) => SiteSpec | undefined,
	) {}

	/** Drop everything for a site, so it is re-derived from a newer spec. */
	forget(siteId: number): void {
		this.provisional.delete(siteId);
		if (!this.roster.delete(siteId)) return;
		this.revision++;
		this.reindex();
	}

	forgetAll(): void {
		this.roster.clear();
		this.provisional.clear();
		this.revision++;
		this.reindex();
	}

	/**
	 * Move everyone to where they should be at this hour.
	 *
	 * Schedules are the cheapest thing in the game that makes a village feel
	 * inhabited: no model call, no stored state, just a different anchor per part
	 * of the day. Nobody is ever moved out of the world entirely — a town with
	 * nobody in it cannot be asked anything, and looks broken rather than asleep.
	 */
	setHour(hour: number): void {
		const bucket = timeOfDay(hour);
		if (bucket === this.bucket) return;
		this.bucket = bucket;
		this.revision++;
		this.reindex();
	}

	/**
	 * Tell the directory how to decide whether a gated person is present.
	 *
	 * Called after every command that could have changed the answer, which is most of
	 * them — so the cheap path matters: `reindex` re-derives the visible set, and the
	 * revision is bumped only if that set actually differs. Without that check the
	 * render layer, which memoises on `revision`, would rebuild the entity index on
	 * every single step.
	 */
	setGate(gate: (npc: NpcSpec) => boolean): void {
		this.gate = gate;
		this.recheckGate();
	}

	/**
	 * Ask the gate again, because the state it reads has changed.
	 *
	 * Separate from `setGate` so the caller does not have to hand over the predicate
	 * again on every keypress. The revision is bumped only if the visible set actually
	 * differs — the render layer memoises on it, so bumping unconditionally would
	 * rebuild the entity index on every single step for a world with no gated people
	 * in it at all.
	 */
	recheckGate(): void {
		const before = [...this.byId.keys()];
		this.reindex();
		if (this.byId.size !== before.length || before.some((id) => !this.byId.has(id))) {
			this.revision++;
		}
	}

	/** Whether this person's conditions are met right now. */
	private present(npc: PlacedNpc): boolean {
		return this.gate(npc.spec);
	}

	/**
	 * Place everyone belonging to the sites reaching a chunk.
	 *
	 * Called on every chunk change, so it must be cheap for sites already settled and
	 * must not disturb them: re-deriving a roster from a partially evicted footprint
	 * would move people who are standing where they belong. Only a provisional roster
	 * is revisited, and only once the whole footprint is back.
	 */
	populate(sites: readonly MacroSite[]): void {
		let changed = false;
		for (const site of sites) {
			const known = this.roster.has(site.id);
			if (known && !this.provisional.has(site.id)) continue;
			const whole = this.footprintResident(site);
			// Still nothing better to say than last time.
			if (known && !whole) continue;
			const spec = this.specFor(site.id);
			if (!spec) continue;
			// Drop the guess before replacing it: `place` treats every existing station
			// as occupied, so the people about to be replaced would reserve tiles
			// against themselves and get shuffled off their own doorsteps.
			this.roster.delete(site.id);
			this.roster.set(site.id, this.place(site, spec));
			if (whole) this.provisional.delete(site.id);
			else this.provisional.add(site.id);
			changed = true;
		}
		if (!changed) return;
		this.revision++;
		this.reindex();
	}

	/**
	 * Whether every chunk `anchorsFor` consults has been generated.
	 *
	 * The same square, deliberately: the question is not "is the site loaded" but
	 * "would searching for its anchors find all of them", and only the search's own
	 * extent answers that.
	 */
	private footprintResident(site: MacroSite): boolean {
		const reach = Math.ceil(site.radius / CHUNK) + 1;
		for (let dy = -reach; dy <= reach; dy++) {
			for (let dx = -reach; dx <= reach; dx++) {
				if (!this.chunks.get(site.mx + dx, site.my + dy)) return false;
			}
		}
		return true;
	}

	at(x: number, y: number): PlacedNpc | undefined {
		const list = this.byChunk.get(chunkKeyOf(x, y));
		if (!list) return undefined;
		return list.find((npc) => npc.x === x && npc.y === y);
	}

	/** Look someone up by id whether or not they are currently outdoors — an
	 * open conversation must survive the hour ticking over. */
	byNpcId(id: string): PlacedNpc | undefined {
		const known = this.byId.get(id);
		if (known) return known;
		for (const list of this.roster.values()) {
			const found = list.find((npc) => npc.id === id);
			// Gated here as well as in `reindex`. This fallback exists so a conversation
			// survives the clock moving somebody out of the index, and without the check
			// it would also resolve somebody the story has not brought on at all —
			// which is how a hidden NPC stays talkable.
			if (found && this.present(found)) return found;
		}
		return undefined;
	}

	/** Everyone visible right now, for rendering and the journal. */
	all(): readonly PlacedNpc[] {
		return [...this.byId.values()];
	}

	/** Rebuild the spatial index for the current time of day. */
	private reindex(): void {
		this.byChunk.clear();
		this.byId.clear();
		for (const list of this.roster.values()) {
			for (const npc of list) {
				// Somebody the story has not brought on yet. Skipped here rather than at
				// `place` time so their station stays reserved: a courier who appears in
				// chapter two must not find their doorstep taken by whoever was shuffled
				// into it while they were absent.
				if (!this.present(npc)) continue;
				// Every bucket should be filled; skipping is a guard, not a schedule.
				// When `night` and `dawn` were left absent for most roles, this quietly
				// emptied every town between 23:00 and 07:00.
				const station = npc.stations[this.bucket];
				if (!station) continue;
				npc.x = station.x;
				npc.y = station.y;
				this.byId.set(npc.id, npc);
				const key = chunkKeyOf(npc.x, npc.y);
				const existing = this.byChunk.get(key);
				if (existing) existing.push(npc);
				else this.byChunk.set(key, [npc]);
			}
		}
	}

	private place(site: MacroSite, spec: SiteSpec): PlacedNpc[] {
		const anchors = this.anchorsFor(site);
		const buildings = this.buildingsFor(site);
		// Occupancy is tracked across the whole directory, not per site: two towns
		// whose halos overlap would otherwise each place someone on the same tile.
		// The chokes go in with them: they are tiles nobody may stand on, and the
		// cheapest way to say that is to call them already occupied.
		const taken = this.occupied();
		for (const tile of this.chokePoints(buildings)) taken.add(tile);
		const placed: PlacedNpc[] = [];

		const plaza = anchors.filter(
			(a) =>
				(a.kind === "bench" || a.kind === "stall" || a.kind === "well") &&
				!taken.has(`${a.x},${a.y}`),
		);

		for (const npc of spec.npcs) {
			// Somebody the scenario put in a room belongs to `InteriorPeople`, not here.
			// Placing them anyway would draw them twice — once in the street on an anchor
			// they never asked for, and once inside where they were meant to be.
			if (npc.indoors) continue;
			const spot = pickAnchor(npc, anchors, buildings, taken);
			if (!spot) continue;
			taken.add(`${spot.x},${spot.y}`);
			placed.push({
				id: npcId(site.id, npc.slot),
				name: npc.name,
				role: npc.role,
				glyph: glyphFor(npc),
				x: spot.x,
				y: spot.y,
				siteId: site.id,
				regionId: site.regionId,
				spec: npc,
				stations: stationsFor(npc, spot, plaza[npc.slot % Math.max(1, plaza.length)]),
			});
		}
		return placed;
	}

	/**
	 * Tiles that are the only way into somewhere, which nobody may stand on.
	 *
	 * Walking into a person is how you talk to them, so a person on the sole approach
	 * to a door is a person you talk to *instead of* going in — and nothing on screen
	 * says the way is blocked, because from the game's point of view nothing is wrong.
	 * The player simply cannot get in, and reads it as the door being broken.
	 *
	 * This used to be a rule about anchor *kinds*: `pickAnchor` refused a `doorstep`
	 * because a doorstep is usually the one tile a door opens onto. Guarding a
	 * geometric property by name only works while every generator agrees about which
	 * names are dangerous, and twice they did not — a castle's `gate` anchor was the
	 * middle tile of its own arch, and a cave's `square` was the single step its mouth
	 * is entered from. Both looked entirely reasonable, both sealed the only way in,
	 * and both cost a play-test to find. Asking the geometry instead covers the
	 * anchors a feature has not been written yet.
	 *
	 * Only the *last* approach. A door with two ways up to it can have somebody
	 * standing at one of them, which is what a shopkeeper outside their own shop is —
	 * and refusing that would empty the streets to fix something that is not wrong.
	 */
	private chokePoints(buildings: readonly BuildingPlacement[]): Set<string> {
		const sealed = new Set<string>();
		for (const building of buildings) {
			const { x, y } = building.door;
			const ways = [
				{ x: x + 1, y },
				{ x: x - 1, y },
				{ x, y: y + 1 },
				{ x, y: y - 1 },
			].filter((way) => this.passable(way.x, way.y));
			// The door itself, always: standing in a doorway is the same conversation
			// trap even where the approach is wide.
			sealed.add(`${x},${y}`);
			if (ways.length === 1 && ways[0]) sealed.add(`${ways[0].x},${ways[0].y}`);
		}
		return sealed;
	}

	private passable(x: number, y: number): boolean {
		const chunk = this.chunks.get(Math.floor(x / CHUNK), Math.floor(y / CHUNK));
		if (!chunk) return false;
		const local = ((y % CHUNK) + CHUNK) % CHUNK;
		const column = ((x % CHUNK) + CHUNK) % CHUNK;
		return ((chunk.flags[local * CHUNK + column] ?? 0) & TFlag.Passable) !== 0;
	}

	/** Every tile a placed NPC already stands on, at any hour. */
	private occupied(): Set<string> {
		const taken = new Set<string>();
		for (const list of this.roster.values()) {
			for (const npc of list) {
				for (const station of Object.values(npc.stations)) {
					if (station) taken.add(`${station.x},${station.y}`);
				}
			}
		}
		return taken;
	}

	/**
	 * Collect the site's own anchors from whichever of its chunks are resident.
	 *
	 * A settlement is clipped across several chunks, so its anchors are too; an
	 * NPC whose anchor lies in a chunk that has not been built yet is simply not
	 * placed until it is, at which point `forget`/`populate` picks them up.
	 *
	 * The bounds filter is load-bearing. Chunks are searched in whole-chunk
	 * steps, so the search square reaches well past a small town — and without
	 * the filter a village's blacksmith cheerfully takes up station on the
	 * doorstep of a different village two chunks away.
	 */
	private anchorsFor(site: MacroSite): Anchor[] {
		const found: Anchor[] = [];
		const reach = Math.ceil(site.radius / CHUNK) + 1;
		const limit = site.radius + 2;
		for (let dy = -reach; dy <= reach; dy++) {
			for (let dx = -reach; dx <= reach; dx++) {
				for (const anchor of this.chunks.anchorsIn(site.mx + dx, site.my + dy)) {
					if (Math.hypot(anchor.x - site.site.x, anchor.y - site.site.y) > limit) continue;
					found.push(anchor);
				}
			}
		}
		return found;
	}

	/**
	 * Everyone belonging to a site, whether or not they are outdoors right now.
	 *
	 * Gated people are left out, because this is what grounds a conversation: the
	 * dialogue layer is told who is here so an NPC can name them, and naming somebody
	 * the story has not brought on is exactly the invented-detail failure that
	 * `surroundingsFor` exists to prevent.
	 */
	atSite(siteId: number): readonly PlacedNpc[] {
		const roster = this.roster.get(siteId);
		if (!roster) return [];
		return roster.filter((npc) => this.present(npc));
	}

	/** The buildings a site actually has, for grounding what an NPC may promise. */
	buildingsAt(site: MacroSite): readonly BuildingPlacement[] {
		return this.buildingsFor(site);
	}

	private buildingsFor(site: MacroSite): BuildingPlacement[] {
		const found: BuildingPlacement[] = [];
		const reach = Math.ceil(site.radius / CHUNK) + 1;
		const limit = site.radius + 2;
		for (let dy = -reach; dy <= reach; dy++) {
			for (let dx = -reach; dx <= reach; dx++) {
				for (const building of this.chunks.buildingsIn(site.mx + dx, site.my + dy)) {
					if (Math.hypot(building.door.x - site.site.x, building.door.y - site.site.y) > limit) {
						continue;
					}
					found.push(building);
				}
			}
		}
		return found;
	}
}

function chunkKeyOf(x: number, y: number): string {
	return `${Math.floor(x / CHUNK)},${Math.floor(y / CHUNK)}`;
}

function glyphFor(npc: NpcSpec): string {
	const candidate = npc.glyph?.trim() ?? "";
	if (/^[A-Za-z]$/.test(candidate)) return candidate.toUpperCase();
	return (npc.role[0] ?? npc.name[0] ?? "p").toUpperCase();
}

/**
 * Find somewhere for one NPC to stand.
 *
 * Preference order: the yard of the building they were named against, then any
 * anchor of the kind they asked for, then any free outdoor anchor at all. The
 * last fallback matters — the model's `placement` is advisory, and a settlement
 * small enough to have no square still has yards.
 *
 * Doorsteps are allowed again, and that is not a relaxation. `place` marks every
 * tile that is the *only* way into a building as occupied before anybody is seated,
 * so the case this used to blanket-ban — somebody sealing a door that has one
 * approach — is refused on the geometry instead of on the anchor's name. A doorstep
 * with a second way round it is a shopkeeper standing outside their own shop, which
 * is what the anchor was for.
 *
 * Naming the dangerous kinds is what failed twice: a castle called its choke point
 * `gate` and a cave called its single step `square`, and neither name was on the list.
 */
function pickAnchor(
	npc: NpcSpec,
	anchors: readonly Anchor[],
	buildings: readonly BuildingPlacement[],
	taken: ReadonlySet<string>,
): Anchor | undefined {
	const free = (a: Anchor) => !taken.has(`${a.x},${a.y}`) && OUTDOOR.has(a.kind);

	if (npc.structureName) {
		const wanted = npc.structureName.toLowerCase();
		const building = buildings.find((b) => b.name?.toLowerCase() === wanted);
		if (building) {
			const own = anchors.find(
				(a) => a.kind === "yard" && a.building === building.index && free(a),
			);
			if (own) return own;
		}
	}

	// "yard" is what the schema calls standing outside your own building; a doorstep
	// is the tile the door itself opens onto, and either will do for somebody who asked
	// to be outside their own front door.
	const wantedKind = npc.placement === "doorstep" ? "yard" : npc.placement;
	return anchors.find((a) => a.kind === wantedKind && free(a)) ?? anchors.find(free);
}

/** Roles that are still about after dark. */
const NIGHT_ROLES = /\b(guard|watch|innkeep|inn|sentry|warden|night|priest|toll)\b/i;

/**
 * Where one person is at each part of the day.
 *
 * Work in the working hours, the square in the evening, their own doorstep
 * overnight. Derived rather than simulated, and the single largest contributor to
 * a village reading as inhabited rather than as a diorama.
 *
 * Every bucket is filled for everybody, which was not true before: only nocturnal
 * roles had a `night` station and only nocturnal or early ones had `dawn`, so
 * between 23:00 and 07:00 almost every station was absent, `reindex` skipped
 * almost everybody, and a town had *nobody at all* in it. Measured on a
 * five-person town: five visible from 07:00 to 22:00, zero for the other eight
 * hours of the day. They were not indoors either — placement is in world
 * coordinates and an interior is its own space — so they were nowhere, and any
 * errand that needed a person could not be progressed for a third of the clock,
 * with nothing to tell the player that waiting would help.
 *
 * Keeping them on their doorstep overnight preserves the rhythm — the square
 * empties, the workday ends — without anyone ceasing to exist. It matches what
 * this class already accepts for the daytime: everybody stands outdoors, because
 * placing them inside needs a per-interior entity layer.
 */
function stationsFor(
	npc: NpcSpec,
	work: { x: number; y: number },
	plaza: Anchor | undefined,
): PlacedNpc["stations"] {
	const at = { x: work.x, y: work.y };

	// Somebody the story needs found. A schedule is atmosphere, and atmosphere that
	// moves the one person an errand names is an errand the player cannot finish
	// without learning the game's hours. The only way to say this used to be turning
	// the whole world's clock off, which costs a village its evening to pin one lord.
	if (npc.stays) {
		return {
			night: at,
			dawn: at,
			morning: at,
			afternoon: at,
			dusk: at,
			evening: at,
		};
	}

	const social = plaza ? { x: plaza.x, y: plaza.y } : at;
	const nocturnal = NIGHT_ROLES.test(npc.role);

	// Only two places are available to vary between — an NPC's own anchor and the
	// square — because that is all the geometry the generator gives. A separate home
	// distinct from a workplace is what would let this say more than it does.
	return {
		// A watchman is in the square at two in the morning; everyone else is home.
		night: nocturnal ? social : at,
		dawn: at,
		morning: at,
		afternoon: at,
		dusk: at,
		// The square at the end of the day, unless their work is the evening.
		evening: nocturnal ? at : social,
	};
}

/**
 * Anchors somebody may stand on.
 *
 * `doorstep` is deliberately absent: it is the sole approach to a door, so an
 * NPC parked there locks the building for good.
 */
const OUTDOOR: ReadonlySet<Anchor["kind"]> = new Set([
	"square",
	"well",
	"stall",
	"bench",
	"gate",
	"yard",
	// A doorstep is standable ground like any other. Whether *this* doorstep can be
	// stood on is a question about the door behind it, and `chokePoints` answers it.
	"doorstep",
]);
