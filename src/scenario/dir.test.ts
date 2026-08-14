import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	npcIdFor,
	TWO_PHASE_ID,
	twoPhaseArtifact,
	WENTHOLLOW_ID,
} from "../../test/fixtures/two-phase.js";
import type { ScenarioArtifact } from "./artifact.js";
import { listScenarioDirs, readScenarioDir, writeScenarioDir } from "./dir.js";

const roots: string[] = [];

/** Write an artifact into a throwaway root and hand back where it landed. */
function laid(artifact: ScenarioArtifact = twoPhaseArtifact()): string {
	const root = mkdtempSync(join(tmpdir(), "scenario-dir-"));
	roots.push(root);
	return writeScenarioDir(artifact, root);
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("a scenario as a directory", () => {
	it("writes the files where the format says they go", () => {
		const dir = laid();
		for (const file of [
			"scenario.json",
			"world/sites.json",
			"world/placements.json",
			"world/terraform.json",
			"phases/2-after-the-flood.json",
			"scenes/the-messenger-arrives.json",
			`trees/${npcIdFor(WENTHOLLOW_ID, 0)}.json`,
		]) {
			expect(existsSync(join(dir, file)), file).toBe(true);
		}
	});

	/*
	 * The round trip is the contract, rather than which line a field lands on. A test against
	 * expected file contents would fail every time a comment moved, and would not catch the
	 * thing that matters — a field that goes out and does not come back.
	 */
	it("reads back exactly what was written", () => {
		const artifact = twoPhaseArtifact();
		expect(readScenarioDir(laid(artifact))).toEqual(artifact);
	});

	it("is version two", () => {
		expect(readScenarioDir(laid())?.artifactVersion).toBe(2);
	});

	it("keeps the phases in file order", () => {
		expect(readScenarioDir(laid())?.phases?.map((phase) => phase.id)).toEqual(["after-the-flood"]);
	});

	it("keys scenes and conversations by their filename", () => {
		const artifact = readScenarioDir(laid());
		expect(Object.keys(artifact?.scenes ?? {})).toEqual(["the-messenger-arrives"]);
		for (const [key, tree] of Object.entries(artifact?.trees ?? {})) {
			expect(tree.npcId).toBe(key);
		}
	});

	it("is not there when the directory has no scenario.json", () => {
		expect(readScenarioDir(join(laid(), "world"))).toBeUndefined();
	});

	it("is not there when the directory does not exist at all", () => {
		expect(readScenarioDir(join(tmpdir(), "no-such-scenario-anywhere"))).toBeUndefined();
	});
});

describe("what a directory is refused for", () => {
	it("a scene whose id disagrees with its filename", () => {
		// Two names for one thing is two things to keep in step by hand, and the one that would
		// go wrong is the trigger — it names the scene by id, and would find nothing.
		const dir = laid();
		const path = join(dir, "scenes/the-messenger-arrives.json");
		const scene = JSON.parse(readFileSync(path, "utf8"));
		writeFileSync(path, JSON.stringify({ ...scene, id: "something-else" }));
		expect(readScenarioDir(dir)).toBeUndefined();
	});

	it("a conversation whose npcId disagrees with its filename", () => {
		const dir = laid();
		const path = join(dir, `trees/${npcIdFor(WENTHOLLOW_ID, 0)}.json`);
		const tree = JSON.parse(readFileSync(path, "utf8"));
		writeFileSync(path, JSON.stringify({ ...tree, npcId: "9999-9" }));
		expect(readScenarioDir(dir)).toBeUndefined();
	});

	it("a trigger that plays a scene which is not there", () => {
		const artifact = twoPhaseArtifact();
		const dir = laid({
			...artifact,
			triggers: [
				{
					id: "ghost",
					when: { flag: "flood" },
					effects: [{ t: "PlayScene", id: "no-such-scene" }],
				},
			],
		});
		expect(readScenarioDir(dir)).toBeUndefined();
	});

	it("a later phase with no condition, which would be in force from the first frame", () => {
		const artifact = twoPhaseArtifact();
		const phase = artifact.phases?.[0];
		if (!phase) throw new Error("the fixture has no phase, so this test proves nothing");
		const { when: always, ...unconditional } = phase;
		void always;
		expect(readScenarioDir(laid({ ...artifact, phases: [unconditional] }))).toBeUndefined();
	});

	it("a phase diff over something nothing adds", () => {
		const artifact = twoPhaseArtifact();
		const phase = artifact.phases?.[0];
		if (!phase) throw new Error("the fixture has no phase, so this test proves nothing");
		const dir = laid({
			...artifact,
			phases: [{ ...phase, placements: { remove: ["a-thing-that-was-never-there"] } }],
		});
		expect(readScenarioDir(dir)).toBeUndefined();
	});

	it("a scene that grants an item before its last step", () => {
		const artifact = twoPhaseArtifact();
		const scene = artifact.scenes?.["the-messenger-arrives"];
		if (!scene) throw new Error("the fixture has no scene, so this test proves nothing");
		const dir = laid({
			...artifact,
			scenes: {
				"the-messenger-arrives": {
					...scene,
					steps: [
						{
							do: [
								{
									t: "Effects",
									effects: [{ t: "GrantItem", name: "Ledger", description: "Damp.", quantity: 1 }],
								},
							],
						},
						...scene.steps,
					],
				},
			},
		});
		expect(readScenarioDir(dir)).toBeUndefined();
	});

	it("a file that is not JSON at all", () => {
		const dir = laid();
		writeFileSync(join(dir, "scenes/the-messenger-arrives.json"), "{ not json");
		expect(readScenarioDir(dir)).toBeUndefined();
	});
});

describe("writing a directory again", () => {
	it("removes a phase that is no longer in the artifact", () => {
		// A chapter deleted from the artifact and left on disk would keep being played, which is
		// the worst kind of stale file: the world has a chapter nothing in the source mentions.
		const artifact = twoPhaseArtifact();
		const dir = laid(artifact);
		expect(existsSync(join(dir, "phases/2-after-the-flood.json"))).toBe(true);

		const { phases: dropped, ...withoutPhases } = artifact;
		void dropped;
		writeScenarioDir(withoutPhases, join(dir, ".."));
		expect(existsSync(join(dir, "phases/2-after-the-flood.json"))).toBe(false);
		expect(readScenarioDir(dir)?.phases).toBeUndefined();
	});
});

describe("listScenarioDirs", () => {
	it("names the directories and ignores loose files", () => {
		const dir = laid();
		const root = join(dir, "..");
		writeFileSync(join(root, "notes.txt"), "not a scenario");
		expect(listScenarioDirs(root)).toEqual([TWO_PHASE_ID]);
	});

	it("has nothing to list when the root does not exist", () => {
		expect(listScenarioDirs(join(tmpdir(), "no-such-root-anywhere"))).toEqual([]);
	});
});
