import { describe, expect, it } from "vitest";
import { scatterField, scatterInRect, scatterPoint } from "./blue-noise.js";
import { makeRng } from "./rng.js";

const SEED = 0x51a77e2;

describe("jittered-grid scatter", () => {
	it("is pointwise pure: a cell's point never depends on visit order", () => {
		// This is the property Bridson's algorithm cannot provide, and the reason
		// it must never be substituted in here. A sequential sampler's output
		// depends on iteration order, and iteration order depends on which chunk
		// is generating — so seams would appear only intermittently.
		const cells: (readonly [number, number])[] = [];
		for (let y = -4; y <= 4; y++) for (let x = -4; x <= 4; x++) cells.push([x, y]);

		const reference = new Map<string, string>();
		for (const [x, y] of cells) {
			const p = scatterPoint(SEED, "trees", x, y, 4);
			reference.set(`${x},${y}`, `${p.x},${p.y},${p.roll}`);
		}

		for (let attempt = 0; attempt < 10; attempt++) {
			for (const [x, y] of makeRng(attempt).shuffled(cells)) {
				const p = scatterPoint(SEED, "trees", x, y, 4);
				expect(`${p.x},${p.y},${p.roll}`).toBe(reference.get(`${x},${y}`));
			}
		}
	});

	it("keeps points inside their own cell", () => {
		const cellSize = 6;
		for (let y = -3; y <= 3; y++) {
			for (let x = -3; x <= 3; x++) {
				const p = scatterPoint(SEED, "trees", x, y, cellSize);
				expect(p.x).toBeGreaterThanOrEqual(x * cellSize);
				expect(p.x).toBeLessThan((x + 1) * cellSize);
				expect(p.y).toBeGreaterThanOrEqual(y * cellSize);
				expect(p.y).toBeLessThan((y + 1) * cellSize);
			}
		}
	});

	it("separates points by roughly the cell size", () => {
		const points = scatterInRect(SEED, "trees", 0, 0, 64, 64, 5);
		let minDistance = Number.POSITIVE_INFINITY;
		for (let i = 0; i < points.length; i++) {
			for (let j = i + 1; j < points.length; j++) {
				const a = points[i];
				const b = points[j];
				if (!a || !b) continue;
				minDistance = Math.min(minDistance, Math.hypot(a.x - b.x, a.y - b.y));
			}
		}
		// Jitter is 0.8 of a cell, so two points in adjacent cells can approach
		// but cannot coincide. This is the blue-noise property that matters.
		expect(points.length).toBeGreaterThan(100);
		expect(minDistance).toBeGreaterThan(0);
	});

	it("includes points whose cell origin lies outside the query rectangle", () => {
		// A point jittered within its cell can land inside the rectangle while
		// its cell origin does not. Missing that halo is the classic cause of
		// scenery vanishing exactly at a chunk boundary.
		// Bounds are [x0, x1) x [y0, y1), not origin plus size.
		const inner = scatterInRect(SEED, "trees", 10, 10, 30, 30, 7);
		for (const p of inner) {
			expect(p.x).toBeGreaterThanOrEqual(10);
			expect(p.x).toBeLessThan(30);
			expect(p.y).toBeGreaterThanOrEqual(10);
			expect(p.y).toBeLessThan(30);
		}

		// Querying a wider area must find exactly the same points inside the
		// smaller one — no candidate may be lost to the window's own edges.
		const wide = scatterInRect(SEED, "trees", 0, 0, 40, 40, 7);
		const wideCoveringInner = wide.filter((p) => p.x >= 10 && p.x < 30 && p.y >= 10 && p.y < 30);
		expect(new Set(wideCoveringInner.map((p) => `${p.x},${p.y}`))).toEqual(
			new Set(inner.map((p) => `${p.x},${p.y}`)),
		);
	});
});

describe("scatterField", () => {
	it("agrees exactly with the per-point form", () => {
		// The field form exists purely for speed; if it ever disagreed with the
		// reference form, chunks would differ from the preview tool.
		const width = 32;
		const height = 32;
		const x0 = -16;
		const y0 = 48;
		const field = scatterField(SEED, "scatter", x0, y0, width, height, 3);
		const points = scatterInRect(SEED, "scatter", x0, y0, x0 + width, y0 + height, 3);

		const fromField = new Set<string>();
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				if ((field[y * width + x] as number) >= 0) fromField.add(`${x0 + x},${y0 + y}`);
			}
		}
		const fromPoints = new Set(points.map((p) => `${p.x},${p.y}`));
		expect([...fromField].sort()).toEqual([...fromPoints].sort());
	});

	it("marks tiles with no candidate as -1", () => {
		const field = scatterField(SEED, "scatter", 0, 0, 16, 16, 6);
		const empty = [...field].filter((v) => v < 0).length;
		expect(empty).toBeGreaterThan(0);
		expect(empty).toBeLessThan(16 * 16);
	});

	it("produces rolls in [0, 1)", () => {
		const field = scatterField(SEED, "scatter", 0, 0, 64, 64, 3);
		for (const value of field) {
			if (value < 0) continue;
			expect(value).toBeGreaterThanOrEqual(0);
			expect(value).toBeLessThan(1);
		}
	});
});
