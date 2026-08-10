import { featureKindFor, invalidateFeature } from "../core/gen/features/registry.js";
import { generateSettlement } from "../core/gen/features/settlement.js";
import { artifactWorld, type ScenarioArtifact } from "./artifact.js";
import { siteIndex } from "./validate.js";

/**
 * Mechanical properties a playable world has, measured one at a time.
 *
 * Deliberately *not* a second validator. `validateArtifact` already answers seventeen
 * questions and its answers are trusted; re-asking any of them here would produce a
 * second opinion that can disagree with the first, which is the failure mode
 * `validate.ts:80-86` describes — "a validator that disagrees with the thing it
 * validates is worse than no validator, because it is believed".
 *
 * `checkPlaces` (`validate.ts:1249`) is the closest relative and the one this is easiest
 * to mistake for: it already warns `"asked for N structures, M fitted"` when some
 * structure is named. What it measures is an aggregate count, so a substitution that
 * swaps a house for a filler shack without changing the total slips past it unnoticed,
 * and the gate on a named structure means an unnamed roster gets no check at all. What
 * follows measures per kind, so that substitution is caught, and unconditionally, so an
 * unnamed roster is measured the same as a named one.
 *
 * Every check below measures something no existing check measures. Their purpose is
 * attribution: a scenario that is hard to play should be explainable as a named
 * violated invariant rather than as a feeling, both before a change and after it.
 */

export type InvariantId =
	| "structures-built"
	| "buildings-reachable"
	| "scenes-written"
	| "legs-walkable";

export interface Violation {
	readonly invariant: InvariantId;
	/** Where it went wrong, in terms a person can look up: a site name, a beat id. */
	readonly where: string;
	readonly detail: string;
}

export interface InvariantReport {
	readonly violations: readonly Violation[];
	readonly counts: Readonly<Record<InvariantId, number>>;
}

/**
 * Every structure a site's spec asked for appears in the settlement that was built.
 *
 * Counted as a multiset over kinds rather than matched one-to-one by name, because a
 * spec may legitimately ask for three houses and the builder does not label them. What
 * is being measured is the substitution: `settlement.ts:249-254` gives a plot to filler
 * when the requested structure will not fit it, so the story's counting house becomes a
 * house and nothing anywhere says so.
 *
 * Only sites the settlement builder claims. A castle and a dock lay out their own
 * buildings from their own rules, so measuring their spec against their patch would
 * report a fault that is not one.
 */
export function checkStructuresBuilt(artifact: ScenarioArtifact): Violation[] {
	const world = artifactWorld(artifact);
	const sites = siteIndex(artifact);
	const violations: Violation[] = [];

	// Sorted, so a report is stable between runs and diffable between changes.
	const ids = Object.keys(artifact.sites).sort();
	for (const id of ids) {
		const spec = artifact.sites[id];
		const site = sites.get(Number(id));
		if (!spec || !site) continue;
		if (featureKindFor(site.kind)?.id !== "settlement") continue;

		// `generateFeature`/`generateSettlement` memoise by `(world, kind, siteId)` alone —
		// the spec is not part of the cache key. That is right for a running game, where a
		// site is generated once and every caller wants the same patch, but wrong here: a
		// repair pass or a second authoring edit can leave a stale patch cached under this
		// site's id, and measuring the current spec against it would report a verdict about
		// a layout that is no longer the one on the artifact. Dropping the entry first makes
		// this check describe the spec it was actually handed, matching `checkPlaces`.
		invalidateFeature(world, site.id);
		const patch = generateSettlement(world, site, spec.settlement);
		const built = new Map<string, number>();
		for (const building of patch.buildings) {
			built.set(building.kind, (built.get(building.kind) ?? 0) + 1);
		}

		const wanted = new Map<string, number>();
		for (const structure of spec.settlement.structures) {
			wanted.set(structure.kind, (wanted.get(structure.kind) ?? 0) + 1);
		}

		for (const kind of [...wanted.keys()].sort()) {
			const asked = wanted.get(kind) ?? 0;
			const got = built.get(kind) ?? 0;
			if (got >= asked) continue;
			violations.push({
				invariant: "structures-built",
				where: `${spec.name} (site ${id})`,
				detail: `asked for ${asked} ${kind}, built ${got}`,
			});
		}
	}
	return violations;
}
