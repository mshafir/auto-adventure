import { describe, expect, it } from "vitest";
import { createNpcRecord } from "../../core/rules/npc.js";
import { createInitialState } from "../../core/rules/state.js";
import type { Surroundings } from "../../core/rules/surroundings.js";
import type { WorldLore } from "../../core/world/spec.js";
import { dialogueSystem, type PersonaInput } from "./persona.js";

const LORE: WorldLore = {
	title: "The Hollowmoor",
	premise: "The fens are rising.",
	era: "the late drainage years",
	tone: "eerie",
	factions: ["the Fen Wardens"],
	deities: ["Ninth Silt"],
};

const STATE = createInitialState(
	{ id: "t", name: "t", seed: 1, createdAt: "2026-01-01T00:00:00.000Z" },
	{ x: 0, y: 0 },
);

const WORLD: Surroundings = {
	place: "Harrowfen",
	buildings: [
		{ name: "Harrowmill Mill", kind: "mill" },
		{ name: "house", kind: "house" },
	],
	people: [{ name: "Wren", role: "miller" }],
	places: ["Stonecutter's Reach"],
	items: ["Coil of Rope"],
};

function system(surroundings?: Surroundings): string {
	const input: PersonaInput = {
		lore: LORE,
		record: createNpcRecord({ id: "npc:1:0", name: "Wren", role: "miller", siteId: 1 }),
		state: STATE,
		...(surroundings ? { surroundings } : {}),
	};
	return dialogueSystem(input);
}

describe("grounding the prompt", () => {
	/**
	 * An NPC used to be told its town's name and description and nothing else
	 * physical, so it furnished a plausible village from tone alone — sending the
	 * player after timber from a mill the generator had never placed.
	 */
	it("names every building the generator actually placed", () => {
		const prompt = system(WORLD);
		expect(prompt).toContain("Harrowmill Mill");
		expect(prompt).toContain("mill");
	});

	it("names a building by kind when it has no authored name", () => {
		// A `house` with no name should read as "the house", not "house (house)".
		expect(system(WORLD)).toContain("- the house");
	});

	it("names the people and the neighbouring places", () => {
		const prompt = system(WORLD);
		expect(prompt).toContain("Wren, miller");
		expect(prompt).toContain("Stonecutter's Reach");
	});

	it("states the list is exhaustive and forbids inventing more", () => {
		// A model handed a bare list treats it as a sample and invents the rest,
		// which is the whole failure. The constraint has to be explicit, or the
		// action boundary silently drops the objective it made up.
		const prompt = system(WORLD);
		expect(prompt).toContain("there are no others");
		expect(prompt).toMatch(/Do not invent a building/);
	});

	it("says nothing at all when there are no surroundings", () => {
		// A world with no grounding must produce the prompt it always did, so an
		// unwired caller degrades to the old behaviour rather than to a lie about
		// there being no buildings anywhere.
		const prompt = system();
		expect(prompt).not.toContain("there are no others");
		expect(prompt).not.toContain("Do not invent");
	});

	it("omits the constraint when the site is genuinely empty", () => {
		// Claiming "these are all the buildings" of an empty list would tell an NPC
		// standing in a hamlet that the hamlet does not exist.
		const empty: Surroundings = { buildings: [], people: [], places: [], items: [] };
		const prompt = system(empty);
		expect(prompt).not.toContain("there are no others");
		expect(prompt).not.toContain("Do not invent");
	});
});

describe("what the model is given to name things after", () => {
	/**
	 * The grounding has to be worth reading, not just present.
	 *
	 * Listed one per line, a real town put "the house" in front of the model five
	 * times and "the smithy" twice — a list of words rather than a list of places.
	 * With nothing distinctive to name an errand after, the model invents a name,
	 * the boundary refuses it, and the player is handed a quest with nothing in it.
	 */
	const CROWDED: Surroundings = {
		place: "Brackgate",
		buildings: [
			{ name: "house", kind: "house" },
			{ name: "house", kind: "house" },
			{ name: "house", kind: "house" },
			{ name: "smithy", kind: "smithy" },
			{ name: "smithy", kind: "smithy" },
			{ name: "The Slaked Ox", kind: "inn" },
		],
		people: [{ name: "Wren", role: "miller" }],
		places: [],
		items: ["Timber", "Coil of Rope"],
	};

	it("counts repeated buildings instead of repeating them", () => {
		const prompt = system(CROWDED);
		expect(prompt).toContain("3 houses");
		expect(prompt).toContain("2 smithies");
		expect(prompt.match(/- the house/g)).toBeNull();
	});

	it("still lists a named building individually, because the name is the point", () => {
		expect(system(CROWDED)).toContain("The Slaked Ox (inn)");
	});

	it("pluralises the awkward kinds correctly", () => {
		const kinds: Surroundings = {
			...CROWDED,
			buildings: [
				{ name: "smithy", kind: "smithy" },
				{ name: "smithy", kind: "smithy" },
				{ name: "warehouse", kind: "warehouse" },
				{ name: "warehouse", kind: "warehouse" },
			],
		};
		const prompt = system(kinds);
		expect(prompt).toContain("2 smithies");
		expect(prompt).toContain("2 warehouses");
	});

	it("names the things that can actually be fetched", () => {
		// Without this the model has no idea what anything is called, so it asks for
		// firewood in a place that has Timber and the objective is refused.
		expect(system(CROWDED)).toContain("Timber");
		expect(system(CROWDED)).toMatch(/bought or found here/);
	});

	it("says nothing about items when there are none", () => {
		const bare: Surroundings = { ...CROWDED, items: [] };
		expect(system(bare)).not.toMatch(/bought or found here/);
	});
});
