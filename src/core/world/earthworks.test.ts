import { describe, expect, it } from "vitest";
import { hashString } from "../rand/hash.js";
import { valueFor } from "../rand/rng.js";
import { elevationAt, elevationBand, slopeAt } from "./fields.js";
import { MACRO } from "./macro.js";
import { resolveRecipe, worldSeed, type ZoneRecipe } from "./recipe.js";
import { riverFrom } from "./rivers.js";

/*
 * Moving the ground itself.
 *
 * Every other terraform edit paints over the world: a path is a run of road tiles, a bridge is
 * a run of planks. This one changes the elevation field the world is made of, and the reason it
 * has to is rivers — `rivers.ts` traces by steepest descent over macro-cell heights, so a river
 * can only be authored by giving the water somewhere lower to go. A blue line stamped across a
 * hillside is not a river.
 *
 * The cost of that reach is that it moves coastlines, buildable ground and cliffs at the same
 * time, which is why the CLI refuses an earthwork that drowns a place already founded.
 */

const SEED = hashString("earthworks");

function withZone(zone: ZoneRecipe) {
	return worldSeed(SEED, { zones: [zone] });
}

const plain = worldSeed(SEED);

describe("an elevation zone", () => {
	it("moves the ground by what it asked for, at the centre", () => {
		const at = { x: 0, y: 0 };
		const before = elevationAt(plain, at.x, at.y);
		const after = elevationAt(withZone({ at, radius: 60, elevation: -0.1 }), at.x, at.y);
		expect(after).toBeCloseTo(before - 0.1, 5);
	});

	it("fades to nothing at the rim, so no chunk can disagree about an edge", () => {
		// The whole reason this is a zone rather than a stamp: the influence is continuous
		// everywhere and exactly zero outside the radius, so it can live inside a pure field
		// function without introducing a discontinuity two chunks could resolve differently.
		const world = withZone({ at: { x: 0, y: 0 }, radius: 40, elevation: -0.2 });
		expect(elevationAt(world, 40, 0)).toBeCloseTo(elevationAt(plain, 40, 0), 6);
		expect(elevationAt(world, 39, 0)).not.toBeCloseTo(elevationAt(plain, 39, 0), 6);
	});

	it("moves the coastline, which is the point and also the danger", () => {
		// Find dry lowland and drown it. Banding reads the same field, so a lowered valley is
		// water rather than a dry hollow with a blue line painted in it.
		const spot = firstWhere(
			(x, y) => elevationBand(elevationAt(plain, x, y), plain.rules) === "lowland",
		);
		const world = withZone({ at: spot, radius: 60, elevation: -0.3 });
		expect(elevationBand(elevationAt(world, spot.x, spot.y), world.rules)).toBe("ocean");
	});

	it("changes the slope, so cliffs and roads follow the new shape", () => {
		const at = { x: 0, y: 0 };
		// A sharp falloff on a small radius is a steep-sided pit: the slope at the rim has to
		// rise, because slope is measured between neighbours of the same field.
		const world = withZone({ at, radius: 8, falloff: 4, elevation: -0.4 });
		expect(slopeAt(world, at.x + 6, at.y)).toBeGreaterThan(slopeAt(plain, at.x + 6, at.y));
	});

	/*
	 * The claim the feature exists for. A river needs a source cell above `uplandLevel` that
	 * also passes the spring roll; raising such a cell produces a river where the seed gave
	 * none, which is what "the terraforming can change map elevations to make rivers possible"
	 * means in practice.
	 */
	it("can put a river where the seed had none", () => {
		const spring = firstSpringCandidate();
		expect(riverFrom(plain, spring.mx, spring.my), "the seed already had one here").toBeUndefined();

		const river = riverFrom(raisedAt(spring), spring.mx, spring.my);
		expect(river, "raising a spring cell should source a river").toBeDefined();
		// Three cells is the shortest thing `traceRiver` will call a river.
		expect(river?.points.length ?? 0).toBeGreaterThanOrEqual(3);
	});

	it("needs a hillside to spring from, not a pillar", () => {
		// Worth knowing while authoring, and it falls out of how rivers are traced: the water
		// leaves by steepest descent over macro *cells*, whose centres are 64 tiles apart. A
		// narrow raise lifts one cell and leaves its neighbours where they were, so the water
		// runs off it and immediately finds a local minimum — two cells, which is not a river.
		// A broad one tilts the whole neighbourhood, and the water has somewhere to keep going.
		const spring = firstSpringCandidate();
		expect(riverFrom(raisedAt(spring, 40), spring.mx, spring.my)).toBeUndefined();
		expect(riverFrom(raisedAt(spring), spring.mx, spring.my)).toBeDefined();
	});
});

describe("a world with no earthworks", () => {
	it("pays nothing for the feature", () => {
		// `elevationAt` is the hottest function in the generator — four thousand samples a
		// chunk, quadrupled again by `slopeAt` — so the guard is a boolean rather than a loop.
		expect(resolveRecipe(undefined).flatElevation).toBe(true);
		expect(
			resolveRecipe({ zones: [{ at: { x: 0, y: 0 }, radius: 40, moisture: 0.3 }] }).flatElevation,
		).toBe(true);
	});

	it("is unmoved by a zone that only wets the ground", () => {
		const damp = worldSeed(SEED, { zones: [{ at: { x: 0, y: 0 }, radius: 80, moisture: 0.4 }] });
		for (const [x, y] of [
			[0, 0],
			[20, -20],
			[79, 0],
		] as const) {
			expect(elevationAt(damp, x, y)).toBe(elevationAt(plain, x, y));
		}
	});

	it("knows it has earthworks the moment one is asked for", () => {
		const moved = resolveRecipe({ zones: [{ at: { x: 0, y: 0 }, radius: 40, elevation: -0.1 }] });
		expect(moved.flatElevation).toBe(false);
	});
});

/** The first position on a coarse sweep where a predicate holds. */
function firstWhere(predicate: (x: number, y: number) => boolean): { x: number; y: number } {
	for (let y = -400; y <= 400; y += 16) {
		for (let x = -400; x <= 400; x += 16) {
			if (predicate(x, y)) return { x, y };
		}
	}
	throw new Error("nowhere in range");
}

interface Spring {
	readonly mx: number;
	readonly my: number;
	readonly lift: number;
}

/** The same raise the CLI would write, so the tests exercise the shape a scenario carries. */
function raisedAt(spring: Spring, radius = 150) {
	const centre = { x: spring.mx * MACRO + MACRO / 2, y: spring.my * MACRO + MACRO / 2 };
	return worldSeed(SEED, {
		zones: [{ id: "the-spring", at: centre, radius, elevation: spring.lift }],
	});
}

/**
 * A macro cell that would spring a river if it were high enough, and how much to lift it.
 *
 * The spring roll is a pure function of the cell, so a cell that passes it and sits below the
 * upland level is a river waiting for the ground to be raised — which is exactly the case this
 * feature is for. Searched rather than hard-coded because the cell that works depends on the
 * shape of the country around it, which is what the next test is about.
 */
function firstSpringCandidate(): Spring {
	const { uplandLevel } = plain.rules.climate;
	for (let my = -6; my <= 6; my++) {
		for (let mx = -6; mx <= 6; mx++) {
			if (valueFor(SEED, "river:source", mx, my) > 0.35) continue;
			const centre = { x: mx * MACRO + MACRO / 2, y: my * MACRO + MACRO / 2 };
			const height = elevationAt(plain, centre.x, centre.y);
			if (height >= uplandLevel) continue;
			if (riverFrom(plain, mx, my)) continue;
			const lift = uplandLevel - height + 0.04;
			if (lift > 0.5) continue;
			const spring = { mx, my, lift };
			// A candidate is only a candidate if raising it actually produces water; the
			// descent has to keep going for three cells, and not every hilltop's does.
			if (riverFrom(raisedAt(spring), mx, my)) return spring;
		}
	}
	throw new Error("no cell in range springs a river");
}
