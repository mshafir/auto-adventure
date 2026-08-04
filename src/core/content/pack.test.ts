import { describe, expect, it } from "vitest";
import { getInterior } from "../gen/features/interior.js";
import { residentsOf } from "../gen/features/residents.js";
import { hashString } from "../rand/hash.js";
import { personName, placeName, regionName } from "../world/names.js";
import { DEFAULT_PACK } from "./default.js";
import { isOverrideEmpty, mergePack, type PackOverride } from "./pack.js";
import { ContentPackSchema, PackOverrideSchema } from "./schema.js";

const SEED = hashString("pack-test");

describe("the default pack", () => {
	it("validates against the full schema", () => {
		// Which is what makes `assets/content/default.json` a worked example an author
		// can copy rather than a fragment they have to guess the shape of.
		expect(ContentPackSchema.safeParse(DEFAULT_PACK).success).toBe(true);
	});

	it("has a head list for every mood, so no biome can name nothing", () => {
		for (const mood of ["wet", "green", "cold", "dry", "high", "plain"] as const) {
			expect(DEFAULT_PACK.names.heads[mood].length, mood).toBeGreaterThan(0);
		}
	});

	it("has a house household, which is the fallback for any unlisted kind", () => {
		expect(DEFAULT_PACK.households.house?.roles.length).toBeGreaterThan(0);
	});
});

describe("mergePack", () => {
	it("returns the base untouched when nothing was overridden", () => {
		expect(mergePack(DEFAULT_PACK)).toBe(DEFAULT_PACK);
	});

	it("merges maps by key, so changing one trade keeps the other thirty", () => {
		// The usability of the whole format rests on this: restating thirty appearance
		// lines to change one is how a config format stops being used.
		const merged = mergePack(DEFAULT_PACK, {
			appearance: { cooper: "Up to the elbows in pitch." },
		});
		expect(merged.appearance.cooper).toBe("Up to the elbows in pitch.");
		expect(merged.appearance.weaver).toBe(DEFAULT_PACK.appearance.weaver);
	});

	it("replaces lists, because appending would keep the names being replaced", () => {
		const merged = mergePack(DEFAULT_PACK, { names: { given: ["Ott", "Bevan"] } });
		expect(merged.names.given).toEqual(["Ott", "Bevan"]);
		// And a list not mentioned is left alone.
		expect(merged.names.family).toEqual(DEFAULT_PACK.names.family);
	});

	it("merges head lists by mood rather than replacing the whole set", () => {
		const merged = mergePack(DEFAULT_PACK, { names: { heads: { green: ["timber"] } } });
		expect(merged.names.heads.green).toEqual(["timber"]);
		expect(merged.names.heads.cold).toEqual(DEFAULT_PACK.names.heads.cold);
	});

	it("takes the override's id, so a log says which pack is in play", () => {
		expect(mergePack(DEFAULT_PACK, { id: "thornwick" }).id).toBe("thornwick");
		expect(mergePack(DEFAULT_PACK, { appearance: {} }).id).toBe("default");
	});
});

describe("isOverrideEmpty", () => {
	it("treats an id on its own as saying nothing", () => {
		// An id is bookkeeping, not content, so a file with only an id should not be
		// persisted onto a world as though it had changed something.
		expect(isOverrideEmpty({ id: "named" })).toBe(true);
		expect(isOverrideEmpty(undefined)).toBe(true);
		expect(isOverrideEmpty({ appearance: {} })).toBe(true);
		expect(isOverrideEmpty({ appearance: { cooper: "x" } })).toBe(false);
	});
});

describe("a pack in the generators", () => {
	it("renames people", () => {
		const pack = mergePack(DEFAULT_PACK, {
			names: { given: ["Ott"], family: ["Pell"] },
		});
		expect(personName(SEED, 1, 0, pack)).toBe("Ott Pell");
	});

	it("renames places and regions", () => {
		const pack = mergePack(DEFAULT_PACK, {
			names: { heads: { plain: ["cord"] }, tails: ["house"], regionTails: ["fell"] },
		});
		expect(placeName(SEED, 7, "village", "grassland", pack)).toMatch(/^Cord ?[Hh]ouse$/);
		expect(regionName(SEED, 7, "grassland", pack)).toBe("Cord Fell");
	});

	it("repeoples a household with different trades", () => {
		const pack = mergePack(DEFAULT_PACK, {
			households: { house: { count: [2, 2], roles: ["feller"] } },
			appearance: { feller: "Sawdust in the cuffs, axe by the door." },
		});
		const interior = getInterior(SEED, 4242, "house");
		const people = residentsOf(SEED, 4242, "house", interior, pack);
		expect(people).toHaveLength(2);
		expect(people.every((person) => person.role === "feller")).toBe(true);
		expect(people[0]?.spec.appearance).toBe("Sawdust in the cuffs, axe by the door.");
	});

	it("empties a building a pack says nobody lives in", () => {
		const pack = mergePack(DEFAULT_PACK, {
			households: { house: { count: [0, 0], roles: [] } },
		});
		const interior = getInterior(SEED, 99, "house");
		expect(residentsOf(SEED, 99, "house", interior, pack)).toEqual([]);
	});

	it("still describes a trade the pack forgot to write a line for", () => {
		// So an author can add a role to a household without the game refusing to run
		// until they have also written its appearance.
		const pack = mergePack(DEFAULT_PACK, {
			households: { house: { count: [1, 1], roles: ["tithe-clerk"] } },
		});
		const interior = getInterior(SEED, 77, "house");
		const person = residentsOf(SEED, 77, "house", interior, pack)[0];
		expect(person?.spec.appearance.length ?? 0).toBeGreaterThan(0);
		expect(person?.spec.persona.length ?? 0).toBeGreaterThan(0);
	});
});

describe("the override schema", () => {
	it("accepts a pack that changes only one thing", () => {
		expect(PackOverrideSchema.safeParse({ appearance: { cooper: "x" } }).success).toBe(true);
	});

	it("refuses an empty name list, which would name everybody undefined", () => {
		// The failure this prevents is silent and total: `pick` indexes into nothing and
		// every person in the world is called "undefined undefined".
		expect(PackOverrideSchema.safeParse({ names: { given: [] } }).success).toBe(false);
	});

	it("refuses an id that could not be a filename", () => {
		expect(PackOverrideSchema.safeParse({ id: "Not A Slug" }).success).toBe(false);
	});

	const override: PackOverride = { id: "ok", wanderers: [{ role: "carter", placement: "well" }] };
	it("round-trips a valid override", () => {
		expect(PackOverrideSchema.parse(override)).toEqual(override);
	});
});
