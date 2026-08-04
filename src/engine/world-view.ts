import { variantAt } from "../core/rand/blue-noise.js";
import type { Chunk } from "../core/tiles/chunk.js";
import { D, type DecorId } from "../core/tiles/decor.js";
import { TFlag } from "../core/tiles/flags.js";
import { T, type TerrainId } from "../core/tiles/terrain.js";
import { CHUNK, toChunkX, toChunkY, toLocalX, toLocalY } from "../core/world/coords.js";

export interface ChunkProvider {
	readonly seed: number;
	/** Returns the chunk if it is resident; `undefined` if it is not yet built. */
	chunkAt(cx: number, cy: number): Chunk | undefined;
}

/**
 * A single stitched read surface over the chunk grid, addressed in world
 * coordinates.
 *
 * Everything above this line — rendering, collision, field of view, autotiling
 * — works in world coordinates and never learns that chunks exist. That is what
 * makes the chunk grid a storage detail rather than a gameplay boundary, and it
 * is also what lets autotile masks be computed at render time across a chunk
 * edge: the neighbour lookup simply resolves into a different chunk.
 */
export interface WorldView {
	terrainAt(x: number, y: number): TerrainId;
	decorAt(x: number, y: number): DecorId;
	flagsAt(x: number, y: number): number;
	variantAt(x: number, y: number): number;
	/**
	 * Quantised terrain height, 0..255, or `-1` where the chunk is not resident.
	 *
	 * The sentinel matters: treating an absent neighbour as height 0 would make
	 * the whole load frontier read as a cliff, drawing a dark seam exactly where
	 * the point of the chunk grid is that there is no seam.
	 */
	elevationAt(x: number, y: number): number;
	isPassable(x: number, y: number): boolean;
	blocksSight(x: number, y: number): boolean;
	/** True when the chunk covering this position has not been generated yet. */
	isLoaded(x: number, y: number): boolean;
}

export function createWorldView(provider: ChunkProvider): WorldView {
	// Chunk lookups are extremely repetitive during a render pass — a whole row
	// of the viewport usually lives in one or two chunks — so remember the last
	// one rather than recomputing the division and map lookup per tile.
	let lastCx = Number.NaN;
	let lastCy = Number.NaN;
	let lastChunk: Chunk | undefined;

	const resolve = (x: number, y: number): Chunk | undefined => {
		const cx = toChunkX(x);
		const cy = toChunkY(y);
		if (cx !== lastCx || cy !== lastCy) {
			lastCx = cx;
			lastCy = cy;
			lastChunk = provider.chunkAt(cx, cy);
		}
		return lastChunk;
	};

	const indexOf = (x: number, y: number) => toLocalY(y) * CHUNK + toLocalX(x);

	return {
		terrainAt(x, y) {
			const chunk = resolve(x, y);
			return chunk ? (chunk.terrain[indexOf(x, y)] ?? T.void) : T.void;
		},
		decorAt(x, y) {
			const chunk = resolve(x, y);
			return chunk ? (chunk.decor[indexOf(x, y)] ?? D.none) : D.none;
		},
		flagsAt(x, y) {
			const chunk = resolve(x, y);
			return chunk ? (chunk.flags[indexOf(x, y)] ?? 0) : 0;
		},
		variantAt(x, y) {
			const chunk = resolve(x, y);
			// Fall back to the pure function so ungenerated ground still has
			// stable texture instead of flickering when the chunk arrives.
			return chunk ? (chunk.variant[indexOf(x, y)] ?? 0) : variantAt(provider.seed, x, y);
		},
		elevationAt(x, y) {
			const chunk = resolve(x, y);
			return chunk ? (chunk.elevation[indexOf(x, y)] ?? -1) : -1;
		},
		isPassable(x, y) {
			const chunk = resolve(x, y);
			// Ungenerated ground is impassable: the player must never walk off
			// the edge of what exists and end up somewhere unrecoverable.
			if (!chunk) return false;
			return ((chunk.flags[indexOf(x, y)] ?? 0) & TFlag.Passable) !== 0;
		},
		blocksSight(x, y) {
			const chunk = resolve(x, y);
			if (!chunk) return true;
			return ((chunk.flags[indexOf(x, y)] ?? 0) & TFlag.BlocksSight) !== 0;
		},
		isLoaded(x, y) {
			return resolve(x, y) !== undefined;
		},
	};
}
