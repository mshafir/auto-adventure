import { beatNpcId, mainLineBeats, type ScenarioBeat } from "../core/rules/arc.js";
import type { GameState } from "../core/rules/state.js";
import type { MacroSite } from "../core/world/macro.js";
import { buildSession } from "../session.js";
import type { ScenarioArtifact } from "./artifact.js";
import { canReach, reachableFrom } from "./passability.js";
import { buildPassability, siteIndex } from "./validate.js";
import { type StoryWalker, storyWalker } from "./walker.js";

/**
 * Playing a story in a session nobody will ever see.
 *
 * Two passes want the same thing: a real engine, a real world, a real reducer settling after
 * every command, and a walker that knows how a player does things. `settleTheStory` walks the
 * main line and fixes what it can; `fitSideQuests` walks it to bring the state up and then goes
 * looking for the side errands. Written twice, the second copy would relearn every bug the
 * walker's comments record — a card nobody read, a room with no way out, a teleport that left
 * the player believing they were still indoors.
 *
 * So the session, the walk and the diagnosis live here, and the *policy* lives with each caller.
 * That split is the useful one: this file reports what happened and never repairs anything, which
 * is what lets the pass above it decide what a fault is worth. A walk that quietly fixed things
 * would make its own report a tautology.
 */

export interface Playing {
	readonly walker: StoryWalker;
	/** The state as it is now. A function, because every command moves it. */
	readonly state: () => GameState;
	readonly sites: ReadonlyMap<number, MacroSite>;
}

/**
 * Build a session, play something in it, and leave nothing behind.
 *
 * The session is ephemeral in the one way that matters: `buildSession` constructs a
 * `SaveRepository` and `dispose()` *flushes* it, so a walk used to write a save that appeared in
 * the launcher's Continue list — tolerable for a CLI tool, a visible bug on the generation path.
 * `persist: false` is what makes it a question rather than a world.
 */
export async function withStory<T>(
	artifact: ScenarioArtifact,
	run: (playing: Playing) => Promise<T>,
): Promise<T> {
	const sites = siteIndex(artifact);
	const session = buildSession(
		{
			worldId: `play-${artifact.id}`,
			seed: artifact.seed,
			flavour: "prebuilt",
			scenario: artifact,
		},
		{ saveDebounceMs: 0, persist: false },
	);
	try {
		// The opening card blocks movement until it is read, which is the point of it.
		session.engine.dispatch({ t: "DismissCard" });
		const walker = storyWalker(artifact, session.engine, sites);
		return await run({ walker, state: () => session.engine.getState(), sites });
	} finally {
		// On every path, including a throw and the early returns inside the walk. A session left
		// undisposed holds a debounce timer, and a pass may build several.
		session.dispose();
	}
}

/** What happened when the main line was played, and where it stopped if it stopped. */
export interface Walkthrough {
	/** Main-line beats that opened, in the order they opened. */
	readonly opened: readonly string[];
	/** What had to be given rather than earned. Recorded, never gated on. */
	readonly concessions: readonly string[];
	/** The beat that would not open, if one would not. */
	readonly stuck?: {
		readonly beat: string;
		readonly siteId: number;
		readonly why: string;
	};
}

/**
 * Play the main line, beat by beat, and stop at the first one that will not open.
 *
 * Stops rather than carries on, and hands the fault back rather than acting on it: only the
 * caller knows what it has already tried and how much of its budget is left. There is
 * deliberately no "drop it and carry on" branch — deleting a step of the main story to make a
 * fault go away is the thing this whole track exists to prevent.
 */
export async function walkMainLine(
	artifact: ScenarioArtifact,
	playing: Playing,
	deadline: number,
): Promise<Walkthrough> {
	const arc = artifact.arc;
	if (!arc) return { opened: [], concessions: [] };
	const { walker, state, sites } = playing;

	const opened: string[] = [];
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

		// An arm of a fork the story has since taken the other way is not stuck — it is barred,
		// and permanently, which is what makes a choice a choice. Re-asked per beat rather than
		// computed once because opening one arm is what bars its siblings: the static set
		// contains every arm, and walking all of them is impossible by design. Asked through
		// `mainLineBeats` rather than by testing the branch flag here, so this cannot drift from
		// what the outline counts.
		if (!mainLineBeats(arc, state()).some((live) => live.id === beat.id)) continue;

		const site = sites.get(beat.siteId);
		// A beat at a site the bounded world does not contain is not something a fix can reach:
		// the arc names somewhere that is not in this world at all.
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

		if (await openBeat(playing, beat, site)) {
			opened.push(beat.id);
			// Close whatever errands are open before moving on, because the next beat commonly
			// waits on the last one's. Written without this first, and both shipped stories
			// stopped at their second scene: the beat had opened, its errand was still in the
			// log, and the beat gated on that errand could never come.
			await closeWhatIsOpen(playing);
			continue;
		}

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
}

/**
 * Go and open one beat, the way a player would, and say whether it opened.
 *
 * Both callers do exactly this and only differ in what they make of the answer, so it is one
 * function: arriving at a site and finding nobody to speak to is the same event whether the beat
 * is the point of the story or a favour for a carter.
 */
export async function openBeat(
	playing: Playing,
	beat: ScenarioBeat,
	site: MacroSite,
): Promise<boolean> {
	const { walker, state } = playing;
	// A beat gated on carrying something opens the moment the player has it, and finding it is
	// not something a walker can do.
	walker.openWith(beat);
	walker.goTo(site);
	if (!state().flags[beat.setsFlag]) {
		await walker.talkTo(beatNpcId(beat), walker.roomOf(beat.siteId, beat.npcSlot));
	}
	return Boolean(state().flags[beat.setsFlag]);
}

/**
 * Tick whatever the open errands ask for, so the next beat's gate can be met.
 *
 * Judged on whether an objective actually ticked rather than on whether the attempt ran, the
 * same way `walkTheStory` judges it: walking to a town an errand names is always *possible*, so
 * counting the attempt as progress would loop for as long as the budget allowed.
 */
export async function closeWhatIsOpen(playing: Playing): Promise<void> {
	const { walker, state } = playing;
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
