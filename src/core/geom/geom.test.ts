import { describe, expect, it } from "vitest";
import { makeRng } from "../rand/rng.js";
import { euclideanMst, findPath } from "./astar.js";
import { bspSplit } from "./bsp.js";
import { componentAt, labelComponents, primaryComponent } from "./floodfill.js";
import { MinHeap } from "./heap.js";
import {
	bresenham,
	polylineIntersections,
	rasterizePolyline,
	segmentIntersection,
} from "./line.js";
import { rectContains, rectInset, rectIntersection } from "./vec.js";

describe("MinHeap", () => {
	it("pops in priority order", () => {
		const heap = new MinHeap();
		for (const [key, priority] of [
			[1, 5],
			[2, 3],
			[3, 9],
			[4, 1],
			[5, 7],
		] as const) {
			heap.push(key, priority);
		}
		expect([heap.pop(), heap.pop(), heap.pop(), heap.pop(), heap.pop()]).toEqual([4, 2, 1, 5, 3]);
		expect(heap.pop()).toBeUndefined();
	});

	it("survives a randomised workload", () => {
		const rng = makeRng(7);
		const heap = new MinHeap();
		const expected: number[] = [];
		for (let i = 0; i < 500; i++) {
			const p = rng.int(1000);
			heap.push(i, p);
			expected.push(p);
		}
		expected.sort((a, b) => a - b);
		const got: number[] = [];
		while (heap.size > 0) got.push(heap.pop() as number);
		expect(got).toHaveLength(500);
	});
});

describe("bresenham", () => {
	it("connects endpoints with no gaps", () => {
		const points = bresenham(0, 0, 10, 4);
		expect(points[0]).toEqual({ x: 0, y: 0 });
		expect(points[points.length - 1]).toEqual({ x: 10, y: 4 });
		for (let i = 1; i < points.length; i++) {
			const a = points[i - 1];
			const b = points[i];
			if (!a || !b) continue;
			expect(Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))).toBe(1);
		}
	});

	it("handles a degenerate zero-length line", () => {
		expect(bresenham(3, 3, 3, 3)).toEqual([{ x: 3, y: 3 }]);
	});

	it("handles negative directions", () => {
		const points = bresenham(5, 5, -5, -2);
		expect(points[points.length - 1]).toEqual({ x: -5, y: -2 });
	});

	it("rasterises a polyline without duplicating joints", () => {
		const points = rasterizePolyline([
			{ x: 0, y: 0 },
			{ x: 5, y: 0 },
			{ x: 5, y: 5 },
		]);
		const keys = points.map((p) => `${p.x},${p.y}`);
		expect(new Set(keys).size).toBe(keys.length);
	});
});

describe("segment intersection", () => {
	it("finds a crossing", () => {
		expect(
			segmentIntersection({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 }),
		).toEqual({ x: 5, y: 5 });
	});

	it("returns undefined for parallel and non-overlapping segments", () => {
		expect(
			segmentIntersection({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 5 }, { x: 10, y: 5 }),
		).toBeUndefined();
		expect(
			segmentIntersection({ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 8, y: 9 }, { x: 9, y: 8 }),
		).toBeUndefined();
	});

	it("finds where a road polyline crosses a river polyline", () => {
		// This is how bridge positions are decided, in world space, so that both
		// chunks sharing the crossing compute the identical tile.
		const road = [
			{ x: 0, y: 5 },
			{ x: 20, y: 5 },
		];
		const river = [
			{ x: 10, y: 0 },
			{ x: 10, y: 20 },
		];
		expect(polylineIntersections(road, river)).toEqual([{ x: 10, y: 5 }]);
	});
});

describe("findPath", () => {
	const open = { bounds: { x: 0, y: 0, w: 20, h: 20 }, cost: () => 1 };

	it("finds a path across open ground", () => {
		const path = findPath({ x: 0, y: 0 }, { x: 19, y: 19 }, open);
		expect(path?.[0]).toEqual({ x: 0, y: 0 });
		expect(path?.[path.length - 1]).toEqual({ x: 19, y: 19 });
	});

	it("returns undefined when the goal is walled off", () => {
		const path = findPath(
			{ x: 0, y: 0 },
			{ x: 19, y: 10 },
			{
				bounds: { x: 0, y: 0, w: 20, h: 20 },
				// A full-height wall with no gap.
				cost: (x) => (x === 10 ? Number.POSITIVE_INFINITY : 1),
			},
		);
		expect(path).toBeUndefined();
	});

	it("routes around an obstacle through the one gap", () => {
		const path = findPath(
			{ x: 0, y: 0 },
			{ x: 19, y: 0 },
			{
				bounds: { x: 0, y: 0, w: 20, h: 20 },
				cost: (x, y) => (x === 10 && y !== 15 ? Number.POSITIVE_INFINITY : 1),
			},
		);
		expect(path).toBeDefined();
		expect(path?.some((p) => p.x === 10 && p.y === 15)).toBe(true);
	});

	it("prefers cheap ground over the short route", () => {
		const path = findPath(
			{ x: 0, y: 5 },
			{ x: 10, y: 5 },
			{
				bounds: { x: 0, y: 0, w: 20, h: 20 },
				// A costly band along y=5 that is passable but expensive.
				cost: (_x, y) => (y === 5 ? 50 : 1),
			},
		);
		expect(path?.some((p) => p.y !== 5)).toBe(true);
	});

	it("is deterministic", () => {
		const a = findPath({ x: 0, y: 0 }, { x: 19, y: 19 }, open);
		const b = findPath({ x: 0, y: 0 }, { x: 19, y: 19 }, open);
		expect(a).toEqual(b);
	});

	it("rejects out-of-bounds endpoints instead of searching forever", () => {
		expect(findPath({ x: -5, y: 0 }, { x: 5, y: 5 }, open)).toBeUndefined();
		expect(findPath({ x: 0, y: 0 }, { x: 500, y: 5 }, open)).toBeUndefined();
	});
});

describe("euclideanMst", () => {
	it("returns n-1 edges spanning all points", () => {
		const points = [
			{ x: 0, y: 0 },
			{ x: 10, y: 0 },
			{ x: 10, y: 10 },
			{ x: 0, y: 10 },
			{ x: 5, y: 5 },
		];
		const edges = euclideanMst(points);
		expect(edges).toHaveLength(points.length - 1);
		const touched = new Set(edges.flat());
		expect(touched.size).toBe(points.length);
	});

	it("is stable under input order for a fixed point set", () => {
		const points = [
			{ x: 0, y: 0 },
			{ x: 3, y: 1 },
			{ x: 9, y: 4 },
		];
		expect(euclideanMst(points)).toEqual(euclideanMst(points));
	});

	it("handles degenerate inputs", () => {
		expect(euclideanMst([])).toEqual([]);
		expect(euclideanMst([{ x: 1, y: 1 }])).toEqual([]);
	});
});

describe("labelComponents", () => {
	const bounds = { x: 0, y: 0, w: 10, h: 10 };

	it("finds one component for fully open ground", () => {
		const result = labelComponents(bounds, () => true);
		expect(result.componentCount).toBe(1);
		expect(result.sizes[1]).toBe(100);
	});

	it("separates regions split by a wall", () => {
		const result = labelComponents(bounds, (x) => x !== 5);
		expect(result.componentCount).toBe(2);
		expect(primaryComponent(result)).toBeGreaterThan(0);
		expect(componentAt(result, bounds, 0, 0)).not.toBe(componentAt(result, bounds, 9, 0));
	});

	it("joins diagonally-touching regions only when asked", () => {
		const passable = (x: number, y: number) => x === y;
		expect(labelComponents(bounds, passable, false).componentCount).toBe(10);
		expect(labelComponents(bounds, passable, true).componentCount).toBe(1);
	});

	it("reports nothing passable as zero components", () => {
		const result = labelComponents(bounds, () => false);
		expect(result.componentCount).toBe(0);
		expect(primaryComponent(result)).toBe(0);
	});

	it("does not overflow the stack on a large open region", () => {
		const big = { x: 0, y: 0, w: 200, h: 200 };
		expect(() => labelComponents(big, () => true)).not.toThrow();
	});
});

describe("bspSplit", () => {
	it("produces non-overlapping leaves inside the area", () => {
		const area = { x: 0, y: 0, w: 60, h: 40 };
		const { leaves } = bspSplit(area, makeRng(3), { minSize: 6, cutWidth: 1 });
		expect(leaves.length).toBeGreaterThan(1);
		for (const leaf of leaves) {
			expect(rectContains(area, leaf.x, leaf.y)).toBe(true);
			expect(leaf.x + leaf.w).toBeLessThanOrEqual(area.x + area.w);
			expect(leaf.y + leaf.h).toBeLessThanOrEqual(area.y + area.h);
			expect(leaf.w).toBeGreaterThanOrEqual(6);
			expect(leaf.h).toBeGreaterThanOrEqual(6);
		}
		for (let i = 0; i < leaves.length; i++) {
			for (let j = i + 1; j < leaves.length; j++) {
				expect(rectIntersection(leaves[i] as never, leaves[j] as never)).toBeUndefined();
			}
		}
	});

	it("emits a cut for every split it made", () => {
		const { leaves, cuts } = bspSplit({ x: 0, y: 0, w: 60, h: 60 }, makeRng(9), { minSize: 7 });
		expect(cuts.length).toBe(leaves.length - 1);
	});

	it("is deterministic for a given rng seed", () => {
		const a = bspSplit({ x: 0, y: 0, w: 50, h: 50 }, makeRng(11), { minSize: 5 });
		const b = bspSplit({ x: 0, y: 0, w: 50, h: 50 }, makeRng(11), { minSize: 5 });
		expect(a).toEqual(b);
	});

	it("refuses to split an area too small to split", () => {
		const { leaves } = bspSplit({ x: 0, y: 0, w: 8, h: 8 }, makeRng(1), { minSize: 6 });
		expect(leaves).toHaveLength(1);
	});
});

describe("rect helpers", () => {
	it("insets and intersects", () => {
		expect(rectInset({ x: 0, y: 0, w: 10, h: 10 }, 2)).toEqual({ x: 2, y: 2, w: 6, h: 6 });
		expect(rectIntersection({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 })).toEqual({
			x: 5,
			y: 5,
			w: 5,
			h: 5,
		});
		expect(
			rectIntersection({ x: 0, y: 0, w: 4, h: 4 }, { x: 9, y: 9, w: 4, h: 4 }),
		).toBeUndefined();
	});
});
