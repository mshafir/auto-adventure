import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mainLineBeats, type ScenarioArc, type ScenarioBeat } from "../core/rules/arc.js";
import { listSaves } from "../persist/save-repo.js";
import { fitSideQuests } from "./fit.js";
import { readScenarioFile, scenarioPath } from "./repo.js";

/**
 * Fitting the side quests, with the main line already standing.
 *
 * The tolerance here is deliberately lower than the main line's, and every test below is about
 * one of the two halves of that. A side errand is worth having: so a working one must never be
 * dropped, and the pass must not touch the map to place it, because growing a site re-rolls its
 * layout and would move every plot the main line has just been settled against. And none of them
 * is worth risking the story for: so one that will not fit is dropped — unless dropping it would
 * take the main line with it, which is the one case where the fault is reported instead.
 */

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "auto-adventure-fit-"));
	process.env.AUTO_ADVENTURE_HOME = home;
});

afterEach(() => {
	delete process.env.AUTO_ADVENTURE_HOME;
	rmSync(home, { recursive: true, force: true });
});

describe("fitSideQuests", { timeout: 180_000 }, () => {
	for (const name of ["thornwick-road", "green-chapel"]) {
		it(`fits every side quest of ${name} without dropping any`, async () => {
			const artifact = readScenarioFile(scenarioPath(name));
			expect(artifact?.arc, `${name} has no arc`).toBeDefined();
			if (!artifact?.arc) return;
			const optional = artifact.arc.beats.filter((beat) => beat.optional);
			expect(optional.length, `${name} has no side quests, so this proves nothing`).toBeGreaterThan(
				0,
			);

			const report = await fitSideQuests(artifact);
			expect(report.dropped, `${name}: a working side quest was dropped`).toEqual([]);
			expect(report.refused).toEqual([]);
			expect(report.fitted.length).toBe(optional.length);
			// And never the map. This is the assertion that protects the settled main line: a
			// grown site is a re-rolled layout, and every placement in it was written against the
			// old one.
			expect(report.artifact.recipe?.places).toEqual(artifact.recipe?.places);
		});
	}

	it("drops the one it cannot fit and keeps the others", async () => {
		// Independence is the property: an unplaceable side errand must cost the others nothing.
		const artifact = readScenarioFile(scenarioPath("thornwick-road"));
		if (!artifact?.arc) return;
		const arc = artifact.arc;
		const optional = arc.beats.filter((beat) => beat.optional);
		const doomed = optional[0] as ScenarioBeat;
		const broken = {
			...artifact,
			arc: {
				...arc,
				beats: arc.beats.map((beat) =>
					beat.id === doomed.id ? { ...beat, siteId: 987_654_321 } : beat,
				),
			},
		};

		const report = await fitSideQuests(broken);
		expect(report.dropped.join(" ")).toContain(doomed.id);
		expect(report.fitted).toEqual(optional.slice(1).map((beat) => beat.id));
		expect(report.artifact.arc?.beats.some((beat) => beat.id === doomed.id)).toBe(false);
		// The main line is exactly as long as it was, which is the thing that must hold whatever
		// else this pass does.
		expect(mainLineBeats(report.artifact.arc as ScenarioArc).length).toBe(
			mainLineBeats(broken.arc).length,
		);
	});

	it("refuses to drop a side quest the main line waits on", async () => {
		// The rule the whole track rests on, in the one place this pass could break it: a
		// main-line beat written as a step of an optional one can never open once its parent is
		// gone, so the parent stays and the fault is reported.
		const artifact = readScenarioFile(scenarioPath("thornwick-road"));
		if (!artifact?.arc) return;
		const arc = artifact.arc;
		const doomed = arc.beats.find((beat) => beat.optional) as ScenarioBeat;
		const waiting = mainLineBeats(arc)[3] as ScenarioBeat;
		const broken = {
			...artifact,
			arc: {
				...arc,
				beats: arc.beats.map((beat) =>
					beat.id === doomed.id
						? { ...beat, siteId: 987_654_321 }
						: beat.id === waiting.id
							? { ...beat, requires: [`arc:${doomed.id}`] }
							: beat,
				),
			},
		};

		const report = await fitSideQuests(broken);
		expect(report.refused.join(" ")).toContain(doomed.id);
		expect(report.dropped.join(" ")).not.toContain(doomed.id);
		expect(report.artifact.arc?.beats.some((beat) => beat.id === doomed.id)).toBe(true);
	});

	it("keeps a side errand the main line barred by going the other way", async () => {
		// The one case a second attempt cannot examine: the arm is barred by the walk that brings
		// the story's state up, so there is no playthrough in which it is the arm that was chosen.
		// It did not fail to fit — it is the road the story did not take — and dropping it would
		// delete the alternative that made the choice worth making.
		const artifact = readScenarioFile(scenarioPath("thornwick-road"));
		if (!artifact?.arc) return;
		const arc = artifact.arc;
		const fork = arc.beats.find((beat) => beat.branch !== undefined) as ScenarioBeat;
		expect(fork, "thornwick-road has no fork on its main line").toBeDefined();
		const side = arc.beats.find((beat) => beat.optional) as ScenarioBeat;
		const forked = {
			...artifact,
			arc: {
				...arc,
				beats: arc.beats.map((beat) =>
					beat.id === side.id ? { ...beat, branch: fork.branch } : beat,
				),
			},
		};

		const report = await fitSideQuests(forked);
		expect(report.fitted).toContain(side.id);
		expect(report.dropped).toEqual([]);
		expect(report.artifact.arc?.beats.length).toBe(arc.beats.length);
	});

	it("still drops a forked side errand that could not open whichever arm was taken", async () => {
		// Two side errands forking against each other. Opening one bars the other, so they cannot
		// both be tried in one playthrough — and calling the barred one "kept, unexamined" would
		// hide precisely this: a beat that can never open, left in the story because the pass
		// never got a session in which it was the one chosen.
		const artifact = readScenarioFile(scenarioPath("thornwick-road"));
		if (!artifact?.arc) return;
		const arc = artifact.arc;
		const optional = arc.beats.filter((beat) => beat.optional);
		expect(optional.length, "this test needs two side errands to fork between").toBe(2);
		const good = optional[0] as ScenarioBeat;
		const doomed = optional[1] as ScenarioBeat;
		const forked = {
			...artifact,
			arc: {
				...arc,
				beats: arc.beats.map((beat) =>
					beat.id === good.id
						? { ...beat, branch: "the-favour" }
						: beat.id === doomed.id
							? { ...beat, branch: "the-favour", siteId: 987_654_321 }
							: beat,
				),
			},
		};

		const report = await fitSideQuests(forked);
		expect(report.fitted).toEqual([good.id]);
		expect(report.dropped.join(" ")).toContain(doomed.id);
	});

	it("has nothing to do when the story has no side quests", async () => {
		const artifact = readScenarioFile(scenarioPath("thornwick-road"));
		if (!artifact?.arc) return;
		const straight = {
			...artifact,
			arc: { ...artifact.arc, beats: artifact.arc.beats.filter((beat) => !beat.optional) },
		};
		const report = await fitSideQuests(straight);
		expect(report.artifact).toBe(straight);
		expect(report.fitted).toEqual([]);
	});

	it("leaves no world behind for the launcher to offer", async () => {
		const artifact = readScenarioFile(scenarioPath("thornwick-road"));
		if (!artifact) return;
		await fitSideQuests(artifact);
		expect(listSaves()).toEqual([]);
	});
});
