import { npcId as makeNpcId } from "../world/spec.js";
import type { CardSection } from "./card.js";
import { asCondition, type Condition, evaluate } from "./condition.js";
import type { DomainEffect } from "./effects.js";
import { endingCard } from "./ending.js";
import type { GameState, QuestObjective } from "./state.js";

/**
 * A story, as a sequence of things that become true.
 *
 * There is no new rules engine here, and deliberately so. `verifyQuests` already
 * checks objectives against the real game state after every command, and
 * `mapActions` already lowers declarative requests into `DomainEffect`s. A beat is
 * a thin wrapper over both: it gates on flags, it opens a quest, and the quest
 * finishes when the player has actually done the thing.
 *
 * That matters because of the failure `quests.ts` was written to eliminate. A
 * quest that completes only when an NPC remembers to say so will sometimes never
 * complete — the player fetches the lamp, hands it over, and watches the entry sit
 * open because the conversation went somewhere else. Beats inherit the fix rather
 * than reintroducing the problem.
 */

export interface ScenarioBeat {
	readonly id: string;
	/** Position in the story. Ties are broken by id, so ordering is total. */
	readonly order: number;
	/** The site this beat happens at. */
	readonly siteId: number;
	/** Which person in that site opens it. */
	readonly npcSlot: number;
	/**
	 * Open without anybody having to say anything, once this is true.
	 *
	 * A conversation is the right way for most beats to arrive — somebody tells you
	 * something — but not all of them: walking into the burnt mill, or finding the
	 * ledger, is the story moving on its own. The NPC anchor stays required even here,
	 * because it is what the validator checks a beat against and what a later
	 * conversation about the beat hangs off.
	 *
	 * Evaluated in the reducer's trigger pass, so it lands in the same command that
	 * made it true rather than on the player's next step.
	 */
	readonly opensOn?: Condition;
	/**
	 * What must already be true. An empty list means "from the start".
	 *
	 * A list of flag names is the shorthand for "all of these are set" and is how
	 * every arc has been written so far. A {@link Condition} lets a beat wait on
	 * something the story never wrote a flag for — an item in hand, a quest closed,
	 * a person warmed up.
	 */
	readonly requires: readonly string[] | Condition;
	/** Set when the beat opens. Later beats gate on it, and it marks it done. */
	readonly setsFlag: string;
	/**
	 * A fork this beat is one arm of.
	 *
	 * Beats sharing a group are mutually exclusive: opening one records the choice and
	 * bars its siblings for good. That is what makes a decision a decision — without
	 * it a player could walk the story twice and take both paths, which is worse than
	 * having no fork at all, because it reads as the choice not having mattered.
	 *
	 * The bar is deliberately permanent and deliberately not a warning. A fork the
	 * player can back out of is a menu.
	 */
	readonly branch?: string;
	/**
	 * A side errand rather than a step of the main story.
	 *
	 * Excluded from `remaining` and from whether the arc is `finished`, so a story can
	 * end with side quests still open — which is the whole point of one being optional.
	 * It still opens, journals and hands out its errand exactly like any other beat.
	 */
	readonly optional?: boolean;
	readonly quest?: {
		readonly id: string;
		readonly name: string;
		readonly description: string;
		readonly objectives: readonly QuestObjective[];
		/**
		 * The errand this one is a step of.
		 *
		 * Display only — the gating is a `quest` objective on the parent, which is real
		 * state — but it is what lets the quest pane show one job with three parts rather
		 * than three unrelated jobs, which is the difference between a branching story and
		 * an unsorted to-do list.
		 */
		readonly parentId?: string;
	};
	/** Written to the journal when the beat opens. */
	readonly journal?: string;
	/**
	 * A full screen shown as the beat opens.
	 *
	 * For the turns in a story that a line of dialogue cannot carry — a revelation,
	 * a passage of time, the moment the errand becomes something else. The id is
	 * derived from the beat, so a card cannot be shown twice however often the
	 * beat's effects are applied.
	 */
	readonly card?: {
		readonly title: string;
		readonly subtitle?: string;
		readonly sections: readonly CardSection[];
	};
	/**
	 * What else happens when the beat opens.
	 *
	 * A beat could set exactly one flag and hand out exactly one errand, so anything
	 * else it did to the world had to be written as a *trigger* watching for that flag
	 * — three objects to say "and he takes the girdle back", one of which exists only
	 * to notice the other. Reaching for a trigger is right when the cause is something
	 * the player does; it is a workaround when the cause is the beat itself.
	 *
	 * Applied through the same effect runner as everything else, so they are as
	 * re-appliable as the rest of a beat: the flag is still written last, and a beat
	 * that was interrupted midway is retried whole.
	 */
	readonly effects?: readonly DomainEffect[];
}

export interface ScenarioArc {
	readonly title: string;
	/** What the story is, in a sentence or two. Shown when a scenario starts. */
	readonly premise: string;
	readonly beats: readonly ScenarioBeat[];
	/**
	 * A last page, shown once every beat is reached and every errand closed.
	 *
	 * Optional because one is assembled from the arc when nobody writes one — a story
	 * with no ending at all is what left a player asking whether they had finished.
	 */
	readonly ending?: {
		readonly title: string;
		readonly subtitle?: string;
		readonly sections: readonly CardSection[];
	};
	/**
	 * Endings to choose between, by what the player actually did.
	 *
	 * First match wins, in author order, falling back to {@link ending} and then to the
	 * assembled one. This is what makes a fork worth taking: a branch the player chose
	 * changes how the story is *told back to them*, not merely which errands they ran.
	 *
	 * Ordered rather than scored, because an author writing "the grim one if the mill
	 * burned, otherwise the quiet one" is expressing precedence, and a scoring rule
	 * would need them to invent numbers to say it.
	 */
	readonly endings?: readonly ArcEnding[];
}

export interface ArcEnding {
	/** Stable id; becomes the card's id, so it is read exactly once. */
	readonly id: string;
	/** Absent means "always", which is how a final fallback is written. */
	readonly when?: Condition;
	readonly title: string;
	readonly subtitle?: string;
	readonly sections: readonly CardSection[];
}

/** The flag recording that the story has been told, so it is said exactly once. */
export const ARC_DONE_FLAG = "arc:complete";

/**
 * The journal source a beat's entry is filed under.
 *
 * Tagging is what makes a beat's journal line readable *back*: the quest pane shows
 * the story's clues, and without a tag it would have to match on prose, which breaks
 * the first time an author edits a line an old save already recorded.
 */
export function beatClueSource(beat: Pick<ScenarioBeat, "id">): string {
	return `arc:${beat.id}`;
}

/** A beat's card id, namespaced so it cannot collide with the opening. */
export function beatCardId(beat: Pick<ScenarioBeat, "id">): string {
	return `beat:${beat.id}`;
}

/** The npc who opens a beat. */
export function beatNpcId(beat: ScenarioBeat): string {
	return makeNpcId(beat.siteId, beat.npcSlot);
}

export function beatIsOpen(state: GameState, beat: ScenarioBeat): boolean {
	return Boolean(state.flags[beat.setsFlag]);
}

/**
 * The flag recording which arm of a fork was taken.
 *
 * A flag rather than a set of per-beat flags, because the question asked of it is
 * "which way did this go" and one value answers that — which is also what lets a
 * dialogue node or an ending condition read the decision with `{ flag, equals }`
 * instead of having to enumerate the arms not taken.
 *
 * Under `arc:` so `isEngineFlag` treats it as engine-written: nothing an author
 * writes sets it, so the unreachable-flag check must not report it.
 */
export function branchKey(group: string): string {
	return `arc:branch:${group}`;
}

/** Which arm of a fork was taken, if the fork has been reached. */
export function branchTaken(state: GameState, group: string): string | undefined {
	const value = state.flags[branchKey(group)];
	return typeof value === "string" ? value : undefined;
}

function requirementsMet(state: GameState, beat: ScenarioBeat): boolean {
	// A fork already decided bars every arm but the one taken. Checked before the
	// beat's own requirement, because the requirement is usually satisfiable on both
	// arms — that is what makes them alternatives — so it is this check and only this
	// check that stops the player walking the story twice and taking both paths.
	if (beat.branch !== undefined) {
		const taken = branchTaken(state, beat.branch);
		if (taken !== undefined && taken !== beat.id) return false;
	}
	return evaluate(asCondition(beat.requires), state);
}

/**
 * Beats in their intended order.
 *
 * Sorted by `order` then `id` rather than trusted as written: an artifact is data
 * from outside the program, and two beats sharing an order would otherwise open in
 * whatever sequence the JSON happened to list them.
 */
export function orderedBeats(arc: ScenarioArc): readonly ScenarioBeat[] {
	return [...arc.beats].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/**
 * What opens when the player speaks to someone.
 *
 * At most one beat per conversation, even when several are eligible: a single
 * "hello" that dumps three quests into the journal reads as a bug, and the story
 * loses its shape. The earliest eligible beat wins, so a player who reaches the
 * anchor of beat five first still has to walk back through the story in order.
 */
export function beatOpenedBy(
	arc: ScenarioArc | undefined,
	state: GameState,
	npcId: string,
): ScenarioBeat | undefined {
	if (!arc) return undefined;
	return orderedBeats(arc).find(
		(beat) => beatNpcId(beat) === npcId && !beatIsOpen(state, beat) && requirementsMet(state, beat),
	);
}

/**
 * Beats that have become true on their own, without anybody speaking.
 *
 * Checked after every command in the same settled position as triggers, and for the
 * same reason: the state a beat waits on can be reached by walking, by picking
 * something up or by another beat closing, and there is no command whose handler could
 * reasonably know about all three.
 *
 * All of them, not just the first — unlike `beatOpenedBy`, which deliberately opens at
 * most one per conversation so a single "hello" cannot dump three quests in the log.
 * There is no such risk here: an author writing two beats that both become true on the
 * same act meant both, and the ordering is `orderedBeats`', which is total.
 */
export function beatsOpenedByState(
	arc: ScenarioArc | undefined,
	state: GameState,
): readonly ScenarioBeat[] {
	if (!arc) return [];
	return orderedBeats(arc).filter(
		(beat) =>
			beat.opensOn !== undefined &&
			!beatIsOpen(state, beat) &&
			requirementsMet(state, beat) &&
			evaluate(beat.opensOn, state),
	);
}

/**
 * Lower a beat into effects.
 *
 * The flag is set last. Everything else is idempotent on its own, but the flag is
 * what marks the beat done, so a partially-applied beat that failed midway is
 * retried rather than skipped.
 */
export function beatEffects(beat: ScenarioBeat): DomainEffect[] {
	const effects: DomainEffect[] = [];
	if (beat.quest) {
		effects.push({
			t: "CreateQuest",
			id: beat.quest.id,
			name: beat.quest.name,
			description: beat.quest.description,
			objectives: beat.quest.objectives,
			siteId: beat.siteId,
			...(beat.quest.parentId ? { parentId: beat.quest.parentId } : {}),
		});
	}
	if (beat.journal) {
		effects.push({
			t: "RecordJournal",
			entry: { kind: "event", text: beat.journal, source: beatClueSource(beat) },
		});
	}
	// After the quest and the journal, so what the player reads is already true of
	// the game behind the card — the errand is in the log by the time they look.
	if (beat.card) {
		effects.push({ t: "ShowCard", card: { ...beat.card, id: beatCardId(beat) } });
	}
	// Whatever else the beat does to the world. After the card, so the player reads
	// the scene before the consequence lands in the log; before the flag, so a beat
	// interrupted midway is retried whole rather than counted as done.
	if (beat.effects) effects.push(...beat.effects);
	// Before the beat's own flag, so a fork half-applied after a partial save is
	// already closed to its siblings when the retry comes round — the reverse order
	// would leave a window in which both arms were open.
	if (beat.branch !== undefined) {
		effects.push({ t: "SetFlag", key: branchKey(beat.branch), value: beat.id });
	}
	effects.push({ t: "SetFlag", key: beat.setsFlag, value: true });
	return effects;
}

/** How far through the story the player is, for the journal panel. */
export function arcProgress(
	arc: ScenarioArc | undefined,
	state: GameState,
): { readonly opened: number; readonly total: number } {
	if (!arc) return { opened: 0, total: 0 };
	const beats = orderedBeats(arc);
	return { opened: beats.filter((beat) => beatIsOpen(state, beat)).length, total: beats.length };
}

/**
 * What a label for a beat is.
 *
 * The quest's name when it has one, because that is a sentence somebody wrote for
 * the player to read. Otherwise the id, unslugged — beats are named `the-short-tally`
 * by hand, so "The short tally" is a real title rather than a placeholder, and it
 * costs authors nothing.
 */
export function beatLabel(beat: ScenarioBeat): string {
	if (beat.quest?.name) return beat.quest.name;
	const words = beat.id.split("-").filter(Boolean).join(" ");
	return words.charAt(0).toUpperCase() + words.slice(1);
}

export interface ArcStep {
	readonly label: string;
	/**
	 * Whether this step of the story is actually finished.
	 *
	 * A beat *opening* only means the conversation happened. If it handed over an
	 * errand, the step is not done until the errand is — and ticking it early was
	 * visibly wrong: the outline showed "Ask Ott Pell" complete while that very errand
	 * sat open in the list underneath it.
	 */
	readonly complete: boolean;
	/** A side errand. Shown, but not counted toward the story being told. */
	readonly optional?: boolean;
}

export interface ArcOutline {
	readonly title: string;
	readonly premise: string;
	/**
	 * Whether there is nothing left to do.
	 *
	 * Every beat reached and every errand they handed out finished. Worth its own
	 * field rather than being left as arithmetic on the two below: a player asking
	 * "have I finished this?" was reading `3/3` and still not sure, which is the whole
	 * reason this exists.
	 */
	readonly finished: boolean;
	/** Beats already reached, oldest first, as the player would list them. */
	readonly steps: readonly ArcStep[];
	/** How many beats have not been reached, without saying what they are. */
	readonly remaining: number;
	/** What the story has told the player so far, oldest first. */
	readonly clues: readonly string[];
}

/**
 * The story so far, for a pane that is always on screen.
 *
 * Deliberately backwards-looking. It reports what has been accomplished and what has
 * been learned, and says only *how many* beats remain — never which. The next step is
 * already carried by the open errand below it, with a bearing on the map; naming the
 * beat after that would hand the player the plot in the first minute.
 *
 * Clues are read out of the journal by source rather than being stored twice, so a
 * clue and the journal entry that reports it cannot disagree.
 */
export function arcOutline(arc: ScenarioArc | undefined, state: GameState): ArcOutline | undefined {
	if (!arc) return undefined;
	const beats = orderedBeats(arc);
	const opened = beats.filter((beat) => beatIsOpen(state, beat));
	const sources = new Set(opened.map((beat) => beatClueSource(beat)));

	const finished = new Set(
		state.quests.filter((quest) => quest.completed).map((quest) => quest.id),
	);

	const steps = opened.map((beat) => ({
		label: beatLabel(beat),
		complete: !beat.quest || finished.has(beat.quest.id),
		...(beat.optional ? { optional: true as const } : {}),
	}));

	/**
	 * The beats the main story is actually made of, for this playthrough.
	 *
	 * Two exclusions, and both are the difference between "3/3, and am I done?" and an
	 * answer. Optional beats are side errands and were never part of the count. Arms of
	 * a fork the player did not take can never open — `requirementsMet` bars them
	 * permanently — so counting them would leave the story one step short of finished
	 * forever, which is the same silent dead-end this whole outline exists to prevent.
	 */
	const mainLine = beats.filter((beat) => !beat.optional && !isBarredBranch(state, beat));
	const mainOpened = mainLine.filter((beat) => beatIsOpen(state, beat));
	const mainSteps = steps.filter((_, index) => !opened[index]?.optional);

	return {
		title: arc.title,
		premise: arc.premise,
		finished: mainOpened.length === mainLine.length && mainSteps.every((step) => step.complete),
		steps,
		remaining: mainLine.length - mainOpened.length,
		clues: state.journal
			.filter((entry) => entry.source !== undefined && sources.has(entry.source))
			.map((entry) => entry.text),
	};
}

/** Whether this beat is an arm of a fork that went the other way. */
function isBarredBranch(state: GameState, beat: ScenarioBeat): boolean {
	if (beat.branch === undefined) return false;
	const taken = branchTaken(state, beat.branch);
	return taken !== undefined && taken !== beat.id;
}

/**
 * What happens the moment a story runs out of story.
 *
 * Returns nothing at all unless the arc has *just* finished, so this is safe to ask
 * after every command — which is what it has to be, because an arc can close on any
 * of three unrelated acts: the last beat opening, the last errand's objective
 * latching, or a quest being completed outright by a conversation.
 *
 * The flag is set here rather than left to the card's own dedupe, because the journal
 * entry needs the same guard and a scenario may have no card to dedupe against.
 */
export function arcEndEffects(
	arc: ScenarioArc | undefined,
	state: GameState,
	outline: ArcOutline | undefined,
): DomainEffect[] {
	if (!arc || !outline?.finished) return [];
	if (state.flags[ARC_DONE_FLAG]) return [];
	if (arc.beats.length === 0) return [];

	return [
		{
			t: "RecordJournal",
			entry: {
				kind: "event",
				// Says it in the words the player asked the question in. "3/3" was what
				// they had before, and it was not an answer.
				text: `${arc.title}: the story is told. Nothing is waiting on you now.`,
				source: ARC_DONE_FLAG,
			},
		},
		{ t: "ShowCard", card: endingCard(arc, outline, state) },
		{ t: "SetFlag", key: ARC_DONE_FLAG, value: true },
	];
}
