import { DEFAULT_PACK } from "../core/content/default.js";
import type { ContentPack } from "../core/content/pack.js";
import { getInterior } from "../core/gen/features/interior.js";
import type { StructureKind } from "../core/gen/features/patch.js";
import { type Resident, residentsOf } from "../core/gen/features/residents.js";

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
export class InteriorPeople {
	private readonly cache = new Map<number, readonly Resident[]>();

	constructor(
		private readonly seed: number,
		private readonly pack: ContentPack = DEFAULT_PACK,
	) {}

	/** Everyone in one building. */
	in(interiorId: number, kind: string): readonly Resident[] {
		const known = this.cache.get(interiorId);
		if (known) return known;
		const interior = getInterior(this.seed, interiorId, kind as StructureKind);
		const people = residentsOf(this.seed, interiorId, kind as StructureKind, interior, this.pack);
		this.cache.set(interiorId, people);
		return people;
	}

	at(interiorId: number, kind: string, x: number, y: number): Resident | undefined {
		return this.in(interiorId, kind).find((resident) => resident.x === x && resident.y === y);
	}

	/**
	 * Resolve a resident by id.
	 *
	 * Needs the building to be known, because the id alone does not say what kind of
	 * interior it belongs to and the roster depends on the kind. In practice the only
	 * caller is a conversation the player is currently having, and they are standing
	 * in the room — so the caller always knows.
	 */
	byId(interiorId: number, kind: string, id: string): Resident | undefined {
		return this.in(interiorId, kind).find((resident) => resident.id === id);
	}

	clear(): void {
		this.cache.clear();
	}
}
