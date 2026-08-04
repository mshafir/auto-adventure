import { fbm2, unit } from "../rand/noise.js";
import { streamId } from "../rand/rng.js";
import { T, type TerrainId } from "../tiles/terrain.js";

/**
 * The edge of a bounded world.
 *
 * A pre-generated scenario is a bounded map rather than a slice of an infinite
 * world: the story has to know where it ends, and validation needs a closed
 * region to reason about. Everything outside the interior rectangle is
 * impassable, so there is nothing beyond the edge to reach and no need to
 * generate it.
 *
 * There is deliberately no `Boundary` tile flag. The flags byte is fully
 * allocated and `flags.ts` asks that new state be derived from terrain where it
 * can be, so the band is made of terrain that is already impassable. That also
 * makes it unbreakable for free: the rewrite removed runtime wall-breaking
 * outright, so nothing in the game mutates terrain for passability.
 */

/**
 * What the edge is made of.
 *
 * Three, not more, because these are the impassable terrains the tile set
 * actually has. A style the renderer cannot express is not a style.
 */
export type BoundaryStyle = "ocean" | "cliffs" | "mountains";

export interface WorldBounds {
	readonly minX: number;
	readonly minY: number;
	readonly maxX: number;
	readonly maxY: number;
	readonly style: BoundaryStyle;
	/**
	 * How far the band may wobble inward from the nominal edge, in tiles.
	 *
	 * It does not set how *deep* the band is — outward it is unbounded, because
	 * every tile beyond the rectangle is boundary. It sets how ragged the inner
	 * edge is, which is the difference between a coastline and a drawn rectangle.
	 */
	readonly thickness: number;
}

const BOUNDARY_STREAM = streamId("bounds");

/** Wobble scale in world units. Wide enough to read as landform, not as noise. */
const WOBBLE_SCALE = 24;

export function boundaryTerrain(style: BoundaryStyle): TerrainId {
	switch (style) {
		case "ocean":
			// Deep, not shallow: shallow water is passable and would be a way out.
			return T.deepWater;
		case "cliffs":
			return T.cliff;
		case "mountains":
			return T.mountain;
	}
}

/** Tiles from the nominal edge. Negative outside the rectangle. */
function edgeDistance(bounds: WorldBounds, x: number, y: number): number {
	return Math.min(x - bounds.minX, bounds.maxX - x, y - bounds.minY, bounds.maxY - y);
}

/**
 * Whether this tile is part of the impassable edge.
 *
 * The band starts at the rectangle and reaches inward by a noise-driven amount,
 * so the inner edge wanders. It cannot develop a gap: everything outside the
 * rectangle has a negative edge distance and the intrusion is never negative, so
 * the ring is closed by construction rather than by inspection.
 */
export function isBoundary(seed: number, bounds: WorldBounds, x: number, y: number): boolean {
	const distance = edgeDistance(bounds, x, y);
	if (distance < 0) return true;
	if (distance >= bounds.thickness) return false;
	const wobble = unit(fbm2(seed ^ BOUNDARY_STREAM, x, y, { octaves: 2, scale: WOBBLE_SCALE }));
	return distance < wobble * bounds.thickness;
}

/**
 * Whether a position is playable whatever the wobble does.
 *
 * The authoring pass places sites against this rather than against the rectangle:
 * a town whose footprint reached into the band would be half clipped into a cliff
 * face, and which half would depend on the noise.
 */
export function isWellInside(bounds: WorldBounds, x: number, y: number): boolean {
	return edgeDistance(bounds, x, y) >= bounds.thickness;
}

/** The playable rectangle, with the wobble margin already removed. */
export function safeInterior(bounds: WorldBounds): {
	readonly minX: number;
	readonly minY: number;
	readonly maxX: number;
	readonly maxY: number;
} {
	return {
		minX: bounds.minX + bounds.thickness,
		minY: bounds.minY + bounds.thickness,
		maxX: bounds.maxX - bounds.thickness,
		maxY: bounds.maxY - bounds.thickness,
	};
}

export interface BoundsAroundOptions {
	readonly style?: BoundaryStyle;
	readonly thickness?: number;
}

/** A square bound centred on a position, sized in tiles. */
export function boundsAround(
	centre: { readonly x: number; readonly y: number },
	radiusTiles: number,
	options: BoundsAroundOptions = {},
): WorldBounds {
	return {
		minX: centre.x - radiusTiles,
		minY: centre.y - radiusTiles,
		maxX: centre.x + radiusTiles,
		maxY: centre.y + radiusTiles,
		style: options.style ?? "mountains",
		thickness: options.thickness ?? 8,
	};
}
