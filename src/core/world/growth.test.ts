import { describe, expect, it } from "vitest";
import { sitePlots } from "../gen/features/settlement.js";
import { hashString } from "../rand/hash.js";
import type { WorldBounds } from "./bounds.js";
import { growSite, rosterTarget } from "./growth.js";
import { isSettlement, type MacroSite, macroSite } from "./macro.js";
import { worldSeed } from "./recipe.js";
import { overlapBy } from "./spacing.js";

/**
 * Making a site big enough for what it will be asked to hold.
 *
 * The survey grows every settlement that is short before a token is spent; the settling walk
 * grows one when a required building turns out to have had nowhere to stand. Both ask this, and
 * they must not answer it separately: two growth rules would mean a world the survey called
 * big enough and the walk grew anyway, on the same seed.
 */

/** A rectangle large enough that the boundary is never the reason growth is refused. */
const ROOMY: WorldBounds = {
	minX: -2048,
	minY: -2048,
	maxX: 2048,
	maxY: 2048,
	style: "cliffs",
	thickness: 8,
};

function settlementsOf(seedName: string, reach = 5) {
	const world = worldSeed(hashString(seedName));
	const sites: MacroSite[] = [];
	for (let my = -reach; my <= reach; my++) {
		for (let mx = -reach; mx <= reach; mx++) {
			const site = macroSite(world, mx, my);
			if (isSettlement(site.kind)) sites.push(site);
		}
	}
	return { world, sites };
}

describe("growing a site", () => {
	it("makes it hold what it was asked for, when the ground allows", () => {
		const { world, sites } = settlementsOf("grow-one");
		const short = sites.find((site) => sitePlots(world, site).length < rosterTarget(world, site));
		expect(short, "no site in this seed is short, so this test proves nothing").toBeDefined();
		if (!short) return;

		const grown = growSite({
			world,
			site: short,
			bounds: ROOMY,
			neighbours: sites,
			wanted: rosterTarget(world, short),
		});
		expect(grown).toBeDefined();
		expect(grown?.radius ?? 0).toBeGreaterThan(short.radius);
		// Bigger for a reason: the point is plots, not tiles.
		expect(
			sitePlots(world, { ...short, radius: grown?.radius ?? short.radius }).length,
		).toBeGreaterThan(sitePlots(world, short).length);
	});

	it("refuses to grow into a neighbour", () => {
		// A grown site is pinned as an authored place, which is exactly what validate.ts warns
		// about overlapping a rolled one. A generator that produced worlds its own checker
		// complains about would be worse than one that never grew anything.
		//
		// The neighbour is placed rather than found, because in every seed tried the rolled
		// sites are far enough apart that growth stops for want of plots long before it reaches
		// one — the closest approach measured across this seed was 39 tiles of clearance. So a
		// test that grew the real map and checked the real neighbours passed with the clearance
		// rule deleted, which is no test at all. Here the same site is grown twice, once with a
		// neighbour close enough to bind and once without, and the two answers must differ.
		const { world, sites } = settlementsOf("grow-one");
		const site = sites.find((entry) => sitePlots(world, entry).length < rosterTarget(world, entry));
		expect(site, "no site in this seed is short, so this test proves nothing").toBeDefined();
		if (!site) return;

		const alone = growSite({
			world,
			site,
			bounds: ROOMY,
			neighbours: [site],
			wanted: rosterTarget(world, site),
		});
		expect(alone?.radius, "the site did not grow even unobstructed").toBeDefined();
		if (alone?.radius === undefined) return;

		// Close enough that the unobstructed answer would overlap it, and far enough that some
		// growth is still allowed — so this pins where growth stopped, not merely that it did.
		const gap = site.radius + 4;
		const crowd: MacroSite = {
			...site,
			id: site.id + 1,
			site: { x: site.site.x + gap + alone.radius, y: site.site.y },
			radius: alone.radius,
		};
		const hemmed = growSite({
			world,
			site,
			bounds: ROOMY,
			neighbours: [site, crowd],
			wanted: rosterTarget(world, site),
		});

		expect(hemmed?.radius ?? site.radius, "growth ignored the neighbour").toBeLessThan(
			alone.radius,
		);
		expect(
			overlapBy(
				{ at: site.site, radius: hemmed?.radius ?? site.radius },
				{ at: crowd.site, radius: crowd.radius },
			),
			"grew into the neighbour",
		).toBeLessThanOrEqual(0);
	});

	it("refuses to grow past the boundary band", () => {
		const { world, sites } = settlementsOf("grow-one");
		const site = sites[0];
		expect(site).toBeDefined();
		if (!site) return;
		// A rectangle whose edge is barely clear of the site as it stands, so any growth at all
		// puts the footprint in the band.
		const tight: WorldBounds = {
			minX: site.site.x - site.radius - 2,
			minY: site.site.y - site.radius - 2,
			maxX: site.site.x + site.radius + 2,
			maxY: site.site.y + site.radius + 2,
			style: "cliffs",
			thickness: 8,
		};
		expect(
			growSite({ world, site, bounds: tight, neighbours: [site], wanted: 999 }),
		).toBeUndefined();
	});

	it("gives back nothing when it is already big enough", () => {
		const { world, sites } = settlementsOf("grow-one");
		const site = sites.find((entry) => sitePlots(world, entry).length > 0);
		expect(site).toBeDefined();
		if (!site) return;
		expect(growSite({ world, site, bounds: ROOMY, neighbours: sites, wanted: 1 })).toBeUndefined();
	});

	it("does not grow a place somebody chose the size of", () => {
		// The recipe is the one thing here with an opinion.
		const { world, sites } = settlementsOf("grow-one");
		const site = sites[0];
		expect(site).toBeDefined();
		if (!site) return;
		expect(
			growSite({
				world,
				site: { ...site, authored: true },
				bounds: ROOMY,
				neighbours: sites,
				wanted: 999,
			}),
		).toBeUndefined();
	});

	it("asks for the same roster however big the site has already grown", () => {
		// The fixed point behind growing being idempotent. `ambition` goes as the square of the
		// radius, so a target read off the current footprint rises every time the site grows —
		// and each pass would grow it again, for ever. Measured at the recipe's size it does not
		// move.
		//
		// Asked of a site whose target is below the clamp, which took a second attempt: the
		// first site in this seed is a town of radius 40 whose ambition is already pinned at the
		// ceiling of 24, so doubling its radius changed nothing and the test passed with the
		// bug in place.
		const { world, sites } = settlementsOf("grow-one");
		const site = sites.find((entry) => rosterTarget(world, entry) < 24 && !entry.authored);
		expect(
			site,
			"every site here is at the ambition ceiling, so this proves nothing",
		).toBeDefined();
		if (!site) return;
		expect(rosterTarget(world, { ...site, radius: site.radius * 2 })).toBe(
			rosterTarget(world, site),
		);
	});
});
