import { describe, expect, it } from "vitest";
import { overlapBy } from "./spacing.js";

/**
 * How close two places may stand.
 *
 * One predicate, used by the survey to decide whether a site may grow and by the validator
 * to report a recipe that put two places on top of each other. Two implementations of this
 * would drift, and the survey would grow a site into an overlap the validator then
 * complained about — a generator arguing with its own checker.
 */

describe("how much two footprints overlap", () => {
	it("is zero or less when they stand clear of each other", () => {
		expect(
			overlapBy({ at: { x: 0, y: 0 }, radius: 10 }, { at: { x: 40, y: 0 }, radius: 10 }),
		).toBeLessThanOrEqual(0);
	});

	it("counts the tiles by which they intrude on each other", () => {
		expect(overlapBy({ at: { x: 0, y: 0 }, radius: 20 }, { at: { x: 30, y: 0 }, radius: 20 })).toBe(
			10,
		);
	});

	it("does not care which is given first", () => {
		const a = { at: { x: 0, y: 0 }, radius: 20 };
		const b = { at: { x: 30, y: 15 }, radius: 15 };
		expect(overlapBy(a, b)).toBe(overlapBy(b, a));
	});

	it("measures on the diagonal the same way as along an axis", () => {
		// A 3-4-5 triangle, so the distance is exactly 50 and the arithmetic is checkable
		// by hand: two radius-30 places whose centres are 50 apart intrude by 10.
		expect(
			overlapBy({ at: { x: 0, y: 0 }, radius: 30 }, { at: { x: 30, y: 40 }, radius: 30 }),
		).toBe(10);
	});
});
