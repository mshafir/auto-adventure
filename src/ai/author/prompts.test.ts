import { describe, expect, it } from "vitest";
import type { SiteSpec, WorldLore } from "../../core/world/spec.js";
import type { SurveyedSite } from "../../scenario/survey.js";
import { arcPrompt, MAIN_LINE_FLOOR, treePrompt } from "./prompts.js";

/**
 * What the authoring passes actually ask for.
 *
 * Prompts are usually not worth testing — the answer is a model's and the assertion would
 * be about wording. These two are worth it because they encode *arithmetic and policy*, and
 * both got it wrong in ways that were only visible in a finished world several minutes and
 * several dollars later.
 */

const LORE: WorldLore = {
	title: "The Rust Marches",
	premise: "The levy came and the iron stayed.",
	era: "the third year",
	tone: "dry",
	factions: ["The Tally Office"],
	deities: [],
};

function site(name: string, id: number): { entry: SurveyedSite; spec: SiteSpec } {
	const spec: SiteSpec = {
		siteId: id,
		name,
		shortName: name,
		description: "A town.",
		settlement: { name, walled: false, structures: [] },
		npcs: [
			{
				slot: 0,
				name: `${name}'s clerk`,
				role: "clerk",
				glyph: "C",
				appearance: "Inky.",
				persona: "Terse.",
				disposition: 0,
				placement: "doorstep",
				knows: [],
			},
		],
		hooks: [],
	};
	return {
		entry: {
			site: { id } as SurveyedSite["site"],
			context: {} as SurveyedSite["context"],
			distanceFromSpawn: 100,
			settlement: true,
		},
		spec,
	};
}

const SITES = [site("Rustgutter", 1), site("Rust-Hollow", 2), site("Saltgate", 3)];

function arc(beats: number): string {
	return arcPrompt({ brief: {}, lore: LORE, beats, sites: SITES });
}

describe("plotting an arc", () => {
	/*
	 * The bug two real generated worlds had, and the reason both read as having nothing to do.
	 * `tiny` is two beats; the side-errand count was floored at one; so the main line was a
	 * single beat, and the only other thing in the world was marked refusable. The player
	 * arrived, had one conversation, and the story was over — and no check could say so,
	 * because there was no second main beat for anything to be unclear about.
	 */
	it("asks for no side errands in a story too short to spare one", () => {
		for (const beats of [2, 3]) {
			const prompt = arc(beats);
			expect(prompt, `${beats} beats`).toContain("Mark none of them optional");
			expect(prompt, `${beats} beats`).not.toMatch(/\d+ of those \d+ beats must/);
		}
	});

	it("still asks for something to search for, however short the story is", () => {
		// A beat with nothing to find is a conversation; the object is what makes it happen in
		// a place. It is the one demand that survives at every length.
		for (const beats of [2, 3, 6, 10]) {
			expect(arc(beats), `${beats} beats`).toContain("hide something to find");
		}
	});

	it("asks for about one side errand per three beats once there are beats to spare", () => {
		expect(arc(6)).toContain("2 of those 6 beats must");
		expect(arc(10)).toContain("3 of those 10 beats must");
	});

	it("never asks for so many that the main line drops below three beats", () => {
		// The arithmetic, stated as the property rather than as the formula: whatever the
		// count is, what is left over has to still be a road.
		for (let beats = 1; beats <= 20; beats++) {
			const asked = arc(beats).match(/(\d+) of those \d+ beats must/);
			const optional = asked ? Number(asked[1]) : 0;
			expect(beats - optional, `${beats} beats`).toBeGreaterThanOrEqual(
				Math.min(beats, MAIN_LINE_FLOOR),
			);
		}
	});

	/*
	 * The other half of "I could not tell what to do next": the arc is the only pass that
	 * knows which beat follows which, so it is the only one that can be asked to name the
	 * next place in the prose the player is left holding.
	 */
	it("insists a beat names where the player goes next", () => {
		const prompt = arc(6);
		expect(prompt).toContain("Every beat must say where the player goes next");
		expect(prompt).toContain("name the person to ask for");
	});

	/*
	 * Asked for outright, because leaving them to the schema lost every story this pass wrote.
	 * `cappedText` trims rather than refuses — which is what stopped half the pipeline throwing
	 * good answers away — and both Claude models answered this prompt with a perfectly good list
	 * of beats, no title, no premise, and a schema failure that discarded the lot. Two live runs
	 * in a row came out with no story at all.
	 */
	it("asks for the story's own title and premise, which the schema alone did not get", () => {
		expect(arc(6)).toContain("Give the story a title and a premise of its own");
	});
});

describe("writing a conversation", () => {
	const base = {
		lore: LORE,
		site: SITES[0]?.spec as SiteSpec,
		npc: (SITES[0]?.spec as SiteSpec).npcs[0] as SiteSpec["npcs"][number],
		availableFlags: [],
	};

	/*
	 * A line of dialogue is the one piece of prose the player cannot miss: they are standing
	 * in front of it with nothing else on the screen. So it is where "go to Rust-Hollow and
	 * ask for the clerk" belongs, and the scene had no way of knowing that until it was told.
	 */
	it("says where the story goes next, by name, when the scene sends the player on", () => {
		const prompt = treePrompt({
			...base,
			sendsTo: { place: "Rust-Hollow", person: "Lune Harrowgate" },
		});
		expect(prompt).toContain("Rust-Hollow");
		expect(prompt).toContain("Lune Harrowgate");
		expect(prompt).toContain("Not a hint");
	});

	it("says nothing about going anywhere when the scene sends the player nowhere", () => {
		expect(treePrompt(base)).not.toContain("should go to");
	});

	/*
	 * What the thorough pass adds, and the whole of why it is more than a retry: a rewrite
	 * told what was wrong with the last attempt fixes it, and one asked to try again produces
	 * something different with the same fault in it. The notes are the validator's own
	 * sentences, passed through rather than paraphrased.
	 */
	it("hands a rewrite the faults from last time, in the words they were written in", () => {
		const note = "this opens while the player carries it and then takes it";
		const prompt = treePrompt({ ...base, notes: [note] });
		expect(prompt).toContain(note);
		expect(prompt).toContain("change nothing else about who they are");
		// Last, so it is the freshest thing in the context when the answer is composed.
		expect(prompt.indexOf(note)).toBeGreaterThan(prompt.indexOf("Only use an action"));
	});

	it("says nothing about a previous attempt on a first one", () => {
		expect(treePrompt(base)).not.toContain("written once already");
	});
});
