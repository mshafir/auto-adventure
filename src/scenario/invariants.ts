import { featureKindFor, invalidateFeature } from "../core/gen/features/registry.js";
import { generateSettlement } from "../core/gen/features/settlement.js";
import { reachableFrom } from "../core/gen/features/terraform.js";
import { orderedBeats } from "../core/rules/arc.js";
import { artifactWorld, type ScenarioArtifact } from "./artifact.js";
import {
	beatsWithoutTrees,
	buildPassability,
	LONG_MARCH,
	SHORT_STORY,
	siteIndex,
	storyWalk,
} from "./validate.js";

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
 * The rule is not "every check below measures something nothing else measures" — that
 * was true once and stopped being true the moment two of these checks turned out to be
 * asking a question `validate.ts` already had an answer for. The actual rule: measure
 * what nothing else measures (`structures-built`, `buildings-reachable`, and the
 * journal half of `scenes-written`); share a question something else already asks
 * rather than re-asking it independently (the tree half of `scenes-written`, via
 * `beatsWithoutTrees`); or roll up a computation something else already does
 * (`legs-walkable`, over `storyWalk`). What is never allowed is asking the identical
 * question twice by two separate routes, because the two routes can drift and produce
 * two answers, and a check that disagrees with the thing it validates is worse than no
 * check, because it is believed. Their purpose is attribution: a scenario that is hard
 * to play should be explainable as a named violated invariant rather than as a feeling,
 * both before a change and after it.
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

	// The "no tree" question is `checkTrees`' question too, and asked once, through
	// `beatsWithoutTrees`, so the two cannot answer it differently. The scope narrows
	// here on purpose: `checkTrees` warns about every beat missing a tree, side errands
	// included, because an author reading that report wants to know about all of them;
	// this counts only the main line, because a player goes looking for a side errand by
	// choice, and a beat nobody is required to reach is not the hole in the story that a
	// main-line one is.
	const withoutTree = new Set(
		beatsWithoutTrees(artifact)
			.filter(({ beat }) => !beat.optional)
			.map(({ beat }) => beat.id),
	);

	const violations: Violation[] = [];
	for (const beat of orderedBeats(arc)) {
		if (beat.optional) continue;
		if (withoutTree.has(beat.id)) {
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

/**
 * Every leg the story asks the player to walk, against the pacing the validator already
 * judges by.
 *
 * A rollup over `storyWalk` rather than a second path search, deliberately, and the
 * thresholds are `LONG_MARCH` and `SHORT_STORY` *imported* from `validate.ts` rather than
 * copied, so the two cannot silently drift apart on what counts as too long or too short.
 *
 * Where this deliberately goes further than the validator: `validate.ts` (`:1428-1432`)
 * judges only the single *longest* leg against `LONG_MARCH`, so a story with two legs of
 * 300 tiles each passes there. This checks every leg, which is stricter — so the two can
 * still disagree about whether a *specific* world is paced badly, just never about where
 * the line is. `SHORT_STORY` is judged the same way in both places, against the total.
 */
export function checkLegsWalkable(artifact: ScenarioArtifact): Violation[] {
	if (!artifact.arc) return [];
	const grid = buildPassability(artifact);
	const walk = storyWalk(artifact, grid, siteIndex(artifact));
	const violations: Violation[] = [];

	// An unreachable beat is reported and nothing else is. `storyWalk` returns *early* when
	// a leg cannot be walked (`validate.ts:200-210`), so `legs` and `tiles` are a partial
	// sum of the journey up to that point — and judging pacing against a partial sum turns
	// one fault into two. A story stopped at its second beat thirty tiles out would be
	// reported as unreachable *and* as under `SHORT_STORY`, which inflates exactly the count
	// this module exists to make comparable. `checkStory` avoids it the same way, by putting
	// its pacing checks in the `else` branch (`validate.ts:1419-1444`).
	if (walk.unreachable) {
		return [
			{
				invariant: "legs-walkable",
				where: `beat ${walk.unreachable}`,
				detail: "there is no walkable route to this beat, so the story cannot be finished",
			},
		];
	}

	for (const leg of walk.legs) {
		if (leg.tiles <= LONG_MARCH) continue;
		violations.push({
			invariant: "legs-walkable",
			where: leg.to,
			detail: `${leg.tiles} tiles in one leg, over the ${LONG_MARCH} a session tolerates`,
		});
	}

	if (walk.legs.length > 0 && walk.tiles < SHORT_STORY) {
		violations.push({
			invariant: "legs-walkable",
			where: "the whole story",
			detail: `${walk.tiles} tiles in total, under the ${SHORT_STORY} that makes a journey`,
		});
	}
	return violations;
}

/**
 * Every invariant, with a count per id.
 *
 * The counts include the zeroes. A report that omits what passed cannot be compared
 * against a later one, and comparing before with after is the only reason this module
 * exists.
 */
export function checkInvariants(artifact: ScenarioArtifact): InvariantReport {
	// Settlements first, then the passability grid. `checkStructuresBuilt` and
	// `checkBuildingsReachable` generate settlement patches, and the grid stamps those
	// same patches — so building the grid first would measure a layout that is about to
	// be regenerated. The same ordering `validateArtifact:230-233` takes, for the same
	// reason.
	const violations = [
		...checkStructuresBuilt(artifact),
		...checkBuildingsReachable(artifact),
		...checkScenesWritten(artifact),
		...checkLegsWalkable(artifact),
	];

	const counts: Record<InvariantId, number> = {
		"structures-built": 0,
		"buildings-reachable": 0,
		"scenes-written": 0,
		"legs-walkable": 0,
	};
	for (const violation of violations) counts[violation.invariant]++;

	return { violations, counts };
}
