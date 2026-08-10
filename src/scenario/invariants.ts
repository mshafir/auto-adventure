import { featureKindFor, invalidateFeature } from "../core/gen/features/registry.js";
import { generateSettlement } from "../core/gen/features/settlement.js";
import { reachableFrom } from "../core/gen/features/terraform.js";
import { beatNpcId, orderedBeats } from "../core/rules/arc.js";
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

/**
 * Every building in a settlement can be walked into from its own town square.
 *
 * `carveConnections` routes to every anchor and `pruneUnreachable` demolishes the
 * buildings it could not reach (`settlement.ts:339-375`), so in principle nothing
 * unreachable survives. This measures whether that holds in practice, because the
 * demolition is bounded at four rounds and gives up quietly afterwards — and because
 * demolition is itself a fault when the building was one the story needed.
 *
 * `reachableFrom` returns `undefined` when the square itself is not walkable, which is
 * a different fault and is reported as its own violation rather than as "every building
 * is unreachable".
 */
export function checkBuildingsReachable(artifact: ScenarioArtifact): Violation[] {
	const world = artifactWorld(artifact);
	const sites = siteIndex(artifact);
	const violations: Violation[] = [];

	for (const id of Object.keys(artifact.sites).sort()) {
		const spec = artifact.sites[id];
		const site = sites.get(Number(id));
		if (!spec || !site) continue;
		if (featureKindFor(site.kind)?.id !== "settlement") continue;

		// See `checkStructuresBuilt` above: the settlement patch is cached by `(world,
		// kind, siteId)` alone, not by the spec, so a stale patch from an earlier spec for
		// this same site can otherwise be handed back here instead of the one the current
		// artifact actually describes.
		invalidateFeature(world, site.id);
		const patch = generateSettlement(world, site, spec.settlement);
		const square = patch.anchors.find((anchor) => anchor.kind === "square");
		if (!square) {
			violations.push({
				invariant: "buildings-reachable",
				where: `${spec.name} (site ${id})`,
				detail: "the settlement has no square to measure from",
			});
			continue;
		}

		const reached = reachableFrom(patch, { x: square.x, y: square.y }, patch.anchors);
		if (!reached) {
			violations.push({
				invariant: "buildings-reachable",
				where: `${spec.name} (site ${id})`,
				detail: "the square itself is not walkable",
			});
			continue;
		}

		for (const anchor of patch.anchors) {
			if (anchor.kind !== "doorstep" || anchor.building === undefined) continue;
			if (reached.has(anchor)) continue;
			const building = patch.buildings.find((entry) => entry.index === anchor.building);
			violations.push({
				invariant: "buildings-reachable",
				where: `${spec.name} (site ${id})`,
				detail: `${building?.name ?? building?.kind ?? `building ${anchor.building}`} cannot be reached from the square`,
			});
		}
	}
	return violations;
}

/**
 * Every main-line beat has words to say and something to write down.
 *
 * A beat with no tree still opens, still sets its flag and still lands an errand in the
 * journal — so nothing reports it and the story simply has a hole where a scene should
 * be. That is one of the two things a player experiences as "the events do not connect";
 * the other is a beat with no journal, which leaves nothing behind to connect *to*.
 *
 * Side errands are exempt. A player goes looking for one by choice, and warning about
 * every optional beat in every world is how an author learns to stop reading a report.
 */
export function checkScenesWritten(artifact: ScenarioArtifact): Violation[] {
	const arc = artifact.arc;
	if (!arc) return [];

	const violations: Violation[] = [];
	for (const beat of orderedBeats(arc)) {
		if (beat.optional) continue;
		const tree = artifact.trees?.[beatNpcId(beat)];
		const spoken = Object.keys(tree?.nodes ?? {}).length;
		if (spoken === 0) {
			violations.push({
				invariant: "scenes-written",
				where: `beat ${beat.id}`,
				detail: "no conversation was written for the person this beat hangs on",
			});
		}
		const written = beat.journal ?? beat.quest?.description ?? "";
		if (written.trim() === "") {
			violations.push({
				invariant: "scenes-written",
				where: `beat ${beat.id}`,
				detail: "nothing is written down, so the next beat has nothing to follow from",
			});
		}
	}
	return violations;
}
