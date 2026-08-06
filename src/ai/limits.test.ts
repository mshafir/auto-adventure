import { describe, expect, it } from "vitest";
import { TreeSchema } from "./author/schemas.js";
import { DialogueTurnSchema } from "./dialogue/schema.js";
import { RegionSpecSchema, SiteSpecSchema } from "./director/schemas.js";
import { cappedInt, cappedList, cappedText, toSlug, trimTo } from "./limits.js";

/**
 * The bug this file exists for, stated as tests.
 *
 * Sampling the live pipeline, roughly half of all authoring calls were being thrown away
 * — and *every* one of them for the same reason: a list one item over its cap, or a
 * sentence a few characters over. The answers were good. A discarded call falls back to
 * the deterministic spec, so the visible symptom was not an error but a thin world:
 * unnamed regions, and no story at all, because the arc is plotted only from settlements
 * that have people in them.
 */

describe("a cap that trims", () => {
	it("leaves anything inside the budget exactly as it was", () => {
		expect(cappedText(10).parse("short")).toBe("short");
		expect(cappedList(cappedText(10), 3).parse(["a", "b"])).toEqual(["a", "b"]);
		expect(cappedInt(1, 5).parse(3)).toBe(3);
	});

	it("takes the first n rather than refusing the lot", () => {
		expect(cappedList(cappedText(10), 2).parse(["a", "b", "c"])).toEqual(["a", "b"]);
	});

	it("cuts a long string at a word boundary when there is one to use", () => {
		// Mid-word truncation reads as corruption in a way a slightly short sentence does
		// not, and these strings are shown to the player.
		expect(trimTo("the wind tears at your cloak and hood", 24)).toBe("the wind tears at your");
	});

	it("cuts mid-word rather than losing most of the line", () => {
		// No space anywhere near the limit, so there is nothing to cut back to.
		expect(trimTo("aaaaaaaaaaaaaaaaaaaaaaaa bb", 10)).toBe("aaaaaaaaaa");
	});

	it("pulls a number back inside its range instead of rejecting it", () => {
		expect(cappedInt(-40, 60).parse(70)).toBe(60);
		expect(cappedInt(-40, 60).parse(-100)).toBe(-40);
		// A model asked for an integer occasionally offers a fraction.
		expect(cappedInt(1, 5).parse(3.5)).toBe(4);
	});
});

describe("the answers that used to be thrown away", () => {
	/** The exact shapes observed failing against the live gateway. */
	it("keeps a region that offered six ambient lines against a cap of five", () => {
		const parsed = RegionSpecSchema.parse({
			name: "Stone Rake",
			blurb: "A harsh country of wind-scoured rock.",
			tone: "weatherbeaten",
			culture: "folk who know the value of a good roof",
			factionName: "Salt Factors",
			lore: ["a", "b"],
			ambient: ["one", "two", "three", "four", "five", "six"],
		});
		expect(parsed.ambient).toHaveLength(5);
		expect(parsed.name).toBe("Stone Rake");
	});

	it("keeps a site that offered three hooks against a cap of two", () => {
		const parsed = SiteSpecSchema.parse({
			name: "Bravenrock",
			shortName: "Bravenrock",
			description: "A fortress on a hill.",
			walled: true,
			structures: [],
			npcs: [],
			hooks: ["one", "two", "three"],
		});
		expect(parsed.hooks).toEqual(["one", "two"]);
	});

	it("keeps a person whose knowledge ran ten characters long", () => {
		const knows = "x".repeat(170);
		const parsed = SiteSpecSchema.parse({
			name: "Bravenrock",
			shortName: "Bravenrock",
			description: "A fortress on a hill.",
			walled: true,
			structures: [],
			npcs: [
				{
					name: "Vance",
					role: "auditor",
					glyph: "A",
					appearance: "Ink to the elbow.",
					persona: "Precise.",
					disposition: 0,
					placement: "square",
					structureName: null,
					knows: [knows],
				},
			],
			hooks: [],
		});
		expect(parsed.npcs[0]?.knows[0]).toHaveLength(160);
	});

	it("keeps a turn that offered five replies against a cap of four", () => {
		const parsed = DialogueTurnSchema.parse({
			speech: "Well?",
			choices: ["a", "b", "c", "d", "e"],
			actions: [],
			endsConversation: false,
		});
		expect(parsed.choices).toHaveLength(4);
	});
});

describe("an identifier that is normalised rather than refused", () => {
	/**
	 * This one cost the entire dialogue pass. Asked for "a lower-case slug" the model
	 * reliably writes `ask_about_the_siege`, and a `.regex()` threw away every
	 * conversation in every generated world over it — measured at 0 of 4 calls surviving.
	 */
	it("accepts the shapes a model actually writes", () => {
		expect(toSlug("ask_about_the_siege", 48)).toBe("ask-about-the-siege");
		expect(toSlug("AskAboutSiege", 48)).toBe("askaboutsiege");
		expect(toSlug("  the gate's toll  ", 48)).toBe("the-gate-s-toll");
	});

	it("leaves a slug that was already one alone", () => {
		expect(toSlug("meet-the-clerk", 48)).toBe("meet-the-clerk");
	});

	it("never produces something the engine would reject", () => {
		for (const input of ["___", "9lives", "-leading", "trailing-", "", "!!!"]) {
			expect(toSlug(input, 48), input).toMatch(/^[a-z0-9][a-z0-9-]*$/);
		}
	});

	it("maps a reference and its target the same way", () => {
		// The whole reason this is one shared function: `goto`, `entry` and `partOf` point
		// at ids, so a normalised node must stay reachable from a reference that was
		// written in the same words.
		const node = TreeSchema.parse({
			entry: "Ask_About_Siege",
			entryAfter: [],
			revisit: null,
			nodes: [
				{
					id: "Ask_About_Siege",
					speech: "Well?",
					requiresFlag: null,
					choices: [{ text: "Go on", goto: "Tell_More", requiresFlag: null }],
					actions: [],
				},
				{
					id: "Tell_More",
					speech: "It has been nine years.",
					requiresFlag: null,
					choices: [],
					actions: [],
				},
			],
		});
		expect(node.entry).toBe(node.nodes[0]?.id);
		expect(node.nodes[0]?.choices[0]?.goto).toBe(node.nodes[1]?.id);
	});
});

describe("what a cap must still refuse", () => {
	// Trimming is for budgets. A missing field or a value from outside a closed set is a
	// genuinely unusable answer, and quietly inventing one would be far worse than
	// falling back to the deterministic spec.
	it("refuses an answer with a required field missing", () => {
		expect(() => RegionSpecSchema.parse({ name: "Stone Rake", blurb: "x", tone: "y" })).toThrow();
	});

	it("refuses a value outside a closed set", () => {
		expect(() =>
			SiteSpecSchema.parse({
				name: "x",
				shortName: "x",
				description: "x",
				walled: true,
				structures: [
					{ kind: "spaceport", name: null, signText: null, size: "small", importance: 1 },
				],
				npcs: [],
				hooks: [],
			}),
		).toThrow();
	});
});
