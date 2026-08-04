import type { Rect, Vec2 } from "../../geom/vec.js";
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
	| "shrine";

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
}

export function createPatch(
	id: number,
	bounds: Rect,
): {
	patch: FeaturePatch;
	buildings: BuildingPlacement[];
	anchors: Anchor[];
} {
	const size = bounds.w * bounds.h;
	const buildings: BuildingPlacement[] = [];
	const anchors: Anchor[] = [];
	return {
		patch: {
			id,
			bounds,
			terrain: new Uint16Array(size),
			decor: new Uint16Array(size),
			flags: new Uint8Array(size),
			buildings,
			anchors,
		},
		buildings,
		anchors,
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
