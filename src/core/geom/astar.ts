import { MinHeap } from "./heap.js";
import type { Rect, Vec2 } from "./vec.js";

export interface GridPathOptions {
	/** Search is confined to this rectangle, which also bounds the cost arrays. */
	readonly bounds: Rect;
	/** Movement cost to *enter* a cell. Return `Infinity` for impassable. */
	readonly cost: (x: number, y: number) => number;
	/** Whether diagonal steps are allowed. Off by default: roads read better. */
	readonly diagonal?: boolean;
	/** Scales the heuristic. 1 is admissible; >1 trades optimality for speed. */
	readonly heuristicWeight?: number;
}

/**
 * A* over a bounded integer grid.
 *
 * Ties are broken by the order neighbours are generated, which is fixed, and
 * the frontier is a deterministic binary heap — so the same inputs always yield
 * the same path. That matters more than it sounds: two adjacent chunks each
 * rasterise the portion of a road that crosses them, and they must agree on the
 * whole polyline, not merely on where it touches their shared edge.
 */
export function findPath(start: Vec2, goal: Vec2, options: GridPathOptions): Vec2[] | undefined {
	const { bounds, cost } = options;
	const weight = options.heuristicWeight ?? 1;
	const { x: bx, y: by, w, h } = bounds;

	const inBounds = (x: number, y: number) => x >= bx && y >= by && x < bx + w && y < by + h;
	if (!inBounds(start.x, start.y) || !inBounds(goal.x, goal.y)) return undefined;

	const index = (x: number, y: number) => (y - by) * w + (x - bx);
	const total = w * h;

	const gScore = new Float64Array(total).fill(Number.POSITIVE_INFINITY);
	const cameFrom = new Int32Array(total).fill(-1);
	const closed = new Uint8Array(total);

	const steps: readonly (readonly [number, number, number])[] = options.diagonal
		? [
				[0, -1, 1],
				[1, 0, 1],
				[0, 1, 1],
				[-1, 0, 1],
				[1, -1, Math.SQRT2],
				[1, 1, Math.SQRT2],
				[-1, 1, Math.SQRT2],
				[-1, -1, Math.SQRT2],
			]
		: [
				[0, -1, 1],
				[1, 0, 1],
				[0, 1, 1],
				[-1, 0, 1],
			];

	const heuristic = options.diagonal
		? (x: number, y: number) => Math.max(Math.abs(x - goal.x), Math.abs(y - goal.y))
		: (x: number, y: number) => Math.abs(x - goal.x) + Math.abs(y - goal.y);

	const startIndex = index(start.x, start.y);
	const goalIndex = index(goal.x, goal.y);
	gScore[startIndex] = 0;

	const open = new MinHeap();
	open.push(startIndex, heuristic(start.x, start.y) * weight);

	while (open.size > 0) {
		const current = open.pop() as number;
		if (current === goalIndex) break;
		if (closed[current]) continue;
		closed[current] = 1;

		const cx = bx + (current % w);
		const cy = by + Math.floor(current / w);
		const currentG = gScore[current] as number;

		for (const [dx, dy, stepCost] of steps) {
			const nx = cx + dx;
			const ny = cy + dy;
			if (!inBounds(nx, ny)) continue;
			const ni = index(nx, ny);
			if (closed[ni]) continue;

			const enter = cost(nx, ny);
			if (!Number.isFinite(enter)) continue;

			const tentative = currentG + enter * stepCost;
			if (tentative >= (gScore[ni] as number)) continue;

			gScore[ni] = tentative;
			cameFrom[ni] = current;
			open.push(ni, tentative + heuristic(nx, ny) * weight);
		}
	}

	if (!Number.isFinite(gScore[goalIndex] as number)) return undefined;

	const path: Vec2[] = [];
	let node = goalIndex;
	while (node !== -1) {
		path.push({ x: bx + (node % w), y: by + Math.floor(node / w) });
		if (node === startIndex) break;
		node = cameFrom[node] as number;
	}
	return path.reverse();
}

/**
 * Minimum spanning tree over points by Euclidean distance (Prim's).
 *
 * Ties break on the lower index, and indices come from a deterministic site
 * ordering, so the tree is stable no matter which chunk asks for it.
 */
export function euclideanMst(points: readonly Vec2[]): (readonly [number, number])[] {
	const n = points.length;
	if (n < 2) return [];

	const inTree = new Uint8Array(n);
	const best = new Float64Array(n).fill(Number.POSITIVE_INFINITY);
	const parent = new Int32Array(n).fill(-1);
	const edges: (readonly [number, number])[] = [];

	best[0] = 0;
	for (let iteration = 0; iteration < n; iteration++) {
		let pick = -1;
		let pickCost = Number.POSITIVE_INFINITY;
		for (let i = 0; i < n; i++) {
			if (inTree[i]) continue;
			const b = best[i] as number;
			if (b < pickCost) {
				pickCost = b;
				pick = i;
			}
		}
		if (pick === -1) break;
		inTree[pick] = 1;
		const from = parent[pick] as number;
		if (from !== -1) {
			edges.push(pick < from ? [pick, from] : [from, pick]);
		}

		const p = points[pick] as Vec2;
		for (let i = 0; i < n; i++) {
			if (inTree[i]) continue;
			const q = points[i] as Vec2;
			const d = (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
			if (d < (best[i] as number)) {
				best[i] = d;
				parent[i] = pick;
			}
		}
	}

	return edges;
}
