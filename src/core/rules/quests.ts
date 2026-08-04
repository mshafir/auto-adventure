import type { GameState, Quest, QuestObjective } from "./state.js";
import { itemCount } from "./state.js";

/**
 * Quest progress, decided by the engine.
 *
 * Previously a quest completed only if the model remembered to call
 * `completeQuest` — so a player could fetch the lamp, hand it over, and watch
 * the quest sit open forever because the NPC got chatty instead. Objectives are
 * now checked against the actual game state after every command. The model can
 * still declare a quest done, but it is no longer the only thing that can.
 */

export interface QuestContext {
	/** The settlement the player is standing in, if any. */
	readonly placeName?: string | undefined;
	/** Who the player is talking to right now, if anyone. */
	readonly talkedTo?: string | undefined;
}

export interface QuestProgress {
	readonly state: GameState;
	/** Quests that just finished, for the journal and the notification line. */
	readonly completed: readonly Quest[];
}

/** Loose comparison, because targets come from prose. */
function matches(target: string, candidate: string | undefined): boolean {
	if (!candidate) return false;
	const a = target.trim().toLowerCase();
	const b = candidate.trim().toLowerCase();
	if (!a || !b) return false;
	return a === b || b.includes(a) || a.includes(b);
}

function satisfied(objective: QuestObjective, state: GameState, context: QuestContext): boolean {
	if (objective.done) return true;
	switch (objective.kind) {
		case "have":
			return itemCount(state, objective.target) >= (objective.quantity ?? 1);
		case "flag":
			return Boolean(state.flags[objective.target]);
		case "reach":
			return matches(objective.target, context.placeName);
		case "talk":
			return matches(objective.target, context.talkedTo);
	}
}

/**
 * Tick off whatever the player has actually done.
 *
 * Objectives latch: once a `have` objective is satisfied it stays satisfied
 * even if the item is later handed over, which is the only sane reading of
 * "bring me the lamp" — the alternative un-completes the quest at the moment
 * the player fulfils it.
 */
export function verifyQuests(state: GameState, context: QuestContext): QuestProgress {
	let changed = false;
	const completed: Quest[] = [];

	const quests = state.quests.map((quest) => {
		if (quest.completed) return quest;

		let questChanged = false;
		const objectives = quest.objectives.map((objective) => {
			if (objective.done || !satisfied(objective, state, context)) return objective;
			questChanged = true;
			return { ...objective, done: true };
		});

		// A quest with no objectives is a note to self, not something the engine
		// can decide is finished; only the model may close one of those.
		const allDone = objectives.length > 0 && objectives.every((o) => o.done);
		if (!questChanged && !allDone) return quest;

		changed = true;
		const next: Quest = { ...quest, objectives, completed: allDone };
		if (allDone) completed.push(next);
		return next;
	});

	if (!changed) return { state, completed: [] };
	return { state: { ...state, quests }, completed };
}
