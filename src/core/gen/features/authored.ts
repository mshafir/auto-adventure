import type { TerraformEdit } from "../../../scenario/terraform.js";
import { bresenham } from "../../geom/line.js";
import type { Rect, Vec2 } from "../../geom/vec.js";
import { T, type TerrainId } from "../../tiles/terrain.js";

/**
 * Ground an author asked for, over ground the generator produced.
 *
 * Deliberately a flat map from world position to terrain rather than a list of shapes.
 * Two edits that overlap have to resolve to one tile, and the only rule an author can
 * predict is that the later one wins — so the rasterisation happens once, up front, and
 * that rule belongs to the data rather than to whatever reads it.
 *
 * Rasterised by the chunk manager rather than per chunk, because a world with a road across
 * it would otherwise re-rasterise the whole road for every chunk it crosses.
 */
export function authoredTiles(edits: readonly TerraformEdit[]): Map<string, TerrainId> {
	const tiles = new Map<string, TerrainId>();
	for (const edit of edits) {
		switch (edit.t) {
			case "Path": {
				const terrain = SURFACES[edit.surface];
				// A square brush, not a perpendicular one. Perpendicular is what a road really
				// wants, but it needs a direction per segment and leaves gaps at the corners of a
				// stepped diagonal, so a wide diagonal road would come out perforated. The cost is
				// that a wide path fans one tile past each end.
				const half = Math.floor(((edit.width ?? 1) - 1) / 2);
				for (const point of walkable(edit.from, edit.to)) {
					for (let dy = -half; dy <= half; dy++) {
						for (let dx = -half; dx <= half; dx++) {
							tiles.set(key(point.x + dx, point.y + dy), terrain);
						}
					}
				}
				break;
			}
			case "Bridge":
				for (const point of walkable(edit.from, edit.to)) {
					tiles.set(key(point.x, point.y), T.bridge);
				}
				break;
			case "Clearing":
				// A disc rather than a square, and by Manhattan distance rather than Euclidean:
				// movement is four-directional, so that is the shape a player experiences as round.
				for (let dy = -edit.radius; dy <= edit.radius; dy++) {
					for (let dx = -edit.radius; dx <= edit.radius; dx++) {
						if (Math.abs(dx) + Math.abs(dy) > edit.radius) continue;
						tiles.set(key(edit.at.x + dx, edit.at.y + dy), T.grass);
					}
				}
				break;
		}
	}
	return tiles;
}

export function key(x: number, y: number): string {
	return `${x},${y}`;
}

/**
 * A line the player can actually walk.
 *
 * Bresenham gives the visually straightest line, which for a diagonal is a staircase of
 * *diagonal* steps — and movement is four-directional, so such a path is a row of tiles
 * touching only at their corners: a road that looks like a road and cannot be walked down.
 * Every diagonal step is therefore expanded into two orthogonal ones.
 */
function walkable(from: Vec2, to: Vec2): Vec2[] {
	const out: Vec2[] = [];
	for (const point of bresenham(from.x, from.y, to.x, to.y)) {
		const last = out[out.length - 1];
		if (last && last.x !== point.x && last.y !== point.y) out.push({ x: point.x, y: last.y });
		out.push(point);
	}
	return out;
}

const SURFACES: Readonly<Record<"path" | "dirt" | "cobble", TerrainId>> = {
	path: T.path,
	dirt: T.dirtRoad,
	cobble: T.cobbleRoad,
};

/**
 * The rectangle a set of edits touches, for invalidating chunks when a phase changes them.
 *
 * Undefined for no edits, which is the common case — most phases change no ground at all —
 * and lets the caller skip the work rather than invalidating an empty rectangle.
 */
export function terraformBounds(edits: readonly TerraformEdit[]): Rect | undefined {
	const tiles = authoredTiles(edits);
	if (tiles.size === 0) return undefined;
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const at of tiles.keys()) {
		const comma = at.indexOf(",");
		const x = Number(at.slice(0, comma));
		const y = Number(at.slice(comma + 1));
		minX = Math.min(minX, x);
		minY = Math.min(minY, y);
		maxX = Math.max(maxX, x);
		maxY = Math.max(maxY, y);
	}
	return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}
