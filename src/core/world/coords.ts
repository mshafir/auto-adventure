/**
 * The world is one continuous integer plane. Chunks are a storage and
 * generation convenience laid over it, never a gameplay boundary: the player
 * crosses a chunk edge without a transition, a load, or a visible seam.
 */
export const CHUNK = 64;
export const CHUNK_AREA = CHUNK * CHUNK;

/** How many macro cells beyond a chunk are consulted when generating it. */
export const HALO = 2;

export interface ChunkCoord {
	readonly cx: number;
	readonly cy: number;
}

export type ChunkKey = string;

export function chunkKey(cx: number, cy: number): ChunkKey {
	return `${cx},${cy}`;
}

export function parseChunkKey(key: ChunkKey): ChunkCoord {
	const comma = key.indexOf(",");
	return { cx: Number(key.slice(0, comma)), cy: Number(key.slice(comma + 1)) };
}

/**
 * Chunk containing a world coordinate. `Math.floor` rather than a shift or a
 * truncating divide, because world coordinates are signed and truncation would
 * fold -1 and 0 into the same chunk.
 */
export function toChunkX(worldX: number): number {
	return Math.floor(worldX / CHUNK);
}

export function toChunkY(worldY: number): number {
	return Math.floor(worldY / CHUNK);
}

export function toChunk(worldX: number, worldY: number): ChunkCoord {
	return { cx: toChunkX(worldX), cy: toChunkY(worldY) };
}

/** Position within a chunk, always in `[0, CHUNK)` even for negative worlds. */
export function toLocalX(worldX: number): number {
	return worldX - Math.floor(worldX / CHUNK) * CHUNK;
}

export function toLocalY(worldY: number): number {
	return worldY - Math.floor(worldY / CHUNK) * CHUNK;
}

export function localIndex(localX: number, localY: number): number {
	return localY * CHUNK + localX;
}

/** Index into a chunk's arrays for a world coordinate. */
export function worldToIndex(worldX: number, worldY: number): number {
	return localIndex(toLocalX(worldX), toLocalY(worldY));
}

export function chunkOriginX(cx: number): number {
	return cx * CHUNK;
}

export function chunkOriginY(cy: number): number {
	return cy * CHUNK;
}

export function chunkBounds(cc: ChunkCoord) {
	return { x: cc.cx * CHUNK, y: cc.cy * CHUNK, w: CHUNK, h: CHUNK };
}

/** Chunk rectangle grown by `margin` tiles on every side. */
export function chunkBoundsWithMargin(cc: ChunkCoord, margin: number) {
	return {
		x: cc.cx * CHUNK - margin,
		y: cc.cy * CHUNK - margin,
		w: CHUNK + margin * 2,
		h: CHUNK + margin * 2,
	};
}

export function chunksInRadius(centre: ChunkCoord, radius: number): ChunkCoord[] {
	const out: ChunkCoord[] = [];
	for (let dy = -radius; dy <= radius; dy++) {
		for (let dx = -radius; dx <= radius; dx++) {
			out.push({ cx: centre.cx + dx, cy: centre.cy + dy });
		}
	}
	return out;
}
