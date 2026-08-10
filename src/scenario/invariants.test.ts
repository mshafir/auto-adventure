import { describe, expect, it } from "vitest";
import {
	demoArtifact,
	demoSiteSpec,
	FIXTURE_SEED,
	findSettlement,
} from "../../test/fixtures/scenario.js";
import { clearFeatureCache } from "../core/gen/features/registry.js";
import type { SettlementSpec } from "../core/gen/features/settlement.js";
import type { ScenarioArtifact } from "./artifact.js";
import { checkStructuresBuilt } from "./invariants.js";

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
