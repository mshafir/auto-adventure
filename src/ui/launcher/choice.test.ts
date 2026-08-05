import { describe, expect, it } from "vitest";
import { hashString } from "../../core/rand/hash.js";
import type { SaveSummary } from "../../persist/save-repo.js";
import type { ScenarioSummary } from "../../scenario/repo.js";
import { type ChoiceContext, choiceFor, freeWorldId } from "./choice.js";

function save(overrides: Partial<SaveSummary> = {}): SaveSummary {
	return {
		worldId: "default",
		name: "default",
		seed: hashString("default"),
		at: { x: 10, y: 20 },
		day: 3,
		playedAt: 1000,
		...overrides,
	};
}

function scenario(overrides: Partial<ScenarioSummary> = {}): ScenarioSummary {
	return {
		id: "drowned-archipelago",
		title: "The Drowned Archipelago",
		blurb: "Debt-collectors and rope.",
		path: "/tmp/drowned-archipelago.json",
		siteCount: 13,
		...overrides,
	};
}

function context(overrides: Partial<ChoiceContext> = {}): ChoiceContext {
	return { saves: [], baseWorldId: "default", noAi: false, ...overrides };
}

describe("freeWorldId", () => {
	it("uses the name when it is free", () => {
		expect(freeWorldId("default", [])).toBe("default");
	});

	it("never returns a slot that is taken", () => {
		// The worst thing this screen could do is start a new world on top of
		// somebody's existing one.
		expect(freeWorldId("default", ["default"])).toBe("default-2");
		expect(freeWorldId("default", ["default", "default-2"])).toBe("default-3");
	});
});

describe("choiceFor", () => {
	it("resumes a save with its own seed, and insists it exists", () => {
		const existing = save({ worldId: "hollowmoor", seed: 4242 });
		expect(choiceFor({ kind: "save", save: existing }, context({ saves: [existing] }))).toEqual({
			worldId: "hollowmoor",
			seed: 4242,
			flavour: "live",
			mustExist: true,
		});
	});

	it("resumes a scenario world as prebuilt whatever the environment says", () => {
		// Its content is already written, so there is nothing for a model to do even
		// when one is available.
		const existing = save({ worldId: "arch", scenarioId: "drowned-archipelago" });
		const choice = choiceFor(
			{ kind: "save", save: existing },
			context({ saves: [existing], noAi: false }),
		);
		expect(choice.flavour).toBe("prebuilt");
	});

	it("resumes a plain world procedurally when there is no model", () => {
		const existing = save();
		const choice = choiceFor(
			{ kind: "save", save: existing },
			context({ saves: [existing], noAi: true }),
		);
		expect(choice.flavour).toBe("procedural");
	});

	it("gives a new scenario world a slot named after the scenario", () => {
		const choice = choiceFor({ kind: "scenario", scenario: scenario() }, context());
		expect(choice.worldId).toBe("drowned-archipelago");
		expect(choice.flavour).toBe("prebuilt");
	});

	it("does not reuse a scenario slot that is already played", () => {
		const choice = choiceFor(
			{ kind: "scenario", scenario: scenario() },
			context({ saves: [save({ worldId: "drowned-archipelago" })] }),
		);
		expect(choice.worldId).toBe("drowned-archipelago-2");
	});

	it("derives a different seed for each new world", () => {
		// Otherwise every "new world" from the menu is the same world, since the
		// configured seed has a fixed default.
		const first = choiceFor({ kind: "new", flavour: "live" }, context());
		const second = choiceFor(
			{ kind: "new", flavour: "live" },
			context({ saves: [save({ worldId: "default" })] }),
		);
		expect(first.worldId).toBe("default");
		expect(second.worldId).toBe("default-2");
		expect(first.seed).not.toBe(second.seed);
	});

	it("honours a seed the environment asked for", () => {
		const choice = choiceFor({ kind: "new", flavour: "live" }, context({ configuredSeed: 999 }));
		expect(choice.seed).toBe(999);
	});
});
