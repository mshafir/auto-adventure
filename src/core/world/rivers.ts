import { rasterizePolyline } from "../geom/line.js";
import type { Vec2 } from "../geom/vec.js";
import { hash32 } from "../rand/hash.js";
import { valueFor } from "../rand/rng.js";
import { HALO } from "./coords.js";
import { elevationAt } from "./fields.js";
import { MACRO } from "./macro.js";
import { type WorldSeed, worldKey } from "./recipe.js";

export interface River {
	readonly id: number;
	readonly points: readonly Vec2[];
	/** Accumulated flow at the mouth; drives width. */
	readonly flow: number;
}

const riverCache = new Map<string, River | undefined>();

/** How far a river may run before we stop tracing. Bounds the work per source. */
const MAX_RIVER_STEPS = 60;

function macroElevation(world: WorldSeed, mx: number, my: number): number {
	// Sample at the macro cell centre so the descent graph is well defined.
	return elevationAt(world, mx * MACRO + MACRO / 2, my * MACRO + MACRO / 2);
}

/**
 * A river sourced at a macro cell, traced by steepest descent over the macro
 * graph rather than tile by tile.
 *
 * Tracing on the macro graph is what makes a river a single world-space object
 * instead of a per-chunk decision. Every chunk the river passes through
 * rasterises a clipped portion of the *same* polyline, so the banks line up.
 */
export function riverFrom(world: WorldSeed, mx: number, my: number): River | undefined {
	const key = `${worldKey(world)}:${mx}:${my}`;
	if (riverCache.has(key)) return riverCache.get(key);

	const result = traceRiver(world, mx, my);
	riverCache.set(key, result);
	return result;
}

function traceRiver(world: WorldSeed, mx: number, my: number): River | undefined {
	const sourceElevation = macroElevation(world, mx, my);
	if (sourceElevation < world.rules.climate.uplandLevel) return undefined;
	// Only some highland cells are springs, or the map becomes all water.
	if (valueFor(world.seed, "river:source", mx, my) > 0.35) return undefined;

	const points: Vec2[] = [];
	const visited = new Set<string>();
	let cx = mx;
	let cy = my;
	let flow = 1;

	for (let step = 0; step < MAX_RIVER_STEPS; step++) {
		const cellKey = `${cx},${cy}`;
		if (visited.has(cellKey)) break;
		visited.add(cellKey);

		// Wander the exit point within the cell so rivers are not straight lines
		// between cell centres, but do it as a pure function of the cell.
		const jx = valueFor(world.seed, "river:jx", cx, cy);
		const jy = valueFor(world.seed, "river:jy", cx, cy);
		points.push({
			x: Math.round(cx * MACRO + MACRO * (0.3 + jx * 0.4)),
			y: Math.round(cy * MACRO + MACRO * (0.3 + jy * 0.4)),
		});

		const here = macroElevation(world, cx, cy);
		if (here < world.rules.climate.seaLevel) break;

		let bestX = cx;
		let bestY = cy;
		let bestElevation = here;
		// Fixed neighbour order, so ties always resolve the same way.
		for (const [dx, dy] of [
			[0, -1],
			[1, 0],
			[0, 1],
			[-1, 0],
			[1, -1],
			[1, 1],
			[-1, 1],
			[-1, -1],
		] as const) {
			const e = macroElevation(world, cx + dx, cy + dy);
			if (e < bestElevation) {
				bestElevation = e;
				bestX = cx + dx;
				bestY = cy + dy;
			}
		}

		// A local minimum that is not the sea: the river ends in a tarn.
		if (bestX === cx && bestY === cy) break;

		cx = bestX;
		cy = bestY;
		flow += 1;
	}

	if (points.length < 3) return undefined;
	return { id: hash32(world.seed, 0x21be0, mx, my), points, flow };
}

/** Rivers that could touch a chunk, sourced anywhere in its halo. */
export function riversAround(world: WorldSeed, cx: number, cy: number, halo = HALO): River[] {
	const rivers: River[] = [];
	// Rivers run far, so look further afield than the settlement halo.
	const reach = halo + 6;
	for (let my = cy - reach; my <= cy + reach; my++) {
		for (let mx = cx - reach; mx <= cx + reach; mx++) {
			const river = riverFrom(world, mx, my);
			if (river) rivers.push(river);
		}
	}
	rivers.sort((a, b) => a.id - b.id);
	return rivers;
}

/** Channel half-width in tiles, from accumulated flow. */
export function riverWidth(flow: number): number {
	return Math.max(1, Math.min(5, Math.round(Math.sqrt(flow) * 0.7)));
}

export function riverTiles(river: River): Vec2[] {
	return rasterizePolyline(river.points);
}

export function clearRiverCache(): void {
	riverCache.clear();
}
