import { describe, expect, it } from "vitest";
import { describeObjective, questRows, verifyQuests } from "./quests.js";
import { createInitialState, type GameState, type Quest } from "./state.js";

function quest(overrides: Partial<Quest> = {}): Quest {
	return {
		id: "q",
		name: "An errand",
		description: "",
		objectives: [],
		progress: [],
		completed: false,
		...overrides,
	};
}

function stateWith(quests: readonly Quest[]): GameState {
	return {
		...createInitialState({ id: "t", name: "t", seed: 1, createdAt: "" }, { x: 0, y: 0 }),
		quests,
	};
}

describe("a quest objective", () => {
	it("closes a parent the moment its last step does", () => {
		// The property that makes a story a graph: no model, no trigger and no beat has
		// to notice, because `verifyQuests` re-checks against real state every command.
		const parent = quest({
			id: "the-tally",
			objectives: [
				{ kind: "quest", target: "step-one", done: false },
				{ kind: "quest", target: "step-two", done: false },
			],
		});
		const one = quest({ id: "step-one", parentId: "the-tally", completed: true });
		const two = quest({ id: "step-two", parentId: "the-tally", completed: false });

		const halfway = verifyQuests(stateWith([parent, one, two]), {});
		expect(halfway.state.quests[0]?.completed).toBe(false);
		expect(halfway.state.quests[0]?.objectives[0]?.done).toBe(true);
		expect(halfway.state.quests[0]?.objectives[1]?.done).toBe(false);

		const done = verifyQuests(stateWith([parent, one, { ...two, completed: true }]), {});
		expect(done.state.quests[0]?.completed).toBe(true);
		expect(done.completed.map((q) => q.id)).toContain("the-tally");
	});

	it("is not satisfied by a step that is merely open", () => {
		const parent = quest({
			id: "p",
			objectives: [{ kind: "quest", target: "c", done: false }],
		});
		const child = quest({ id: "c", completed: false });
		expect(verifyQuests(stateWith([parent, child]), {}).state.quests[0]?.completed).toBe(false);
	});

	it("is not satisfied by a step that does not exist", () => {
		// A typo in an id must leave the errand open rather than closing it, which is
		// the safe direction: an errand that will not close is visible, one that closed
		// by accident silently skips the story.
		const parent = quest({ id: "p", objectives: [{ kind: "quest", target: "typo", done: false }] });
		expect(verifyQuests(stateWith([parent]), {}).state.quests[0]?.completed).toBe(false);
	});

	it("matches the id exactly rather than loosely", () => {
		// Every other objective kind matches prose generously, because its target came
		// from prose. A quest id is a slug an author chose, so being generous here would
		// let "the-ledger" satisfy an objective naming "the-ledger-returned".
		const parent = quest({
			id: "p",
			objectives: [{ kind: "quest", target: "the-ledger-returned", done: false }],
		});
		const near = quest({ id: "the-ledger", completed: true });
		expect(verifyQuests(stateWith([parent, near]), {}).state.quests[0]?.completed).toBe(false);
	});

	it("reads as an instruction rather than as its tag", () => {
		expect(describeObjective({ kind: "quest", target: "the-short-tally" })).toBe(
			"finish the short tally",
		);
	});
});

describe("questRows", () => {
	it("puts a job's steps directly under it", () => {
		const rows = questRows(
			stateWith([
				quest({ id: "job-a" }),
				quest({ id: "job-b" }),
				quest({ id: "a-step", parentId: "job-a" }),
			]),
		);
		expect(rows.map((row) => [row.quest.id, row.depth])).toEqual([
			["job-a", 0],
			["a-step", 1],
			["job-b", 0],
		]);
	});

	it("keeps a step whose job is not open, rather than losing it", () => {
		// A parent that was abandoned or never opened leaves an errand the player still
		// has; dropping it would remove it from the only list that shows it.
		const rows = questRows(stateWith([quest({ id: "orphan", parentId: "never-opened" })]));
		expect(rows.map((row) => [row.quest.id, row.depth])).toEqual([["orphan", 0]]);
	});

	it("does not hang on a parent cycle", () => {
		// An artifact is data from outside the program and may well contain one.
		const rows = questRows(
			stateWith([
				quest({ id: "a", parentId: "b" }),
				quest({ id: "b", parentId: "a" }),
				quest({ id: "self", parentId: "self" }),
			]),
		);
		expect(rows).toHaveLength(3);
	});

	it("flattens a step of a step to one level", () => {
		// Two levels is already deeper than an eleven-column list can indent legibly.
		const rows = questRows(
			stateWith([
				quest({ id: "job" }),
				quest({ id: "step", parentId: "job" }),
				quest({ id: "sub-step", parentId: "step" }),
			]),
		);
		expect(rows.every((row) => row.depth <= 1)).toBe(true);
		expect(rows).toHaveLength(3);
	});

	it("leaves out what is finished, like the list it replaces", () => {
		const rows = questRows(
			stateWith([quest({ id: "done", completed: true }), quest({ id: "open" })]),
		);
		expect(rows.map((row) => row.quest.id)).toEqual(["open"]);
	});
});
