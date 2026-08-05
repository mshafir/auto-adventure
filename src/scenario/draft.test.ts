import { describe, expect, it } from "vitest";
import { openingNode } from "../ai/dialogue/tree.js";
import { resolveSeed } from "../config.js";
import { hashString } from "../core/rand/hash.js";
import type { GameState } from "../core/rules/state.js";
import { worldSeed } from "../core/world/recipe.js";
import { npcId } from "../core/world/spec.js";
import { assembleArtifact, resolveDraftSeed, type ScenarioDraft } from "./draft.js";
import { verifyArtifact } from "./repo.js";
import { surveyWorld } from "./survey.js";

const AT = "2026-01-01T00:00:00.000Z";

/** The world the drafts below are written against. */
const SEED = hashString("draft-test");
const SURVEY = surveyWorld(worldSeed(SEED), "short");
const FIRST = SURVEY.sites[0];
if (!FIRST) throw new Error("survey found no sites");
const SITE_ID = FIRST.site.id;

function draft(overrides: Partial<ScenarioDraft> = {}): ScenarioDraft {
	return {
		id: "draft-test",
		brief: { premise: "a toll road counted in timber", duration: "short" },
		title: "The Hollow Tithe",
		blurb: "A road and a levy.",
		lore: {
			title: "The Hollow Tithe",
			premise: "The crown asks for timber now.",
			era: "the third winter",
			tone: "damp",
			factions: ["The Warden's Road"],
			deities: [],
		},
		...overrides,
	};
}

function siteDraft(siteId: number, npcs = 2): NonNullable<ScenarioDraft["sites"]>[number] {
	return {
		siteId,
		name: "Bracken Cross",
		shortName: "Bracken",
		description: "Three roads meet under old trees.",
		structures: [{ kind: "inn", size: "medium", importance: 5, name: "The Green Measure" }],
		npcs: Array.from({ length: npcs }, (_, i) => ({
			name: `Person ${i}`,
			role: i === 0 ? "innkeeper" : "carter",
			appearance: "Weather-beaten.",
			persona: "Counts while they talk.",
			placement: "doorstep" as const,
			knows: ["The tally has been short since the levy doubled."],
		})),
		hooks: ["The tally is short."],
	};
}

describe("resolveDraftSeed", () => {
	it("agrees with the game's own seed resolution", () => {
		// The bug this pins cost an entire authoring session. `draft.ts` had its own
		// copy of the hash "to stay independent of configuration", so `--seed thornwick`
		// surveyed one world and assembled against another — every authored site id was
		// suddenly a site of nowhere, and the only symptom was a wall of "unauthored
		// site" errors naming ids that were correct when written.
		for (const word of ["thornwick", "hollowmoor", "draft-test", "a-b-c"]) {
			expect(resolveDraftSeed(draft({ seed: word }))).toBe(resolveSeed(word));
		}
	});

	it("passes a numeric seed through, as a string or a number", () => {
		expect(resolveDraftSeed(draft({ seed: 4242 }))).toBe(4242);
		expect(resolveDraftSeed(draft({ seed: "4242" }))).toBe(4242);
		expect(resolveDraftSeed(draft({ seed: -7 }))).toBe(-7);
	});

	it("falls back to the id, so a scenario reproduces itself", () => {
		expect(resolveDraftSeed(draft())).toBe(resolveSeed("draft-test"));
	});
});

describe("assembleArtifact", () => {
	it("produces an artifact the loader accepts", () => {
		const artifact = assembleArtifact(draft({ sites: [siteDraft(SITE_ID)] }), AT);
		expect(verifyArtifact(artifact)).toEqual([]);
	});

	it("takes spawn and bounds from the world rather than the draft", () => {
		const artifact = assembleArtifact(draft(), AT);
		expect(artifact.spawn).toEqual(SURVEY.spawn);
		expect(artifact.bounds).toEqual(SURVEY.bounds);
	});

	it("fills every unwritten place with deterministic content", () => {
		// What makes a partial draft worth assembling: the towns you skipped are real
		// places with real people, not gaps.
		const artifact = assembleArtifact(draft(), AT);
		expect(Object.keys(artifact.sites).length).toBe(SURVEY.sites.length);
		for (const spec of Object.values(artifact.sites)) {
			expect(spec.name.length).toBeGreaterThan(0);
		}
	});

	it("keeps written content and fills only around it", () => {
		const artifact = assembleArtifact(draft({ sites: [siteDraft(SITE_ID)] }), AT);
		expect(artifact.sites[String(SITE_ID)]?.name).toBe("Bracken Cross");
		expect(Object.keys(artifact.sites).length).toBe(SURVEY.sites.length);
	});

	it("numbers npc slots from the order they were written", () => {
		const artifact = assembleArtifact(draft({ sites: [siteDraft(SITE_ID, 3)] }), AT);
		expect(artifact.sites[String(SITE_ID)]?.npcs.map((npc) => npc.slot)).toEqual([0, 1, 2]);
	});

	it("derives a glyph from the role when none was given", () => {
		const artifact = assembleArtifact(draft({ sites: [siteDraft(SITE_ID)] }), AT);
		expect(artifact.sites[String(SITE_ID)]?.npcs[0]?.glyph).toBe("I");
	});

	it("is deterministic", () => {
		const once = assembleArtifact(draft({ sites: [siteDraft(SITE_ID)] }), AT);
		const twice = assembleArtifact(draft({ sites: [siteDraft(SITE_ID)] }), AT);
		expect(twice).toEqual(once);
	});
});

describe("the arc a draft describes", () => {
	function withArc(): ScenarioDraft {
		return draft({
			sites: [siteDraft(SITE_ID, 2)],
			arc: {
				title: "The Tithe",
				premise: "Somebody pays.",
				beats: [
					{ id: "first", siteId: SITE_ID, npcSlot: 0, journal: "One." },
					{
						id: "second",
						siteId: SITE_ID,
						npcSlot: 1,
						quest: {
							name: "Find the tally",
							description: "It is short.",
							objective: { kind: "have", target: "Cord House tally" },
						},
					},
				],
			},
		});
	}

	it("chains the beats in the order they were written", () => {
		// Order, gating flags and quest ids are derived, so a drafted arc cannot wait on
		// a flag nothing sets or be reordered by editing the wrong field.
		const arc = assembleArtifact(withArc(), AT).arc;
		expect(arc?.beats.map((beat) => [beat.id, beat.order])).toEqual([
			["first", 0],
			["second", 1],
		]);
		expect(arc?.beats[0]?.requires).toEqual([]);
		expect(arc?.beats[1]?.requires).toEqual(["arc:first"]);
		expect(arc?.beats[0]?.setsFlag).toBe("arc:first");
	});

	it("gives a quest the beat's id, so nothing has to invent one", () => {
		const arc = assembleArtifact(withArc(), AT).arc;
		expect(arc?.beats[1]?.quest?.id).toBe("second");
		expect(arc?.beats[1]?.quest?.objectives).toEqual([
			{ kind: "have", target: "Cord House tally", done: false },
		]);
	});

	it("spells a quest target the way the world does", () => {
		// The runtime canonicalises a target when an NPC opens a quest, via
		// `resolveObjectiveTarget`. An authored quest gets the same treatment here, or it
		// is the one kind that cannot complete: `verifyQuests` matches on significant
		// words, so an objective still spelled the author's way never fires.
		const spelled = draft({
			sites: [siteDraft(SITE_ID)],
			arc: {
				title: "T",
				premise: "",
				beats: [
					{
						id: "there",
						siteId: SITE_ID,
						npcSlot: 0,
						quest: {
							name: "Go there",
							description: "",
							// The draft's inn is "The Green Measure"; an author writes it loosely.
							objective: { kind: "reach", target: "green measure" },
						},
					},
				],
			},
		});
		const objective = assembleArtifact(spelled, AT).arc?.beats[0]?.quest?.objectives[0];
		expect(objective?.target).toBe("The Green Measure");
	});

	it("does not canonicalise to a name the runtime never consults", () => {
		// `shortName` is not among the candidates `resolveObjectiveTarget` offers, so
		// resolving to one would hand the game a target it cannot match — worse than
		// leaving the author's words for validation to report.
		const short = draft({
			sites: [siteDraft(SITE_ID)],
			arc: {
				title: "T",
				premise: "",
				beats: [
					{
						id: "there",
						siteId: SITE_ID,
						npcSlot: 0,
						quest: {
							name: "Go",
							description: "",
							objective: { kind: "reach", target: "Bracken" },
						},
					},
				],
			},
		});
		expect(assembleArtifact(short, AT).arc?.beats[0]?.quest?.objectives[0]?.target).toBe(
			"Bracken Cross",
		);
	});

	it("leaves a target it cannot improve alone", () => {
		// Nothing here can spell an item better than the author did, and a flag names
		// nothing in the world at all.
		const kept = draft({
			sites: [siteDraft(SITE_ID)],
			arc: {
				title: "T",
				premise: "",
				beats: [
					{
						id: "fetch",
						siteId: SITE_ID,
						npcSlot: 0,
						quest: {
							name: "Fetch",
							description: "",
							objective: { kind: "have", target: "Cord House tally" },
						},
					},
				],
			},
		});
		expect(assembleArtifact(kept, AT).arc?.beats[0]?.quest?.objectives[0]?.target).toBe(
			"Cord House tally",
		);
	});

	it("survives the loader's arc checks", () => {
		expect(verifyArtifact(assembleArtifact(withArc(), AT))).toEqual([]);
	});
});

describe("the trees a draft describes", () => {
	function withTree(revisit?: string): ScenarioDraft {
		return draft({
			sites: [siteDraft(SITE_ID)],
			trees: [
				{
					siteId: SITE_ID,
					npcSlot: 0,
					entry: "hello",
					entryAfter: [{ node: "later", flag: "arc:first" }],
					...(revisit ? { revisit } : {}),
					nodes: [
						{
							id: "hello",
							speech: "Aye?",
							choices: [{ text: "Bye.", goto: null }],
						},
						{ id: "later", speech: "You again.", choices: [{ text: "Bye.", goto: null }] },
					],
				},
			],
		});
	}

	it("keys a tree by the npc id the engine will ask for", () => {
		const trees = assembleArtifact(withTree(), AT).trees;
		expect(Object.keys(trees ?? {})).toEqual([npcId(SITE_ID, 0)]);
	});

	it("puts gated openings before the plain one", () => {
		const tree = assembleArtifact(withTree(), AT).trees?.[npcId(SITE_ID, 0)];
		expect(tree?.entry).toEqual(["later", "hello"]);
	});

	it("turns an alternative opening's flag into a requirement on its node", () => {
		// `node.requires` is the only gate the runtime consults. Lowering `entryAfter`
		// to a bare list of candidates dropped the flag entirely, and since the
		// alternative is listed first and required nothing, it always won.
		const tree = assembleArtifact(withTree(), AT).trees?.[npcId(SITE_ID, 0)];
		expect(tree?.nodes.later?.requires).toEqual(["arc:first"]);
		expect(tree?.nodes.hello?.requires).toBeUndefined();
	});

	it("greets a first-time visitor with the plain opening", () => {
		// The bug this pins: with the flag dropped, "you again" was the first thing the
		// character ever said, and the greeting written for a first meeting was
		// unreachable in every playthrough.
		const tree = assembleArtifact(withTree(), AT).trees?.[npcId(SITE_ID, 0)];
		if (!tree) throw new Error("no tree");
		const state = (flags: Record<string, boolean>) => ({ flags }) as unknown as GameState;

		expect(openingNode(tree, state({}), undefined)?.id).toBe("hello");
		expect(openingNode(tree, state({ "arc:first": true }), undefined)?.id).toBe("later");
	});

	it("drops a revisit that names no node, rather than dangling", () => {
		const tree = assembleArtifact(withTree("nowhere"), AT).trees?.[npcId(SITE_ID, 0)];
		expect(tree?.revisit).toBeUndefined();
	});

	it("survives the loader's tree checks", () => {
		expect(verifyArtifact(assembleArtifact(withTree(), AT))).toEqual([]);
	});
});
