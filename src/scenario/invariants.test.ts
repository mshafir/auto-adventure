import { describe, expect, it } from "vitest";
import {
	demoArtifact,
	demoJourneyArtifact,
	demoSiteSpec,
	FIXTURE_SEED,
	findSettlement,
} from "../../test/fixtures/scenario.js";
import { clearFeatureCache } from "../core/gen/features/registry.js";
import type { SettlementSpec } from "../core/gen/features/settlement.js";
import { hashString } from "../core/rand/hash.js";
import { beatNpcId } from "../core/rules/arc.js";
import { boundsAround } from "../core/world/bounds.js";
import { macroSite } from "../core/world/macro.js";
import { worldSeed } from "../core/world/recipe.js";
import type { ScenarioArtifact } from "./artifact.js";
import {
	checkBuildingsReachable,
	checkInvariants,
	checkLegsWalkable,
	checkScenesWritten,
	checkStructuresBuilt,
} from "./invariants.js";

/** The one-town fixture, with its settlement asking for exactly these buildings. */
function withStructures(structures: SettlementSpec["structures"]): ScenarioArtifact {
	const site = findSettlement(FIXTURE_SEED);
	const spec = demoSiteSpec(site.id);
	return demoArtifact({
		sites: {
			[String(site.id)]: { ...spec, settlement: { ...spec.settlement, structures } },
		},
	});
}

describe("structures-built", () => {
	it("reports a structure the spec asked for that the settlement did not build", () => {
		clearFeatureCache();
		// Twenty-four halls in one town cannot all get a plot: a hall needs frontage
		// (`structures.ts` gives it a `plotPad`) and the BSP yields a handful of plots that
		// large. The builder swaps the rest for filler and says nothing, which is the
		// substitution this invariant exists to see.
		const artifact = withStructures(
			Array.from({ length: 24 }, (_, i) => ({
				kind: "hall" as const,
				size: "large" as const,
				importance: 5,
				name: `Hall ${i}`,
			})),
		);

		const violations = checkStructuresBuilt(artifact);

		expect(violations.length).toBeGreaterThan(0);
		expect(violations[0]?.invariant).toBe("structures-built");
		expect(violations[0]?.detail).toContain("hall");
	});

	it("reports every kind that came up short, in sorted order", () => {
		clearFeatureCache();
		// Two kinds this time, both oversubscribed, so the per-kind loop
		// (`[...wanted.keys()].sort()`) actually iterates more than once. Smithies are
		// listed before halls, so `wanted`'s insertion order is ["smithy", "hall"] — the
		// opposite of the alphabetical order asserted below. Without the `.sort()` at
		// `invariants.ts:91` this test would see "smithy" first and fail, which is what
		// makes it a check of the sort rather than an accident of construction order.
		const artifact = withStructures([
			...Array.from({ length: 12 }, (_, i) => ({
				kind: "smithy" as const,
				size: "large" as const,
				importance: 5,
				name: `Smithy ${i}`,
			})),
			...Array.from({ length: 12 }, (_, i) => ({
				kind: "hall" as const,
				size: "large" as const,
				importance: 5,
				name: `Hall ${i}`,
			})),
		]);

		const violations = checkStructuresBuilt(artifact);
		const kinds = violations.map((v) => v.detail);

		expect(violations.length).toBe(2);
		expect(kinds[0]).toContain("hall");
		expect(kinds[1]).toContain("smithy");
	});

	it("is silent when every requested structure was built", () => {
		clearFeatureCache();
		// The fixture's settlement site is a small fort (radius 15) with room for exactly
		// one plot, so its own default spec — the inn *and* a house — already triggers the
		// substitution this invariant exists to catch. That is a genuine finding, not a bug
		// in the check (confirmed by generating the patch directly and counting its
		// buildings), so it belongs to the "reports a violation" half of this suite, not
		// here. What this test needs is a spec sized to what the site can actually hold:
		// one structure, requested and built.
		const artifact = withStructures([
			{ kind: "inn", size: "medium", importance: 5, name: "The Drowned Lamp" },
		]);
		expect(checkStructuresBuilt(artifact)).toEqual([]);
	});
});

describe("buildings-reachable", () => {
	it("is silent on a settlement whose buildings all open onto the square", () => {
		clearFeatureCache();
		expect(checkBuildingsReachable(demoArtifact())).toEqual([]);
	});

	/**
	 * A real violation, not only the silent case above. Without this, the silent test
	 * would still pass with `checkBuildingsReachable` replaced by `() => []` — which is
	 * exactly the finding this test answers: the invariant backs one of the branch's two
	 * headline measurements ("buildings-reachable unchanged") and had never actually been
	 * made to fail.
	 *
	 * Reuses the seed and site `settlement.test.ts` pins for the same reason it pins them:
	 * `sweep2-242` at macro cell (-2,-3) is a walled town whose BSP gives it room for only
	 * a couple of plots against this 41-structure spec, so its required hall's own
	 * doorstep is stranded even after every prune round. Built directly from `macroSite`
	 * rather than through `findSettlement`, because the fixture needs *this* site and not
	 * whichever one a sweep from the origin finds first.
	 */
	it("reports a required building the carve could never reach", () => {
		clearFeatureCache();
		const seed = hashString("sweep2-242");
		const site = macroSite(worldSeed(seed), -2, -3);
		const spec = demoSiteSpec(site.id);

		const artifact = demoArtifact({
			seed,
			spawn: { x: site.site.x, y: site.site.y },
			bounds: boundsAround(site.site, site.radius + 40, { style: "cliffs", thickness: 6 }),
			sites: {
				[String(site.id)]: {
					...spec,
					name: "Bulwark",
					shortName: "Bulwark",
					settlement: {
						name: "Bulwark",
						walled: true,
						structures: [
							{
								kind: "hall",
								size: "large",
								importance: 1,
								id: "needed",
								name: "Needed",
								required: true,
							},
							...Array.from({ length: 40 }, () => ({
								kind: "house" as const,
								size: "large" as const,
								importance: 5,
							})),
						],
					},
				},
			},
		});

		const violations = checkBuildingsReachable(artifact);

		expect(violations.length).toBeGreaterThan(0);
		expect(violations[0]?.invariant).toBe("buildings-reachable");
		expect(violations.some((v) => v.detail.includes("Needed"))).toBe(true);
	});
});

describe("scenes-written", () => {
	it("reports a main-line beat with no conversation", () => {
		// `demoJourneyArtifact` has two beats, each with a journal and neither with a tree
		// — which is exactly the fault: the beat opens, the errand lands in the journal,
		// and the person it hangs on has nothing to say.
		const violations = checkScenesWritten(demoJourneyArtifact());

		expect(violations).toHaveLength(2);
		expect(violations[0]?.invariant).toBe("scenes-written");
		expect(violations[0]?.detail).toContain("no conversation");
	});

	it("is silent when every beat has words and a journal", () => {
		const artifact = demoJourneyArtifact();
		// A one-line tree per beat: enough to be a conversation, which is all this checks.
		const trees = Object.fromEntries(
			(artifact.arc?.beats ?? []).map((beat) => {
				const id = beatNpcId(beat);
				return [
					id,
					{
						npcId: id,
						entry: ["hello"],
						nodes: { hello: { id: "hello", speech: "Aye?", choices: [] } },
					},
				];
			}),
		);

		expect(checkScenesWritten({ ...artifact, trees })).toEqual([]);
	});
});

describe("legs-walkable", () => {
	it("reports an unreachable beat once, and says nothing about the total walk", () => {
		// The spawn sits at the first settlement, so the first leg is a few tiles at most and
		// the partial total lands well under `SHORT_STORY`. That is exactly what makes the
		// double-report reachable: pointing the second beat at a site id the world does not
		// have makes `storyWalk` return early with `unreachable` set and a partial `tiles`
		// sum (`validate.ts:200-202`) — a story stopped this early must be reported as
		// unreachable and *only* as unreachable, not also as too short.
		const base = demoJourneyArtifact();
		const beats = (base.arc?.beats ?? []).map((beat, i) =>
			i === 1 ? { ...beat, siteId: 999999999 } : beat,
		);
		const artifact = { ...base, arc: { ...base.arc, beats } } as ScenarioArtifact;

		const violations = checkLegsWalkable(artifact);

		expect(violations).toHaveLength(1);
		expect(violations[0]?.where).toBe(`beat ${beats[1]?.id}`);
		expect(violations.some((v) => v.detail.includes("total"))).toBe(false);
	});

	it("is silent on a story that walks and arrives", () => {
		expect(checkLegsWalkable(demoJourneyArtifact())).toEqual([]);
	});
});

describe("checkInvariants", () => {
	it("returns a count for every invariant, including the ones with no violations", () => {
		clearFeatureCache();
		const report = checkInvariants(demoJourneyArtifact());

		expect(Object.keys(report.counts).sort()).toEqual([
			"buildings-reachable",
			"legs-walkable",
			"scenes-written",
			"structures-built",
		]);
		// Every count is the number of violations carrying that id, so the two agree.
		for (const [id, count] of Object.entries(report.counts)) {
			expect(report.violations.filter((v) => v.invariant === id).length).toBe(count);
		}
	});
});
