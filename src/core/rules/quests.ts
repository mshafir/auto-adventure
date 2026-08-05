import type { GameState, Quest, QuestObjective } from "./state.js";
import { activeQuests, itemCount } from "./state.js";
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
	/**
	 * Objectives that just ticked off on errands still open.
	 *
	 * Reported separately so the journal can record progress rather than only
	 * outcomes: a three-step errand used to leave no trace at all until the moment it
	 * finished, which made the log useless for remembering where you had got to.
	 */
	readonly advanced: readonly { readonly quest: Quest; readonly objective: QuestObjective }[];
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
		case "quest":
			// Exact id, not a loose name match: a quest id is a slug the author chose and
			// the parent's objective was written against it, so there is no prose here to
			// be generous about — and being generous would let "the-ledger" satisfy
			// "the-ledger-returned".
			return state.quests.some((quest) => quest.id === objective.target && quest.completed);
	}
}

/**
 * The open errand that still wants this item, if any.
 *
 * Dropping something destroys it — there is no ground layer to pick it back up
 * from — so the one case worth interrupting the player over is throwing away
 * the very thing they were sent to fetch. Matched with the same loose rule the
 * objective will be checked with, so the warning cannot disagree with whether
 * the item would actually have counted.
 */
export function questNeeding(state: GameState, itemName: string): Quest | undefined {
	return activeQuests(state).find((quest) =>
		quest.objectives.some(
			(objective) =>
				objective.kind === "have" && !objective.done && namesMatch(objective.target, itemName),
		),
	);
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
	const advanced: { quest: Quest; objective: QuestObjective }[] = [];

	const quests = state.quests.map((quest) => {
		if (quest.completed) return quest;

		let questChanged = false;
		const ticked: QuestObjective[] = [];
		const objectives = quest.objectives.map((objective) => {
			if (objective.done || !satisfied(objective, state, context)) return objective;
			questChanged = true;
			ticked.push(objective);
			return { ...objective, done: true };
		});

		// A quest with no objectives is a note to self, not something the engine
		// can decide is finished; only the model may close one of those.
		const allDone = objectives.length > 0 && objectives.every((o) => o.done);
		if (!questChanged && !allDone) return quest;

		changed = true;
		const next: Quest = { ...quest, objectives, completed: allDone };
		if (allDone) completed.push(next);
		// Reported only while the errand is still open: a finished one is announced as
		// finished, and saying both would put two lines in the journal for one act.
		else for (const objective of ticked) advanced.push({ quest: next, objective });
		return next;
	});

	if (!changed) return { state, completed: [], advanced: [] };
	return { state: { ...state, quests }, completed, advanced };
}

export interface QuestRow {
	readonly quest: Quest;
	/** 0 for a job, 1 for one of its steps. Deeper nesting is flattened to 1. */
	readonly depth: number;
}

/**
 * Open errands, arranged so a job and its steps read as one thing.
 *
 * A branching story hands out several errands at once, and a flat list of them is
 * genuinely hard to read: three entries that are one job with three parts look
 * identical to three unrelated jobs, and the player has no way to tell which order
 * they matter in. Parent first, then its steps, then the next parent.
 *
 * Nesting is capped at one level rather than being recursive. Two is already deeper
 * than a list eleven columns wide can indent legibly, and a `parentId` cycle — which
 * an artifact is data from outside the program and may well contain — would hang a
 * recursive walk. A step whose parent is itself a step is shown as a step of the
 * top-level job.
 *
 * An orphan is kept, not dropped: a quest whose parent was never opened, or was
 * abandoned, is still an errand the player has and still has to be readable.
 */
export function questRows(state: GameState): readonly QuestRow[] {
	const open = activeQuests(state);
	const byId = new Map(open.map((quest) => [quest.id, quest]));

	const children = new Map<string, Quest[]>();
	const roots: Quest[] = [];
	for (const quest of open) {
		const parent = quest.parentId;
		if (parent === undefined || parent === quest.id || !byId.has(parent)) {
			roots.push(quest);
			continue;
		}
		const list = children.get(parent);
		if (list) list.push(quest);
		else children.set(parent, [quest]);
	}

	const rows: QuestRow[] = [];
	const emitted = new Set<string>();
	for (const root of roots) {
		if (emitted.has(root.id)) continue;
		emitted.add(root.id);
		rows.push({ quest: root, depth: 0 });
		for (const child of children.get(root.id) ?? []) {
			if (emitted.has(child.id)) continue;
			emitted.add(child.id);
			rows.push({ quest: child, depth: 1 });
		}
	}
	// Anything a cycle kept out of the walk above. Shown flat rather than lost.
	for (const quest of open) {
		if (!emitted.has(quest.id)) rows.push({ quest, depth: 0 });
	}
	return rows;
}

/**
 * An objective as an instruction rather than as its own tag.
 *
 * The tags are the reducer's vocabulary — `have`, `reach`, `talk` — and reading
 * "have Timber x3" in a quest log is reading the implementation.
 *
 * In core rather than in the panel that first needed it, because the journal now
 * phrases progress with the same words. Two copies would drift, and the drift would
 * be visible: the pane and the log describing one objective differently.
 */
export function describeObjective(objective: {
	kind: string;
	target: string;
	quantity?: number;
}): string {
	switch (objective.kind) {
		case "have":
			return objective.quantity && objective.quantity > 1
				? `carry ${objective.quantity} ${objective.target}`
				: `carry ${objective.target}`;
		case "reach":
			return `go to ${objective.target}`;
		case "talk":
			return `speak to ${objective.target}`;
		case "quest":
			// Unslugged, the same way `beatLabel` unslugs a beat id. An author names these
			// `the-short-tally` by hand, so "the short tally" is a real phrase rather than a
			// placeholder — and printing the raw id here would put the implementation in
			// the quest log, which is what this function exists to avoid.
			return `finish ${objective.target.split("-").filter(Boolean).join(" ")}`;
		default:
			return objective.target;
	}
}
