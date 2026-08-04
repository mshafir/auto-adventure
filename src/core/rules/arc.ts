import { npcId as makeNpcId } from "../world/spec.js";
import type { CardSection } from "./card.js";
import type { DomainEffect } from "./effects.js";
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
	/** Flags that must already be set. An empty list means "from the start". */
	readonly requires: readonly string[];
	/** Set when the beat opens. Later beats gate on it, and it marks it done. */
	readonly setsFlag: string;
	readonly quest?: {
		readonly id: string;
		readonly name: string;
		readonly description: string;
		readonly objectives: readonly QuestObjective[];
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
}

export interface ScenarioArc {
	readonly title: string;
	/** What the story is, in a sentence or two. Shown when a scenario starts. */
	readonly premise: string;
	readonly beats: readonly ScenarioBeat[];
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

function requirementsMet(state: GameState, beat: ScenarioBeat): boolean {
	return beat.requires.every((flag) => Boolean(state.flags[flag]));
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
		});
	}
	if (beat.journal) {
		effects.push({ t: "RecordJournal", entry: { kind: "event", text: beat.journal } });
	}
	// After the quest and the journal, so what the player reads is already true of
	// the game behind the card — the errand is in the log by the time they look.
	if (beat.card) {
		effects.push({ t: "ShowCard", card: { ...beat.card, id: beatCardId(beat) } });
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
