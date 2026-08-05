import type { GameState } from "./state.js";
import { itemCount, visitedKey } from "./state.js";

/**
 * A question about the game, as data.
 *
 * There is no new bookkeeping here and that is the point. Every leaf below reads
 * something the game already records for its own reasons: `flags` is the general
 * key/value store the reducer has always had, `visited:<place>` is written by
 * `recordArrival` on every first arrival, an NPC's `totalTurns` is part of what
 * they remember, and `itemCount` is the same function `verifyQuests` uses to
 * decide a `have` objective. So a condition cannot ask about state that is not
 * already durable, and nothing needs to start being tracked for one to work.
 *
 * Data rather than a predicate function for the same reason `DomainEffect` is
 * data: these arrive from a scenario file, which is to say from outside the
 * program. A closed set of shapes can be validated; a function cannot.
 *
 * Deliberately *not* a general expression language. There is no arithmetic, no
 * string matching and no way to read an arbitrary path out of the state — every
 * leaf names one thing and compares it one way. An author who needs something
 * more elaborate is better served by a trigger that sets a flag.
 */
export type Condition =
	| { readonly all: readonly Condition[] }
	| { readonly any: readonly Condition[] }
	| { readonly not: Condition }
	/**
	 * A flag, optionally at a particular value.
	 *
	 * Without `equals` this asks whether the flag is truthy, which is what almost
	 * every author means and what the `string[]` form this replaces could express.
	 * With it, a flag becomes a small enumeration — which is how a branch group
	 * records *which* way it went rather than merely that it went.
	 */
	| { readonly flag: string; readonly equals?: string | number | boolean }
	| { readonly item: string; readonly atLeast?: number }
	| { readonly quest: string; readonly is: "open" | "done" | "absent" }
	/** An npcId the player has exchanged at least one turn with. */
	| { readonly talked: string }
	/** A place name the player has stood in. Matches `recordArrival`'s key. */
	| { readonly visited: string }
	| {
			readonly reputation: string;
			readonly atLeast?: number;
			readonly atMost?: number;
	  }
	/** An npcId, by how they feel about the player. */
	| { readonly disposition: string; readonly atLeast?: number; readonly atMost?: number }
	/**
	 * The hour of the day, inclusive of `from` and exclusive of `to`.
	 *
	 * Wraps when `from > to`, so `{ from: 22, to: 5 }` is the small hours rather
	 * than the empty set — a window that crosses midnight is the one an author is
	 * most likely to want.
	 */
	| { readonly hour: { readonly from: number; readonly to: number } };

/**
 * What a list of flag names means as a condition.
 *
 * Every `requires` in the game was a `string[]` meaning "all of these flags are
 * set", and a good deal of authored content is written that way. Lowering rather
 * than migrating keeps both spellings working forever at the cost of one function,
 * and means the shorthand stays available for the case it is genuinely good at.
 *
 * An empty list is `undefined`, not an empty `all` — "requires nothing" should
 * cost nothing to evaluate, and `requires: []` is by far the commonest value.
 */
export function asCondition(
	requires: readonly string[] | Condition | undefined,
): Condition | undefined {
	if (requires === undefined) return undefined;
	if (!Array.isArray(requires)) return requires as Condition;
	const flags = requires.filter((flag) => flag.length > 0);
	if (flags.length === 0) return undefined;
	if (flags.length === 1) return { flag: flags[0] as string };
	return { all: flags.map((flag) => ({ flag })) };
}

/** Whether a condition holds. Absent means "no requirement", which holds. */
export function evaluate(condition: Condition | undefined, state: GameState): boolean {
	if (condition === undefined) return true;

	if ("all" in condition) return condition.all.every((inner) => evaluate(inner, state));
	// An empty `any` is false, which is the honest reading: none of the listed
	// alternatives holds, because none is listed. `all` is true for the mirror
	// reason. Both fall out of the array methods rather than being special-cased.
	if ("any" in condition) return condition.any.some((inner) => evaluate(inner, state));
	if ("not" in condition) return !evaluate(condition.not, state);

	if ("flag" in condition) {
		const value = state.flags[condition.flag];
		return condition.equals === undefined ? Boolean(value) : value === condition.equals;
	}

	if ("item" in condition) return itemCount(state, condition.item) >= (condition.atLeast ?? 1);

	if ("quest" in condition) {
		const quest = state.quests.find((entry) => entry.id === condition.quest);
		switch (condition.is) {
			case "absent":
				return quest === undefined;
			case "open":
				return quest !== undefined && !quest.completed;
			case "done":
				return quest?.completed === true;
		}
	}

	if ("talked" in condition) return (state.npcs[condition.talked]?.totalTurns ?? 0) > 0;

	if ("visited" in condition) return Boolean(state.flags[visitedKey(condition.visited)]);

	if ("reputation" in condition) {
		const standing = state.reputation[condition.reputation] ?? 0;
		return withinRange(standing, condition.atLeast, condition.atMost);
	}

	if ("disposition" in condition) {
		// Somebody never met has no disposition to test, and treating that as the
		// neutral 0 would make `{ disposition, atMost: -20 }` quietly false for every
		// stranger — which reads as the condition being broken rather than as the
		// player not having met them. Absent is false either way.
		const record = state.npcs[condition.disposition];
		if (!record) return false;
		return withinRange(record.disposition, condition.atLeast, condition.atMost);
	}

	const { from, to } = condition.hour;
	const hour = state.time.hour;
	return from <= to ? hour >= from && hour < to : hour >= from || hour < to;
}

function withinRange(value: number, atLeast?: number, atMost?: number): boolean {
	if (atLeast !== undefined && value < atLeast) return false;
	if (atMost !== undefined && value > atMost) return false;
	return true;
}

/**
 * Every flag name a condition could read.
 *
 * For the offline validator, which is the only thing that can catch a condition
 * gated on a flag nothing ever sets — at runtime such a condition is simply
 * false forever, which is indistinguishable from content the player has not
 * reached yet.
 */
export function flagsRead(
	condition: Condition | undefined,
	into: Set<string> = new Set(),
): Set<string> {
	if (condition === undefined) return into;
	if ("all" in condition) for (const inner of condition.all) flagsRead(inner, into);
	else if ("any" in condition) for (const inner of condition.any) flagsRead(inner, into);
	else if ("not" in condition) flagsRead(condition.not, into);
	else if ("flag" in condition) into.add(condition.flag);
	else if ("visited" in condition) into.add(visitedKey(condition.visited));
	return into;
}

/**
 * Every item name a condition depends on.
 *
 * For the validator, and it earned its place the hard way. A gate on `{ item: X }` is
 * satisfiable in the engine's terms as long as X exists somewhere in the world — but
 * that is not the question. The question is whether the *player* can find out X exists,
 * and an item nothing asks for and nothing mentions is a gate with no visible key: the
 * story stops, the errand log is empty, and there is nothing on screen to read.
 */
export function itemsRead(
	condition: Condition | undefined,
	into: Set<string> = new Set(),
): Set<string> {
	if (condition === undefined) return into;
	if ("all" in condition) for (const inner of condition.all) itemsRead(inner, into);
	else if ("any" in condition) for (const inner of condition.any) itemsRead(inner, into);
	else if ("not" in condition) itemsRead(condition.not, into);
	else if ("item" in condition) into.add(condition.item);
	return into;
}

/**
 * Every npcId a condition asks about.
 *
 * Also for the validator: a `talked` or `disposition` naming somebody the
 * scenario never places is a gate that can never open, and it is a typo in an
 * npcId far more often than it is intentional.
 */
export function npcsRead(
	condition: Condition | undefined,
	into: Set<string> = new Set(),
): Set<string> {
	if (condition === undefined) return into;
	if ("all" in condition) for (const inner of condition.all) npcsRead(inner, into);
	else if ("any" in condition) for (const inner of condition.any) npcsRead(inner, into);
	else if ("not" in condition) npcsRead(condition.not, into);
	else if ("talked" in condition) into.add(condition.talked);
	else if ("disposition" in condition) into.add(condition.disposition);
	return into;
}
