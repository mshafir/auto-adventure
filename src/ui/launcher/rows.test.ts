import { describe, expect, it } from "vitest";
import { hashString } from "../../core/rand/hash.js";
import type { SaveSummary } from "../../persist/save-repo.js";
import type { ScenarioSummary } from "../../scenario/repo.js";
import {
	buildRows,
	type ChoiceContext,
	choiceFor,
	firstSelectable,
	freeWorldId,
	isSelectable,
	type LauncherRow,
	moveCursor,
} from "./rows.js";

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

describe("buildRows", () => {
	it("offers only a new world when there is nothing to resume", () => {
		const rows = buildRows({ saves: [], scenarios: [], canUseModel: true });
		expect(rows.filter((r) => r.kind === "save")).toHaveLength(0);
		expect(rows.filter((r) => r.kind === "scenario")).toHaveLength(0);
		expect(rows.filter((r) => r.kind === "new").length).toBeGreaterThan(0);
	});

	it("hides the live options when there is no key", () => {
		// Offering a world the game cannot actually author is a promise it breaks
		// three steps later, in the log, where nobody is looking.
		const rows = buildRows({ saves: [], scenarios: [], canUseModel: false });
		const flavours = rows.filter((r) => r.kind === "new").map((r) => r.kind === "new" && r.flavour);
		expect(flavours).toEqual(["procedural"]);
	});

	it("lists saves and scenarios under their own headings", () => {
		const rows = buildRows({
			saves: [save()],
			scenarios: [scenario()],
			canUseModel: true,
		});
		const headers = rows.filter((r) => r.kind === "header").map((r) => r.label);
		expect(headers).toEqual(["Continue", "Scenarios", "New world"]);
	});

	it("says which scenario a resumed scenario world came from", () => {
		const rows = buildRows({
			saves: [save({ scenarioId: "drowned-archipelago" })],
			scenarios: [],
			canUseModel: true,
		});
		const row = rows.find((r) => r.kind === "save");
		expect(row?.kind === "save" && row.detail).toContain("drowned-archipelago");
	});
});

describe("cursor movement", () => {
	const rows = buildRows({ saves: [save()], scenarios: [scenario()], canUseModel: true });

	it("starts on something selectable", () => {
		const at = firstSelectable(rows);
		expect(at).toBeGreaterThanOrEqual(0);
		expect(isSelectable(rows[at] as LauncherRow)).toBe(true);
	});

	it("never lands on a heading", () => {
		let at = firstSelectable(rows);
		for (let i = 0; i < rows.length * 2; i++) {
			at = moveCursor(rows, at, 1);
			expect(isSelectable(rows[at] as LauncherRow)).toBe(true);
		}
		for (let i = 0; i < rows.length * 2; i++) {
			at = moveCursor(rows, at, -1);
			expect(isSelectable(rows[at] as LauncherRow)).toBe(true);
		}
	});

	it("stops at the ends rather than wrapping", () => {
		const first = firstSelectable(rows);
		expect(moveCursor(rows, first, -1)).toBe(first);
		let last = first;
		for (let i = 0; i < rows.length; i++) last = moveCursor(rows, last, 1);
		expect(moveCursor(rows, last, 1)).toBe(last);
	});
});

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
		const choice = choiceFor(
			{ kind: "save", label: "hollowmoor", detail: "", save: existing },
			context({ saves: [existing] }),
		);
		expect(choice).toEqual({
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
			{ kind: "save", label: "arch", detail: "", save: existing },
			context({ saves: [existing], noAi: false }),
		);
		expect(choice?.flavour).toBe("prebuilt");
	});

	it("resumes a plain world procedurally when there is no model", () => {
		const existing = save();
		const choice = choiceFor(
			{ kind: "save", label: "default", detail: "", save: existing },
			context({ saves: [existing], noAi: true }),
		);
		expect(choice?.flavour).toBe("procedural");
	});

	it("gives a new scenario world a slot named after the scenario", () => {
		const choice = choiceFor(
			{ kind: "scenario", label: "x", detail: "", scenario: scenario() },
			context(),
		);
		expect(choice?.worldId).toBe("drowned-archipelago");
		expect(choice?.flavour).toBe("prebuilt");
	});

	it("does not reuse a scenario slot that is already played", () => {
		const choice = choiceFor(
			{ kind: "scenario", label: "x", detail: "", scenario: scenario() },
			context({ saves: [save({ worldId: "drowned-archipelago" })] }),
		);
		expect(choice?.worldId).toBe("drowned-archipelago-2");
	});

	it("derives a different seed for each new world", () => {
		// Otherwise every "new world" from the menu is the same world, since the
		// configured seed has a fixed default.
		const first = choiceFor({ kind: "new", label: "", detail: "", flavour: "live" }, context());
		const second = choiceFor(
			{ kind: "new", label: "", detail: "", flavour: "live" },
			context({ saves: [save({ worldId: "default" })] }),
		);
		expect(first?.worldId).toBe("default");
		expect(second?.worldId).toBe("default-2");
		expect(first?.seed).not.toBe(second?.seed);
	});

	it("honours a seed the environment asked for", () => {
		const choice = choiceFor(
			{ kind: "new", label: "", detail: "", flavour: "live" },
			context({ configuredSeed: 999 }),
		);
		expect(choice?.seed).toBe(999);
	});

	it("has nothing to choose for a heading", () => {
		expect(choiceFor({ kind: "header", label: "Continue" }, context())).toBeUndefined();
	});
});
