import type { GameState, Quest, QuestObjective } from "./state.js";
import { itemCount } from "./state.js";
import { namesMatch } from "./surroundings.js";

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
	/**
	 * The building the player is inside, by name, if any.
	 *
	 * Without this a `reach` objective could only ever match a settlement, because
	 * `placeNameAt` resolves sites and nothing else — so "go to the mill" was
	 * unsatisfiable by construction even with the mill standing right there.
	 */
	readonly insideName?: string | undefined;
	/**
	 * What kind of building that is — "mill", "smithy".
	 *
	 * A building only carries a name when the director gave it one, but its kind is
	 * always known, and "go to the mill" is a request about the kind.
	 */
	readonly insideKind?: string | undefined;
	/** Who the player is talking to right now, if anyone. */
	readonly talkedTo?: string | undefined;
}

export interface QuestProgress {
	readonly state: GameState;
	/** Quests that just finished, for the journal and the notification line. */
	readonly completed: readonly Quest[];
}

/**
 * Loose comparison, because targets come from prose.
 *
 * Shares its definition with the action boundary that resolved the target in the
 * first place. Two copies of this rule would be worse than one imperfect one: an
 * objective could resolve against a building at creation and then never match it
 * on arrival, which is indistinguishable from the quest being broken.
 */
function matches(target: string, candidate: string | undefined): boolean {
	return candidate === undefined ? false : namesMatch(target, candidate);
}

function satisfied(objective: QuestObjective, state: GameState, context: QuestContext): boolean {
	if (objective.done) return true;
	switch (objective.kind) {
		case "have":
			return itemCount(state, objective.target) >= (objective.quantity ?? 1);
		case "flag":
			return Boolean(state.flags[objective.target]);
		case "reach":
			// Either granularity counts. A target may name the town or a building in
			// it, and the player standing inside the mill is also standing in the town.
			return (
				matches(objective.target, context.placeName) ||
				matches(objective.target, context.insideName) ||
				matches(objective.target, context.insideKind)
			);
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
