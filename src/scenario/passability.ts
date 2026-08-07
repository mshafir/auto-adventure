import type { SettlementSpec } from "../core/gen/features/settlement.js";
import { generateChunk } from "../core/gen/pipeline.js";
import { findPath } from "../core/geom/astar.js";
import { TFlag } from "../core/tiles/flags.js";
import type { TerrainId } from "../core/tiles/terrain.js";
import type { WorldBounds } from "../core/world/bounds.js";
import { CHUNK, localIndex, toChunk } from "../core/world/coords.js";
import type { MacroSite } from "../core/world/macro.js";
import type { WorldSeed } from "../core/world/recipe.js";

/**
 * Which ground of a bounded world can be stood on, and what can be walked to.
 *
 * Its own module because two very different passes need it. The validator asks it
 * whether the story's legs can be walked once the world is written; the *survey* asks it
 * whether a settlement can be reached at all, before a single word has been authored —
 * and the second is only useful if it can be asked without an artifact to ask about.
 *
 * Generating every chunk of a bounded world is the most expensive thing in the pipeline,
 * so a grid is built once and passed around rather than being rebuilt per query.
 */

export interface PassabilityGrid {
	readonly x: number;
	readonly y: number;
	readonly w: number;
	readonly h: number;
	readonly passable: Uint8Array;
	/**
	 * Terrain ids, for the forage sources.
	 *
	 * Recorded in the same sweep as passability, because generating the world twice to
	 * answer two questions about it would double the slowest thing here.
	 */
	readonly terrain: Uint8Array;
}

/**
 * Sweep a bounded world into a grid.
 *
 * `specFor` is what a settlement was *authored* as, and passing it matters: the streets a
 * roster produces are the streets the player will walk. Omitting it is the honest thing
 * to do before anything is authored — the fallback roster still lays out a settlement, so
 * the answer to "can this town be reached" is the same either way, while the answer to
 * "how long is the walk down its high street" is not being asked yet.
 */
export function gridFor(
	world: WorldSeed,
	bounds: WorldBounds,
	specFor?: (site: MacroSite) => SettlementSpec | undefined,
): PassabilityGrid {
	const min = toChunk(bounds.minX, bounds.minY);
	const max = toChunk(bounds.maxX, bounds.maxY);
	const x = min.cx * CHUNK;
	const y = min.cy * CHUNK;
	const w = (max.cx - min.cx + 1) * CHUNK;
	const h = (max.cy - min.cy + 1) * CHUNK;
	const passable = new Uint8Array(w * h);
	const terrain = new Uint8Array(w * h);

	for (let cy = min.cy; cy <= max.cy; cy++) {
		for (let cx = min.cx; cx <= max.cx; cx++) {
			const { chunk } = generateChunk(
				{ world, bounds, ...(specFor ? { specFor } : {}) },
				{ cx, cy },
			);
			for (let ly = 0; ly < CHUNK; ly++) {
				for (let lx = 0; lx < CHUNK; lx++) {
					const index = localIndex(lx, ly);
					const flags = chunk.flags[index] ?? 0;
					const at = (cy * CHUNK + ly - y) * w + (cx * CHUNK + lx - x);
					passable[at] = flags & TFlag.Passable ? 1 : 0;
					terrain[at] = chunk.terrain[index] ?? 0;
				}
			}
		}
	}
	return { x, y, w, h, passable, terrain };
}

/** Terrain at a position, or undefined outside the generated block. */
export function terrainOf(grid: PassabilityGrid, x: number, y: number): TerrainId | undefined {
	const gx = x - grid.x;
	const gy = y - grid.y;
	if (gx < 0 || gy < 0 || gx >= grid.w || gy >= grid.h) return undefined;
	return grid.terrain[gy * grid.w + gx];
}

export function isPassable(grid: PassabilityGrid, x: number, y: number): boolean {
	const gx = x - grid.x;
	const gy = y - grid.y;
	if (gx < 0 || gy < 0 || gx >= grid.w || gy >= grid.h) return false;
	return grid.passable[gy * grid.w + gx] === 1;
}

/** The nearest walkable tile to a point. A town centre may be a building. */
export function nearestPassable(
	grid: PassabilityGrid,
	at: { readonly x: number; readonly y: number },
	limit = 24,
): { readonly x: number; readonly y: number } | undefined {
	if (isPassable(grid, at.x, at.y)) return at;
	for (let radius = 1; radius <= limit; radius++) {
		for (let dy = -radius; dy <= radius; dy++) {
			for (let dx = -radius; dx <= radius; dx++) {
				if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
				if (isPassable(grid, at.x + dx, at.y + dy)) return { x: at.x + dx, y: at.y + dy };
			}
		}
	}
	return undefined;
}

export function pathLength(
	grid: PassabilityGrid,
	from: { readonly x: number; readonly y: number },
	to: { readonly x: number; readonly y: number },
): number | undefined {
	const start = nearestPassable(grid, from);
	const goal = nearestPassable(grid, to);
	if (!start || !goal) return undefined;
	const path = findPath(start, goal, {
		bounds: { x: grid.x, y: grid.y, w: grid.w, h: grid.h },
		cost: (x, y) => (isPassable(grid, x, y) ? 1 : Number.POSITIVE_INFINITY),
		// Slightly greedy. This runs over a million cells, and the question is whether a
		// route exists and roughly how long, not what the optimal one is.
		heuristicWeight: 1.2,
	});
	return path?.length;
}

/**
 * Every tile that can be walked to from one place, as a flood fill.
 *
 * One sweep answers "which of these forty places can the player get to", where forty A\*
 * runs would answer it forty times over — and unlike A\*, a fill costs the same whether
 * the answer is yes or no. That matters here because the interesting answer is *no*, and
 * a failed A\* is the most expensive kind: it exhausts the frontier before giving up.
 */
export function reachableFrom(
	grid: PassabilityGrid,
	from: { readonly x: number; readonly y: number },
): Uint8Array {
	const seen = new Uint8Array(grid.w * grid.h);
	const start = nearestPassable(grid, from);
	if (!start) return seen;

	const queue: number[] = [(start.y - grid.y) * grid.w + (start.x - grid.x)];
	seen[queue[0] as number] = 1;
	// An index rather than `shift()`: a fill over a million cells shifting an array is
	// quadratic, and this is the one place in the pipeline where that would show.
	for (let head = 0; head < queue.length; head++) {
		const at = queue[head] as number;
		const gx = at % grid.w;
		const gy = (at - gx) / grid.w;
		for (const [dx, dy] of NEIGHBOURS) {
			const nx = gx + dx;
			const ny = gy + dy;
			if (nx < 0 || ny < 0 || nx >= grid.w || ny >= grid.h) continue;
			const next = ny * grid.w + nx;
			if (seen[next] || grid.passable[next] !== 1) continue;
			seen[next] = 1;
			queue.push(next);
		}
	}
	return seen;
}

const NEIGHBOURS: readonly (readonly [number, number])[] = [
	[1, 0],
	[-1, 0],
	[0, 1],
	[0, -1],
];

/** Whether a place can be walked to, allowing for its centre being a building. */
export function canReach(
	grid: PassabilityGrid,
	seen: Uint8Array,
	at: { readonly x: number; readonly y: number },
): boolean {
	const stop = nearestPassable(grid, at);
	if (!stop) return false;
	return seen[(stop.y - grid.y) * grid.w + (stop.x - grid.x)] === 1;
}
