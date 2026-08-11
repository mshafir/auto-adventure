import { describe, expect, it } from "vitest";
import { demoJourneyArtifact } from "../../../test/fixtures/scenario.js";
import { npcId } from "../../core/world/spec.js";
import type { ScenarioArtifact } from "../../scenario/artifact.js";
import type { Finding } from "../../scenario/validate.js";
import type { DialogueTree } from "../dialogue/tree.js";
import type { WriteTreeInput } from "./author.js";
import { polishArtifact } from "./polish.js";

/**
 * The pass the player asks for, with the writer injected.
 *
 * So these are about *which* scenes it decides to spend a call on, *what it tells* the
 * writer, and whether it keeps the answer — never about what a model would say. The reading
 * half needs a gateway and is not exercised here; with no key `structured` returns nothing
 * and the pass falls back to polishing on the offline findings alone, which is the branch
 * that matters most anyway: it is the one that runs when the reading fails.
 */
const SLOW = { timeout: 120_000 };

const BASE = demoJourneyArtifact();
const BEAT = BASE.arc?.beats[0];
const ANCHOR = npcId(BEAT?.siteId as number, BEAT?.npcSlot as number);
const ELSEWHERE = npcId(BASE.arc?.beats[1]?.siteId as number, 0);

/** A one-node tree, so a rewrite is distinguishable from what was there. */
function tree(id: string, speech: string): DialogueTree {
	return {
		npcId: id,
		entry: ["hello"],
		nodes: { hello: { id: "hello", speech, choices: [] } },
	};
}

function finding(
	message: string,
	tree?: string,
	severity: Finding["severity"] = "warning",
): Finding {
	return { severity, message, ...(tree ? { tree } : {}) };
}

/** Records every brief the writer was handed, and answers with a usable tree. */
function recorder(answer?: (input: WriteTreeInput) => DialogueTree | undefined) {
	const asked: WriteTreeInput[] = [];
	return {
		asked,
		writeTree: async (input: WriteTreeInput) => {
			asked.push(input);
			return answer ? answer(input) : tree(input.id, "Go up to Aldermoor and ask for Lune.");
		},
	};
}

describe("polishing a world", SLOW, () => {
	it("hands the writer the findings about that scene, in the validator's own words", async () => {
		const writer = recorder();
		await polishArtifact({
			artifact: BASE,
			findings: [finding("the scene opens while the player carries it and then takes it", ANCHOR)],
			writeTree: writer.writeTree,
		});
		expect(writer.asked.length).toBe(1);
		expect(writer.asked[0]?.id).toBe(ANCHOR);
		expect(writer.asked[0]?.notes).toEqual([
			"the scene opens while the player carries it and then takes it",
		]);
	});

	/*
	 * The scene is where the player is *standing* when the errand is handed out, so it is the
	 * one place "go to Aldermoor and ask for Lune Harrowgate" cannot be missed. A rewrite that
	 * was not told where the story goes next would produce a better version of a scene with
	 * the same hole in it.
	 */
	it("tells the writer where the story goes after that scene", async () => {
		const writer = recorder();
		await polishArtifact({
			artifact: BASE,
			findings: [finding("nothing tells them where to go", ANCHOR)],
			writeTree: writer.writeTree,
		});
		expect(writer.asked[0]?.sendsTo).toEqual({ place: "Aldermoor", person: "Lune Harrowgate" });
	});

	it("rewrites one scene once, however many faults it has", async () => {
		const writer = recorder();
		const result = await polishArtifact({
			artifact: BASE,
			findings: [
				finding("first thing wrong", ANCHOR),
				finding("second thing wrong", ANCHOR),
				finding("third thing wrong", ANCHOR),
			],
			writeTree: writer.writeTree,
		});
		expect(writer.asked.length).toBe(1);
		expect(writer.asked[0]?.notes).toHaveLength(3);
		expect(result.calls).toBe(1);
	});

	/*
	 * A finding with nothing to rewrite is reported and not attempted. A gate that blocks
	 * nothing and a town the story never visits are real faults and no conversation can do
	 * anything about either, so spending a call on them would be spending it to change a
	 * scene that was not wrong.
	 */
	it("leaves alone the faults no conversation could fix", async () => {
		const writer = recorder();
		const result = await polishArtifact({
			artifact: BASE,
			findings: [finding("the story never visits 3 settlements")],
			writeTree: writer.writeTree,
		});
		expect(writer.asked).toEqual([]);
		expect(result.repairs).toEqual([]);
		expect(result.artifact).toBe(BASE);
	});

	it("spends its budget on the worst scenes first", async () => {
		const writer = recorder();
		await polishArtifact({
			artifact: BASE,
			findings: [
				finding("merely rough", ELSEWHERE),
				finding("a step that cannot be taken", ANCHOR, "error"),
			],
			writeTree: writer.writeTree,
			budget: 1,
		});
		expect(writer.asked.map((input) => input.id)).toEqual([ANCHOR]);
	});

	it("stops at the budget rather than rewriting everything it can see", async () => {
		const writer = recorder();
		const result = await polishArtifact({
			artifact: BASE,
			findings: [finding("wrong", ANCHOR), finding("also wrong", ELSEWHERE)],
			writeTree: writer.writeTree,
			budget: 1,
		});
		expect(writer.asked.length).toBe(1);
		expect(result.repairs.length).toBe(1);
	});

	/*
	 * The discipline every repair in this codebase runs under: judged on the validator's own
	 * score, and a round that does not improve it is thrown away. A rewritten conversation is
	 * a real change to the world, and one that trades a forgetful hand-over for a `goto`
	 * pointing at a node it no longer contains is not a repair.
	 */
	it("throws the rewrites away when they make the world worse", async () => {
		const broken = recorder(() => ({
			npcId: ANCHOR,
			entry: ["hello"],
			nodes: {
				hello: { id: "hello", speech: "Well?", choices: [{ text: "Nowhere", goto: "missing" }] },
			},
		}));
		const result = await polishArtifact({
			artifact: BASE,
			findings: [finding("say where to go", ANCHOR)],
			writeTree: broken.writeTree,
		});
		expect(result.artifact).toBe(BASE);
		expect(result.repairs).toEqual([]);
	});

	it("keeps a rewrite that removes the fault it was aimed at", async () => {
		const writer = recorder();
		const before: ScenarioArtifact = {
			...BASE,
			trees: { [ANCHOR]: tree(ANCHOR, "Nothing to say.") },
		};
		const result = await polishArtifact({
			artifact: before,
			findings: [finding("nothing tells them where to go", ANCHOR)],
			writeTree: writer.writeTree,
		});
		expect(result.artifact).not.toBe(before);
		expect(result.artifact.trees?.[ANCHOR]?.nodes.hello?.speech).toContain("Aldermoor");
		expect(result.findings.some((each) => each.message.includes("is expected at"))).toBe(false);
	});

	it("does nothing at all, and says so, when there is nothing to rewrite", async () => {
		const writer = recorder();
		const result = await polishArtifact({
			artifact: BASE,
			findings: [],
			writeTree: writer.writeTree,
		});
		expect(writer.asked).toEqual([]);
		expect(result.artifact).toBe(BASE);
		expect(result.findings).toEqual([]);
	});

	it("keeps the world as it was when the writer answers with nothing", async () => {
		const silent = recorder(() => undefined);
		const result = await polishArtifact({
			artifact: BASE,
			findings: [finding("wrong", ANCHOR)],
			writeTree: silent.writeTree,
		});
		// The call still happened and is still counted; a run that spent money must say so.
		expect(result.calls).toBeGreaterThan(0);
		expect(result.artifact).toBe(BASE);
	});

	it("stops when the caller gives up part-way", async () => {
		const stop = new AbortController();
		stop.abort();
		const writer = recorder();
		const result = await polishArtifact({
			artifact: BASE,
			findings: [finding("wrong", ANCHOR)],
			writeTree: writer.writeTree,
			signal: stop.signal,
		});
		expect(writer.asked).toEqual([]);
		expect(result.artifact).toBe(BASE);
	});
});
