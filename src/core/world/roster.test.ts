import { describe, expect, it } from "vitest";
import { mergeOverride } from "../content/pack.js";
import { fallbackSettlementSpec } from "../gen/features/fallback-spec.js";
import { generateSettlement } from "../gen/features/settlement.js";
import { hashString } from "../rand/hash.js";
import { isSettlement, type MacroSite, macroSite } from "./macro.js";
import { mergeRecipe, type WorldRecipe, worldSeed } from "./recipe.js";
import { WorldRecipeSchema } from "./recipe-schema.js";

/**
 * What a settlement is made of used to be a table in the program, so no scenario and no
 * pack could say anything about it. These are the tests for it being data — and for the
 * defaults still producing the world they always did, which is the guard that says the
 * table was moved rather than rewritten.
 */

const SEED = hashString("roster-test");

/** The first settlement in a seed, which is a place with buildings in it. */
function aSettlement(recipe?: WorldRecipe): MacroSite {
	const world = worldSeed(SEED, recipe);
	for (let my = -6; my <= 6; my++) {
		for (let mx = -6; mx <= 6; mx++) {
			const site = macroSite(world, mx, my);
			if (isSettlement(site.kind) && site.kind !== "camp") return site;
		}
	}
	throw new Error("no settlement in the test seed");
}

function kindsBuiltAt(site: MacroSite, recipe?: WorldRecipe): string[] {
	const world = worldSeed(SEED, recipe);
	const patch = generateSettlement(world, site, fallbackSettlementSpec(world, site));
	return patch.buildings.map((building) => building.kind);
}

describe("the default roster", () => {
	it("still builds the settlements it always built", () => {
		const site = aSettlement();
		const spec = fallbackSettlementSpec(worldSeed(SEED), site);
		expect(spec.structures.length).toBeGreaterThan(0);
		// Every kind it names is one the registry can build, which is the property the
		// three hand-maintained copies of this list used to be relied on for.
		for (const structure of spec.structures) {
			expect(structure.size).toMatch(/^(small|medium|large)$/);
			expect(structure.importance).toBeGreaterThanOrEqual(1);
		}
	});

	it("walls a fort and leaves a hamlet open", () => {
		const world = worldSeed(SEED);
		const fort = { ...aSettlement(), kind: "fort" as const, importance: 1 };
		const hamlet = { ...aSettlement(), kind: "hamlet" as const, importance: 5 };
		expect(fallbackSettlementSpec(world, fort).walled).toBe(true);
		expect(fallbackSettlementSpec(world, hamlet).walled).toBe(false);
	});

	it("walls a town only once it is big enough to be worth the stone", () => {
		const world = worldSeed(SEED);
		const small = { ...aSettlement(), kind: "town" as const, importance: 3 };
		const large = { ...aSettlement(), kind: "town" as const, importance: 4 };
		expect(fallbackSettlementSpec(world, small).walled).toBe(false);
		expect(fallbackSettlementSpec(world, large).walled).toBe(true);
	});

	it("grows with importance, the way the switch it replaced did", () => {
		const world = worldSeed(SEED);
		const at = (importance: number) =>
			fallbackSettlementSpec(world, { ...aSettlement(), kind: "town" as const, importance })
				.structures.length;
		expect(at(5) - at(1)).toBe(4);
	});
});

describe("a roster a scenario wrote", () => {
	const LONGHOUSES: WorldRecipe = {
		sites: {
			roster: {
				village: { count: { base: 5 }, structures: [["barn", 1]] },
			},
		},
	};

	it("builds what it asked for instead of what the defaults would have", () => {
		const site = { ...aSettlement(), kind: "village" as const, importance: 3 };
		const spec = fallbackSettlementSpec(worldSeed(SEED, LONGHOUSES), site);
		expect(spec.structures).toHaveLength(5);
		expect(new Set(spec.structures.map((s) => s.kind))).toEqual(new Set(["barn"]));
	});

	it("leaves every other kind of place alone", () => {
		const site = { ...aSettlement(), kind: "hamlet" as const, importance: 3 };
		const written = fallbackSettlementSpec(worldSeed(SEED, LONGHOUSES), site);
		const plain = fallbackSettlementSpec(worldSeed(SEED), site);
		expect(written.structures.map((s) => s.kind)).toEqual(plain.structures.map((s) => s.kind));
	});

	it("changes what is actually standing on the ground, not only the spec", () => {
		const site = aSettlement();
		const before = kindsBuiltAt(site);
		const after = kindsBuiltAt(site, {
			sites: { roster: { [site.kind]: { count: { base: 6 }, structures: [["temple", 1]] } } },
		});
		expect(before).not.toEqual(after);
		expect(after.filter((kind) => kind === "temple").length).toBeGreaterThan(0);
	});

	it("is accepted from a recipe file", () => {
		const parsed = WorldRecipeSchema.safeParse(LONGHOUSES);
		expect(parsed.success).toBe(true);
	});

	it("refuses a building the generator has no plan for", () => {
		const parsed = WorldRecipeSchema.safeParse({
			sites: { roster: { village: { count: { base: 2 }, structures: [["longhouse", 1]] } } },
		});
		expect(parsed.success).toBe(false);
	});

	it("refuses a cave, which the cave feature builds rather than a roster", () => {
		const parsed = WorldRecipeSchema.safeParse({
			sites: { roster: { village: { count: { base: 2 }, structures: [["cave", 1]] } } },
		});
		expect(parsed.success).toBe(false);
	});
});

describe("mergeRecipe", () => {
	it("keeps whichever side is present when only one is", () => {
		const only = { climate: { seaLevel: 0.5 } };
		expect(mergeRecipe(only, undefined)).toBe(only);
		expect(mergeRecipe(undefined, only)).toBe(only);
	});

	it("lets the scenario correct the pack rather than the other way round", () => {
		const merged = mergeRecipe(
			{ climate: { seaLevel: 0.5, elevationBias: 0.3 } },
			{ climate: { seaLevel: 0.6 } },
		);
		expect(merged?.climate?.seaLevel).toBe(0.6);
		// Untouched by the scenario, so the pack's answer survives.
		expect(merged?.climate?.elevationBias).toBe(0.3);
	});

	it("merges rosters by kind, so changing the village keeps the hamlet", () => {
		const merged = mergeRecipe(
			{
				sites: {
					roster: {
						village: { count: { base: 5 }, structures: [["barn", 1]] },
						hamlet: { count: { base: 2 }, structures: [["house", 1]] },
					},
				},
			},
			{ sites: { roster: { village: { count: { base: 9 }, structures: [["tower", 1]] } } } },
		);
		expect(merged?.sites?.roster?.village?.count.base).toBe(9);
		expect(merged?.sites?.roster?.hamlet?.count.base).toBe(2);
	});

	it("replaces places, because writing them means these are the places", () => {
		const merged = mergeRecipe(
			{ places: [{ at: { x: 0, y: 0 }, kind: "town" }] },
			{ places: [{ at: { x: 99, y: 99 }, kind: "castle" }] },
		);
		expect(merged?.places).toHaveLength(1);
		expect(merged?.places?.[0]?.kind).toBe("castle");
	});
});

describe("a pack that ships a recipe fragment", () => {
	it("survives being merged with a scenario's own cosmetic tables", () => {
		const merged = mergeOverride(
			{
				id: "camelot",
				world: {
					sites: { roster: { village: { count: { base: 5 }, structures: [["barn", 1]] } } },
				},
			},
			{ appearance: { reeve: "A reeve with a tally stick and no patience." } },
		);
		// The scenario said nothing about the world, so the pack's fragment comes through
		// whole rather than being dropped by a merge that only knew about names.
		expect(merged?.world?.sites?.roster?.village?.count.base).toBe(5);
		expect(merged?.appearance?.reeve).toBeTruthy();
	});

	it("is folded in under whatever the scenario said itself", () => {
		const packSide = {
			sites: { roster: { village: { count: { base: 5 }, structures: [["barn", 1] as const] } } },
		};
		const scenarioSide = {
			sites: { roster: { village: { count: { base: 9 }, structures: [["tower", 1] as const] } } },
		};
		const merged = mergeRecipe(packSide, scenarioSide);
		expect(merged?.sites?.roster?.village?.count.base).toBe(9);
	});

	it("is accepted from a pack file", () => {
		const parsed = WorldRecipeSchema.safeParse({
			sites: {
				roster: {
					fort: { count: { base: 6, perImportance: 1 }, walled: true, structures: [["tower", 3]] },
				},
			},
		});
		expect(parsed.success).toBe(true);
	});
});
