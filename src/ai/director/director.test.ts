import { beforeEach, describe, expect, it } from "vitest";
import { generateSettlement } from "../../core/gen/features/settlement.js";
import { hashString } from "../../core/rand/hash.js";
import { siteContext } from "../../core/world/context.js";
import { isSettlement, type MacroSite, macroSite } from "../../core/world/macro.js";
import { worldSeed } from "../../core/world/recipe.js";
import type { SiteSpec } from "../../core/world/spec.js";
import { npcId } from "../../core/world/spec.js";
import { Director } from "./director.js";
import { fallbackLore, fallbackRegion, fallbackSite } from "./fallback.js";
import { STRUCTURE_KINDS } from "./schemas.js";

const SEED = hashString("director-test");

/** The first settlement of a given kind in a search around the origin. */
function findSite(seed: number, kinds?: readonly MacroSite["kind"][]): MacroSite {
	for (let radius = 0; radius < 16; radius++) {
		for (let my = -radius; my <= radius; my++) {
			for (let mx = -radius; mx <= radius; mx++) {
				const site = macroSite(worldSeed(seed), mx, my);
				if (!isSettlement(site.kind)) continue;
				if (kinds && !kinds.includes(site.kind)) continue;
				return site;
			}
		}
	}
	throw new Error("no matching settlement within 16 macro cells");
}

function stubDirector(overrides: Partial<ConstructorParameters<typeof Director>[0]> = {}) {
	const learned: { spec: SiteSpec; source: string }[] = [];
	const changed: MacroSite[] = [];
	const director = new Director({
		world: worldSeed(SEED),
		disabled: true,
		onLore: () => undefined,
		onRegion: () => undefined,
		onSite: (spec, source) => learned.push({ spec, source }),
		onSiteChanged: (site) => changed.push(site),
		...overrides,
	});
	return { director, learned, changed };
}

describe("deterministic fallbacks", () => {
	it("names every settlement without a model", () => {
		const site = findSite(SEED);
		const spec = fallbackSite(worldSeed(SEED), site, siteContext(worldSeed(SEED), site));
		expect(spec.name).toMatch(/\S/);
		expect(spec.shortName).toMatch(/\S/);
		expect(spec.settlement.structures.length).toBeGreaterThan(0);
	});

	it("produces the same spec twice", () => {
		const site = findSite(SEED);
		const a = fallbackSite(worldSeed(SEED), site, siteContext(worldSeed(SEED), site));
		const b = fallbackSite(worldSeed(SEED), site, siteContext(worldSeed(SEED), site));
		expect(a).toEqual(b);
	});

	it("only ever names structure kinds the generator knows how to build", () => {
		// The fallback shares the generator's roster, so this is really a guard
		// against the two drifting apart — the schema the model answers against is
		// built from the same list.
		for (let mx = -4; mx <= 4; mx++) {
			for (let my = -4; my <= 4; my++) {
				const site = macroSite(worldSeed(SEED), mx, my);
				if (site.kind === "none") continue;
				const spec = fallbackSite(worldSeed(SEED), site, siteContext(worldSeed(SEED), site));
				for (const structure of spec.settlement.structures) {
					expect(STRUCTURE_KINDS).toContain(structure.kind);
					expect(structure.importance).toBeGreaterThanOrEqual(1);
					expect(structure.importance).toBeLessThanOrEqual(5);
				}
			}
		}
	});

	it("satisfies every precondition the settlement generator has", () => {
		// The point of a fallback is that it can never be the reason generation
		// fails, so it is run straight through the real generator. A place with
		// room for buildings must actually get them: a spec the generator quietly
		// discards is the failure mode worth catching.
		const site = findSite(SEED, ["town", "village"]);
		const spec = fallbackSite(worldSeed(SEED), site, siteContext(worldSeed(SEED), site));
		const patch = generateSettlement(worldSeed(SEED), site, spec.settlement);
		expect(patch.buildings.length).toBeGreaterThan(0);
		for (const building of patch.buildings) {
			expect(patch.bounds.x).toBeLessThanOrEqual(building.rect.x);
		}
	});

	it("gives every fallback NPC a single-letter glyph and a placement", () => {
		const site = findSite(SEED);
		const spec = fallbackSite(worldSeed(SEED), site, siteContext(worldSeed(SEED), site));
		expect(spec.npcs.length).toBeGreaterThan(0);
		for (const npc of spec.npcs) {
			expect(npc.glyph).toMatch(/^[A-Z]$/);
			expect(npc.name).toMatch(/\S/);
			expect(npc.slot).toBeGreaterThanOrEqual(0);
		}
	});

	it("has a lore and a region fallback that read as prose", () => {
		expect(fallbackLore().premise.length).toBeGreaterThan(40);
		const region = fallbackRegion(SEED, {
			regionId: 7,
			biome: "marsh",
			biomeName: "Marsh",
			biomes: ["Marsh"],
			settlementKinds: ["hamlet"],
		});
		expect(region.name).toMatch(/\S/);
		expect(region.ambient.length).toBeGreaterThan(0);
	});
});

describe("director with no model", () => {
	let site: MacroSite;
	beforeEach(() => {
		site = findSite(SEED);
	});

	it("is inactive without a gateway key", () => {
		const { director } = stubDirector();
		expect(director.active).toBe(false);
	});

	it("still commits a spec for everything the player walks up to", () => {
		const { director, learned } = stubDirector();
		expect(director.specFor(site)).toBeUndefined();

		director.request({ cx: site.mx, cy: site.my });

		expect(director.specFor(site)?.structures.length).toBeGreaterThan(0);
		expect(learned.some((l) => l.spec.siteId === site.id && l.source === "fallback")).toBe(true);
	});

	it("commits each site exactly once, however often the player walks past", () => {
		const { director, learned } = stubDirector();
		for (let i = 0; i < 5; i++) director.request({ cx: site.mx, cy: site.my });
		const forSite = learned.filter((l) => l.spec.siteId === site.id);
		expect(forSite).toHaveLength(1);
	});

	it("never rebuilds a settlement, because nothing authored ever arrives", () => {
		const { director, changed } = stubDirector();
		director.request({ cx: site.mx, cy: site.my });
		expect(changed).toEqual([]);
	});
});

describe("director restored from a save", () => {
	it("reuses the persisted spec rather than re-deciding", () => {
		const site = findSite(SEED);
		const saved: SiteSpec = {
			siteId: site.id,
			name: "Ashreach",
			shortName: "Ashreach",
			description: "A place from a previous session.",
			settlement: { walled: true, structures: [{ kind: "inn", size: "medium", importance: 5 }] },
			npcs: [],
			hooks: [],
		};

		const { director, learned } = stubDirector({
			sites: { [String(site.id)]: saved },
			sources: { [String(site.id)]: "llm" },
		});

		expect(director.siteSpec(site.id)?.name).toBe("Ashreach");
		director.request({ cx: site.mx, cy: site.my });
		// Already committed by the save, so no new spec is manufactured over it.
		expect(learned.filter((l) => l.spec.siteId === site.id)).toHaveLength(0);
		expect(director.specFor(site)?.walled).toBe(true);
	});
});

describe("npc identity", () => {
	it("is stable for a site and slot", () => {
		expect(npcId(1234, 2)).toBe(npcId(1234, 2));
		expect(npcId(1234, 2)).not.toBe(npcId(1234, 3));
	});

	it("survives a negative site hash", () => {
		// Site ids come from a 32-bit hash and may be signed; the id must still be
		// a stable string rather than flipping sign between runs.
		expect(npcId(-5, 0)).toBe(npcId(-5, 0));
		expect(npcId(-5, 0)).not.toContain("-");
	});
});
