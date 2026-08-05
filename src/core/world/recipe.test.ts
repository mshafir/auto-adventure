import { describe, expect, it } from "vitest";
import { generateChunk } from "../gen/pipeline.js";
import { hashString } from "../rand/hash.js";
import { T } from "../tiles/terrain.js";
import { biomeDef } from "./biome.js";
import { CHUNK, localIndex } from "./coords.js";
import { elevationAt, elevationBand, moistureAt, roughnessAt } from "./fields.js";
import { macroSite, maxFeatureRadius, sitesAround } from "./macro.js";
import {
	DEFAULT_RULES,
	resolveRecipe,
	type WorldRecipe,
	worldKey,
	worldSeed,
	zoneInfluence,
} from "./recipe.js";

const SEED = hashString("recipe-test");
const PLAIN = worldSeed(SEED);

describe("the defaults are the old constants", () => {
	it("keeps the elevation bands where they were", () => {
		const { climate } = DEFAULT_RULES;
		expect([
			climate.seaLevel,
			climate.shoreLevel,
			climate.uplandLevel,
			climate.alpineLevel,
		]).toEqual([0.42, 0.46, 0.66, 0.8]);
	});

	it("reproduces the threshold ladder the site roll used to be written as", () => {
		// The old code was a chain of `if (roll > 0.985) return "town"` and so on. The
		// ladder is the same numbers arrived at by subtraction, and this is the assertion
		// that says so — if it drifts, every world in every save moves.
		expect(DEFAULT_RULES.sites.settled).toEqual([
			["town", 0.985],
			["village", 0.96],
			["fort", 0.945],
			["hamlet", 0.9],
			["camp", 0.87],
			["ruins", 0.845],
			["landmark", 0.82],
		]);
		expect(DEFAULT_RULES.sites.wild).toEqual([
			["ruins", 0.94],
			["landmark", 0.88],
		]);
	});

	it("gives an unconfigured world the shared default rules, not a copy", () => {
		// Identity matters: the settlement patch cache is keyed on `rules.key`, and two
		// structurally-equal-but-distinct default objects would halve its hit rate.
		expect(worldSeed(1).rules).toBe(DEFAULT_RULES);
		expect(worldKey(worldSeed(1))).toBe("1:d");
	});

	it("keeps a town within reach of the halo", () => {
		// The one bound that cannot be violated: a feature reaching further than the halo
		// looks exists in some chunks and not others.
		expect(maxFeatureRadius(DEFAULT_RULES)).toBe(35);
	});
});

describe("climate", () => {
	it("moves the coastline when the sea rises", () => {
		const drowned = worldSeed(SEED, { climate: { seaLevel: 0.6, shoreLevel: 0.64 } });
		let plainWater = 0;
		let drownedWater = 0;
		for (let y = -200; y < 200; y += 17) {
			for (let x = -200; x < 200; x += 17) {
				if (elevationBand(elevationAt(PLAIN, x, y), PLAIN.rules) === "ocean") plainWater++;
				if (elevationBand(elevationAt(drowned, x, y), drowned.rules) === "ocean") drownedWater++;
			}
		}
		expect(drownedWater).toBeGreaterThan(plainWater);
	});

	it("shifts moisture everywhere at once, clamped to the unit range", () => {
		const wet = worldSeed(SEED, { climate: { moistureBias: 0.3 } });
		for (const [x, y] of [
			[0, 0],
			[311, -97],
			[-1204, 640],
		] as const) {
			const before = moistureAt(PLAIN, x, y);
			const after = moistureAt(wet, x, y);
			expect(after).toBeCloseTo(Math.min(1, before + 0.3), 5);
		}
	});

	it("changes the shape of the terrain when the scale changes", () => {
		const broad = worldSeed(SEED, { climate: { elevationScale: 900 } });
		expect(elevationAt(broad, 500, 500)).not.toBeCloseTo(elevationAt(PLAIN, 500, 500), 3);
	});

	it("leaves roughness alone until it is asked to change", () => {
		const same = worldSeed(SEED, { climate: { moistureBias: 0.2 } });
		expect(roughnessAt(same, 88, -12)).toBe(roughnessAt(PLAIN, 88, -12));
	});
});

describe("biome overrides", () => {
	const recipe: WorldRecipe = {
		biomes: { forest: { scatterDensity: 0.95, name: "the Deepwood" } },
	};

	it("changes only the field named, and only in that biome", () => {
		const rules = resolveRecipe(recipe);
		expect(biomeDef("forest", rules).scatterDensity).toBe(0.95);
		expect(biomeDef("forest", rules).name).toBe("the Deepwood");
		// Everything else about a forest is inherited rather than reset to a default.
		expect(biomeDef("forest", rules).ground).toBe(biomeDef("forest", DEFAULT_RULES).ground);
		expect(biomeDef("forest", rules).scatter).toBe(biomeDef("forest", DEFAULT_RULES).scatter);
		expect(biomeDef("meadow", rules)).toEqual(biomeDef("meadow", DEFAULT_RULES));
	});

	it("does not mutate the shared default table", () => {
		resolveRecipe(recipe);
		expect(biomeDef("forest", DEFAULT_RULES).scatterDensity).toBe(0.62);
	});
});

describe("authored places", () => {
	const AT = { x: 640, y: 640 };
	const recipe: WorldRecipe = {
		places: [{ at: AT, kind: "town", importance: 5, radius: 26 }],
	};
	const world = worldSeed(SEED, recipe);
	const mx = Math.floor(AT.x / CHUNK);
	const my = Math.floor(AT.y / CHUNK);

	it("puts the site exactly where it was asked for", () => {
		const site = macroSite(world, mx, my);
		expect(site.site).toEqual(AT);
		expect(site.kind).toBe("town");
		expect(site.radius).toBe(26);
		expect(site.authored).toBe(true);
	});

	it("keeps the id the cell would have had", () => {
		// The whole reason a place is keyed by cell rather than appended: a `SiteSpec`
		// written for this town has to key identically whether the town was rolled or
		// authored, or moving it in the recipe orphans everything written about it.
		expect(macroSite(world, mx, my).id).toBe(macroSite(PLAIN, mx, my).id);
	});

	it("replaces whatever the cell would have rolled rather than sitting beside it", () => {
		const here = sitesAround(world, mx, my, 0);
		expect(here).toHaveLength(1);
		expect(here[0]?.site).toEqual(AT);
	});

	it("leaves every other cell alone", () => {
		for (let dy = -2; dy <= 2; dy++) {
			for (let dx = -2; dx <= 2; dx++) {
				if (dx === 0 && dy === 0) continue;
				expect(macroSite(world, mx + dx, my + dy)).toEqual(macroSite(PLAIN, mx + dx, my + dy));
			}
		}
	});

	it("counts an oversized place against the halo budget", () => {
		const huge = resolveRecipe({ places: [{ at: AT, kind: "town", radius: 118 }] });
		expect(maxFeatureRadius(huge)).toBe(118);
	});
});

describe("site weights", () => {
	it("empties the map when every weight is zero", () => {
		const empty = worldSeed(SEED, { sites: { weights: {}, wildWeights: {} } });
		// An explicit empty object still merges over the defaults key by key, so this is
		// only empty because `{}` supplies no keys — which is the behaviour an author
		// gets from `"weights": {}`, and not the one they want. Zeroes are how you mean it.
		const zeroed = worldSeed(SEED, {
			sites: {
				weights: { town: 0, village: 0, fort: 0, hamlet: 0, camp: 0, ruins: 0, landmark: 0 },
				wildWeights: { ruins: 0, landmark: 0 },
			},
		});
		expect(sitesAround(empty, 0, 0)).not.toHaveLength(0);
		expect(sitesAround(zeroed, 0, 0)).toHaveLength(0);
	});

	it("settles the map more thickly when a weight goes up", () => {
		const busy = worldSeed(SEED, { sites: { weights: { hamlet: 30 } } });
		expect(sitesAround(busy, 0, 0, 3).length).toBeGreaterThan(sitesAround(PLAIN, 0, 0, 3).length);
	});
});

describe("zones", () => {
	const CENTRE = { x: 100, y: 100 };
	const world = worldSeed(SEED, {
		zones: [{ at: CENTRE, radius: 120, moisture: 0.25, scatter: 3 }],
	});

	it("is strongest at the centre and exactly nothing at the rim", () => {
		expect(zoneInfluence(world.rules, CENTRE.x, CENTRE.y).moisture).toBeCloseTo(0.25, 6);
		expect(zoneInfluence(world.rules, CENTRE.x + 120, CENTRE.y).moisture).toBe(0);
		expect(zoneInfluence(world.rules, CENTRE.x + 400, CENTRE.y).moisture).toBe(0);
	});

	it("falls off smoothly, with no step anywhere along the radius", () => {
		// The property that lets a zone live inside a pure field function: a jump in the
		// influence is a jump in the terrain, and a jump that happens to land on a chunk
		// edge is a seam.
		let previous = zoneInfluence(world.rules, CENTRE.x, CENTRE.y).moisture;
		for (let d = 1; d <= 120; d++) {
			const here = zoneInfluence(world.rules, CENTRE.x + d, CENTRE.y).moisture;
			expect(here).toBeLessThanOrEqual(previous + 1e-9);
			expect(previous - here).toBeLessThan(0.01);
			previous = here;
		}
		expect(previous).toBeCloseTo(0, 6);
	});

	it("compounds where two zones overlap", () => {
		const both = worldSeed(SEED, {
			zones: [
				{ at: CENTRE, radius: 100, moisture: 0.2 },
				{ at: CENTRE, radius: 100, moisture: 0.2 },
			],
		});
		expect(zoneInfluence(both.rules, CENTRE.x, CENTRE.y).moisture).toBeCloseTo(0.4, 6);
	});

	it("thickens the scatter it covers and leaves the rest of the world alone", () => {
		const dense = worldSeed(SEED, {
			zones: [{ at: { x: 32, y: 32 }, radius: 90, scatter: 4 }],
		});
		const scattered = (w: typeof PLAIN) => {
			const { chunk } = generateChunk({ world: w }, { cx: 0, cy: 0 });
			let n = 0;
			for (let y = 0; y < CHUNK; y++) {
				for (let x = 0; x < CHUNK; x++) {
					const t = chunk.terrain[localIndex(x, y)];
					if (t === T.broadleaf || t === T.conifer || t === T.bush || t === T.flowers) n++;
				}
			}
			return n;
		};
		expect(scattered(dense)).toBeGreaterThan(scattered(PLAIN));

		// Far away the two worlds are the same map. A zone that changed terrain outside
		// its radius would not be a zone, it would be a climate setting.
		const far = { cx: 40, cy: 40 };
		const a = generateChunk({ world: dense }, far).chunk;
		const b = generateChunk({ world: PLAIN }, far).chunk;
		expect(a.terrain).toEqual(b.terrain);
	});

	it("does not move a coastline, a town or a road", () => {
		// Deliberately excluded from the zone effects: elevation decides where those are,
		// and a local bump would drag a settlement's footprint into the sea.
		const wet = worldSeed(SEED, {
			zones: [{ at: { x: 0, y: 0 }, radius: 400, moisture: 0.4, temperature: -0.3 }],
		});
		for (let d = 0; d < 400; d += 37) {
			expect(elevationAt(wet, d, d)).toBe(elevationAt(PLAIN, d, d));
		}
		expect(sitesAround(wet, 0, 0)).toEqual(sitesAround(PLAIN, 0, 0));
	});
});

describe("cache keys", () => {
	it("separates two worlds that share a seed and differ in recipe", () => {
		const a = worldSeed(7, { climate: { seaLevel: 0.5 } });
		const b = worldSeed(7, { climate: { seaLevel: 0.3 } });
		expect(worldKey(a)).not.toBe(worldKey(b));
		expect(worldKey(a)).not.toBe(worldKey(worldSeed(7)));
	});

	it("gives the same recipe the same key twice, so the caches are shared", () => {
		const recipe: WorldRecipe = { sites: { maxImportance: 3 } };
		expect(resolveRecipe(recipe).key).toBe(resolveRecipe({ ...recipe }).key);
	});
});
