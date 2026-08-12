import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mainLineBeats } from "../core/rules/arc.js";
import { listSaves } from "../persist/save-repo.js";
import { readScenarioFile, scenarioPath } from "./repo.js";
import { settleTheStory } from "./settle.js";

/**
 * Making a story work, rather than reporting that it does not.
 *
 * The shipped scenarios are the subjects because they are known good: settling one must succeed,
 * and must not touch the story to do it. A pass that "fixed" a working world by shortening it
 * would be the failure this whole track exists to prevent, and it is silent — every test about
 * faults would still pass.
 *
 * "Changes nothing" turned out to be the wrong bar, and finding that out was worth the attempt.
 * Both shipped artifacts carry placements their ground does not honour — seven of them in
 * thornwick, three in green-chapel, people asked to stand at a well or a yard the town never
 * built. `pickAnchor` falls through to any free outdoor anchor, so none of it breaks a story;
 * they are lies in the file rather than faults in the world, and they are there because a
 * shipped scenario is assembled from a draft and never went through the repair pass. Settling
 * corrects them, which is right. So what is asserted here is that the story is untouched.
 */

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "auto-adventure-settle-"));
	process.env.AUTO_ADVENTURE_HOME = home;
});

afterEach(() => {
	delete process.env.AUTO_ADVENTURE_HOME;
	rmSync(home, { recursive: true, force: true });
});

describe("settleTheStory", { timeout: 180_000 }, () => {
	for (const name of ["thornwick-road", "green-chapel"]) {
		it(`settles ${name} without touching its story`, async () => {
			const artifact = readScenarioFile(scenarioPath(name));
			expect(artifact, `${name} did not load`).toBeDefined();
			if (!artifact) return;
			const arc = artifact.arc;
			expect(arc, `${name} has no arc, so this test proves nothing`).toBeDefined();
			if (!arc) return;

			const report = await settleTheStory(artifact);
			expect(report.stuck?.why, "a main-line beat could not be settled").toBeUndefined();
			expect(report.settled).toBe(true);
			expect(report.grown, "a known-good world was regrown").toEqual({});

			// Whatever was fixed was a placement — where somebody stands, or where a thing is
			// hidden — and never the story. Matched on the repair's own words, which are stable
			// because they are what the working record shows a player.
			for (const fix of report.fixes) {
				expect(fix, "settling changed something that is not a placement").toMatch(
					/stood them at|moved them into|put them outdoors|dropped the claim|hid "|instead|spelled/,
				);
			}
			// And the story is exactly as long as it was. This is the assertion that would catch a
			// pass which made a world "work" by taking a step out of it.
			expect(report.artifact.arc?.beats.length).toBe(arc.beats.length);
			expect(
				report.artifact.arc?.beats.flatMap((entry) => entry.quest?.objectives ?? []).length,
			).toBe(arc.beats.flatMap((entry) => entry.quest?.objectives ?? []).length);
			// Every main-line beat except the arms of each fork that were not taken, counted from
			// the arc rather than written down so that an arc which gains a beat cannot make this
			// pass for the wrong reason. Opening one arm bars its siblings permanently — that is
			// what makes a choice a choice — so a fork of two arms contributes one opened beat.
			const arms = mainLineBeats(arc).filter((entry) => entry.branch !== undefined);
			const groups = new Set(arms.map((entry) => entry.branch)).size;
			expect(report.opened.length).toBe(mainLineBeats(arc).length - (arms.length - groups));
		});
	}

	it("says a world with no story is settled, without building one", async () => {
		const artifact = readScenarioFile(scenarioPath("thornwick-road"));
		if (!artifact) return;
		const { arc: _arc, ...storyless } = artifact;
		const report = await settleTheStory(storyless);
		expect(report.settled).toBe(true);
		expect(report.opened).toEqual([]);
	});

	it("leaves no world behind for the launcher to offer", async () => {
		const artifact = readScenarioFile(scenarioPath("thornwick-road"));
		if (!artifact) return;
		await settleTheStory(artifact);
		expect(listSaves()).toEqual([]);
	});

	it("moves somebody standing in a building the ground never built, and carries on", async () => {
		// The fault the walk exists to catch, injected. An indoor NPC in a building nothing here
		// has leaves them nowhere at all — not somewhere else, nowhere — so the beat they anchor
		// is unreachable while every offline check passes.
		const artifact = readScenarioFile(scenarioPath("thornwick-road"));
		if (!artifact) return;
		const arc = artifact.arc;
		if (!arc) return;
		const beat = mainLineBeats(arc)[0];
		expect(beat).toBeDefined();
		if (!beat) return;

		const spec = artifact.sites[String(beat.siteId)];
		expect(spec).toBeDefined();
		if (!spec) return;
		const broken = {
			...artifact,
			sites: {
				...artifact.sites,
				[String(beat.siteId)]: {
					...spec,
					npcs: spec.npcs.map((npc) =>
						npc.slot === beat.npcSlot
							? { ...npc, indoors: true, structureName: "The Nonexistent Counting House" }
							: npc,
					),
				},
			},
		};

		const report = await settleTheStory(broken);
		expect(report.fixes.length, "nothing was fixed").toBeGreaterThan(0);
		expect(report.settled, `still stuck: ${report.stuck?.why ?? ""}`).toBe(true);
		expect(report.artifact).not.toBe(broken);
		// And the person is somewhere that exists afterwards, which is the point rather than a
		// side effect of the pass having run.
		const fixed = report.artifact.sites[String(beat.siteId)]?.npcs.find(
			(npc) => npc.slot === beat.npcSlot,
		);
		expect(fixed?.structureName).not.toBe("The Nonexistent Counting House");
	});

	it("reports the beat it could not settle, rather than dropping it", async () => {
		// The rule the whole track rests on. A main-line beat anchored at a site that is not in
		// this world cannot be fixed by anything local — and the answer is to say so, not to
		// quietly shorten the story.
		const artifact = readScenarioFile(scenarioPath("thornwick-road"));
		if (!artifact) return;
		const arc = artifact.arc;
		if (!arc) return;
		// Not an arm of a fork: opening one arm bars its siblings, so a broken arm would be
		// skipped as barred rather than reached, and the test would pass for the wrong reason.
		const beats = mainLineBeats(arc).filter((entry) => entry.branch === undefined);
		const last = beats[beats.length - 1];
		expect(last).toBeDefined();
		if (!last) return;

		const broken = {
			...artifact,
			arc: {
				...arc,
				beats: arc.beats.map((entry) =>
					entry.id === last.id ? { ...entry, siteId: 987_654_321 } : entry,
				),
			},
		};

		const report = await settleTheStory(broken);
		expect(report.settled).toBe(false);
		expect(report.stuck?.beat).toBe(last.id);
		expect(report.stuck?.why).toContain("987654321");
		// The beats before it still opened, which is what "forward, fixing in place" means: the
		// pass got as far as it could and says exactly where it stopped.
		expect(report.opened.length).toBe(beats.length - 1);
		expect(report.opened).not.toContain(last.id);
		// And the story is intact. Nothing was deleted to make the fault go away.
		expect(report.artifact.arc?.beats.length).toBe(arc.beats.length);
	});
});
