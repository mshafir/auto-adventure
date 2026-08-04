import { describe, expect, it } from "vitest";
import { resolveSeed } from "../config.js";
import { hashString } from "../core/rand/hash.js";
import { npcId } from "../core/world/spec.js";
import { assembleArtifact, resolveDraftSeed, type ScenarioDraft } from "./draft.js";
import { verifyArtifact } from "./repo.js";
import { surveyWorld } from "./survey.js";

const AT = "2026-01-01T00:00:00.000Z";

/** The world the drafts below are written against. */
const SEED = hashString("draft-test");
const SURVEY = surveyWorld(SEED, "short");
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

	it("drops a revisit that names no node, rather than dangling", () => {
		const tree = assembleArtifact(withTree("nowhere"), AT).trees?.[npcId(SITE_ID, 0)];
		expect(tree?.revisit).toBeUndefined();
	});

	it("survives the loader's tree checks", () => {
		expect(verifyArtifact(assembleArtifact(withTree(), AT))).toEqual([]);
	});
});
