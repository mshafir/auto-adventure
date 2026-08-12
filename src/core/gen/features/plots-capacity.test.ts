import { beforeEach, describe, expect, it } from "vitest";
import { hashString } from "../../rand/hash.js";
import { isSettlement, type MacroSite, macroSite } from "../../world/macro.js";
import { worldSeed } from "../../world/recipe.js";
import { clearRiverCache } from "../../world/rivers.js";
import { clearRoadCache } from "../../world/roads.js";
import { fallbackSettlementSpec } from "./fallback-spec.js";
import { clearFeatureCache } from "./registry.js";
import { generateSettlement, sitePlots } from "./settlement.js";

/**
 * What a site can hold, and what it actually held.
 *
 * The load-bearing test of the whole placement track. Capacity is used to decide how many
 * structures the model may be asked for and whether a site needs to be grown, so a capacity
 * function that can disagree with the builder is worse than the arithmetic estimate it
 * replaces — that one was obviously a guess, and this one would be believed.
 *
 * The two are kept honest by construction rather than by hope: `buildSettlement` calls
 * `sitePlots`. This checks that it stayed that way.
 */

beforeEach(() => {
	clearFeatureCache();
	clearRoadCache();
	clearRiverCache();
});

/**
 * Every settlement within a few macro cells of the origin, for a named seed.
 *
 * A sweep rather than a list of pinned cells, because most cells hold nothing: an earlier
 * version of this file named eight cells across three seeds and exactly one of them turned
 * out to be a settlement, so seven of its eight cases returned before asserting anything.
 */
function settlements(
	seedName: string,
	reach = 4,
): { world: ReturnType<typeof worldSeed>; sites: MacroSite[] } {
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

/** Enough seeds to cross coast, slope, river and open ground. */
const SEEDS = ["alpha", "harrow", "vale", "cramped"] as const;

describe("what a settlement site can hold", () => {
	it.each(SEEDS)("builds %s's settlements on the plots it reported and no others", (seedName) => {
		const { world, sites } = settlements(seedName);
		expect(sites.length, `${seedName} has no settlement to check`).toBeGreaterThan(0);

		let checked = 0;
		for (const site of sites) {
			const plots = sitePlots(world, site);
			const patch = generateSettlement(world, site, fallbackSettlementSpec(world, site));

			// Every building stands inside one of the reported plots. Not equality of counts:
			// the builder drops a plot whose fitted rectangle came out under 5x5, and prunes
			// what it could not reach — both are reductions, never additions. A building
			// *outside* every reported plot is the failure this exists to catch, and it means
			// capacity is describing a layout the builder is not using.
			for (const building of patch.buildings) {
				const inside = plots.some(
					(plot) =>
						building.rect.x >= plot.x &&
						building.rect.y >= plot.y &&
						building.rect.x + building.rect.w <= plot.x + plot.w &&
						building.rect.y + building.rect.h <= plot.y + plot.h,
				);
				expect(
					inside,
					`a building at ${building.rect.x},${building.rect.y} stood outside every plot sitePlots reported`,
				).toBe(true);
				checked++;
			}
			expect(patch.buildings.length).toBeLessThanOrEqual(plots.length);
		}

		// Tripwire: every assertion above is inside a loop over buildings, so a change that
		// left these settlements empty would turn this into a test that cannot fail.
		expect(checked, `${seedName} built nothing at all, so nothing was checked`).toBeGreaterThan(5);
	});

	it("answers the same way twice, because generation is pure in seed and recipe", () => {
		const { world, sites } = settlements("alpha");
		const site = sites[0];
		expect(site).toBeDefined();
		if (!site) return;
		expect(sitePlots(world, site)).toEqual(sitePlots(world, site));
	});

	it("can be asked before anything has been built, and gives the same answer after", () => {
		// The property that makes this usable as capacity at all: the survey asks before a
		// patch exists. It holds only because the split has an rng stream of its own — the
		// plots used to be drawn after the ground pass had rolled a tile for every square of
		// the footprint, so the answer depended on how much had already been made.
		const { world, sites } = settlements("harrow");
		const site = sites[0];
		expect(site).toBeDefined();
		if (!site) return;

		const before = sitePlots(world, site);
		expect(before.length).toBeGreaterThan(0);
		generateSettlement(world, site, fallbackSettlementSpec(world, site));
		expect(sitePlots(world, site)).toEqual(before);
	});

	it("reports nothing for ground with nowhere to build", () => {
		// A site the sea or the slope leaves no room on. The survey drops these; without a
		// zero here it would keep naming them and hanging beats on them. A radius of 3 gives
		// the BSP a four-tile square to work with, which cannot yield a 5x5 plot at all — and
		// the site it is measured on is one that has plots in abundance at its own size, so
		// this is the geometry answering and not an accident of where the site sits.
		const { world, sites } = settlements("alpha");
		const site = sites[0];
		expect(site).toBeDefined();
		if (!site) return;

		expect(sitePlots(world, site).length).toBeGreaterThan(0);
		expect(sitePlots(world, { ...site, radius: 3 })).toHaveLength(0);
	});
});
