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
	  }
	| {
			readonly kind: "site";
			readonly siteId: number;
			/** Which structure, by kind — `smithy`, `mill`. */
			readonly structure?: string;
			/** Which spot inside it. Defaults to any container in the room. */
			readonly anchor?: AnchorKind;
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
	readonly x: number;
	readonly y: number;
}

/** Key for the position index the probe reads, matching `lootKey`'s two cases. */
export function placementSlot(interiorId: number | undefined, x: number, y: number): string {
	return `${interiorId ?? "world"}:${x},${y}`;
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
		index.set(placementSlot(entry.interiorId, entry.x, entry.y), entry);
	}
	return index;
}
