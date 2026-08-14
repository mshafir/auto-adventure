import { describe, expect, it } from "vitest";
import { T } from "../tiles/terrain.js";
import { WorldRecipeSchema } from "./recipe-schema.js";

/**
 * A recipe is data from outside the program that reaches the deepest layer of the
 * generator, so what it accepts and refuses is worth pinning down. These are also the
 * only tests that exercise the schema itself — everything else builds rules in code —
 * which is how the first version shipped demanding all sixteen biome keys.
 */

function parse(recipe: unknown) {
	return WorldRecipeSchema.safeParse(recipe);
}

describe("what a recipe may say", () => {
	it("takes an override for one biome without demanding the rest", () => {
		// `z.record` over an enum in zod 4 is exhaustive: `{ forest: … }` came back as
		// fifteen errors complaining the other fifteen biomes were undefined, which made
		// every recipe with a `biomes` block unreadable.
		const result = parse({ biomes: { forest: { scatterDensity: 0.8 } } });
		expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
	});

	it("takes a weight for one kind of site without demanding the rest", () => {
		expect(parse({ sites: { weights: { town: 0.5 } } }).success).toBe(true);
		expect(parse({ sites: { radius: { castle: { base: 20 } } } }).success).toBe(true);
	});

	it("reads terrain by name and normalises it to a registry id", () => {
		const result = parse({ biomes: { desert: { ground: "sand", scatter: [["rock", 3]] } } });
		expect(result.success).toBe(true);
		expect(result.data?.biomes?.desert?.ground).toBe(T.sand);
		expect(result.data?.biomes?.desert?.scatter?.[0]?.[0]).toBe(T.rock);
	});

	it("reads back the numeric form it wrote, so a save round-trips", () => {
		const once = parse({ biomes: { desert: { ground: "sand" } } });
		const twice = parse(JSON.parse(JSON.stringify(once.data)));
		expect(twice.success).toBe(true);
		expect(twice.data?.biomes?.desert?.ground).toBe(T.sand);
	});

	it("refuses a terrain that does not exist", () => {
		const result = parse({ biomes: { desert: { ground: "lava" } } });
		expect(result.success).toBe(false);
		// Nested inside the union's branch errors, which is where zod puts a custom
		// issue from one arm of a union.
		expect(JSON.stringify(result.error?.issues)).toMatch(/no terrain called/);
	});
});

describe("what a recipe may not say", () => {
	it("refuses elevation bands that do not ascend", () => {
		// Raising the sea past the shore without moving the shore empties the shore
		// band, so every coast becomes lowland grass running into deep water with no
		// beach — which reads as a rendering bug rather than as a setting.
		expect(parse({ climate: { seaLevel: 0.9 } }).success).toBe(false);
		expect(parse({ climate: { seaLevel: 0.6, shoreLevel: 0.64 } }).success).toBe(true);
	});

	it("refuses a world that is one continuous town", () => {
		const busy = { sites: { weights: { town: 40, village: 40, hamlet: 40 } } };
		expect(parse(busy).success).toBe(false);
	});

	it("refuses a place wider than a chunk looks for one", () => {
		// The bound is derived from the halo, not written down, so it cannot drift away
		// from the property it protects.
		expect(parse({ places: [{ at: { x: 0, y: 0 }, kind: "town", radius: 128 }] }).success).toBe(
			true,
		);
		expect(parse({ places: [{ at: { x: 0, y: 0 }, kind: "town", radius: 129 }] }).success).toBe(
			false,
		);
	});

	it("refuses a field it does not know", () => {
		// Strict throughout, because a misspelled knob that is silently ignored is a
		// scenario author changing a number and seeing nothing happen.
		expect(parse({ climate: { seelevel: 0.5 } }).success).toBe(false);
		expect(parse({ zones: [{ at: { x: 0, y: 0 }, radius: 50, hight: 0.2 }] }).success).toBe(false);
	});

	/*
	 * A zone's `elevation` used to be refused here, deliberately: moving the ground moves the
	 * coastline, and a bump under a settlement placed against the unbumped field is a town in
	 * the sea. It is allowed now because a story that wants a river has no other way to get
	 * one — `rivers.ts` runs downhill, so water goes where the land is lower and nowhere else.
	 * The hazard did not go away; `craft terraform` refuses an earthwork that drowns a place
	 * already founded, and `craft check` regenerates every settlement against the new ground.
	 */
	it("takes an earthwork, and holds it to half the field either way", () => {
		expect(parse({ zones: [{ at: { x: 0, y: 0 }, radius: 50, elevation: -0.2 }] }).success).toBe(
			true,
		);
		expect(parse({ zones: [{ at: { x: 0, y: 0 }, radius: 50, elevation: -0.9 }] }).success).toBe(
			false,
		);
	});

	it("accepts the empty recipe, which is the default world", () => {
		expect(parse({}).success).toBe(true);
	});
});
