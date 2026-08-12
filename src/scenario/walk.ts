import { arcOutline, beatNpcId, orderedBeats, type ScenarioBeat } from "../core/rules/arc.js";
import { asCondition, itemsRead } from "../core/rules/condition.js";
import type { DomainEffect } from "../core/rules/effects.js";
import type { GameState, QuestObjective } from "../core/rules/state.js";
import { namesMatch } from "../core/rules/surroundings.js";
import { buildSession } from "../session.js";
import type { ScenarioArtifact } from "./artifact.js";
import { siteIndex } from "./validate.js";
import { storyWalker } from "./walker.js";

/**
 * Play the story to the end, in the real engine, and report what it took.
 *
 * The offline checks all reason *about* the artifact. This one runs it: a real session,
 * real chunks, real settlement patches, real NPC placement, the real reducer settling
 * after every command. That catches the one class nothing else can — a beat whose anchor
 * the engine never actually puts anywhere, so the person the story hangs on is not
 * standing in the town that was written for them.
 *
 * Deliberately not on the generation path. Building a session and walking a story is
 * seconds of work per scenario, and the offline pass already catches everything that can
 * be caught statically. This is the thing to run before shipping a scenario by hand.
 *
 * ## Concessions
 *
 * A walker is not a player. It cannot search a crate it has no reason to look in, or
 * work out which conversation hands over the ring. Where an objective cannot be satisfied
 * by going somewhere or speaking to somebody, it is granted outright — and *recorded*,
 * because a story that only finishes with four things handed to the player is a different
 * result from one that finishes on its own, and reporting "finished" for both would make
 * this worth nothing.
 */

export interface WalkReport {
	/** Beats that opened by being played, in the order they opened. */
	readonly opened: readonly string[];
	/** Beats that never opened. Empty is the result worth having. */
	readonly stuck: readonly string[];
	/** What had to be given rather than earned, in words. */
	readonly concessions: readonly string[];
	/** Whether `arcOutline` says the story is told. */
	readonly finished: boolean;
	/** People the engine never placed, so the walk could not reach them. */
	readonly absent: readonly string[];
	/**
	 * Errands still open at the end, and which objective of each.
	 *
	 * Reported separately from `stuck` because they are a different failure with the same
	 * symptom. Every beat can open and the story still never end: `arcOutline` will not
	 * call it finished while an errand it handed out is unclosed, so one objective the
	 * world cannot tick leaves the player at the last scene with no ending and nothing on
	 * screen to say what is missing.
	 */
	readonly unfinished: readonly string[];
}

/**
 * How many times to go round.
 *
 * Each round opens whatever it can and satisfies whatever it can, and one round is
 * enough for a straight chain of beats — this is the guard against a story that loops,
 * not a budget the walk is expected to spend.
 */
const MAX_ROUNDS = 32;

export async function walkTheStory(
	artifact: ScenarioArtifact,
	worldId = `walk-${artifact.id}`,
): Promise<WalkReport> {
	const arc = artifact.arc;
	if (!arc || arc.beats.length === 0)
		return {
			opened: [],
			stuck: [],
			concessions: [],
			finished: true,
			absent: [],
			unfinished: [],
		};

	const session = buildSession(
		{ worldId, seed: artifact.seed, flavour: "prebuilt", scenario: artifact },
		{ saveDebounceMs: 0, persist: false },
	);
	const { engine } = session;
	// The opening card blocks movement until it is read, which is the point of it.
	engine.dispatch({ t: "DismissCard" });

	const sites = siteIndex(artifact);
	const opened: string[] = [];
	const concessions: string[] = [];
	const state = () => engine.getState();

	const apply = (...effects: DomainEffect[]) => engine.dispatch({ t: "ApplyEffects", effects });

	// How a player gets about, shared with `settleTheStory`. `satisfy` below is *not* in
	// there and should not be: it is this walk's policy on what to do about an errand it
	// cannot earn, not a primitive.
	const { goTo, talkTo, roomOf, absent } = storyWalker(artifact, engine, sites);

	for (let round = 0; round < MAX_ROUNDS; round++) {
		let moved = false;

		for (const beat of orderedBeats(arc)) {
			if (state().flags[beat.setsFlag]) continue;
			const site = sites.get(beat.siteId);
			if (!site) continue;

			// A beat gated on carrying something opens the moment the player has it, and
			// finding it is not something a walker can do. Granted before the visit so the
			// scene plays as it would for a player who had already found it.
			for (const item of itemsRead(asCondition(beat.opensOn))) {
				if (state().inventory.some((entry) => entry.name === item)) continue;
				apply({
					t: "GrantItem",
					name: item,
					description: "Given, to walk the story.",
					quantity: 1,
				});
				concessions.push(`gave "${item}" so beat ${beat.id} could open`);
			}

			goTo(site);
			if (state().flags[beat.setsFlag]) {
				// It opened on arrival: `opensOn` was about standing here, not about talking.
				opened.push(beat.id);
				moved = true;
				continue;
			}
			await talkTo(beatNpcId(beat), roomOf(beat.siteId, beat.npcSlot));
			if (!state().flags[beat.setsFlag]) continue;
			opened.push(beat.id);
			moved = true;
		}

		for (const quest of state().quests) {
			if (quest.completed) continue;
			for (const objective of quest.objectives) {
				if (objective.done) continue;
				// Judged on whether the objective actually ticked, not on whether the attempt
				// ran. Walking to a town the errand names is always *possible*, so a walker
				// that counted the attempt as progress would keep going back there for as many
				// rounds as it has, and a story with one hole in it would cost the same as
				// thirty-two playthroughs to find out.
				const before = ticked(state());
				await satisfy(objective, quest.name);
				if (ticked(state()) > before) moved = true;
			}
		}

		if (!moved) break;
	}

	const stuck = orderedBeats(arc)
		.filter((beat) => !state().flags[beat.setsFlag])
		.filter((beat) => !barred(state(), beat))
		.map((beat) => beat.id);

	const unfinished = state()
		.quests.filter((quest) => !quest.completed)
		.map((quest) => {
			const open = quest.objectives
				.filter((objective) => !objective.done)
				.map((objective) => `${objective.kind} "${objective.target}"`);
			return `"${quest.name}" is open on ${open.join(" and ") || "nothing it can name"}`;
		});

	const finished = arcOutline(arc, state())?.finished === true;
	session.dispose();
	return { opened, stuck, concessions, finished, absent: [...absent], unfinished };

	/** Do the thing an objective asks for, or hand it over and say so. */
	async function satisfy(objective: QuestObjective, questName: string): Promise<boolean> {
		if (objective.kind === "quest") return false;
		if (objective.kind === "reach") {
			const target = [...sites.values()].find((site) =>
				namesMatch(artifact.sites[String(site.id)]?.name ?? "", objective.target),
			);
			if (!target) return false;
			goTo(target);
			return true;
		}
		if (objective.kind === "talk") {
			const found = Object.values(artifact.sites).flatMap((spec) =>
				spec.npcs
					.filter((npc) => namesMatch(npc.name, objective.target))
					.map((npc) => ({ spec, npc })),
			);
			const person = found[0];
			if (!person) return false;
			const site = sites.get(person.spec.siteId);
			if (site) goTo(site);
			return talkTo(
				`npc:${person.spec.siteId >>> 0}:${person.npc.slot}`,
				roomOf(person.spec.siteId, person.npc.slot),
			);
		}
		if (objective.kind === "have") {
			if (state().inventory.some((entry) => entry.name === objective.target)) return false;
			apply({
				t: "GrantItem",
				name: objective.target,
				description: "Given, to walk the story.",
				quantity: objective.quantity ?? 1,
			});
			concessions.push(`gave "${objective.target}" to close "${questName}"`);
			return true;
		}
		if (state().flags[objective.target]) return false;
		apply({ t: "SetFlag", key: objective.target, value: true });
		concessions.push(`set "${objective.target}" to close "${questName}"`);
		return true;
	}
}

/**
 * Whether this beat is an arm of a fork that went the other way.
 *
 * Excluded from `stuck`, because it is not stuck: the player chose, and choosing is what
 * bars it. Counting it would report every fork as an unfinishable story.
 */
/** How much of the errand log is actually done, as one number to compare against. */
function ticked(state: GameState): number {
	return state.quests.reduce(
		(total, quest) => total + quest.objectives.filter((objective) => objective.done).length,
		0,
	);
}

function barred(state: GameState, beat: ScenarioBeat): boolean {
	if (beat.branch === undefined) return false;
	const taken = state.flags[`arc:branch:${beat.branch}`];
	return typeof taken === "string" && taken !== beat.id;
}
