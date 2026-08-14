import { describe, expect, it } from "vitest";
import type { DialogueTree } from "../ai/dialogue/tree.js";
import type { ScenarioBeat } from "../core/rules/arc.js";
import type { Placement } from "../core/rules/placement.js";
import { createInitialState, type GameState } from "../core/rules/state.js";
import {
	composeScenario,
	enteredPhaseIds,
	type Phase,
	phaseProblems,
	type ScenarioContent,
} from "./phase.js";

function state(flags: Record<string, string | number | boolean> = {}): GameState {
	const base = createInitialState({ id: "w", name: "W", seed: 1, createdAt: "" }, { x: 0, y: 0 });
	return { ...base, flags };
}

const EMPTY: ScenarioContent = {
	sites: {},
	placements: [],
	signs: [],
	barriers: [],
	triggers: [],
	terraform: [],
	trees: {},
	scenes: {},
};

function thing(id: string, description = "A thing."): Placement {
	return { id, at: { kind: "world", x: 0, y: 0 }, item: { name: id, description } };
}

function withPlacements(...ids: string[]): ScenarioContent {
	return { ...EMPTY, placements: ids.map((id) => thing(id)) };
}

/** A conversation shaped enough to be told apart from another. */
function tree(npcId: string, entry = "start"): DialogueTree {
	return { npcId, entry: [entry], nodes: {} };
}

const FLOOD = { flag: "flood" } as const;

describe("enteredPhaseIds", () => {
	it("always includes a phase with no condition", () => {
		expect(enteredPhaseIds([{ id: "1-base", name: "The Quiet Vale" }], state())).toEqual([
			"1-base",
		]);
	});

	it("includes a conditional phase only once its condition holds", () => {
		const phases: Phase[] = [
			{ id: "1-base", name: "Before" },
			{ id: "2-after", name: "After", when: FLOOD },
		];
		expect(enteredPhaseIds(phases, state())).toEqual(["1-base"]);
		expect(enteredPhaseIds(phases, state({ flood: true }))).toEqual(["1-base", "2-after"]);
	});

	it("reports them in file order, not in the order they became true", () => {
		const phases: Phase[] = [
			{ id: "2-flood", name: "Flood", when: FLOOD },
			{ id: "3-thaw", name: "Thaw", when: { flag: "thaw" } },
		];
		expect(enteredPhaseIds(phases, state({ thaw: true, flood: true }))).toEqual([
			"2-flood",
			"3-thaw",
		]);
	});
});

describe("composeScenario", () => {
	it("adds what a phase adds", () => {
		const composed = composeScenario(
			withPlacements("ledger"),
			[{ id: "2", name: "After", when: FLOOD, placements: { add: [thing("body", "Drowned.")] } }],
			state({ flood: true }),
		);
		expect(composed.placements.map((p) => p.id)).toEqual(["ledger", "body"]);
	});

	it("leaves the base alone when the phase has not been entered", () => {
		const composed = composeScenario(
			withPlacements("ledger"),
			[{ id: "2", name: "After", when: FLOOD, placements: { add: [thing("body")] } }],
			state(),
		);
		expect(composed.placements.map((p) => p.id)).toEqual(["ledger"]);
	});

	it("hands back the very same content when no phase applies", () => {
		// Identity, not equality: the engine compares by reference to decide whether anything
		// has to be recomposed, and composition runs after every command.
		const base = withPlacements("ledger");
		expect(composeScenario(base, [{ id: "2", name: "After", when: FLOOD }], state())).toBe(base);
	});

	it("removes what a phase removes", () => {
		const composed = composeScenario(
			withPlacements("ledger", "lantern"),
			[{ id: "2", name: "After", when: FLOOD, placements: { remove: ["lantern"] } }],
			state({ flood: true }),
		);
		expect(composed.placements.map((p) => p.id)).toEqual(["ledger"]);
	});

	it("replaces by id, and keeps the position it had", () => {
		const composed = composeScenario(
			withPlacements("ledger", "lantern"),
			[
				{
					id: "2",
					name: "After",
					when: FLOOD,
					placements: { replace: [thing("ledger", "Sodden.")] },
				},
			],
			state({ flood: true }),
		);
		expect(composed.placements.map((p) => p.id)).toEqual(["ledger", "lantern"]);
		expect(composed.placements[0]?.item.description).toBe("Sodden.");
	});

	it("removes a conversation when a phase maps it to null", () => {
		const base: ScenarioContent = { ...EMPTY, trees: { "1-0": tree("1-0"), "1-1": tree("1-1") } };
		const composed = composeScenario(
			base,
			[{ id: "2", name: "After", when: FLOOD, trees: { "1-1": null } }],
			state({ flood: true }),
		);
		expect(Object.keys(composed.trees)).toEqual(["1-0"]);
	});

	it("replaces a conversation wholesale", () => {
		const base: ScenarioContent = { ...EMPTY, trees: { "1-0": tree("1-0") } };
		const after = tree("1-0", "after-the-flood");
		const composed = composeScenario(
			base,
			[{ id: "2", name: "After", when: FLOOD, trees: { "1-0": after } }],
			state({ flood: true }),
		);
		expect(composed.trees["1-0"]).toBe(after);
	});

	it("applies phases in order, so a later one wins", () => {
		const composed = composeScenario(
			withPlacements("ledger"),
			[
				{ id: "2", name: "Two", when: { flag: "a" }, placements: { remove: ["ledger"] } },
				{
					id: "3",
					name: "Three",
					when: { flag: "b" },
					placements: { add: [thing("ledger", "Found again.")] },
				},
			],
			state({ a: true, b: true }),
		);
		expect(composed.placements.map((p) => p.item.description)).toEqual(["Found again."]);
	});

	it("appends a phase's beats to the arc rather than replacing it", () => {
		const beat = (id: string, order: number): ScenarioBeat =>
			({ id, order, siteId: 1, npcSlot: 0, setsFlag: `beat:${id}` }) as ScenarioBeat;
		const base: ScenarioContent = {
			...EMPTY,
			arc: { title: "The Drowned Abbey", premise: "Rope and debt.", beats: [beat("one", 1)] },
		};
		const composed = composeScenario(
			base,
			[{ id: "2", name: "After", when: FLOOD, beats: [beat("two", 2)] }],
			state({ flood: true }),
		);
		expect(composed.arc?.title).toBe("The Drowned Abbey");
		expect(composed.arc?.beats.map((b) => b.id)).toEqual(["one", "two"]);
	});

	it("cannot retrofit an arc onto a world that has no story", () => {
		// A place with no plot in it is a legitimate thing to author. A later chapter adding a
		// title and a premise out of nowhere is not.
		const composed = composeScenario(
			EMPTY,
			[
				{
					id: "2",
					name: "After",
					when: FLOOD,
					beats: [{ id: "one", order: 1, siteId: 1, npcSlot: 0, setsFlag: "x" } as ScenarioBeat],
				},
			],
			state({ flood: true }),
		);
		expect(composed.arc).toBeUndefined();
	});
});

describe("phaseProblems", () => {
	it("refuses a removal of something that is not there", () => {
		expect(
			phaseProblems(withPlacements("ledger"), [
				{ id: "2", name: "After", placements: { remove: ["lantern"] } },
			]),
		).toEqual(['phase 2 removes placement "lantern", which nothing adds']);
	});

	it("refuses a replacement of something that is not there", () => {
		expect(
			phaseProblems(withPlacements("ledger"), [
				{ id: "2", name: "After", placements: { replace: [thing("lantern")] } },
			]),
		).toEqual(['phase 2 replaces placement "lantern", which nothing adds']);
	});

	it("accepts a removal of something an earlier phase added", () => {
		expect(
			phaseProblems(EMPTY, [
				{ id: "2", name: "Two", placements: { add: [thing("body")] } },
				{ id: "3", name: "Three", placements: { remove: ["body"] } },
			]),
		).toEqual([]);
	});

	it("refuses a removal of something a *later* phase adds", () => {
		// Order matters: a chapter cannot take away what only a chapter after it puts there.
		expect(
			phaseProblems(EMPTY, [
				{ id: "2", name: "Two", placements: { remove: ["body"] } },
				{ id: "3", name: "Three", placements: { add: [thing("body")] } },
			]),
		).toHaveLength(1);
	});

	it("names the kind, so a mistyped id says which list it was looked for in", () => {
		const problems = phaseProblems(EMPTY, [
			{ id: "2", name: "Two", triggers: { remove: ["arrive"] } },
			{ id: "3", name: "Three", signs: { remove: ["the-crossroads"] } },
		]);
		expect(problems).toEqual([
			'phase 2 removes trigger "arrive", which nothing adds',
			'phase 3 removes sign "the-crossroads", which nothing adds',
		]);
	});

	it("says nothing about a set of phases that all line up", () => {
		expect(
			phaseProblems(withPlacements("ledger"), [
				{ id: "1-base", name: "Base" },
				{
					id: "2-after",
					name: "After",
					when: FLOOD,
					placements: { remove: ["ledger"], add: [thing("body")] },
				},
			]),
		).toEqual([]);
	});
});
