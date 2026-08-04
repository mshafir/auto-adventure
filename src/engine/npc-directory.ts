import type { Anchor, BuildingPlacement } from "../core/gen/features/patch.js";
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
	private bucket: TimeOfDay = "morning";
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
		if (!this.roster.delete(siteId)) return;
		this.revision++;
		this.reindex();
	}

	forgetAll(): void {
		this.roster.clear();
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

	/** Place everyone belonging to the sites reaching a chunk. */
	populate(sites: readonly MacroSite[]): void {
		let added = false;
		for (const site of sites) {
			if (this.roster.has(site.id)) continue;
			const spec = this.specFor(site.id);
			if (!spec) continue;
			this.roster.set(site.id, this.place(site, spec));
			added = true;
		}
		if (!added) return;
		this.revision++;
		this.reindex();
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
			if (found) return found;
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
		const taken = this.occupied();
		const placed: PlacedNpc[] = [];

		const plaza = anchors.filter(
			(a) => a.kind === "bench" || a.kind === "stall" || a.kind === "well",
		);

		for (const npc of spec.npcs) {
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

	/** Everyone belonging to a site, whether or not they are outdoors right now. */
	atSite(siteId: number): readonly PlacedNpc[] {
		return this.roster.get(siteId) ?? [];
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
 * Never a doorstep. That tile is the only one a door can be entered from, since
 * the other three neighbours are its own wall, so somebody standing there seals
 * the building. It looked entirely reasonable on screen — a shopkeeper waiting
 * outside their shop — and in one measured village it made every door in the
 * place unusable at every hour of the day.
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

	// "yard" is what the schema calls standing outside your own building, and it
	// is now a real anchor rather than an alias for the doorway.
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
]);
