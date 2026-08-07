import { describe, expect, it } from "vitest";
import { demoArtifact, demoSiteSpec } from "../../../test/fixtures/scenario.js";
import type { ScenarioArc, ScenarioBeat } from "../../core/rules/arc.js";
import { type NpcSpec, npcId } from "../../core/world/spec.js";
import type { ScenarioArtifact } from "../../scenario/artifact.js";
import type { DialogueTree } from "../dialogue/tree.js";
import type { WriteTreeInput } from "./author.js";
import { mendArtifact } from "./mend.js";

/**
 * The bounded, model-spending half of the repair loop.
 *
 * Tested with the writer injected, so these are about *which* faults it decides to spend
 * a call on and what it does with the answer — never about what a model would say. The
 * three properties that matter: it asks for the right thing, it keeps an answer only if
 * that answer actually fixed the fault, and it stops when the budget runs out.
 */

const BASE = demoArtifact();
const SITE_KEY = Object.keys(BASE.sites)[0] as string;
const SITE_ID = Number(SITE_KEY);
const NPC = demoSiteSpec(SITE_ID).npcs[0] as NpcSpec;

function beat(id: string, order: number, rest: Partial<ScenarioBeat> = {}): ScenarioBeat {
	return { id, order, siteId: SITE_ID, npcSlot: 0, requires: [], setsFlag: `arc:${id}`, ...rest };
}

/** A tree with one node, optionally gated on a flag. */
function tree(id: string, requires?: string): DialogueTree {
	return {
		npcId: id,
		entry: ["hello"],
		nodes: {
			hello: {
				id: "hello",
				speech: "Well met.",
				...(requires ? { requires: [requires] } : {}),
				choices: [],
			},
		},
	};
}

/** Two people, so a fork can have an arm each and somebody can be left silent. */
function cast(): NpcSpec[] {
	return [NPC, { ...NPC, slot: 1, name: "Ott Pell", glyph: "O" }];
}

function withCast(rest: Partial<ScenarioArtifact>): ScenarioArtifact {
	const spec = demoSiteSpec(SITE_ID);
	return demoArtifact({ sites: { [SITE_KEY]: { ...spec, npcs: cast() } }, ...rest });
}

const FORKED: ScenarioArc = {
	title: "t",
	premise: "p",
	beats: [
		beat("one", 0),
		beat("left", 1, { requires: ["arc:one"], branch: "which" }),
		beat("right", 2, { requires: ["arc:one"], branch: "which", npcSlot: 1 }),
	],
};

/** Records what it was asked for, and answers with whatever it was handed. */
function writer(reply: (input: WriteTreeInput) => DialogueTree | undefined) {
	const asked: WriteTreeInput[] = [];
	return {
		asked,
		writeTree: async (input: WriteTreeInput) => {
			asked.push(input);
			return reply(input);
		},
	};
}

describe("mendArtifact", () => {
	it("spends nothing on a world nobody was written for", async () => {
		const { asked, writeTree } = writer(() => undefined);
		const result = await mendArtifact({ artifact: BASE, writeTree });
		expect(asked).toEqual([]);
		expect(result.calls).toBe(0);
		expect(result.artifact).toBe(BASE);
	});

	it("insists on the fork's own flag when nothing speaks to it", async () => {
		const artifact = withCast({
			arc: FORKED,
			trees: {
				[npcId(SITE_ID, 0)]: tree(npcId(SITE_ID, 0)),
				[npcId(SITE_ID, 1)]: tree(npcId(SITE_ID, 1)),
			},
		});
		const { asked, writeTree } = writer((input) => tree(input.id, input.insist?.[0]));
		const result = await mendArtifact({ artifact, writeTree });
		expect(asked.map((input) => input.insist)).toEqual([["arc:left"], ["arc:right"]]);
		expect(result.repairs).toHaveLength(2);
		expect(result.artifact.trees?.[npcId(SITE_ID, 0)]?.nodes.hello?.requires).toEqual(["arc:left"]);
	});

	it("leaves a fork alone once somebody speaks to it", async () => {
		const artifact = withCast({
			arc: FORKED,
			trees: {
				[npcId(SITE_ID, 0)]: tree(npcId(SITE_ID, 0), "arc:left"),
				[npcId(SITE_ID, 1)]: tree(npcId(SITE_ID, 1)),
			},
		});
		const { asked, writeTree } = writer((input) => tree(input.id, input.insist?.[0]));
		await mendArtifact({ artifact, writeTree });
		expect(asked).toEqual([]);
	});

	it("throws away a rewrite that did not do the thing it was asked for", async () => {
		const artifact = withCast({
			arc: FORKED,
			trees: {
				[npcId(SITE_ID, 0)]: tree(npcId(SITE_ID, 0)),
				[npcId(SITE_ID, 1)]: tree(npcId(SITE_ID, 1)),
			},
		});
		// A perfectly good conversation that still says the same thing whichever arm was
		// taken. Keeping it would be discarding one conversation for another at random.
		const { writeTree } = writer((input) => tree(input.id));
		const result = await mendArtifact({ artifact, writeTree });
		expect(result.repairs).toEqual([]);
		expect(result.artifact).toBe(artifact);
		// It still cost what it cost, and says so.
		expect(result.calls).toBe(2);
	});

	it("writes for the person who carries a beat before the person who does not", async () => {
		const arc: ScenarioArc = { title: "t", premise: "p", beats: [beat("one", 0, { npcSlot: 1 })] };
		// Slot 1 opens the story and has nothing written; slot 0 is texture and does.
		const artifact = withCast({ arc, trees: { [npcId(SITE_ID, 0)]: tree(npcId(SITE_ID, 0)) } });
		const { asked, writeTree } = writer((input) => tree(input.id));
		await mendArtifact({ artifact, writeTree });
		expect(asked.map((input) => input.id)).toEqual([npcId(SITE_ID, 1)]);
	});

	it("stops when the budget runs out", async () => {
		const spec = demoSiteSpec(SITE_ID);
		const many = Array.from({ length: 5 }, (_, slot) => ({
			...NPC,
			slot,
			name: `Person ${slot}`,
		}));
		const artifact = demoArtifact({
			sites: { [SITE_KEY]: { ...spec, npcs: many } },
			trees: { [npcId(SITE_ID, 0)]: tree(npcId(SITE_ID, 0)) },
		});
		const { asked, writeTree } = writer((input) => tree(input.id));
		const result = await mendArtifact({ artifact, writeTree, budget: 2 });
		expect(asked).toHaveLength(2);
		expect(result.calls).toBe(2);
	});
});
