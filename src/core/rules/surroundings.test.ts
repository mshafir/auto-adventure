import { describe, expect, it } from "vitest";
import { namesMatch, resolveName } from "./surroundings.js";

describe("name matching", () => {
	it("matches an exact name regardless of case and padding", () => {
		expect(namesMatch("The Mill", "  the mill ")).toBe(true);
	});

	it("matches either way round, because an NPC says less than the world does", () => {
		// The director names a building "Harrowmill Mill"; the NPC says "the mill".
		expect(namesMatch("the mill", "Harrowmill Mill")).toBe(true);
		expect(namesMatch("Harrowmill Mill", "mill")).toBe(true);
	});

	it("does not match unrelated names", () => {
		expect(namesMatch("the mill", "Stonecutter's Yard")).toBe(false);
	});

	it("treats an empty name as matching nothing", () => {
		expect(namesMatch("", "the mill")).toBe(false);
		expect(namesMatch("   ", "the mill")).toBe(false);
		expect(namesMatch("the mill", "")).toBe(false);
	});
});

describe("resolving a requested name", () => {
	it("returns the world's spelling, not the model's", () => {
		// So the quest log and the place label agree.
		expect(resolveName("the mill", ["Harrowmill Mill", "The Slaked Ox"])).toBe("Harrowmill Mill");
	});

	it("prefers an exact match over a longer one that merely contains it", () => {
		// Regression: with both present, "Mill" must not resolve to the barracks
		// just because the barracks happened to be listed first.
		expect(resolveName("Mill", ["Millgate Barracks", "Mill"])).toBe("Mill");
	});

	it("prefers the shortest partial match, independent of listing order", () => {
		const candidates = ["Millgate Barracks and Armoury", "Millgate Barracks"];
		expect(resolveName("millgate", candidates)).toBe("Millgate Barracks");
		expect(resolveName("millgate", [...candidates].reverse())).toBe("Millgate Barracks");
	});

	it("returns undefined when nothing in the world answers to the name", () => {
		expect(resolveName("the mill", ["The Slaked Ox", "Fenwick"])).toBeUndefined();
	});

	it("returns undefined for an empty request and an empty world", () => {
		expect(resolveName("", ["Mill"])).toBeUndefined();
		expect(resolveName("Mill", [])).toBeUndefined();
	});
});

describe("resolution and verification agree", () => {
	/**
	 * The two halves of the fix have to use the same rule.
	 *
	 * An objective is resolved against the world when the quest is created, and
	 * matched against the world again when the player arrives. If those used
	 * different comparisons, a quest could resolve at creation and then never
	 * complete — which is indistinguishable, from the player's side, from the
	 * broken behaviour this replaced.
	 */
	const BUILDINGS = ["Harrowmill Mill", "The Slaked Ox", "Millgate Barracks"];

	it("matches on arrival whatever it resolved to at creation", () => {
		for (const said of ["the mill", "Harrowmill Mill", "the Slaked Ox", "millgate barracks"]) {
			const resolved = resolveName(said, BUILDINGS);
			expect(resolved, `"${said}" did not resolve`).toBeDefined();
			if (!resolved) continue;
			// Arriving at the building the objective now names must satisfy it.
			expect(namesMatch(resolved, resolved), `"${resolved}" does not match itself`).toBe(true);
		}
	});

	it("does not resolve a milling errand to the barracks", () => {
		// "mill" is a substring of "Millgate", so substring matching would send the
		// player to a barracks. Word matching declines instead, and the objective is
		// dropped rather than pointing somewhere the NPC never meant.
		expect(resolveName("the mill", ["Millgate Barracks"])).toBeUndefined();
		expect(namesMatch("the mill", "Millgate Barracks")).toBe(false);
	});

	it("lets a building's kind satisfy a target that names the building", () => {
		// `reach` also matches the kind of building the player is standing in, which
		// is what makes an unnamed mill work.
		expect(namesMatch("Harrowmill Mill", "mill")).toBe(true);
	});

	it("does not let a town name satisfy a building target", () => {
		expect(namesMatch("Harrowmill Mill", "Harrowfen")).toBe(false);
	});
});
