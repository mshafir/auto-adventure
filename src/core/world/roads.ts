import { euclideanMst, findPath } from "../geom/astar.js";
import { rasterizePolyline } from "../geom/line.js";
import type { Vec2 } from "../geom/vec.js";
import { hashPair } from "../rand/hash.js";
import { streamId, valueAt } from "../rand/rng.js";
import { elevationAt, roughnessAt, slopeAt } from "./fields.js";
import { type MacroSite, sitesAround } from "./macro.js";
import { type WorldSeed, worldKey } from "./recipe.js";

/**
 * Roads are routed in coarse space — one node per 4x4 tile block. Routing at
 * full tile resolution over the distances between settlements would dominate
 * the chunk budget, and the extra precision is invisible once the polyline is
 * rasterised and given a width.
 */
export const ROAD_COARSE = 4;

export interface Road {
	/** Stable identity derived from the unordered site pair. */
	readonly id: number;
	readonly from: MacroSite;
	readonly to: MacroSite;
	/** World-space polyline. */
	readonly points: readonly Vec2[];
	readonly major: boolean;
}

const roadCache = new Map<string, Road | undefined>();

const WANDER_STREAM = streamId("road:wander");

function coarseCost(world: WorldSeed, gx: number, gy: number): number {
	const x = gx * ROAD_COARSE;
	const y = gy * ROAD_COARSE;
	const elevation = elevationAt(world, x, y);
	// Roads do not cross open water; rivers get bridges, seas do not.
	if (elevation < world.rules.climate.seaLevel) return Number.POSITIVE_INFINITY;
	// A small deterministic wander term. Without it A* over gentle terrain finds
	// a perfect 45-degree staircase, which reads as machine-drawn; with it the
	// route meanders the way a track worn by use does, at no extra search cost.
	return (
		1 +
		slopeAt(world, x, y) * 220 +
		roughnessAt(world, x, y) * 3 +
		valueAt(world.seed, WANDER_STREAM, gx, gy) * 1.4
	);
}

/**
 * Route between two sites.
 *
 * Keyed by the *unordered* pair, so `roadBetween(a, b)` and `roadBetween(b, a)`
 * return the same polyline object. Combined with routing over the globally-pure
 * elevation field on a globally-fixed coarse lattice, this is what makes two
 * adjacent chunks rasterise identical road tiles without ever exchanging any
 * information about their shared edge.
 */
export function roadBetween(world: WorldSeed, a: MacroSite, b: MacroSite): Road | undefined {
	const key = `${worldKey(world)}:${Math.min(a.id, b.id)}:${Math.max(a.id, b.id)}`;
	if (roadCache.has(key)) return roadCache.get(key);

	// Order the endpoints canonically so the A* runs in a fixed direction; A*
	// tie-breaking is deterministic but not symmetric under reversal.
	const [start, end] = a.id <= b.id ? [a, b] : [b, a];

	const sx = Math.round(start.site.x / ROAD_COARSE);
	const sy = Math.round(start.site.y / ROAD_COARSE);
	const ex = Math.round(end.site.x / ROAD_COARSE);
	const ey = Math.round(end.site.y / ROAD_COARSE);

	// Search inside a corridor around the straight line. Unbounded A* over an
	// infinite plane would be both slow and, on failure, unbounded.
	const pad = 24;
	const bounds = {
		x: Math.min(sx, ex) - pad,
		y: Math.min(sy, ey) - pad,
		w: Math.abs(ex - sx) + pad * 2 + 1,
		h: Math.abs(ey - sy) + pad * 2 + 1,
	};

	const coarse = findPath(
		{ x: sx, y: sy },
		{ x: ex, y: ey },
		{
			bounds,
			cost: (gx, gy) => coarseCost(world, gx, gy),
			diagonal: true,
			// Slightly greedy: roads should look purposeful, not optimal.
			heuristicWeight: 1.15,
		},
	);

	const road: Road | undefined = coarse
		? {
				id: hashPair(start.mx, start.my, end.mx, end.my),
				from: start,
				to: end,
				points: coarse.map((p) => ({ x: p.x * ROAD_COARSE, y: p.y * ROAD_COARSE })),
				major: start.importance + end.importance >= 6,
			}
		: undefined;

	roadCache.set(key, road);
	return road;
}

/**
 * Every road that could touch a chunk.
 *
 * The MST is computed over the halo's sites. Because the halo is the same size
 * everywhere and sites are ordered deterministically, neighbouring chunks
 * compute overlapping-but-consistent road sets: a road present in both is the
 * identical polyline, and a road only one chunk knows about cannot reach the
 * other (that is what the halo-sufficiency assertion guarantees).
 */
export function roadsAround(world: WorldSeed, cx: number, cy: number): Road[] {
	const sites = sitesAround(world, cx, cy).filter((s) => s.kind !== "landmark");
	if (sites.length < 2) return [];

	const edges = euclideanMst(sites.map((s) => s.site));
	const roads: Road[] = [];
	for (const [i, j] of edges) {
		const a = sites[i];
		const b = sites[j];
		if (!a || !b) continue;
		const road = roadBetween(world, a, b);
		if (road) roads.push(road);
	}
	roads.sort((p, q) => p.id - q.id);
	return roads;
}

export function roadTiles(road: Road): Vec2[] {
	return rasterizePolyline(road.points);
}

/** Clear the memoised routes. Tests use this to prove nothing is order-dependent. */
export function clearRoadCache(): void {
	roadCache.clear();
}
