import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { twoPhaseArtifact } from "../../test/fixtures/two-phase.js";
import { mainLineBeats, type ScenarioBeat } from "../core/rules/arc.js";
import { listSaves } from "../persist/save-repo.js";
import { walkMainLine, withStory } from "./play.js";

/**
 * Playing a story, without deciding anything about it.
 *
 * The split this file exists to protect: a walk reports, and the policy above it decides what a
 * fault is worth. A walk that quietly repaired what it found would make its own report a
 * tautology — every world would settle, because settling would be defined as whatever the walk
 * did on the way through.
 */

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "auto-adventure-play-"));
	process.env.AUTO_ADVENTURE_HOME = home;
});

afterEach(() => {
	delete process.env.AUTO_ADVENTURE_HOME;
	rmSync(home, { recursive: true, force: true });
});

describe("walking the main line", { timeout: 180_000 }, () => {
	it("walks a good story to the end", async () => {
		const artifact = twoPhaseArtifact();
		expect(artifact.arc, "the fixture has no arc, so this test proves nothing").toBeDefined();

		const walk = await withStory(artifact, (playing) =>
			walkMainLine(artifact, playing, Date.now() + 120_000),
		);
		expect(walk.stuck?.why).toBeUndefined();
		expect(walk.opened.length).toBeGreaterThan(0);
	});

	it("reports the beat it could not open rather than fixing it", async () => {
		const artifact = twoPhaseArtifact();
		const arc = artifact.arc;
		if (!arc) throw new Error("the fixture has no arc, so this test proves nothing");
		// Not an arm of a fork: opening one arm bars its siblings, so a broken arm would be
		// skipped as barred rather than reached, and this would pass for the wrong reason.
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

		const walk = await withStory(broken, (playing) =>
			walkMainLine(broken, playing, Date.now() + 120_000),
		);
		expect(walk.stuck?.beat).toBe(last.id);
		expect(walk.stuck?.why).toContain("987654321");
		// Everything before it opened, which is what "forward" means: the walk got as far as it
		// could and says exactly where it stopped.
		expect(walk.opened.length).toBe(beats.length - 1);
		expect(walk.opened).not.toContain(last.id);
	});

	it("leaves no world behind for the launcher to offer", async () => {
		// The regression test for the `walk-<id>` leak: `dispose()` flushes a save repository, so
		// a walk with nothing to stop it wrote a world into the player's Continue list.
		const artifact = twoPhaseArtifact();
		await withStory(artifact, (playing) => walkMainLine(artifact, playing, Date.now() + 120_000));
		expect(listSaves()).toEqual([]);
	});
});
