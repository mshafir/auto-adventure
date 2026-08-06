import { ARC_DONE_FLAG, beatCardId } from "../core/rules/arc.js";
import { cardKey } from "../core/rules/card.js";
import { asCondition, flagsRead } from "../core/rules/condition.js";
import type { ScenarioArtifact } from "./artifact.js";

/**
 * Every flag something in this scenario can actually set.
 *
 * A gate on a flag nothing sets is the worst kind of authoring bug: at runtime it
 * is simply false forever, which looks exactly like content the player has not
 * reached yet, so a story can dead-end four hours in with nothing on screen to
 * say why. Catching it needs a complete list of the writers, and the writers are
 * spread across four unrelated places — which is why this is one function rather
 * than a check that grew up beside each of them.
 *
 * Kept deliberately generous. A false positive here refuses a scenario that would
 * have played, so anything ambiguous is treated as provided.
 */
export function flagsWritten(artifact: ScenarioArtifact): Set<string> {
	const written = new Set<string>();

	for (const beat of artifact.arc?.beats ?? []) {
		written.add(beat.setsFlag);
		// A card records that it has been read, and an author may legitimately gate on
		// that rather than on the beat's own flag.
		if (beat.card) written.add(cardKey(beatCardId(beat)));
		// A beat's own effects are as much a writer as a trigger's are; missing them
		// would report every flag set by a beat as one nothing sets.
		for (const effect of beat.effects ?? []) {
			if (effect.t === "SetFlag") written.add(effect.key);
			if (effect.t === "ShowCard") written.add(cardKey(effect.card.id));
		}
	}

	for (const trigger of artifact.triggers ?? []) {
		written.add(`trigger:${trigger.id}`);
		for (const effect of trigger.effects) {
			if (effect.t === "SetFlag") written.add(effect.key);
			if (effect.t === "ShowCard") written.add(cardKey(effect.card.id));
		}
	}

	for (const barrier of artifact.barriers ?? []) written.add(`barrier:${barrier.id}`);

	// Written dialogue sets flags through the same action boundary a live model
	// uses, so a conversation is a first-class flag writer.
	for (const tree of Object.values(artifact.trees ?? {})) {
		for (const node of Object.values(tree.nodes)) {
			for (const action of node.actions ?? []) {
				if (action.kind === "setFlag" && action.key) written.add(action.key);
			}
		}
	}

	return written;
}

/**
 * Flags the engine sets on its own, by prefix.
 *
 * These have no author-side writer at all — the reducer writes them as a side-effect of
 * the player doing something — so a gate on one is legitimate and must not be reported
 * as unreachable. `visited:` comes from `recordArrival`, `card:` from any card being
 * read, and `looted:`/`picked:` from emptying a container or a patch of ground.
 *
 * Deliberately *not* the whole of `arc:`, which is the trap here. Beat flags are
 * conventionally named `arc:the-short-tally`, so treating the prefix as engine-written
 * would silently exempt every flag in every arc — which is to say it would turn the most
 * valuable check in this file into a no-op while still looking like it was running. Only
 * the two the engine genuinely writes are listed.
 */
const ENGINE_PREFIXES: readonly string[] = [
	"visited:",
	"card:",
	"looted:",
	"picked:",
	"trigger:",
	// Which arm of a fork was taken. Written by `beatEffects`, not by an author.
	"arc:branch:",
];

/** The one engine flag that is a whole name rather than a prefix. */
const ENGINE_FLAGS: readonly string[] = [ARC_DONE_FLAG];

export function isEngineFlag(flag: string): boolean {
	if (ENGINE_FLAGS.includes(flag)) return true;
	return ENGINE_PREFIXES.some((prefix) => flag.startsWith(prefix));
}

/**
 * Flags a condition waits on that nothing can ever provide.
 *
 * The one check worth making about a condition offline, and the reason
 * `flagsRead` exists on the condition module rather than being inlined at the
 * call site.
 */
export function unsatisfiableFlags(
	requires: readonly string[] | Parameters<typeof asCondition>[0],
	written: ReadonlySet<string>,
): string[] {
	const read = flagsRead(asCondition(requires));
	return [...read].filter((flag) => !written.has(flag) && !isEngineFlag(flag));
}

/**
 * Whether a condition could ever hold, given what can be written.
 *
 * Different question from {@link unsatisfiableFlags}, and the difference is `any`.
 * Flattening a condition to the flags it mentions is the right conservative answer to
 * "does this name a flag nothing sets" — a typo inside an `any` is still a typo. It is
 * the *wrong* answer to "can this beat ever open", because the one correct way to hang
 * a beat downstream of a fork is `{ any: [armA, armB] }`, and flattening reports both
 * arms as unreachable on the arm that was not taken. That made the correct spelling the
 * only one the validator refused.
 *
 * Everything that is not a flag is treated as satisfiable: this exists to reason about
 * which flags a fork bars, and an item or an hour is not something a fork can bar.
 */
export function conditionSatisfiable(
	requires: readonly string[] | Parameters<typeof asCondition>[0],
	written: ReadonlySet<string>,
): boolean {
	const condition = asCondition(requires);
	if (condition === undefined) return true;
	if ("all" in condition)
		return condition.all.every((inner) => conditionSatisfiable(inner, written));
	if ("any" in condition)
		return condition.any.some((inner) => conditionSatisfiable(inner, written));
	// A `not` over a barred flag is easier to satisfy, not harder.
	if ("not" in condition) return true;
	if ("flag" in condition) return written.has(condition.flag) || isEngineFlag(condition.flag);
	return true;
}
