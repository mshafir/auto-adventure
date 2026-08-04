import { rasterizePolyline } from "../geom/line.js";
import { CHUNK, type ChunkCoord } from "../world/coords.js";
import { type River, riverWidth } from "../world/rivers.js";
import type { Road } from "../world/roads.js";

/** Margin around the chunk, wide enough for the widest brush plus a bank. */
export const MASK_MARGIN = 8;
export const MASK_SIZE = CHUNK + MASK_MARGIN * 2;

export const MASK_NONE = 0;
export const MASK_MINOR = 1;
export const MASK_MAJOR = 2;
// Ordered so that "keep the larger value" resolves overlaps correctly: a river
// channel outranks its own bank without needing a second normalising pass.
export const MASK_BANK = 1;
export const MASK_CHANNEL = 2;

/**
 * Linear features rasterised into a local grid.
 *
 * The obvious implementation tests every tile against every polyline segment,
 * which is O(tiles x segments) — 4096 tiles against a few hundred road segments
 * per chunk. Stamping each feature once into a mask makes the per-tile lookup
 * O(1) and moves the cost to be proportional to the feature length instead of
 * the chunk area.
 *
 * Determinism is unaffected: the stamp is driven by the same world-space
 * polyline both neighbouring chunks compute, merely clipped differently.
 */
export interface FeatureMasks {
	readonly roads: Uint8Array;
	readonly rivers: Uint8Array;
}

function maskIndex(localX: number, localY: number): number {
	return (localY + MASK_MARGIN) * MASK_SIZE + (localX + MASK_MARGIN);
}

export function maskAt(mask: Uint8Array, localX: number, localY: number): number {
	if (
		localX < -MASK_MARGIN ||
		localY < -MASK_MARGIN ||
		localX >= CHUNK + MASK_MARGIN ||
		localY >= CHUNK + MASK_MARGIN
	) {
		return MASK_NONE;
	}
	return mask[maskIndex(localX, localY)] ?? MASK_NONE;
}

/** Paint a filled disc, keeping the strongest value already present. */
function stamp(
	mask: Uint8Array,
	originX: number,
	originY: number,
	worldX: number,
	worldY: number,
	radius: number,
	value: number,
): void {
	const r = Math.max(0, Math.floor(radius));
	const r2 = radius * radius;
	const lx = worldX - originX;
	const ly = worldY - originY;
	for (let dy = -r; dy <= r; dy++) {
		for (let dx = -r; dx <= r; dx++) {
			if (dx * dx + dy * dy > r2) continue;
			const px = lx + dx;
			const py = ly + dy;
			if (
				px < -MASK_MARGIN ||
				py < -MASK_MARGIN ||
				px >= CHUNK + MASK_MARGIN ||
				py >= CHUNK + MASK_MARGIN
			) {
				continue;
			}
			const i = maskIndex(px, py);
			if ((mask[i] ?? 0) < value) mask[i] = value;
		}
	}
}

export function buildFeatureMasks(
	cc: ChunkCoord,
	roads: readonly Road[],
	rivers: readonly River[],
): FeatureMasks {
	const originX = cc.cx * CHUNK;
	const originY = cc.cy * CHUNK;
	const roadMask = new Uint8Array(MASK_SIZE * MASK_SIZE);
	const riverMask = new Uint8Array(MASK_SIZE * MASK_SIZE);

	const minX = originX - MASK_MARGIN;
	const minY = originY - MASK_MARGIN;
	const maxX = originX + CHUNK + MASK_MARGIN;
	const maxY = originY + CHUNK + MASK_MARGIN;

	for (const road of roads) {
		const value = road.major ? MASK_MAJOR : MASK_MINOR;
		// A highway is three tiles across and a track two. Wider than this and a
		// road stops reading as a route through the landscape and starts reading
		// as a clearing.
		const radius = road.major ? 1.6 : 1.05;
		for (const p of rasterizePolyline(road.points)) {
			// Skip points that cannot reach the mask before doing disc work.
			if (p.x < minX - 3 || p.x > maxX + 3 || p.y < minY - 3 || p.y > maxY + 3) continue;
			stamp(roadMask, originX, originY, p.x, p.y, radius, value);
		}
	}

	for (const river of rivers) {
		const half = riverWidth(river.flow);
		for (const p of rasterizePolyline(river.points)) {
			if (p.x < minX - half - 3 || p.x > maxX + half + 3) continue;
			if (p.y < minY - half - 3 || p.y > maxY + half + 3) continue;
			stamp(riverMask, originX, originY, p.x, p.y, half + 2, MASK_BANK);
			stamp(riverMask, originX, originY, p.x, p.y, half, MASK_CHANNEL);
		}
	}

	return { roads: roadMask, rivers: riverMask };
}
