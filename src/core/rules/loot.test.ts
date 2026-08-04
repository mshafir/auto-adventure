import { describe, expect, it } from "vitest";
import { hashString } from "../rand/hash.js";
import { D } from "../tiles/decor.js";
import { containerContents, isContainer, itemsStoredIn, lootKey } from "./loot.js";

const SEED = hashString("vale");

describe("what counts as a container", () => {
	it("includes storage the player can open", () => {
		for (const decor of [D.chest, D.crate, D.barrel, D.shelf]) {
			expect(isContainer(decor)).toBe(true);
		}
	});

	it("excludes furniture and fittings", () => {
		// A bed is not a container, and neither is the anvil.
		for (const decor of [D.bed, D.table, D.anvil, D.hearth, D.well, D.none]) {
			expect(isContainer(decor)).toBe(false);
		}
	});
});

describe("container contents", () => {
	it("is a pure function of position, so a barrel does not refill", () => {
		// Nothing about a container is saved; only the fact that it was emptied. That
		// only works if asking twice gives the same answer.
		const once = containerContents(SEED, 7, 4, 5, D.crate, "mill");
		const twice = containerContents(SEED, 7, 4, 5, D.crate, "mill");
		expect(once).toEqual(twice);
	});

	it("gives different containers different contents", () => {
		const positions = [
			[3, 3],
			[4, 3],
			[5, 3],
			[3, 4],
			[6, 7],
			[8, 2],
		] as const;
		const results = positions.map(([x, y]) =>
			JSON.stringify(containerContents(SEED, 7, x, y, D.crate, "warehouse")),
		);
		expect(new Set(results).size).toBeGreaterThan(1);
	});

	it("yields nothing from something that is not a container", () => {
		expect(containerContents(SEED, 7, 4, 5, D.bed, "mill")).toEqual([]);
	});

	it("always puts something in a chest, because a chest is a find", () => {
		for (let x = 0; x < 12; x++) {
			expect(containerContents(SEED, 3, x, 1, D.chest, "ruin").length).toBe(1);
		}
	});

	it("leaves most everyday storage empty, so a warehouse is not a free shop", () => {
		// Fourteen crates should not be fourteen items.
		let holding = 0;
		const total = 40;
		for (let x = 0; x < total; x++) {
			if (containerContents(SEED, 9, x, 2, D.crate, "warehouse").length > 0) holding++;
		}
		expect(holding).toBeGreaterThan(0);
		expect(holding).toBeLessThan(total * 0.6);
	});

	it("only ever yields something the building is documented to store", () => {
		for (const structure of ["mill", "smithy", "warehouse", "inn", "ruin"]) {
			const allowed = new Set(itemsStoredIn(structure));
			for (let x = 0; x < 30; x++) {
				for (const item of containerContents(SEED, 5, x, 3, D.crate, structure)) {
					expect(allowed, `${structure} yielded ${item.name}`).toContain(item.name);
				}
			}
		}
	});

	it("gives a positive quantity and a description to everything it yields", () => {
		for (let x = 0; x < 30; x++) {
			for (const item of containerContents(SEED, 5, x, 3, D.chest, "mill")) {
				expect(item.quantity).toBeGreaterThan(0);
				expect(item.description.length).toBeGreaterThan(0);
			}
		}
	});
});

describe("what a building stores", () => {
	it("lets a mill hold timber", () => {
		// The errand that started all this: fetch timber from near the mill.
		expect(itemsStoredIn("mill")).toContain("Timber");
	});

	it("does not let a temple hold timber", () => {
		// The point of keying stores to the building is that the resolver can refuse
		// an errand the world cannot satisfy.
		expect(itemsStoredIn("temple")).not.toContain("Timber");
	});

	it("falls back to household goods for a kind with no store of its own", () => {
		const unknown = itemsStoredIn("observatory");
		expect(unknown.length).toBeGreaterThan(0);
		expect(unknown).toEqual(itemsStoredIn("house"));
	});
});

describe("remembering an emptied container", () => {
	it("keys on the interior and the position", () => {
		expect(lootKey(7, 4, 5)).toBe("looted:7:4,5");
	});

	it("distinguishes the same position in different interiors", () => {
		expect(lootKey(7, 4, 5)).not.toBe(lootKey(8, 4, 5));
	});

	it("has a distinct key for the open world", () => {
		expect(lootKey(undefined, 4, 5)).toBe("looted:world:4,5");
	});
});
