import type { Rect, Vec2 } from "../../geom/vec.js";
import type { Lock } from "../../rules/lock.js";
import type { DecorId } from "../../tiles/decor.js";
import { T, type TerrainId, terrainDef } from "../../tiles/terrain.js";

export type AnchorKind =
	| "square"
	| "well"
	| "stall"
	| "bench"
	| "gate"
	| "doorstep"
	| "counter"
	| "hearth"
	| "backroom"
	| "yard";

export interface Anchor {
	readonly id: string;
	readonly kind: AnchorKind;
	readonly x: number;
	readonly y: number;
	/** Index into {@link FeaturePatch.buildings}, when the anchor is indoors. */
	readonly building?: number;
}

export type StructureKind =
	| "house"
	| "shop"
	| "inn"
	| "smithy"
	| "temple"
	| "barracks"
	| "tower"
	| "farmhouse"
	| "barn"
	| "warehouse"
	| "mill"
	| "stable"
	| "apothecary"
	| "ruin"
	| "shrine"
	/** A long room with benches and no altar: the civic building of a world with no church. */
	| "hall"
	/** The mouth of a cave. A "building" only in that you walk into it through a door. */
	| "cave";

export interface BuildingPlacement {
	readonly index: number;
	readonly kind: StructureKind;
	/** Outer footprint including walls, in world coordinates. */
	readonly rect: Rect;
	readonly door: Vec2;
	readonly signAt?: Vec2;
	/** Stable id for generating the interior on demand. */
	readonly interiorId: number;
	readonly name?: string;
	readonly signText?: string;
	/**
	 * What has to be true to get inside, if anything.
	 *
	 * Travels with the building rather than with its door tile, which is what makes
	 * it free to persist: the patch is regenerated from the spec, so a locked door in
	 * an evicted chunk comes back locked without anything having been written down.
	 */
	readonly lock?: Lock;
	/**
	 * Whether the spec insisted on this building.
	 *
	 * Carried on the placement rather than re-derived, because the two passes that must
	 * respect it — the demolition pass in `settlement.ts` and the `buildings-reachable`
	 * invariant — both see placements and not specs. Re-deriving it would mean matching
	 * a building back to a spec entry by name, which is exactly the fuzzy join this flag
	 * exists to avoid.
	 */
	readonly required?: boolean;
}

/**
 * A generated feature, in world coordinates but stored densely over its own
 * bounding box.
 *
 * The patch is the unit of order-independence. A settlement is generated once,
 * in its own frame, cached by site id, and then *clipped* into whichever chunks
 * it overlaps — so a town straddling a four-chunk corner is one town seen four
 * ways, not four partial towns that have to be reconciled. Terrain id 0 means
 * "this patch writes nothing here", which is what lets it be sparse in effect
 * while staying a dense array in memory.
 */
export interface FeaturePatch {
	readonly id: number;
	readonly bounds: Rect;
	readonly terrain: Uint16Array;
	readonly decor: Uint16Array;
	readonly flags: Uint8Array;
	readonly buildings: readonly BuildingPlacement[];
	readonly anchors: readonly Anchor[];
	/**
	 * Ids of structures the spec required that no plot could take.
	 *
	 * Empty for the builders that lay out their own buildings from their own rules — a
	 * castle's ward and a dock's row of sheds are not solved against a roster. For a
	 * settlement it is `assignPlots`'s own verdict, carried rather than discarded: it was
	 * computed and read by nothing, so the only evidence that the story's counting house had
	 * become a shack was the shack.
	 */
	readonly unplaced: readonly string[];
}

export function createPatch(
	id: number,
	bounds: Rect,
): {
	patch: FeaturePatch;
	buildings: BuildingPlacement[];
	anchors: Anchor[];
	unplaced: string[];
} {
	const size = bounds.w * bounds.h;
	const buildings: BuildingPlacement[] = [];
	const anchors: Anchor[] = [];
	const unplaced: string[] = [];
	return {
		patch: {
			id,
			bounds,
			terrain: new Uint16Array(size),
			decor: new Uint16Array(size),
			flags: new Uint8Array(size),
			buildings,
			anchors,
			unplaced,
		},
		buildings,
		anchors,
		unplaced,
	};
}

export function patchIndex(patch: FeaturePatch, x: number, y: number): number {
	const lx = x - patch.bounds.x;
	const ly = y - patch.bounds.y;
	if (lx < 0 || ly < 0 || lx >= patch.bounds.w || ly >= patch.bounds.h) return -1;
	return ly * patch.bounds.w + lx;
}

export function patchWrite(
	patch: FeaturePatch,
	x: number,
	y: number,
	terrain: TerrainId,
	extraFlags = 0,
): void {
	const i = patchIndex(patch, x, y);
	if (i < 0) return;
	patch.terrain[i] = terrain;
	patch.flags[i] = terrainDef(terrain).flags | extraFlags;
}

export function patchDecor(patch: FeaturePatch, x: number, y: number, decor: DecorId): void {
	const i = patchIndex(patch, x, y);
	if (i < 0) return;
	patch.decor[i] = decor;
}

export function patchTerrainAt(patch: FeaturePatch, x: number, y: number): TerrainId {
	const i = patchIndex(patch, x, y);
	return i < 0 ? T.void : (patch.terrain[i] ?? T.void);
}

export function patchWrites(patch: FeaturePatch, x: number, y: number): boolean {
	return patchTerrainAt(patch, x, y) !== T.void;
}
