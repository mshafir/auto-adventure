import type { AnchorKind } from "../gen/features/patch.js";
import type { Condition } from "./condition.js";

/**
 * A particular thing, in a particular place.
 *
 * The generator can already put items in the world — `containerContents` fills
 * every crate and `forageAt` every patch of crops — but only *typical* items: what
 * a mill keeps, what a hedgerow yields. There was no way to say "the ledger is in
 * the chest in the mill", which is the one sentence most stories are built out of.
 *
 * Implemented inside the search gesture rather than beside it. The player already
 * has one verb for "look in this thing", the engine already resolves what a tile
 * holds through one probe, and taking-once is already recorded by one flag keyed on
 * position. A placement is consulted *first* in that same path, so an authored item
 * inherits the whole of it: it can be the target of a `have` objective, it survives
 * the chunk being evicted, and searching the same chest twice says it is empty
 * rather than handing over a second ledger.
 */
export interface Placement {
	/** Stable id, for the validator to name and for the journal to reference. */
	readonly id: string;
	readonly at: PlacementSite;
	readonly item: {
		readonly name: string;
		readonly description: string;
		readonly quantity?: number;
	};
	/**
	 * What has to be true for it to be there at all.
	 *
	 * Absent means always. Present is how a thing appears somewhere only once the
	 * story has moved — the body is in the millrace *after* the flood, and searching
	 * the millrace before it reports nothing rather than nothing-yet.
	 */
	readonly requires?: Condition;
	/**
	 * Draw a mark on the tile, so the player has a reason to search it.
	 *
	 * Off by default: most placements belong inside a container the player would
	 * open anyway, and marking those would give away which crate in the warehouse
	 * matters. On for a thing lying in the open, which is otherwise invisible.
	 */
	readonly showDecor?: boolean;
	/** Replaces "there is nothing here" once it has been taken. */
	readonly emptyText?: string;
}

/**
 * Where a placement is.
 *
 * Three spellings, in descending order of how much the author has to know. A world
 * tile is exact and needs the map open in front of you. An interior position needs
 * an interior id, which only the survey tool prints. A site-and-anchor is the one an
 * author can write from the story alone — "in the chest in the smithy" — and is
 * resolved against the real generated settlement when the world opens, which is
 * also where it can be reported as unresolvable rather than silently missing.
 */
export type PlacementSite =
	| { readonly kind: "world"; readonly x: number; readonly y: number }
	| {
			readonly kind: "interior";
			readonly interiorId: number;
			readonly x: number;
			readonly y: number;
			/**
			 * Which storey. Absent is the ground floor.
			 *
			 * Without this a building with three levels is three grids sharing one id, so
			 * one placement appeared at the same coordinates on *every* one of them — and
			 * the only reachable half of a cave was the mouth, because nothing could be put
			 * anywhere else.
			 */
			readonly level?: number;
	  }
	| {
			readonly kind: "site";
			readonly siteId: number;
			/** Which structure, by name — or failing that by kind: `smithy`, `mill`. */
			readonly structure?: string;
			/** Which spot inside it. Defaults to any container in the room. */
			readonly anchor?: AnchorKind;
			/** Which storey of it. Absent is the ground floor. */
			readonly level?: number;
	  };

/**
 * A placement resolved to a definite tile.
 *
 * The `site` spelling needs the generated world to become one of the other two, so
 * resolution happens once when the world is opened and the result is what the
 * reducer's probe consults. Keeping the resolved form separate means an
 * unresolvable placement is a finding at load time rather than an item that is
 * quietly nowhere.
 */
export interface ResolvedPlacement {
	readonly id: string;
	readonly placement: Placement;
	/** Absent for a world tile; present for an interior position. */
	readonly interiorId?: number;
	/** Which storey of that interior. Absent is the ground floor. */
	readonly level?: number;
	readonly x: number;
	readonly y: number;
}

/**
 * Key for the position index the probe reads, matching `lootKey`'s cases.
 *
 * The ground floor keeps the key it always had, exactly as `lootKey` does — a save
 * records what has been taken under these, so changing one would hand back an item the
 * player had already picked up. Anything above it is a distinct grid that happens to
 * share coordinates, and sharing the key meant an item on the ground floor was also
 * lying at the same spot two storeys down.
 */
export function placementSlot(
	interiorId: number | undefined,
	x: number,
	y: number,
	level = 0,
): string {
	const floor = level === 0 ? "" : `:${level}`;
	return `${interiorId ?? "world"}${floor}:${x},${y}`;
}

/**
 * The flag recording that an authored item has been picked up.
 *
 * Keyed on the placement's own id rather than on the tile it happens to sit on, which
 * is a correction of two silent failures and not a tidy-up.
 *
 * The first: a placement gated on the story shares its tile with whatever the
 * generator put there. Under a positional key, a player who searched the shelf in the
 * Lady's bower *before* she offered the girdle emptied it — and when the girdle
 * appeared in that shelf a minute later, the flag saying "you have been through this"
 * was already set. The errand became unfinishable, in a room the quest log was
 * pointing at, with prose about folded linen where the item should have been.
 *
 * The second: a positional key is only stable while the resolver keeps choosing the
 * same tile. It does not — the axe at Camelot moved when the resolver learned to
 * prefer a container the player could actually reach — and a save carrying the old
 * tile's flag then applied it to whatever else landed there.
 *
 * The cost is one-time and small: a save that took an authored item under the old key
 * may offer it once more. An item that comes back is a curiosity; an item that can
 * never be picked up ends the story.
 */
export function takenKey(placementId: string): string {
	return `taken:${placementId}`;
}

/**
 * Index resolved placements by the tile they sit on.
 *
 * A map rather than a list because the probe runs on every interact, and because
 * two placements on one tile is an authoring error worth being able to see: the
 * later one wins, deterministically, and the validator reports the collision.
 */
export function placementIndex(
	resolved: readonly ResolvedPlacement[],
): Map<string, ResolvedPlacement> {
	const index = new Map<string, ResolvedPlacement>();
	for (const entry of resolved) {
		index.set(placementSlot(entry.interiorId, entry.x, entry.y, entry.level), entry);
	}
	return index;
}
