import { readdirSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { listPacks } from "../content/load.js";
import { packRoot, scenarioRoot } from "../paths.js";
import { readScenarioFile } from "./repo.js";

/**
 * The files that are actually in the repository, read the way the game reads them.
 *
 * This is the point of committing them. A scenario is 30KB of hand-editable JSON
 * keyed to a seed, and every way it can go wrong is silent at runtime: a site id
 * the seed does not produce is a town that never gets its name, a dangling `goto`
 * is a conversation that ends abruptly, a pack name with a typo in it is a world
 * that stops appearing in the launcher. None of those fail a build, and none of
 * them are visible in a diff.
 *
 * So the check is the load itself. `readScenarioFile` already refuses everything
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

function jsonFiles(root: string): string[] {
	try {
		return readdirSync(root)
			.filter((entry) => entry.endsWith(".json"))
			.sort();
	} catch {
		return [];
	}
}

describe(".scenarios", () => {
	const files = jsonFiles(scenarioRoot());

	it("has something in it", () => {
		expect(files.length).toBeGreaterThan(0);
	});

	for (const file of files) {
		it(`${file} loads, with every check the launcher applies`, () => {
			const artifact = readScenarioFile(`${scenarioRoot()}/${file}`);
			expect(artifact, `${file} did not load; the warning says why`).toBeDefined();
			// The stem is the id a save records, so a renamed file is a save that can no
			// longer find the scenario it came from.
			expect(artifact?.id).toBe(file.slice(0, -".json".length));
		});

		it(`${file} arrives with its pack already folded in`, () => {
			const artifact = readScenarioFile(`${scenarioRoot()}/${file}`);
			if (!artifact?.pack) return;
			// Resolved, not referenced: this is what the save will carry.
			expect(artifact.content, `${file} names a pack but has no tables`).toBeDefined();
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
