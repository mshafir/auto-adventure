import { beforeEach, describe, expect, it } from "vitest";
import { listPacks } from "../content/load.js";
import { packRoot, scenarioRoot } from "../paths.js";
import { listScenarioDirs } from "./dir.js";
import { readScenarioAt } from "./repo.js";

/**
 * The scenarios that are actually in the repository, read the way the game reads them.
 *
 * This is the point of committing them. A scenario is a directory of hand-editable JSON
 * keyed to a seed, and every way it can go wrong is silent at runtime: a site id
 * the seed does not produce is a town that never gets its name, a dangling `goto`
 * is a conversation that ends abruptly, a pack name with a typo in it is a world
 * that stops appearing in the launcher. None of those fail a build, and none of
 * them are visible in a diff.
 *
 * So the check is the load itself. `readScenarioAt` already refuses everything
 * that would be broken — schema, seed consistency, arc reachability, dialogue
 * targets, and now a missing pack — and it is exercised here against the real
 * directory rather than a fixture.
 *
 * Deliberately reads the committed paths with no redirection, unlike `repo.test.ts`,
 * which points at a temporary directory so it can write. This one only reads.
 */
beforeEach(() => {
	delete process.env.AUTO_ADVENTURE_SCENARIOS;
	delete process.env.AUTO_ADVENTURE_PACKS;
});

/*
 * There is nothing in `.scenarios` on this branch yet.
 *
 * The pipeline that wrote the old ones has been deleted, and the first world authored by an
 * agent driving the `craft` CLI arrives in sub-project 3. So the loop below currently iterates
 * nothing — deliberately, rather than being skipped: the moment a scenario directory is
 * committed it is checked, without anybody remembering to turn a test back on. Until then the
 * claim these checks make is proved against the fixture, in `two-phase.test.ts`.
 */
describe(".scenarios", () => {
	const shipped = listScenarioDirs(scenarioRoot());

	it("is a directory of scenario directories, not of files", () => {
		// The one thing worth asserting while the shelf is empty: nothing has been left behind in
		// the old single-file format, which would be read as a scenario named `x.json`.
		for (const entry of shipped) expect(entry.endsWith(".json")).toBe(false);
	});

	for (const name of shipped) {
		it(`${name} loads, with every check the launcher applies`, () => {
			const artifact = readScenarioAt(`${scenarioRoot()}/${name}`);
			expect(artifact, `${name} did not load; the warning says why`).toBeDefined();
			// The directory name is the id a save records, so a renamed directory is a save that
			// can no longer find the scenario it came from.
			expect(artifact?.id).toBe(name);
		});

		it(`${name} arrives with its pack already folded in`, () => {
			const artifact = readScenarioAt(`${scenarioRoot()}/${name}`);
			if (!artifact?.pack) return;
			// Resolved, not referenced: this is what the save will carry.
			expect(artifact.content, `${name} names a pack but has no tables`).toBeDefined();
			expect(listPacks()).toContain(artifact.pack);
		});
	}
});

describe(".packs", () => {
	it("holds the default and is where listPacks looks", () => {
		expect(packRoot().endsWith(".packs")).toBe(true);
		expect(listPacks()).toContain("default");
	});
});
