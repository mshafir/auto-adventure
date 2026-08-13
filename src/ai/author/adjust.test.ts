import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mainLineBeats, type ScenarioBeat } from "../../core/rules/arc.js";
import { npcId } from "../../core/world/spec.js";
import type { ScenarioArtifact } from "../../scenario/artifact.js";
import { readScenarioFile, scenarioPath } from "../../scenario/repo.js";
import { adjustTheStory, lowerAdjustment } from "./adjust.js";
import type { AdjustmentResponse } from "./schemas.js";

/**
 * Adjusting the story to the side errands that fitted.
 *
 * Two properties, and both of them are about restraint. What the model may name is checked on the
 * way *in*, because this pass runs after the world has been declared playable and a beat naming a
 * town that is not here would be an unreachable step added one pass after the walk that proved
 * there were none. And whatever it produces is thrown away *wholesale* if the story stops playing
 * afterwards: the world was already good, this is a flourish, and a flourish does not get to
 * spend the main line's guarantee.
 */

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "auto-adventure-adjust-"));
	process.env.AUTO_ADVENTURE_HOME = home;
});

afterEach(() => {
	delete process.env.AUTO_ADVENTURE_HOME;
	rmSync(home, { recursive: true, force: true });
});

function thornwick(): ScenarioArtifact {
	const artifact = readScenarioFile(scenarioPath("thornwick-road"));
	if (!artifact) throw new Error("thornwick-road did not load");
	return artifact;
}

/** The ids of the side errands the fitting pass would have handed over. */
function sideQuests(artifact: ScenarioArtifact): string[] {
	return (artifact.arc?.beats ?? []).filter((beat) => beat.optional).map((beat) => beat.id);
}

function response(over: Partial<AdjustmentResponse> = {}): AdjustmentResponse {
	return { ending: null, revisions: [], beats: [], ...over };
}

function newBeat(over: Partial<AdjustmentResponse["beats"][number]> = {}) {
	return {
		id: "the-carters-thanks",
		siteIndex: 0,
		npcIndex: 0,
		summary: "The carter is grateful.",
		journal: "The carter owes me one.",
		needs: [0],
		quest: null,
		...over,
	};
}

describe("what an adjustment is allowed to name", () => {
	it("rejects a beat at a settlement this world does not have", () => {
		const artifact = thornwick();
		const lowered = lowerAdjustment(
			response({ beats: [newBeat({ siteIndex: 99 })] }),
			artifact,
			sideQuests(artifact),
		);
		expect(lowered).toBeUndefined();
	});

	it("rejects a beat opened by somebody who is not there", () => {
		const artifact = thornwick();
		const lowered = lowerAdjustment(
			response({ beats: [newBeat({ npcIndex: 99 })] }),
			artifact,
			sideQuests(artifact),
		);
		expect(lowered).toBeUndefined();
	});

	it("rejects an errand to speak to somebody two towns away", () => {
		// Found on a real run: the model wrote "speak to Oster" at a beat two towns from Oster,
		// which is somebody this world does contain — and `checkQuests` resolves an objective
		// against the surroundings of the beat that handed it out, so it called the target one
		// nothing answers to. Accepting it made the whole adjustment score worse and got it
		// discarded wholesale, which is a call spent for nothing.
		const artifact = thornwick();
		const sites = Object.values(artifact.sites);
		const elsewhere = sites[1]?.npcs[0]?.name as string;
		expect(elsewhere).toBeDefined();
		const lowered = lowerAdjustment(
			response({
				beats: [
					newBeat({
						siteIndex: 0,
						quest: {
							name: "A Word Far Away",
							description: "Go and find them.",
							objective: { kind: "talk", target: elsewhere },
						},
					}),
				],
			}),
			artifact,
			sideQuests(artifact),
		);
		expect(lowered).toBeUndefined();
	});

	it("rejects a beat opened by somebody with nothing written to say", () => {
		// A beat added *after* the dialogue pass has run is a beat whose anchor has no
		// conversation, and the validator says so. Every adjustment that added one scored worse
		// than the world it was written for and was thrown away — so the anchor has to be
		// somebody who already speaks.
		const artifact = thornwick();
		const sites = Object.values(artifact.sites);
		const mute = sites.findIndex((spec) =>
			spec.npcs.some((npc) => !artifact.trees?.[npcId(spec.siteId, npc.slot)]),
		);
		expect(mute, "every single person in thornwick has a conversation").toBeGreaterThanOrEqual(0);
		const spec = sites[mute] as (typeof sites)[number];
		const slot = spec.npcs.findIndex((npc) => !artifact.trees?.[npcId(spec.siteId, npc.slot)]);
		const lowered = lowerAdjustment(
			response({ beats: [newBeat({ siteIndex: mute, npcIndex: slot })] }),
			artifact,
			sideQuests(artifact),
		);
		expect(lowered).toBeUndefined();
	});

	it("rejects an errand naming something this world does not contain", () => {
		const artifact = thornwick();
		const lowered = lowerAdjustment(
			response({
				beats: [
					newBeat({
						quest: {
							name: "A Word With Nobody",
							description: "Find them.",
							objective: { kind: "talk", target: "Nobody At All" },
						},
					}),
				],
			}),
			artifact,
			sideQuests(artifact),
		);
		expect(lowered).toBeUndefined();
	});

	it("rejects a beat waiting on a side errand that did not fit", () => {
		const artifact = thornwick();
		// Nothing fitted, so index 0 names nothing — which is exactly the case this pass exists
		// for: what survived is not knowable until the world has been played.
		const lowered = lowerAdjustment(response({ beats: [newBeat()] }), artifact, []);
		expect(lowered).toBeUndefined();
	});

	it("adds a beat everything about which exists, and only ever as a side errand", () => {
		const artifact = thornwick();
		const fitted = sideQuests(artifact);
		const sites = Object.values(artifact.sites);
		// Somebody who already speaks, since a beat opened by somebody with nothing written for
		// them is the case above.
		const at = sites.findIndex((spec) =>
			spec.npcs.some((npc) => artifact.trees?.[npcId(spec.siteId, npc.slot)]),
		);
		const site = sites[at];
		const slot = (site?.npcs ?? []).findIndex(
			(npc) => artifact.trees?.[npcId(site?.siteId as number, npc.slot)],
		);
		const lowered = lowerAdjustment(
			response({
				beats: [
					newBeat({
						siteIndex: at,
						npcIndex: slot,
						quest: {
							name: "The Carter's Thanks",
							description: "Go back and hear him out.",
							// Deliberately spelled loosely: the world's own spelling is what must land on
							// the objective, or the player reads one name and the game ticks another.
							objective: { kind: "reach", target: (site?.name ?? "").toLowerCase() },
						},
					}),
				],
			}),
			artifact,
			fitted,
		);
		const added = lowered?.arc.beats.find((beat) => beat.id === "the-carters-thanks");
		expect(added).toBeDefined();
		expect(added?.optional, "an adjustment may not add to the main line").toBe(true);
		expect(added?.requires).toEqual({ flag: `arc:${fitted[0]}` });
		expect(added?.quest?.objectives[0]?.target).toBe(site?.name);
		// And the main line is exactly what it was.
		expect(mainLineBeats(lowered?.arc as never).length).toBe(
			mainLineBeats(artifact.arc as never).length,
		);
	});

	it("puts a new ending ahead of the old ones, because the first match wins", () => {
		const artifact = thornwick();
		const lowered = lowerAdjustment(
			response({
				ending: {
					title: "The Long Way Round",
					heading: "After",
					body: "You went where nobody asked you to.",
					needs: [0],
				},
			}),
			artifact,
			sideQuests(artifact),
		);
		expect(lowered?.arc.endings?.[0]?.title).toBe("The Long Way Round");
		expect(lowered?.arc.endings?.length).toBe((artifact.arc?.endings?.length ?? 0) + 1);
	});

	it("revises the words of a beat and nothing else about it", () => {
		const artifact = thornwick();
		const before = artifact.arc?.beats[1] as ScenarioBeat;
		const lowered = lowerAdjustment(
			response({ revisions: [{ beat: 1, journal: "A new line entirely.", errand: null }] }),
			artifact,
			sideQuests(artifact),
		);
		const after = lowered?.arc.beats.find((beat) => beat.id === before.id);
		expect(after?.journal).toBe("A new line entirely.");
		expect(after?.siteId).toBe(before.siteId);
		expect(after?.npcSlot).toBe(before.npcSlot);
		expect(after?.setsFlag).toBe(before.setsFlag);
		expect(after?.requires).toEqual(before.requires);
	});

	it("keeps the story it was given when nothing survived the checks", () => {
		const artifact = thornwick();
		expect(lowerAdjustment(response(), artifact, sideQuests(artifact))).toBeUndefined();
	});
});

describe("adjustTheStory", { timeout: 180_000 }, () => {
	it("makes no call when no side errand fitted", async () => {
		const artifact = thornwick();
		let asked = 0;
		const result = await adjustTheStory({
			artifact,
			fitted: [],
			ask: async () => {
				asked++;
				return undefined;
			},
		});
		expect(asked, "a call spent to be told there is nothing to say").toBe(0);
		expect(result.artifact).toBe(artifact);
		expect(result.calls).toBe(0);
	});

	it("keeps an adjustment the story still plays with", async () => {
		const artifact = thornwick();
		const result = await adjustTheStory({
			artifact,
			fitted: sideQuests(artifact),
			ask: async () =>
				response({ revisions: [{ beat: 0, journal: "Cull signs two tallies.", errand: null }] }),
		});
		expect(result.discarded).toBeUndefined();
		expect(result.artifact).not.toBe(artifact);
		expect(result.changes.length).toBeGreaterThan(0);
	});

	it("throws the whole adjustment away when the story stops playing", async () => {
		// Asserted on a world that was *already* broken, which is the honest version of this
		// guarantee: the pass discards its own work whenever the walk after it does not pass,
		// rather than only when it can tell it was to blame. It has no business shipping a story
		// it cannot see play, however sure it is that its own change was harmless.
		const artifact = thornwick();
		const arc = artifact.arc as NonNullable<ScenarioArtifact["arc"]>;
		const beats = mainLineBeats(arc).filter((beat) => beat.branch === undefined);
		const last = beats[beats.length - 1] as ScenarioBeat;
		const broken = {
			...artifact,
			arc: {
				...arc,
				beats: arc.beats.map((beat) =>
					beat.id === last.id ? { ...beat, siteId: 987_654_321 } : beat,
				),
			},
		};

		const result = await adjustTheStory({
			artifact: broken,
			fitted: sideQuests(broken),
			ask: async () =>
				response({ revisions: [{ beat: 0, journal: "Something worth saying.", errand: null }] }),
		});
		expect(result.discarded).toContain(last.id);
		expect(result.artifact, "the pre-adjustment story is what is kept").toBe(broken);
		expect(result.changes).toEqual([]);
	});
});
