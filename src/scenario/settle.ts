import { invalidateFeature } from "../core/gen/features/registry.js";
import { generateSettlement, sitePlots } from "../core/gen/features/settlement.js";
import { mainLineBeats } from "../core/rules/arc.js";
import { growSite } from "../core/world/growth.js";
import type { PlaceRecipe } from "../core/world/recipe.js";
import { artifactWorld, type ScenarioArtifact } from "./artifact.js";
import { walkMainLine, withStory } from "./play.js";
import { applySpatialRepairs } from "./repair.js";
import { siteIndex } from "./validate.js";

/**
 * Make the main line work, beat by beat, in the engine it will be played in.
 *
 * The pass that turns "this world validates" into "this story has been played". Everything
 * before it reasons *about* the artifact; this walks the main line in a real session — real
 * chunks, real settlement patches, real NPC placement, the real reducer settling after every
 * command — and where a beat will not open it fixes what it can and tries again.
 *
 * Forward, and fixing in place, rather than checking the whole world and starting over. Each
 * round of the static repair loop generates the bounded world twice (`repair.ts`); a walk
 * visits only the sites the story actually uses, and after a fix that does not touch the map
 * every untouched site's patch is still cached. So this is both stronger than the offline
 * checks and cheaper than the loop it stands beside.
 *
 * **The main line only.** Optional beats are fitted afterwards, under stricter rules, because
 * a side errand must never be the reason a site is regrown. And there is deliberately no
 * "drop it and carry on" branch here: a main-line beat that cannot be settled stops the pass
 * and is reported. Deleting a step of the main story to make a fault go away is the thing the
 * whole track exists to prevent.
 *
 * **Concessions are not failures.** A walker cannot search a crate it has no reason to look
 * in, or work out which conversation hands over a ring — so where an objective can only be
 * satisfied by being given, it is given and recorded. Gating on that would be measuring the
 * walker rather than the world.
 */

export interface SettleReport {
	/** The artifact as it ended up, fixes and growth folded in. */
	readonly artifact: ScenarioArtifact;
	/** Main-line beats that opened, in the order they opened. */
	readonly opened: readonly string[];
	/** The beat the pass gave up on, if it gave up. */
	readonly stuck?: {
		readonly beat: string;
		readonly why: string;
		/** Every fix tried on it, in words, in the order they were tried. */
		readonly tried: readonly string[];
	};
	/** What was changed to get here, in words. */
	readonly fixes: readonly string[];
	/** Sites made bigger, id to new radius. */
	readonly grown: Readonly<Record<string, number>>;
	/** What had to be given rather than earned. Recorded, never gated on. */
	readonly concessions: readonly string[];
	/** True when every main-line beat opened. */
	readonly settled: boolean;
}

/** Fix attempts per beat, before the pass admits the beat is the problem. */
const MAX_FIXES_PER_BEAT = 3;

/**
 * How long the whole pass may take before it stops and says where it got to.
 *
 * A wall clock, which is the one place a clock is allowed near generation: it decides when to
 * stop *trying*, never what the world contains. A pass cut short reports the beat it was on,
 * and the artifact it hands back is the one it had already settled — a deterministic function
 * of the walk, whatever the clock did.
 */
const BUDGET_MS = 60_000;

export async function settleTheStory(
	artifact: ScenarioArtifact,
	onProgress: (message: string) => void = () => undefined,
): Promise<SettleReport> {
	const started = Date.now();
	const arc = artifact.arc;
	if (!arc || arc.beats.length === 0) {
		return { artifact, opened: [], fixes: [], grown: {}, concessions: [], settled: true };
	}

	let current = artifact;
	const fixes: string[] = [];
	const grown: Record<string, number> = {};
	const concessions: string[] = [];
	// Growth is the only fix that restarts the walk, so it is the only one that needs a budget
	// of its own: a site is grown at most once and there is nothing else to grow.
	const growthBudget = mainLineBeats(arc).length;
	let growths = 0;
	const tried: string[] = [];
	let lastStuck: string | undefined;
	let attempts = 0;

	for (;;) {
		// Fix what can be known without walking, first. All three re-derive their own
		// conditions, so on a world with nothing wrong they change nothing — and one of them
		// cannot be reached reactively at all, because the walker grants items rather than
		// finding them and so never trips over one hidden in a building that was never built.
		const before = current;
		current = applySpatialFixes(current, fixes);
		if (current !== before) {
			onProgress(`fixed ${fixes.length} placement fault(s) before walking`);
		}

		// The walk itself is in `play.ts`, because the pass beside this one needs the same one.
		// What is here is the policy: which fault is worth which fix, and what a fix costs.
		const attempt = await withStory(current, (playing) =>
			walkMainLine(current, playing, started + BUDGET_MS),
		);
		concessions.push(...attempt.concessions);
		if (!attempt.stuck) {
			return {
				artifact: current,
				opened: attempt.opened,
				fixes,
				grown,
				concessions,
				settled: true,
			};
		}

		// The ground itself: a required structure that no plot could take. This is the placement
		// solver's `unplaced`, which is why the solver had to start reporting it first — before
		// that, the only evidence that the story's counting house had become a shack was the
		// shack.
		const room = growths < growthBudget ? makeRoomAt(current, attempt.stuck.siteId) : undefined;
		if (room) {
			growths++;
			grown[String(attempt.stuck.siteId)] = room.radius;
			current = room.artifact;
			fixes.push(room.said);
			tried.push(room.said);
			onProgress(room.said);
			// From the first beat, not from this one. Replaying to beat N-1 costs exactly what
			// walking to it cost, so resuming saves nothing — and a fresh session is provably
			// right where splicing a regrown site under a live one works until it does not.
			continue;
		}

		// Nothing about the map can be changed for this beat. One more pass of the artifact-only
		// fixes is worth trying, because a growth earlier in the run may have moved a building
		// somebody was standing in — but only while they are still changing something.
		attempts = attempt.stuck.beat === lastStuck ? attempts + 1 : 1;
		lastStuck = attempt.stuck.beat;
		if (attempts < MAX_FIXES_PER_BEAT) {
			const retried = applySpatialFixes(current, fixes);
			// A fix that changed nothing will change nothing next time either, so this is where
			// the pass stops rather than spending the whole attempt budget learning that once.
			if (retried !== current) {
				current = retried;
				tried.push(`re-applied the placement fixes at ${attempt.stuck.beat}`);
				continue;
			}
		}

		return {
			artifact: current,
			opened: attempt.opened,
			stuck: { beat: attempt.stuck.beat, why: attempt.stuck.why, tried: [...tried] },
			fixes,
			grown,
			concessions,
			settled: false,
		};
	}
}

/**
 * Put everybody and everything somewhere that exists, and say what moved.
 *
 * The list of which repairs those are lives in `repair.ts`, because they are repairs and
 * because the alternative is this file and that one each keeping an opinion about it.
 */
function applySpatialFixes(artifact: ScenarioArtifact, fixes: string[]): ScenarioArtifact {
	const result = applySpatialRepairs(artifact);
	fixes.push(...result.repairs);
	return result.artifact;
}

/**
 * Give a site the room the story needed it to have.
 *
 * Asked only of a beat that would not open, and only where the ground is the reason: the site's
 * patch reports structures the roster required and no plot could take. That report is
 * `FeaturePatch.unplaced`, computed by the placement solver for years and read by nothing until
 * it was carried out of the builder — this is what it was for.
 *
 * Growth is written into the recipe rather than held aside, because `artifactWorld` is
 * `worldSeed(seed, recipe)` and the recipe is what a reload will read. That also makes
 * invalidation free: the feature cache is keyed on a hash of the recipe as written, so a grown
 * world is a different namespace and cannot serve a patch from the ungrown one.
 */
function makeRoomAt(
	artifact: ScenarioArtifact,
	siteId: number,
): { artifact: ScenarioArtifact; radius: number; said: string } | undefined {
	const site = siteIndex(artifact).get(siteId);
	const spec = artifact.sites[String(siteId)];
	if (!site || !spec) return undefined;

	const world = artifactWorld(artifact);
	// The same invalidation `checkPlaces` does, and for the same reason: the cache is keyed by
	// site, so a re-authored roster would otherwise be measured against the layout of the roster
	// before it.
	invalidateFeature(world, site.id);
	const patch = generateSettlement(world, site, spec.settlement);
	invalidateFeature(world, site.id);
	if (patch.unplaced.length === 0) return undefined;

	const place = growSite({
		world,
		site,
		bounds: artifact.bounds,
		neighbours: [...siteIndex(artifact).values()],
		// Enough plots for what the roster asked for and could not have. One structure needs one
		// plot, so this is arithmetic rather than a guess — and it is the *story's* target rather
		// than the survey's, which is why it is not `rosterTarget`: the survey grows a site to
		// hold the roster it will be offered, and this grows one to hold the buildings the story
		// has already been written against.
		wanted: sitePlots(world, site).length + patch.unplaced.length,
	});
	if (place?.radius === undefined) return undefined;

	// Appended, never merged. `mergeRecipe` lets one recipe's `places` *replace* another's, which
	// is right for a pack override and here would delete every place the author wrote down.
	const places: PlaceRecipe[] = [...(artifact.recipe?.places ?? []), place];
	return {
		artifact: { ...artifact, recipe: { ...artifact.recipe, places } },
		radius: place.radius,
		said: `${spec.name} had nowhere to build ${patch.unplaced.length} of the structures the story needs; made it ${place.radius} across`,
	};
}
