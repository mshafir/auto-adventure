import { describe, expect, it } from "vitest";
import { demoArtifact, demoSiteSpec } from "../../test/fixtures/scenario.js";
import { AuthoringStopped, type AuthorResult } from "../ai/author/author.js";
import type { ScenarioArtifact } from "./artifact.js";
import { freeScenarioId, generateScenario } from "./generate.js";
import { verifyArtifact } from "./repo.js";
import type { GenerateRequest } from "./scenario.js";
import type { Finding } from "./validate.js";

/**
 * Writing a world to order, minus the four minutes and the model.
 *
 * The flow is worth testing on its own because the first version of it was tested only by
 * running it, and the run that mattered — a world that generated, validated with faults,
 * wrote itself to disk, and then quit to the shell instead of being played — was a bug in
 * the eight lines *after* everything interesting had already succeeded.
 */

const REQUEST: GenerateRequest = {
	brief: { premise: "a siege that has gone on nine years", duration: "short" },
	dayAndNight: true,
	liveInGame: false,
};

/**
 * A stand-in for the authoring pipeline that reports what the real one would.
 *
 * Findings travel *with* the result rather than being re-derived here, because deriving
 * them means generating the whole bounded world a second time — so a fake author that
 * always claimed a clean world would be testing a contract nothing keeps.
 */
function author(artifact: ScenarioArtifact, calls = 12, findings: readonly Finding[] = []) {
	return async (): Promise<AuthorResult> => ({ artifact, calls, findings, repairs: [] });
}

/** A world with a fault in it, and the findings the authoring pass would hand over with it. */
function broken(): { artifact: ScenarioArtifact; findings: readonly Finding[] } {
	// A spec keyed to a site this seed does not produce: `verifyArtifact` calls that an
	// error, which is as bad as a generated artifact gets.
	const artifact = demoArtifact({ sites: { "12345": demoSiteSpec(12345) } });
	return {
		artifact,
		findings: [
			...verifyArtifact(artifact).map((message) => ({ severity: "error" as const, message })),
			{ severity: "warning" as const, message: "a place the story never visits" },
		],
	};
}

/** Collects what was written instead of touching `.scenarios`. */
function harness(overrides: Partial<Parameters<typeof generateScenario>[1]> = {}) {
	const written: ScenarioArtifact[] = [];
	const progress: string[] = [];
	return {
		written,
		progress,
		deps: {
			onProgress: (message: string) => progress.push(message),
			author: author(demoArtifact()),
			write: (artifact: ScenarioArtifact) => {
				written.push(artifact);
				return `/tmp/${artifact.id}.json`;
			},
			taken: () => [],
			...overrides,
		} as Parameters<typeof generateScenario>[1],
	};
}

describe("generating a world", () => {
	it("writes it and hands back something to play", async () => {
		// The regression. Everything below the write used to run in an Ink callback and the
		// process ended before the world opened, so the file was on disk and the player was
		// back at their shell with no idea why.
		const h = harness();
		const outcome = await generateScenario(REQUEST, h.deps);

		expect(h.written).toHaveLength(1);
		expect(outcome.path).toBeTruthy();
		expect(outcome.choice).toBeDefined();
		expect(outcome.choice?.flavour).toBe("prebuilt");
		expect(outcome.choice?.scenario).toBeDefined();
		expect(outcome.stopped).toBeUndefined();
		expect(outcome.failure).toBeUndefined();
	});

	it("hands back a world to play even when it has faults in it", async () => {
		// A finding is a fault in *our* authoring passes. Refusing to start after several
		// paid minutes turns a blemish into a total loss, so findings are reported and the
		// world is still played.
		const { artifact, findings } = broken();
		const h = harness({ author: author(artifact, 12, findings) });
		const outcome = await generateScenario(REQUEST, h.deps);

		expect(outcome.findings.some((f) => f.severity === "error")).toBe(true);
		expect(outcome.choice, "a world with faults is still a world").toBeDefined();
		expect(h.written).toHaveLength(1);
	});

	it("puts the errors above the warnings, so a truncated list shows what matters", async () => {
		const faulty = broken();
		const h = harness({ author: author(faulty.artifact, 12, faulty.findings) });
		const { findings } = await generateScenario(REQUEST, h.deps);
		const firstWarning = findings.findIndex((f) => f.severity !== "error");
		const lastError = findings.map((f) => f.severity).lastIndexOf("error");
		if (firstWarning >= 0 && lastError >= 0) expect(lastError).toBeLessThan(firstWarning);
	});

	it("writes nothing when the player stops it", async () => {
		const h = harness({
			author: async () => {
				throw new AuthoringStopped("the regions");
			},
		});
		const outcome = await generateScenario(REQUEST, h.deps);

		expect(outcome.stopped).toBe(true);
		expect(outcome.choice).toBeUndefined();
		expect(h.written, "a half-authored world is not a world").toHaveLength(0);
	});

	it("writes nothing when authoring fails, and says what happened", async () => {
		const h = harness({
			author: async () => {
				throw new Error("the gateway said no");
			},
		});
		const outcome = await generateScenario(REQUEST, h.deps);

		expect(outcome.failure).toContain("the gateway said no");
		expect(outcome.choice).toBeUndefined();
		expect(h.written).toHaveLength(0);
	});

	it("carries the settings it was asked for onto the artifact", async () => {
		const h = harness();
		await generateScenario(
			{ ...REQUEST, tiles: "gramarye", pack: "camelot", dayAndNight: false, liveInGame: true },
			h.deps,
		);
		expect(h.written[0]).toMatchObject({
			tiles: "gramarye",
			pack: "camelot",
			time: { enabled: false },
			liveInGame: true,
		});
	});

	it("says nothing about the clock for an ordinary world", async () => {
		// So a generated artifact stays the shape every hand-written one already has.
		const h = harness();
		await generateScenario(REQUEST, h.deps);
		expect(h.written[0]?.time).toBeUndefined();
		expect(h.written[0]?.liveInGame).toBeUndefined();
	});

	it("reports progress as it goes", async () => {
		const h = harness({
			author: async (options) => {
				options.onProgress?.("lore: The Long Siege");
				return { artifact: demoArtifact(), calls: 1, findings: [], repairs: [] };
			},
		});
		await generateScenario(REQUEST, h.deps);
		expect(h.progress).toContain("lore: The Long Siege");
	});
});

describe("naming the file it will be kept in", () => {
	it("names it after what was asked for, because .scenarios is read by people", () => {
		expect(freeScenarioId("A siege that has gone on nine years!", [])).toBe(
			"a-siege-that-has-gone",
		);
	});

	it("falls back to a fixed stem when the model chose the premise", () => {
		expect(freeScenarioId(undefined, [])).toBe("a-world");
		expect(freeScenarioId("   ", [])).toBe("a-world");
	});

	it("never overwrites a world that is already there", () => {
		expect(freeScenarioId(undefined, ["a-world"])).toBe("a-world-2");
		expect(freeScenarioId(undefined, ["a-world", "a-world-2"])).toBe("a-world-3");
	});

	it("only ever produces a name the scenario id rules accept", () => {
		for (const premise of ["!!!", "ÜBER", "a/../../etc/passwd", "9 lives", ""]) {
			expect(freeScenarioId(premise, []), premise).toMatch(/^[a-z0-9][a-z0-9-]*$/);
		}
	});
});
