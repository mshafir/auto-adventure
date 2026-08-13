import { describe, expect, it } from "vitest";
import { demoArtifact, demoSiteSpec } from "../../test/fixtures/scenario.js";
import type { ScenarioArc, ScenarioBeat } from "../core/rules/arc.js";
import type { NpcSpec } from "../core/world/spec.js";
import type { ScenarioArtifact } from "./artifact.js";
import { applySpatialRepairs, repairArtifact, repairUntilClean } from "./repair.js";
import { validateArtifact } from "./validate.js";

/**
 * The mechanical half of "repair until clean".
 *
 * Each of these is a fault put in on purpose, and each is checked the same two ways:
 * the finding the validator writes about it is gone afterwards, and *no new finding has
 * appeared*. The second half is the one that matters. A repair pass is trusted with the
 * whole artifact, so a fix that removes one warning while quietly stranding a beat
 * somewhere else would be worse than the fault it was written for — and it would be
 * invisible, because the finding it was aimed at did disappear.
 */

// Generating the bounded world is what these measure against, and it is slow by nature.
const SLOW = { timeout: 120_000 };

const BASE = demoArtifact();
const SITE_KEY = Object.keys(BASE.sites)[0] as string;
const SITE_ID = Number(SITE_KEY);
const NPC = demoSiteSpec(SITE_ID).npcs[0] as NpcSpec;

function withNpcs(
	npcs: readonly NpcSpec[],
	rest: Partial<ScenarioArtifact> = {},
): ScenarioArtifact {
	const spec = demoSiteSpec(SITE_ID);
	return demoArtifact({ sites: { [SITE_KEY]: { ...spec, npcs } }, ...rest });
}

function messages(artifact: ScenarioArtifact): string[] {
	return validateArtifact(artifact).map((finding) => `${finding.severity}: ${finding.message}`);
}

/**
 * What the repair removed and, more importantly, what it introduced.
 *
 * Both halves come from one comparison so they cannot drift apart.
 */
function difference(
	broken: ScenarioArtifact,
	// Which pass to measure. The repairs that answer "is this thing somewhere that exists" moved
	// out of `repairArtifact` and into the settling walk, which can tell whether the fix worked —
	// so the tests for those ask for them by name rather than through the static list.
	apply: (artifact: ScenarioArtifact) => ReturnType<typeof repairArtifact> = repairArtifact,
): {
	readonly gone: string[];
	readonly added: string[];
	readonly repairs: readonly string[];
	readonly fixed: ScenarioArtifact;
} {
	const before = messages(broken);
	const { artifact: fixed, repairs } = apply(broken);
	const after = messages(fixed);
	return {
		gone: before.filter((finding) => !after.includes(finding)),
		added: after.filter((finding) => !before.includes(finding)),
		repairs,
		fixed,
	};
}

function beat(id: string, order: number, rest: Partial<ScenarioBeat> = {}): ScenarioBeat {
	return { id, order, siteId: SITE_ID, npcSlot: 0, requires: [], setsFlag: `arc:${id}`, ...rest };
}

describe("repairArtifact", SLOW, () => {
	it("leaves a sound scenario exactly as it found it", () => {
		const { artifact, repairs } = repairArtifact(BASE);
		expect(repairs).toEqual([]);
		expect(artifact).toBe(BASE);
	});

	it("stands somebody at an anchor the town actually builds", () => {
		// A counter belongs to an inn's taproom, and this roster is one house — so the
		// anchor does not exist and the engine silently stands them somewhere else.
		const spec = demoSiteSpec(SITE_ID);
		const broken = demoArtifact({
			sites: {
				[SITE_KEY]: {
					...spec,
					settlement: {
						...spec.settlement,
						structures: [{ kind: "house", size: "small", importance: 2, name: "The Shack" }],
					},
					npcs: [{ ...NPC, placement: "counter" }],
				},
			},
		});
		const { gone, added, repairs, fixed } = difference(broken, applySpatialRepairs);
		expect(gone.join("\n")).toContain('asked for a "counter"');
		expect(added).toEqual([]);
		expect(repairs.join("\n")).toContain("stood them at");
		const moved = Object.values(fixed.sites)[0]?.npcs[0];
		expect(moved?.placement).not.toBe("counter");
	});

	it("drops a claim on a building that was not built", () => {
		const broken = withNpcs([{ ...NPC, structureName: "The Salt Exchange" }]);
		const { gone, added, fixed } = difference(broken, applySpatialRepairs);
		expect(gone.join("\n")).toContain('belongs to "The Salt Exchange"');
		expect(added).toEqual([]);
		expect(Object.values(fixed.sites)[0]?.npcs[0]?.structureName).toBeUndefined();
	});

	it("moves somebody standing inside a room that does not exist", () => {
		const broken = withNpcs([{ ...NPC, indoors: true, structureName: "The Salt Exchange" }]);
		const { gone, added, fixed } = difference(broken, applySpatialRepairs);
		expect(gone.join("\n")).toContain("which was not built; they are nowhere");
		expect(added).toEqual([]);
		const moved = Object.values(fixed.sites)[0]?.npcs[0];
		// Either indoors somewhere real, or out in the street — never inside a lie.
		expect(moved?.structureName).not.toBe("The Salt Exchange");
	});

	it("hides a thing in a building the ground actually held", () => {
		// The roster asked for an inn and a house and got the inn. A story that hides
		// something in "the smithy" has hidden it nowhere.
		const broken = demoArtifact({
			placements: [
				{
					id: "the-ledger",
					at: { kind: "site", siteId: SITE_ID, structure: "smithy" },
					item: { name: "Salt Ledger", description: "A wet book of debts." },
				},
			],
		});
		const { gone, added, fixed } = difference(broken, applySpatialRepairs);
		expect(gone.join("\n")).toContain("no smithy");
		expect(added).toEqual([]);
		const at = fixed.placements?.[0]?.at;
		expect(at?.kind === "site" && at.structure).toBe("The Drowned Lamp");
	});

	it("leaves a thing hidden somewhere that exists", () => {
		const sound = demoArtifact({
			placements: [
				{
					id: "the-ledger",
					at: { kind: "site", siteId: SITE_ID, structure: "The Drowned Lamp" },
					item: { name: "Salt Ledger", description: "A wet book of debts." },
				},
			],
		});
		const { repairs, fixed } = difference(sound, applySpatialRepairs);
		expect(repairs).toEqual([]);
		expect(fixed.placements).toBe(sound.placements);
	});

	it("says an objective the way the world says it", () => {
		const arc: ScenarioArc = {
			title: "t",
			premise: "p",
			beats: [
				beat("one", 0, {
					quest: {
						id: "the-lamp",
						name: "The lamp",
						description: "d",
						// The inn is "The Drowned Lamp"; this is the same building said loosely,
						// which resolves at runtime and reads back differently in the log.
						objectives: [{ kind: "reach", target: "Drowned Lamp", done: false }],
					},
				}),
			],
		};
		const { gone, added, fixed } = difference(demoArtifact({ arc }), applySpatialRepairs);
		expect(gone.join("\n")).toContain("is spelled");
		expect(added).toEqual([]);
		expect(fixed.arc?.beats[0]?.quest?.objectives[0]?.target).toBe("The Drowned Lamp");
	});

	/**
	 * The test that justifies letting a pack write goods at all.
	 *
	 * A pack may now empty a catalogue, and an errand written against a fuller one then
	 * names something the world does not contain. The promise made when that was allowed
	 * was not that authors would be careful — it was that this is *checkable*, because
	 * `obtainableItems` already answers the question and the validator already asks it.
	 * So: a hostile pack must produce a reported fault and a repaired scenario, never a
	 * story that quietly cannot be finished.
	 */
	it("hides what an errand asks for, rather than dropping the errand", () => {
		// The answer that was missing. An errand naming an item nothing in this world produces has
		// three possible outcomes — delete the errand, refuse the world, or put the item in it —
		// and until a live run went looking for the third, the pipeline only had the first two.
		const fetch = (target: string, optional = true): ScenarioArc => ({
			title: "t",
			premise: "p",
			beats: [
				beat("one", 0, {
					...(optional ? { optional: true } : {}),
					quest: {
						id: "the-nails",
						name: "The nails",
						description: "d",
						objectives: [
							{ kind: "talk", target: "Ilse Marrow", done: false },
							{ kind: "have", target, done: false },
						],
					},
				}),
			],
		});

		// Nothing in any world stocks this, so it stands for an errand written against a
		// catalogue this scenario's pack does not have.
		const broken = demoArtifact({ arc: fetch("Sheaf of Arrows") });
		const { repairs, fixed } = difference(broken);
		expect(messages(broken).join("\n")).toContain("Sheaf of Arrows");
		expect(repairs.join("\n")).toContain("hid one in the");
		// The errand is exactly as long as it was, and the thing it asks for is now somewhere.
		expect(fixed.arc?.beats[0]?.quest?.objectives).toHaveLength(2);
		const placed = (fixed.placements ?? []).find(
			(placement) => placement.item.name === "Sheaf of Arrows",
		);
		expect(placed, "the errand's item was not put anywhere").toBeDefined();
		expect(placed?.at.kind).toBe("site");
	});

	it("leaves an errand for a thing the world does stock exactly as it found it", () => {
		const arc: ScenarioArc = {
			title: "t",
			premise: "p",
			beats: [
				beat("one", 0, {
					quest: {
						id: "the-candles",
						name: "The candles",
						description: "d",
						objectives: [{ kind: "have", target: "Tallow Candles", done: false }],
					},
				}),
			],
		};
		const { added, repairs } = difference(demoArtifact({ arc }));
		expect(added).toEqual([]);
		expect(repairs.join("\n")).not.toContain("nothing here produces");
	});

	it("drops an objective waiting on a flag nothing sets, from a side errand", () => {
		// Optional, and that is now the whole of why this is allowed to be dropped. On the main
		// line the same fault is reported instead — see the two tests below.
		const arc: ScenarioArc = {
			title: "t",
			premise: "p",
			beats: [
				beat("one", 0, {
					optional: true,
					quest: {
						id: "the-lamp",
						name: "The lamp",
						description: "d",
						objectives: [
							{ kind: "talk", target: "Ilse Marrow", done: false },
							{ kind: "flag", target: "lamp-lit", done: false },
						],
					},
				}),
			],
		};
		const { gone, added, fixed } = difference(demoArtifact({ arc }));
		expect(gone.join("\n")).toContain('"lamp-lit"');
		expect(added).toEqual([]);
		expect(fixed.arc?.beats[0]?.quest?.objectives).toHaveLength(1);
	});

	it("refuses to drop an objective from a beat the story needs", () => {
		// The rule the whole track rests on: a main-line beat is not deletable. An errand
		// waiting on a flag nothing sets is a real fault and dropping the objective is a real
		// fix — for a side errand. On the main line it is a step of the story removed to make a
		// finding go away, and the finding was the more useful of the two.
		const arc: ScenarioArc = {
			title: "t",
			premise: "p",
			beats: [
				beat("spine", 0, {
					quest: {
						id: "the-lamp",
						name: "The lamp",
						description: "d",
						objectives: [
							{ kind: "talk", target: "Ilse Marrow", done: false },
							{ kind: "flag", target: "lamp-lit", done: false },
						],
					},
				}),
			],
		};
		const result = repairArtifact(demoArtifact({ arc }));
		expect(result.artifact.arc?.beats[0]?.quest?.objectives).toHaveLength(2);
		expect(result.refused.map((refusal) => refusal.message).join("\n")).toContain("spine");
		expect(result.refused.map((refusal) => refusal.message).join("\n")).toContain("main line");
	});

	it("puts the main line's item in the world rather than leaving the errand unfinishable", () => {
		// This used to be a refusal, and the refusal was correct and not good enough. A main-line
		// errand naming something nothing produces cannot be shortened — that is the rule — so the
		// errand stayed, unclosable, and `arcOutline.finished` needs every opened main-line beat's
		// quest *completed*: the story could be walked to its last beat and never end. A live run
		// produced exactly that and the launcher wrote the world anyway.
		//
		// The refusal is still there for a `flag` objective nothing sets, which is the test above:
		// nothing can be placed to satisfy one of those.
		const arc: ScenarioArc = {
			title: "t",
			premise: "p",
			beats: [
				beat("spine", 0, {
					quest: {
						id: "the-nails",
						name: "The nails",
						description: "d",
						objectives: [
							{ kind: "talk", target: "Ilse Marrow", done: false },
							{ kind: "have", target: "Sheaf of Arrows", done: false },
						],
					},
				}),
			],
		};
		const result = repairArtifact(demoArtifact({ arc }));
		expect(result.artifact.arc?.beats[0]?.quest?.objectives).toHaveLength(2);
		expect(result.refused.map((refusal) => refusal.message).join("\n")).not.toContain(
			"Sheaf of Arrows",
		);
		expect(
			(result.artifact.placements ?? []).some(
				(placement) => placement.item.name === "Sheaf of Arrows",
			),
			"the main line's errand is still unfinishable",
		).toBe(true);
	});

	it("keeps both arms of a fork, having no way to know which one is taken", () => {
		// A repair pass reasons about the artifact and not about a playthrough, so it cannot
		// know which arm a player will take — and treating either as droppable side content
		// would delete half a choice.
		const arc: ScenarioArc = {
			title: "t",
			premise: "p",
			beats: [
				beat("left", 0, {
					branch: "which",
					quest: {
						id: "l",
						name: "Left",
						description: "d",
						objectives: [
							{ kind: "talk", target: "Ilse Marrow", done: false },
							{ kind: "flag", target: "never-set", done: false },
						],
					},
				}),
				beat("right", 1, { branch: "which" }),
			],
		};
		const result = repairArtifact(demoArtifact({ arc }));
		expect(result.artifact.arc?.beats[0]?.quest?.objectives).toHaveLength(2);
		expect(result.refused.map((refusal) => refusal.message).join("\n")).toContain("left");
	});

	it("leaves an errand alone when the dead objective is its only one", () => {
		const arc: ScenarioArc = {
			title: "t",
			premise: "p",
			beats: [
				beat("one", 0, {
					quest: {
						id: "the-lamp",
						name: "The lamp",
						description: "d",
						objectives: [{ kind: "flag", target: "lamp-lit", done: false }],
					},
				}),
			],
		};
		// An errand with nothing left to do closes the instant it is handed out, which is a
		// different wrong thing. Reported rather than repaired.
		const { repairs, fixed } = difference(demoArtifact({ arc }));
		expect(repairs).toEqual([]);
		expect(fixed.arc?.beats[0]?.quest?.objectives).toHaveLength(1);
	});

	it("drops a fork that has only one arm", () => {
		const arc: ScenarioArc = {
			title: "t",
			premise: "p",
			beats: [beat("one", 0), beat("two", 1, { requires: ["arc:one"], branch: "which" })],
		};
		const { gone, added, fixed } = difference(demoArtifact({ arc }));
		expect(gone.join("\n")).toContain("has only one arm");
		expect(added).toEqual([]);
		expect(fixed.arc?.beats[1]?.branch).toBeUndefined();
	});

	it("keeps a fork that has two", () => {
		const arc: ScenarioArc = {
			title: "t",
			premise: "p",
			beats: [
				beat("one", 0),
				beat("left", 1, { requires: ["arc:one"], branch: "which" }),
				beat("right", 2, { requires: ["arc:one"], branch: "which" }),
			],
		};
		const { fixed } = difference(demoArtifact({ arc }));
		expect(fixed.arc?.beats[1]?.branch).toBe("which");
		expect(fixed.arc?.beats[2]?.branch).toBe("which");
	});

	it("stops a conversation waiting on somebody who is not in the scenario", () => {
		const artifact = demoArtifact({
			trees: {
				[`npc:${SITE_ID}:0`]: {
					npcId: `npc:${SITE_ID}:0`,
					entry: ["hello"],
					nodes: {
						hello: {
							id: "hello",
							speech: "Well met.",
							requires: { talked: "npc:999999:3" },
							choices: [],
						},
						other: { id: "other", speech: "Good day.", choices: [] },
					},
				},
			},
		});
		const { gone, added, fixed } = difference(artifact);
		expect(gone.join("\n")).toContain("npc:999999:3");
		expect(added).toEqual([]);
		expect(fixed.trees?.[`npc:${SITE_ID}:0`]?.nodes.hello?.requires).toBeUndefined();
	});

	it("keeps the rest of a condition when only part of it names a stranger", () => {
		const artifact = demoArtifact({
			trees: {
				[`npc:${SITE_ID}:0`]: {
					npcId: `npc:${SITE_ID}:0`,
					entry: ["hello"],
					nodes: {
						hello: {
							id: "hello",
							speech: "Well met.",
							requires: { all: [{ visited: "Thornwick" }, { talked: "npc:999999:3" }] },
							choices: [],
						},
						other: { id: "other", speech: "Good day.", choices: [] },
					},
				},
			},
		});
		const { fixed } = difference(artifact);
		expect(fixed.trees?.[`npc:${SITE_ID}:0`]?.nodes.hello?.requires).toEqual({
			visited: "Thornwick",
		});
	});

	it("gates somebody who is on stage before the beat they carry", () => {
		const arc: ScenarioArc = {
			title: "t",
			premise: "p",
			beats: [
				beat("one", 0, { npcSlot: 1 }),
				beat("two", 1, { requires: ["arc:one"], npcSlot: 0 }),
			],
		};
		const extra: NpcSpec = { ...NPC, slot: 1, name: "Ott Pell", glyph: "O" };
		const broken = withNpcs([{ ...NPC, requires: { visited: "Thornwick" } }, extra], { arc });
		const { gone, added, fixed } = difference(broken);
		expect(gone.join("\n")).toContain("is on stage before beat two can open");
		expect(added).toEqual([]);
		expect(fixed.sites[SITE_KEY]?.npcs[0]?.requires).toEqual({
			all: [{ visited: "Thornwick" }, { flag: "arc:one" }],
		});
	});

	it("runs the repairs once, rather than judging a second round", () => {
		// The loop existed because static findings were the only available measure of "better".
		// `settleTheStory` is that check now, and a far stronger one — and a judged round would
		// throw a deliberate main-line refusal out along with every good repair beside it.
		const spoken: string[] = [];
		repairUntilClean(withNpcs([{ ...NPC, structureName: "The Salt Exchange" }]), (message) =>
			spoken.push(message),
		);
		expect(spoken.filter((line) => line.includes("made nothing better"))).toEqual([]);
	});

	it("hands back what it could not fix, and does not re-check it twice", () => {
		// A side errand waiting on a flag nothing sets: a fault the static pass still fixes, now
		// that the placement repairs run in the settling walk instead. The subject changed; the
		// property being tested did not.
		const broken = demoArtifact({
			arc: {
				title: "t",
				premise: "p",
				beats: [
					beat("errand", 0, {
						optional: true,
						quest: {
							id: "the-lamp",
							name: "The lamp",
							description: "d",
							objectives: [
								{ kind: "talk", target: "Ilse Marrow", done: false },
								{ kind: "flag", target: "never-written", done: false },
							],
						},
					}),
				],
			},
		});
		const before = validateArtifact(broken);
		const cleaned = repairUntilClean(broken);
		expect(cleaned.repairs.length).toBeGreaterThan(0);
		expect(cleaned.findings.length).toBeLessThan(before.length);
		// The findings are the ones the repaired world produces, not the ones the broken
		// one did — the whole reason they are returned rather than recomputed upstream.
		expect(cleaned.findings.map((finding) => finding.message).join("\n")).not.toContain(
			"never-written",
		);
	});

	it("does not touch a world it has nothing to say about", () => {
		const cleaned = repairUntilClean(BASE);
		expect(cleaned.repairs).toEqual([]);
		expect(cleaned.artifact).toBe(BASE);
	});

	it("leaves permanent scenery ungated", () => {
		const arc: ScenarioArc = {
			title: "t",
			premise: "p",
			beats: [beat("one", 0, { npcSlot: 1 }), beat("two", 1, { requires: ["arc:one"] })],
		};
		const extra: NpcSpec = { ...NPC, slot: 1, name: "Ott Pell", glyph: "O" };
		// No `requires` at all means they were never gated, so being present early is what
		// they are: scenery. Gating them would be inventing a rule nobody wrote.
		const { fixed } = difference(withNpcs([NPC, extra], { arc }));
		expect(fixed.sites[SITE_KEY]?.npcs[0]?.requires).toBeUndefined();
	});
});
