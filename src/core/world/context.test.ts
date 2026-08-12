import { beforeEach, describe, expect, it } from "vitest";
import { clearFeatureCache } from "../gen/features/registry.js";
import { sitePlots } from "../gen/features/settlement.js";
import { hashString } from "../rand/hash.js";
import { ambition, buildingBudget } from "./context.js";
import { macroSite } from "./macro.js";
import { worldSeed } from "./recipe.js";
import { clearRiverCache } from "./rivers.js";
import { clearRoadCache } from "./roads.js";

/**
 * How many buildings a place may be asked for.
 *
 * The number reaches the model as "give exactly N structures", so it is not advice: a
 * budget the ground cannot keep is a roster whose tail becomes filler, and the story's
 * counting house is somewhere in that tail.
 */

beforeEach(() => {
	clearFeatureCache();
	clearRoadCache();
	clearRiverCache();
});

/**
 * A town with far less room than its radius suggests.
 *
 * Found by sweeping eight seeds over eleven macro cells square: sixty of the eighty
 * settlements there hold fewer plots than the formula promises, and this is the widest gap
 * of them — a town of radius 35 on ground that yields two plots, against an estimate of
 * fourteen.
 */
const CRAMPED = { seed: "harrow", mx: 2, my: -4 } as const;

/**
 * A town with more room than a roster should use.
 *
 * The same sweep the other way round. At radius 48 — which is exactly what a town of the
 * highest importance comes to — this site yields more than thirty plots, so it is the case
 * where the ambition ceiling has to be the one that binds.
 */
const ROOMY = { seed: "vale", mx: -1, my: 1 } as const;

describe("the building budget", () => {
	it("never promises more buildings than the ground can hold", () => {
		const world = worldSeed(hashString(CRAMPED.seed));
		const site = macroSite(world, CRAMPED.mx, CRAMPED.my);
		const plots = sitePlots(world, site).length;

		expect(buildingBudget(world, site)).toBeLessThanOrEqual(plots);
		// And the case is a real one: the estimate alone would have promised far more.
		expect(ambition(site)).toBeGreaterThan(plots);
	});

	it("still caps a roomy site by what a roster is for, rather than by its plot count", () => {
		// Measuring is a ceiling, not a target: a site with thirty plots should not be asked
		// for thirty buildings, because a roster is a cast list and a story as well.
		const world = worldSeed(hashString(ROOMY.seed));
		const site = { ...macroSite(world, ROOMY.mx, ROOMY.my), radius: 48 };

		expect(sitePlots(world, site).length).toBeGreaterThan(ambition(site));
		expect(buildingBudget(world, site)).toBe(ambition(site));
	});

	it("leaves the kinds that lay out their own buildings to their own rules", () => {
		// A castle's ward and a dock's row of sheds are not solved against a roster, and
		// `sitePlots` does not describe them — measuring them would report zero and silence
		// a castle entirely.
		const world = worldSeed(hashString("alpha"));
		const base = macroSite(world, 0, 0);
		for (const kind of ["castle", "docks"] as const) {
			const site = { ...base, kind, radius: 20 };
			expect(buildingBudget(world, site), kind).toBe(ambition(site));
			expect(buildingBudget(world, site), kind).toBeGreaterThan(0);
		}
	});

	it("asks for nothing at a cave, which has nothing above ground", () => {
		const world = worldSeed(hashString("alpha"));
		const site = { ...macroSite(world, 0, 0), kind: "cave" as const, radius: 9 };
		expect(buildingBudget(world, site)).toBe(0);
	});
});
