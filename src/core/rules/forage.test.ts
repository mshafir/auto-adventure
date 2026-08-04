import { describe, expect, it } from "vitest";
import { hashString } from "../rand/hash.js";
import { T } from "../tiles/terrain.js";
import { forageAt, forageKey, forageYields, isForageable } from "./forage.js";

const SEED = hashString("hollowmoor");

/** Everything a stretch of one kind of ground gives up, walked tile by tile. */
function sweep(terrain: number, tiles = 400): Map<string, number> {
	const found = new Map<string, number>();
	for (let x = 0; x < tiles; x++) {
		for (const item of forageAt(SEED, x, 7, terrain)) {
			found.set(item.name, (found.get(item.name) ?? 0) + item.quantity);
		}
	}
	return found;
}

describe("what ground can be gathered from", () => {
	it("includes the things growing in the world", () => {
		for (const terrain of [
			T.crops,
			T.forestFloor,
			T.marsh,
			T.tallGrass,
			T.reeds,
			T.bush,
			T.flowers,
			T.stump,
			T.rock,
		]) {
			expect(isForageable(terrain)).toBe(true);
		}
	});

	it("excludes ground with nothing on it", () => {
		for (const terrain of [T.dirtRoad, T.cobbleRoad, T.stoneWall, T.deepWater, T.floorWood]) {
			expect(isForageable(terrain)).toBe(false);
		}
	});
});

describe("gathering", () => {
	it("is a pure function of position, so a patch does not regrow by being asked twice", () => {
		expect(forageAt(SEED, 12, 34, T.forestFloor)).toEqual(forageAt(SEED, 12, 34, T.forestFloor));
	});

	it("yields nothing from ground that grows nothing", () => {
		expect(forageAt(SEED, 12, 34, T.cobbleRoad)).toEqual([]);
	});

	it("leaves most of a meadow untouched, so grass is not a shop", () => {
		// There is a great deal of tall grass in the world; if every tile paid out,
		// walking across a field would be an income.
		let holding = 0;
		const tiles = 400;
		for (let x = 0; x < tiles; x++) {
			if (forageAt(SEED, x, 3, T.tallGrass).length > 0) holding++;
		}
		expect(holding).toBeGreaterThan(0);
		expect(holding).toBeLessThan(tiles * 0.25);
	});

	it("only ever yields what its ground is documented to give", () => {
		for (const terrain of [T.crops, T.forestFloor, T.marsh, T.bush, T.rock]) {
			const allowed = new Set(forageYields(terrain));
			for (const [name] of sweep(terrain)) {
				expect(allowed, `unexpected yield ${name}`).toContain(name);
			}
		}
	});

	it("gives everything on its ground's list eventually", () => {
		// A yield that can never actually come up would be a lie in the item list the
		// model is given, and an errand for it could not be finished.
		for (const terrain of [T.crops, T.forestFloor, T.marsh, T.bush, T.rock]) {
			const got = new Set(sweep(terrain, 3000).keys());
			for (const name of forageYields(terrain)) {
				expect(got, `${name} never appeared`).toContain(name);
			}
		}
	});

	it("grows moss where an errand would look for it", () => {
		// The errand this was built for: fetch moss from the crops near the forest.
		expect(forageYields(T.forestFloor)).toContain("Cushion Moss");
		expect(forageYields(T.crops)).toContain("Cushion Moss");
		expect(forageYields(T.marsh)).toContain("Sphagnum Moss");
	});

	it("describes everything it yields", () => {
		for (const terrain of [T.crops, T.forestFloor, T.marsh]) {
			for (let x = 0; x < 200; x++) {
				for (const item of forageAt(SEED, x, 9, terrain)) {
					expect(item.description.length).toBeGreaterThan(0);
					expect(item.quantity).toBeGreaterThan(0);
				}
			}
		}
	});
});

describe("remembering a gathered patch", () => {
	it("keys on the world position", () => {
		expect(forageKey(4, 5)).toBe("gathered:4,5");
	});

	it("does not collide with an emptied container", () => {
		// Containers use `looted:`, so the two namespaces cannot be confused.
		expect(forageKey(4, 5).startsWith("gathered:")).toBe(true);
	});

	it("handles negative coordinates", () => {
		expect(forageKey(-4, -5)).toBe("gathered:-4,-5");
	});
});
