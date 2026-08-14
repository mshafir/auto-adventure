import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { demoArtifact } from "../../test/fixtures/scenario.js";
import type { ScenarioArc, ScenarioBeat } from "../core/rules/arc.js";
import type { Trigger } from "../core/rules/trigger.js";
import { scenarioRoot } from "../paths.js";
import type { ScenarioArtifact } from "./artifact.js";
import { checkCompleteness } from "./completeness.js";

/**
 * The proof that a story can be finished.
 *
 * Two halves, and the first is the more important one. A checker that refuses good
 * content is worse than none, because it is believed for a while and then ignored
 * forever — so the shipped scenarios, which are the only stories known to be sound, are
 * the standing guard against this becoming merely strict. Everything after that is a
 * hole put in on purpose, one class at a time.
 */

function withArc(arc: ScenarioArc, triggers?: readonly Trigger[]): ScenarioArtifact {
	return demoArtifact({ arc, ...(triggers ? { triggers } : {}) });
}

/** A beat with the fields that carry no meaning here filled in. */
function beat(id: string, order: number, rest: Partial<ScenarioBeat> = {}): ScenarioBeat {
	return {
		id,
		order,
		siteId: 1,
		npcSlot: 0,
		requires: [],
		setsFlag: `arc:${id}`,
		...rest,
	};
}

/** Every field of a dialogue action, so one can be written by naming only what it does. */
const NOTHING = {
	item: null,
	description: null,
	quantity: null,
	questId: null,
	questName: null,
	note: null,
	objectives: null,
	key: null,
	value: null,
} as const;

function messages(artifact: ScenarioArtifact): string[] {
	return checkCompleteness(artifact).map((finding) => `${finding.severity}: ${finding.message}`);
}

/*
 * Skipped until the `two-phase` fixture directory exists.
 *
 * These suites are parameterised over the scenarios that used to ship in `.scenarios/`,
 * and those were deleted with the pipeline that wrote them — so they currently assert
 * things about content that is not there. The checkers themselves are kept deliberately:
 * they become `craft check` and `craft playtest`. Task 11 of
 * docs/superpowers/plans/2026-08-14-scenario-v2-and-scenes.md points them at
 * test/fixtures/scenarios/two-phase and turns them back on.
 */
describe.skip("checkCompleteness", () => {
	// The scenarios in the repository, read as JSON rather than through the launcher:
	// this asks about the story alone, and the story is in the file exactly as written.
	for (const name of ["thornwick-road", "green-chapel"]) {
		it(`accepts ${name}, which is known to be finishable`, () => {
			const artifact = JSON.parse(
				readFileSync(`${scenarioRoot()}/${name}.json`, "utf8"),
			) as ScenarioArtifact;
			expect(messages(artifact)).toEqual([]);
		});
	}

	it("says nothing about a scenario with no story", () => {
		expect(checkCompleteness(demoArtifact())).toEqual([]);
	});

	it("walks a plain chain to the end", () => {
		const arc: ScenarioArc = {
			title: "t",
			premise: "p",
			beats: [
				beat("one", 0),
				beat("two", 1, { requires: ["arc:one"] }),
				beat("three", 2, { requires: ["arc:two"] }),
			],
		};
		expect(messages(withArc(arc))).toEqual([]);
	});

	it("reports a beat waiting on a flag nothing writes", () => {
		const arc: ScenarioArc = {
			title: "t",
			premise: "p",
			beats: [beat("one", 0), beat("two", 1, { requires: ["arc:one", "the-lost-key"] })],
		};
		const found = messages(withArc(arc));
		expect(found).toHaveLength(1);
		expect(found[0]).toContain("beat two can never open");
		expect(found[0]).toContain('"the-lost-key"');
		expect(found[0]).toMatch(/^error:/);
	});

	/*
	 * The fault no spell-check can find: both flags are written, both conditions are
	 * spelled correctly, every id resolves — and neither beat can go first, so the story
	 * stops at the door with a full journal and nothing to do.
	 */
	it("reports two beats that wait on each other", () => {
		const arc: ScenarioArc = {
			title: "t",
			premise: "p",
			beats: [
				beat("one", 0),
				beat("two", 1, { requires: ["arc:three"] }),
				beat("three", 2, { requires: ["arc:two"] }),
			],
		};
		const found = messages(withArc(arc));
		expect(found).toHaveLength(2);
		expect(found.join("\n")).toContain("beat two can never open");
		expect(found.join("\n")).toContain("beat three can never open");
	});

	it("counts a beat's own effects as writers, not only its flag", () => {
		const arc: ScenarioArc = {
			title: "t",
			premise: "p",
			beats: [
				beat("one", 0, { effects: [{ t: "SetFlag", key: "the-mill-burned", value: true }] }),
				beat("two", 1, { requires: ["the-mill-burned"] }),
			],
		};
		expect(messages(withArc(arc))).toEqual([]);
	});

	it("lets a trigger carry the story forward", () => {
		const arc: ScenarioArc = {
			title: "t",
			premise: "p",
			beats: [beat("one", 0), beat("two", 1, { requires: ["the-bell"] })],
		};
		const triggers: Trigger[] = [
			{
				id: "rings",
				when: { flag: "arc:one" },
				effects: [{ t: "SetFlag", key: "the-bell", value: true }],
			},
		];
		expect(messages(withArc(arc, triggers))).toEqual([]);
	});

	it("does not let a trigger that waits on the beat it feeds", () => {
		const arc: ScenarioArc = {
			title: "t",
			premise: "p",
			beats: [beat("one", 0), beat("two", 1, { requires: ["the-bell"] })],
		};
		const triggers: Trigger[] = [
			{
				id: "rings",
				when: { flag: "arc:two" },
				effects: [{ t: "SetFlag", key: "the-bell", value: true }],
			},
		];
		expect(messages(withArc(arc, triggers))[0]).toContain("beat two can never open");
	});

	it("takes both arms of a fork and reports neither", () => {
		const arc: ScenarioArc = {
			title: "t",
			premise: "p",
			beats: [
				beat("one", 0),
				beat("left", 1, { requires: ["arc:one"], branch: "which" }),
				beat("right", 2, { requires: ["arc:one"], branch: "which" }),
				beat("after", 3, { requires: { any: [{ flag: "arc:left" }, { flag: "arc:right" }] } }),
			],
		};
		expect(messages(withArc(arc))).toEqual([]);
	});

	/*
	 * The fault the last real generation run hit — the model made each arm a step of the
	 * other — and the one place this check deliberately keeps quiet. `checkBranches`
	 * already reports it in the fork's own terms, which are more useful than these: it
	 * names the arm, the flag and the beat left stranded.
	 */
	it("leaves a fork gated on its own sibling to the branch check", () => {
		const arc: ScenarioArc = {
			title: "t",
			premise: "p",
			beats: [
				beat("one", 0),
				beat("left", 1, { requires: ["arc:right"], branch: "which" }),
				beat("right", 2, { requires: ["arc:left"], branch: "which" }),
			],
		};
		expect(messages(withArc(arc))).toEqual([]);
	});

	it("reports a side errand that can never open, but only as a warning", () => {
		const arc: ScenarioArc = {
			title: "t",
			premise: "p",
			beats: [beat("one", 0), beat("two", 1, { requires: ["nobody-sets-this"], optional: true })],
		};
		const found = messages(withArc(arc));
		expect(found).toHaveLength(1);
		expect(found[0]).toMatch(/^warning:/);
		expect(found[0]).toContain("side errand");
	});

	it("reports an errand waiting on a flag nothing sets", () => {
		const arc: ScenarioArc = {
			title: "t",
			premise: "p",
			beats: [
				beat("one", 0, {
					quest: {
						id: "the-ledger",
						name: "Find the ledger",
						description: "d",
						objectives: [{ kind: "flag", target: "ledger-found", done: false }],
					},
				}),
			],
		};
		const found = messages(withArc(arc));
		expect(found).toHaveLength(1);
		expect(found[0]).toContain('"Find the ledger"');
		expect(found[0]).toContain('"ledger-found"');
		expect(found[0]).toContain("never reaches its ending");
	});

	it("accepts an errand whose flag a conversation sets", () => {
		const arc: ScenarioArc = {
			title: "t",
			premise: "p",
			beats: [
				beat("one", 0, {
					quest: {
						id: "the-ledger",
						name: "Find the ledger",
						description: "d",
						objectives: [{ kind: "flag", target: "ledger-found", done: false }],
					},
				}),
			],
		};
		const artifact = demoArtifact({
			arc,
			trees: {
				"npc:1:0": {
					npcId: "npc:1:0",
					entry: ["hello"],
					nodes: {
						hello: {
							id: "hello",
							speech: "Here it is.",
							choices: [],
							actions: [{ ...NOTHING, kind: "setFlag", key: "ledger-found", value: "yes" }],
						},
					},
				},
			},
		});
		expect(messages(artifact)).toEqual([]);
	});

	it("closes a parent errand behind its steps, and reports one that cannot close", () => {
		const sound: ScenarioArc = {
			title: "t",
			premise: "p",
			beats: [
				beat("child", 0, {
					quest: { id: "step", name: "A step", description: "d", objectives: [] },
				}),
				beat("parent", 1, {
					requires: ["arc:child"],
					quest: {
						id: "whole",
						name: "The whole job",
						description: "d",
						objectives: [{ kind: "quest", target: "step", done: false }],
					},
				}),
			],
		};
		expect(messages(withArc(sound))).toEqual([]);

		const circular: ScenarioArc = {
			...sound,
			beats: [
				beat("child", 0, {
					quest: {
						id: "step",
						name: "A step",
						description: "d",
						objectives: [{ kind: "quest", target: "whole", done: false }],
					},
				}),
				beat("parent", 1, {
					requires: ["arc:child"],
					quest: {
						id: "whole",
						name: "The whole job",
						description: "d",
						objectives: [{ kind: "quest", target: "step", done: false }],
					},
				}),
			],
		};
		const found = messages(withArc(circular));
		expect(found).toHaveLength(2);
		expect(found.join("\n")).toContain("cannot be completed either");
	});

	it("opens a beat that waits on a finished errand", () => {
		const arc: ScenarioArc = {
			title: "t",
			premise: "p",
			beats: [
				beat("one", 0, {
					quest: {
						id: "fetch",
						name: "Fetch it",
						description: "d",
						objectives: [{ kind: "have", target: "Lead Standard", done: false }],
					},
				}),
				beat("two", 1, { requires: { quest: "fetch", is: "done" } }),
			],
		};
		expect(messages(withArc(arc))).toEqual([]);
	});

	it("reports a beat waiting on an errand that can never close", () => {
		const arc: ScenarioArc = {
			title: "t",
			premise: "p",
			beats: [
				beat("one", 0, {
					quest: {
						id: "fetch",
						name: "Fetch it",
						description: "d",
						objectives: [{ kind: "flag", target: "never-set", done: false }],
					},
				}),
				beat("two", 1, { requires: { quest: "fetch", is: "done" } }),
			],
		};
		const found = messages(withArc(arc));
		expect(found.join("\n")).toContain("beat two can never open");
		expect(found.join("\n")).toContain('waits on "fetch", which cannot be completed');
	});
});
