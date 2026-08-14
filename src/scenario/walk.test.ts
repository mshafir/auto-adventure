import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { twoPhaseArtifact } from "../../test/fixtures/two-phase.js";
import { listSaves } from "../persist/save-repo.js";
import { walkTheStory } from "./walk.js";

/**
 * A whole story, played to the end in the real engine.
 *
 * The strongest claim anything in this repository makes about a scenario, and the one
 * the offline checks cannot make: not that the story *looks* finishable, but that a
 * session built the ordinary way, walked the ordinary way, reaches the ending. Every
 * fault it has caught so far has been in the walker rather than in the scenarios — a
 * door opened with the wrong key, a room with no way out, a card nobody read — and each
 * of those was a thing a player does without thinking about it and a harness has to be
 * told.
 */

let home: string;

beforeEach(() => {
	// A home of its own, so nothing here can read or write the real saves. The walk no longer
	// writes one — `persist: false`, pinned by the test below — and this is the belt to those
	// braces: a test that builds a session and plays it must not be able to reach a
	// playthrough if any of that goes wrong.
	home = mkdtempSync(join(tmpdir(), "auto-adventure-walk-"));
	process.env.AUTO_ADVENTURE_HOME = home;
});

afterEach(() => {
	delete process.env.AUTO_ADVENTURE_HOME;
	rmSync(home, { recursive: true, force: true });
});

// Building a session, generating chunks and walking between towns is real work.
const SLOW = { timeout: 120_000 };

describe("walkTheStory", SLOW, () => {
	it("plays the two-phase fixture to its ending", async () => {
		const artifact = twoPhaseArtifact();
		const walk = await walkTheStory(artifact, "walk-test-two-phase");
		expect(walk.absent, "somebody the story hangs on was not standing anywhere").toEqual([]);
		expect(walk.stuck, "a beat never opened").toEqual([]);
		expect(walk.unfinished, "an errand could not be closed").toEqual([]);
		expect(walk.finished).toBe(true);
		expect(walk.opened.length).toBe(artifact.arc?.beats.length ?? 0);
	});

	/*
	 * The walk has to be able to get *through* a cutscene, or every beat behind one is
	 * unreachable and a scenario that plays perfectly reports as stuck at its first scene.
	 */
	it("gets through the cutscene on the way, rather than stopping at it", async () => {
		const walk = await walkTheStory(twoPhaseArtifact(), "walk-test-cutscene");
		expect(walk.finished).toBe(true);
	});

	it("leaves no world behind for the launcher to offer", async () => {
		// The walk used to write a save under `walk-<id>`, and `listSaves` has no filter — so
		// a checked scenario appeared in Continue as a half-played world nobody started. That
		// was tolerable while this was a tool somebody ran by hand and is not once generation
		// walks every story it writes.
		await walkTheStory(twoPhaseArtifact(), "walk-test-ephemeral");
		expect(listSaves().map((entry) => entry.worldId)).not.toContain("walk-test-ephemeral");
	});

	it("says a world with no story is finished, without building one", async () => {
		const { arc: _arc, ...storyless } = twoPhaseArtifact();
		const walk = await walkTheStory(storyless, "walk-test-storyless");
		expect(walk.finished).toBe(true);
		expect(walk.opened).toEqual([]);
	});
});
