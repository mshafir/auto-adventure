import { DEFAULT_PACK } from "../core/content/default.js";
import type { ContentPack } from "../core/content/pack.js";
import { getInterior, type Interior } from "../core/gen/features/interior.js";
import type { StructureKind } from "../core/gen/features/patch.js";
import { type Resident, residentsOf, standingRoom } from "../core/gen/features/residents.js";
import type { NpcSpec } from "../core/world/spec.js";

/**
 * The people inside buildings, kept apart from the people outside them.
 *
 * A separate index from `NpcDirectory` because the coordinates mean different
 * things. Outdoors a position is a world tile; indoors it is local to one interior,
 * so `(6, 7)` is a different place in every building in the game. Merging the two
 * into one spatial map would work right up until a town near the world origin, where
 * a kitchen tile and a street tile collide — and the symptom would be a shopkeeper
 * appearing in somebody's hallway.
 *
 * Cached rather than stored. Residents are pure in `(seed, interiorId, kind)`, so
 * dropping the cache costs a regeneration and changes nothing the player can see;
 * persisting them would put thirty people per town into every save for no gain.
 * Their memory records *are* persisted, under ids that survive this cache, which is
 * the part that has to be stable.
 */
/**
 * Somebody a scenario put in this room, with the id they already have.
 *
 * The id is `npc:<siteId>:<slot>` — the one they would have had standing in the street
 * — and keeping it is the whole reason an indoor beat needs no new beat machinery.
 */
export interface AuthoredResident {
	readonly id: string;
	readonly spec: NpcSpec;
}

export class InteriorPeople {
	private readonly cache = new Map<string, readonly Resident[]>();

	constructor(
		private readonly seed: number,
		private readonly pack: ContentPack = DEFAULT_PACK,
		/**
		 * The scenario's own people for a room, if any.
		 *
		 * A callback rather than a table, because working out which building an interior
		 * id belongs to means asking the resident chunks — which only the engine can do,
		 * and only while the player is near enough for the answer to matter. Absent in a
		 * procedural or live world, where nobody has been authored indoors.
		 */
		private readonly authored?: (interiorId: number, level: number) => readonly AuthoredResident[],
		/**
		 * Tiles the household must leave clear.
		 *
		 * The way up to an authored item. A container cannot be stood on, so nobody can
		 * sit on the chest itself — but somebody parked on the one tile you could have
		 * searched it from seals it in just as completely, and the symptom is an errand
		 * that cannot be finished with nothing on screen to say why.
		 */
		private readonly reserved?: (
			interiorId: number,
			level: number,
		) => readonly { readonly x: number; readonly y: number }[],
	) {}

	/**
	 * Forget everything, so a changed cast is re-derived.
	 *
	 * Authored people are gated on the story, so the roster of a room is not fixed the
	 * way a household is — someone can arrive between two visits.
	 */
	invalidate(interiorId: number): void {
		for (const key of [...this.cache.keys()]) {
			if (key.startsWith(`${interiorId}:`)) this.cache.delete(key);
		}
	}

	/**
	 * Everyone on one storey of one building.
	 *
	 * Keyed by level as well as by building, which it was not: a resident's position is
	 * local to a *grid*, and an interior with three levels is three grids that happen to
	 * share an id. Ignoring the level drew the ground floor's cook on every storey of
	 * the inn and in every chamber of a cave, at the coordinates of a room the player
	 * had already left.
	 */
	in(interiorId: number, kind: string, level = 0): readonly Resident[] {
		const key = `${interiorId}:${level}`;
		const known = this.cache.get(key);
		if (known) return known;
		const interior = getInterior(this.seed, interiorId, kind as StructureKind, level);

		// The scenario's own people take their places first, so the household fills in
		// around them rather than a cook being generated onto the lady's chair.
		const taken = new Set<string>();
		for (const tile of this.reserved?.(interiorId, level) ?? []) taken.add(`${tile.x},${tile.y}`);
		const spots = byTheFire(
			interior,
			standingRoom(interior).filter((spot) => !taken.has(`${spot.x},${spot.y}`)),
		);
		const named: Resident[] = [];
		for (const [index, person] of (this.authored?.(interiorId, level) ?? []).entries()) {
			const spot = spots[index];
			if (!spot) break;
			taken.add(`${spot.x},${spot.y}`);
			named.push({
				id: person.id,
				name: person.spec.name,
				role: person.spec.role,
				glyph: person.spec.glyph,
				x: spot.x,
				y: spot.y,
				spec: person.spec,
			});
		}

		const people = [
			...named,
			...residentsOf(this.seed, interiorId, kind as StructureKind, interior, this.pack, taken),
		];
		this.cache.set(key, people);
		return people;
	}

	at(interiorId: number, kind: string, x: number, y: number, level = 0): Resident | undefined {
		return this.in(interiorId, kind, level).find(
			(resident) => resident.x === x && resident.y === y,
		);
	}

	/**
	 * Resolve a resident by id.
	 *
	 * Needs the building to be known, because the id alone does not say what kind of
	 * interior it belongs to and the roster depends on the kind. In practice the only
	 * caller is a conversation the player is currently having, and they are standing
	 * in the room — so the caller always knows.
	 */
	byId(interiorId: number, kind: string, id: string, level = 0): Resident | undefined {
		return this.in(interiorId, kind, level).find((resident) => resident.id === id);
	}

	clear(): void {
		this.cache.clear();
	}
}

/**
 * Standing room, nearest the hearth first.
 *
 * Authored people are placed off the front of this list, so where they end up is the
 * difference between a scene and a floor plan. Row-major order put the Lady of
 * Hautdesert in the top-left corner of her own bower while her first line invited the
 * player to sit down by the fire — the room was right, the blocking was nonsense.
 *
 * The hearth when there is one, because that is where a room's life is; failing that
 * the first anchor the interior declares — a counter, an altar, a bed — which is the
 * same thing for rooms built round something other than a fire. Failing both, the
 * order is left exactly as it was: nothing to prefer, so nothing to change.
 */
function byTheFire(
	interior: Interior,
	spots: readonly { x: number; y: number }[],
): { x: number; y: number }[] {
	const focus = interior.anchors.find((anchor) => anchor.kind === "hearth") ?? interior.anchors[0];
	if (!focus) return [...spots];
	return [...spots].sort(
		(a, b) => Math.hypot(a.x - focus.x, a.y - focus.y) - Math.hypot(b.x - focus.x, b.y - focus.y),
	);
}
