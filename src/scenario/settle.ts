import { invalidateFeature } from "../core/gen/features/registry.js";
import { generateSettlement, sitePlots } from "../core/gen/features/settlement.js";
import { beatNpcId, mainLineBeats, type ScenarioBeat } from "../core/rules/arc.js";
import type { GameState } from "../core/rules/state.js";
import { growSite } from "../core/world/growth.js";
import type { MacroSite } from "../core/world/macro.js";
import type { PlaceRecipe } from "../core/world/recipe.js";
import { buildSession } from "../session.js";
import { artifactWorld, type ScenarioArtifact } from "./artifact.js";
import { canReach, reachableFrom } from "./passability.js";
import {
	groundFor,
	hideThingsWhereThereIsSomewhereToHideThem,
	spellObjectivesAsTheWorldDoes,
	standTheCastSomewhereReal,
} from "./repair.js";
import { buildPassability, siteIndex } from "./validate.js";
import { type StoryWalker, storyWalker } from "./walker.js";

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

		const attempt = await walkMainLine(current, started + BUDGET_MS);
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
 * The fixes that change what the artifact *says* about where things are.
 *
 * Three repairs, run together because they answer one question — "is this thing somewhere that
 * exists" — and because none of them touches the map, so the walk carries on from where it was
 * rather than starting again. Each re-derives its own condition, so on a world with nothing
 * wrong they change nothing and this is free.
 *
 * `Ground` is built once and handed to all three: `built` is memoised per site and hits the
 * feature cache the walk has already warmed, and `grid` is lazy, so the one that needs it pays
 * for it only if the first two did not already fix the fault.
 */
function applySpatialFixes(artifact: ScenarioArtifact, fixes: string[]): ScenarioArtifact {
	const ground = groundFor(artifact);
	let current = artifact;
	for (const fix of [
		standTheCastSomewhereReal,
		hideThingsWhereThereIsSomewhereToHideThem,
		spellObjectivesAsTheWorldDoes,
	]) {
		const result = fix(current, ground);
		if (result.artifact === current) continue;
		current = result.artifact;
		fixes.push(...result.repairs);
	}
	return current;
}

interface Attempt {
	readonly opened: readonly string[];
	readonly concessions: readonly string[];
	readonly stuck?: {
		readonly beat: string;
		readonly siteId: number;
		readonly why: string;
	};
}

async function walkMainLine(artifact: ScenarioArtifact, deadline: number): Promise<Attempt> {
	const arc = artifact.arc;
	if (!arc) return { opened: [], concessions: [] };

	const sites = siteIndex(artifact);
	const session = buildSession(
		{
			worldId: `settle-${artifact.id}`,
			seed: artifact.seed,
			flavour: "prebuilt",
			scenario: artifact,
		},
		{ saveDebounceMs: 0, persist: false },
	);
	const { engine } = session;
	// The opening card blocks movement until it is read, which is the point of it.
	engine.dispatch({ t: "DismissCard" });
	const walker = storyWalker(artifact, engine, sites);
	const state = () => engine.getState();

	const opened: string[] = [];
	try {
		for (const beat of mainLineBeats(arc)) {
			if (Date.now() > deadline) {
				return {
					opened,
					concessions: [...walker.concessions],
					stuck: {
						beat: beat.id,
						siteId: beat.siteId,
						why: "the settling budget ran out here",
					},
				};
			}

			// An arm of a fork the story has since taken the other way is not stuck — it is
			// barred, and permanently, which is what makes a choice a choice. Re-asked per beat
			// rather than computed once because opening one arm is what bars its siblings: the
			// static set contains every arm, and walking all of them is impossible by design.
			// Asked through `mainLineBeats` rather than by testing the branch flag here, so this
			// cannot drift from what the outline counts.
			if (!mainLineBeats(arc, state()).some((live) => live.id === beat.id)) continue;

			const site = sites.get(beat.siteId);
			// A beat at a site the bounded world does not contain is not something a fix can
			// reach: the arc names somewhere that is not in this world at all.
			if (!site) {
				return {
					opened,
					concessions: [...walker.concessions],
					stuck: {
						beat: beat.id,
						siteId: beat.siteId,
						why: `site ${beat.siteId} is not in this world`,
					},
				};
			}

			// A beat gated on carrying something opens the moment the player has it, and finding
			// it is not something a walker can do.
			walker.openWith(beat);

			walker.goTo(site);
			if (!state().flags[beat.setsFlag]) {
				await walker.talkTo(beatNpcId(beat), walker.roomOf(beat.siteId, beat.npcSlot));
			}
			if (state().flags[beat.setsFlag]) {
				opened.push(beat.id);
				// Close whatever errands are open before moving on, because the next beat commonly
				// waits on the last one's. Written without this first, and both shipped stories
				// stopped at their second scene: the beat had opened, its errand was still in the
				// log, and the beat gated on that errand could never come.
				await closeWhatIsOpen(walker, state);
				continue;
			}

			// It did not open. Whatever is wrong is wrong here, so stop and say so: the caller
			// decides whether a fix is available, because only it knows what it has already tried
			// and how much of its budget is left.
			return {
				opened,
				concessions: [...walker.concessions],
				stuck: {
					beat: beat.id,
					siteId: beat.siteId,
					why: whyStuck(artifact, walker, beat, site),
				},
			};
		}
		return { opened, concessions: [...walker.concessions] };
	} finally {
		// On every path, including the early returns above. A session left undisposed holds a
		// debounce timer, and this pass may build several.
		session.dispose();
	}
}

/**
 * Tick whatever the open errands ask for, so the next beat's gate can be met.
 *
 * Judged on whether an objective actually ticked rather than on whether the attempt ran, the
 * same way `walkTheStory` judges it: walking to a town an errand names is always *possible*, so
 * counting the attempt as progress would loop for as long as the budget allowed.
 */
async function closeWhatIsOpen(walker: StoryWalker, state: () => GameState): Promise<void> {
	for (let round = 0; round < MAX_CLOSE_ROUNDS; round++) {
		let moved = false;
		for (const quest of state().quests) {
			if (quest.completed) continue;
			for (const objective of quest.objectives) {
				if (objective.done) continue;
				const before = ticked(state());
				await walker.satisfy(objective, quest.name);
				if (ticked(state()) > before) moved = true;
			}
		}
		if (!moved) return;
	}
}

/**
 * How many times to go round closing errands before moving to the next beat.
 *
 * More than one because an errand can be a step of another — a `quest` objective ticks only
 * once its child is closed — and the child may be satisfied in the same pass that found the
 * parent. Two is enough for that; this is a guard against a cycle, not a budget.
 */
const MAX_CLOSE_ROUNDS = 3;

/** How much of the errand log is actually done, as one number to compare against. */
function ticked(state: GameState): number {
	return state.quests.reduce(
		(total, quest) => total + quest.objectives.filter((objective) => objective.done).length,
		0,
	);
}

/**
 * Why a beat would not open, cheapest question first.
 *
 * Each answer excludes the ones after it, so the order is the diagnosis.
 */
function whyStuck(
	artifact: ScenarioArtifact,
	walker: StoryWalker,
	beat: ScenarioBeat,
	site: MacroSite,
): string {
	if (walker.absent.has(beatNpcId(beat))) {
		return `${beatNpcId(beat)} opens it and the engine put them nowhere`;
	}
	// The only sweep of the whole world in the pass, and only on a beat that has already failed.
	const grid = buildPassability(artifact);
	if (!canReach(grid, reachableFrom(grid, artifact.spawn), site.site)) {
		return "there is no way to walk there from the start";
	}
	// Honest about whose limit this is. A walker cannot work out which conversation hands over a
	// ring, and reporting that as the world's fault would send somebody looking for one that is
	// not there.
	return `${beatNpcId(beat)} was standing there and the beat did not open`;
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
