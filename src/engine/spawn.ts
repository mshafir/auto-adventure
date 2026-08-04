import { generateChunk } from "../core/gen/pipeline.js";
import { TFlag } from "../core/tiles/flags.js";
import { CHUNK, type ChunkCoord } from "../core/world/coords.js";
import { isSettlement, sitesAround } from "../core/world/macro.js";

/**
 * Choose where a new game begins.
 *
 * Spawning at the origin is not safe in an infinite procedural world: the
 * origin can land in open ocean or inside a mountain. This walks outward in a
 * spiral looking for standable ground, preferring somewhere near a settlement
 * so a new player has something to walk toward.
 */
export function findSpawn(seed: number, maxRadius = 12): { x: number; y: number } {
	for (let radius = 0; radius <= maxRadius; radius++) {
		for (const cc of ring(radius)) {
			// Prefer chunks whose halo contains a settlement, so the opening view
			// has a road or a village in it rather than empty moor.
			const settled = sitesAround(seed, cc.cx, cc.cy, 1).some((s) => isSettlement(s.kind));
			if (radius > 0 && !settled) continue;

			const spot = standableIn(seed, cc);
			if (spot) return spot;
		}
	}

	// Every candidate was unusable, which should be impossible; fall back to the
	// origin chunk and accept whatever is there rather than looping forever.
	return standableIn(seed, { cx: 0, cy: 0 }) ?? { x: 0, y: 0 };
}

function* ring(radius: number): Generator<ChunkCoord> {
	if (radius === 0) {
		yield { cx: 0, cy: 0 };
		return;
	}
	for (let d = -radius; d <= radius; d++) {
		yield { cx: d, cy: -radius };
		yield { cx: d, cy: radius };
		yield { cx: -radius, cy: d };
		yield { cx: radius, cy: d };
	}
}

function standableIn(seed: number, cc: ChunkCoord): { x: number; y: number } | undefined {
	const { chunk } = generateChunk({ seed }, cc);
	const centre = CHUNK / 2;

	let best: { x: number; y: number; distance: number } | undefined;
	for (let ly = 0; ly < CHUNK; ly++) {
		for (let lx = 0; lx < CHUNK; lx++) {
			const flags = chunk.flags[ly * CHUNK + lx] ?? 0;
			if (!(flags & TFlag.Passable)) continue;
			// Standing on a road is the friendliest possible start: it is walkable
			// by construction and it leads somewhere.
			const bonus = flags & TFlag.Road ? -24 : 0;
			const distance = Math.hypot(lx - centre, ly - centre) + bonus;
			if (!best || distance < best.distance) {
				best = { x: cc.cx * CHUNK + lx, y: cc.cy * CHUNK + ly, distance };
			}
		}
	}

	return best ? { x: best.x, y: best.y } : undefined;
}
