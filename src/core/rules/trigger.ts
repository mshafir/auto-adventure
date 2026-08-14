import { type Condition, evaluate } from "./condition.js";
import type { DomainEffect } from "./effects.js";
import type { GameState } from "./state.js";

/**
 * Something the world does when something becomes true.
 *
 * This is the piece that makes the rest of the scenario vocabulary compose. Every
 * gate in the game reads flags — a dialogue node, a locked door, an absent NPC, a
 * beat's requirement — so a trigger that watches for an arrival and sets a flag is
 * simultaneously how reaching a place opens a conversation, unbars a gate and puts
 * somebody in the square, with no coupling between those three systems and no new
 * code in any of them.
 *
 * It is deliberately not an event bus. There are no event types to subscribe to and
 * no ordering between listeners: a trigger is a *condition over state*, checked
 * after the state has settled. That means an author never has to know which command
 * caused a thing to become true, and a trigger cannot be missed because it was
 * registered after the event fired — the same reason `verifyQuests` re-checks
 * objectives against real state rather than trusting a model to announce progress.
 */
export interface Trigger {
	/** Stable id. Becomes `trigger:<id>` in the flags, so it must not change. */
	readonly id: string;
	readonly when: Condition;
	/**
	 * Whether this fires at most once. Defaults to true.
	 *
	 * A repeating trigger is the sharp edge here: its condition is checked after
	 * every command, so one whose effects do not change its own condition will fire
	 * forever. Almost every use wants once, so once is the default and repeating is
	 * something an author has to ask for.
	 */
	readonly once?: boolean;
	readonly effects: readonly DomainEffect[];
}

/** The flag recording that a trigger has fired. */
export function triggerKey(id: string): string {
	return `trigger:${id}`;
}

export function triggerFired(state: GameState, trigger: Trigger): boolean {
	return Boolean(state.flags[triggerKey(trigger.id)]);
}

/**
 * Whether these effects hand the world over to a scene.
 *
 * A trigger that plays a scene must not be marked fired when it *fires*, only once the
 * scene it started has finished. Otherwise a player who quits halfway through a cutscene
 * comes back to a world that believes the scene has happened: it never plays again, and
 * whatever it was going to change — the chapter flag, the item, the gate — never happens
 * either. The story stops there, silently, which is the failure this whole format exists
 * to make impossible.
 *
 * The flag is written by `closeScene` in the reducer instead, on the two paths that count
 * as the scene being over: running out of steps, and the player skipping it.
 */
export function playsAScene(effects: readonly DomainEffect[]): boolean {
	return effects.some((effect) => effect.t === "PlayScene");
}

/**
 * Whether these effects would take the whole screen away from the player.
 *
 * A conversation owns the screen until it ends. This is the rule that makes a beat's own
 * trigger work at all: a beat's flag is set the moment its conversation *opens*, so anything
 * watching for that beat fires while the player is still reading the first line of it — and
 * what they saw was the world taken away mid-sentence, a cutscene played over the top, and
 * the thing the person had actually come to say happening afterwards as though it were a
 * second, unrelated conversation.
 *
 * Waiting costs nothing. A trigger is a condition over state checked after every command, so
 * one skipped here fires on the command that closes the conversation instead.
 */
export function takesTheScreen(effects: readonly DomainEffect[]): boolean {
	return effects.some((effect) => effect.t === "PlayScene" || effect.t === "ShowCard");
}

/**
 * How many times the trigger pass may go round in one command.
 *
 * A trigger's effects can satisfy another trigger's condition, and an author will
 * reasonably expect a chain of two or three to resolve in the same step rather than
 * one per keypress — a card that appears only after the player's *next* move reads
 * as a bug. But a chain is also how a repeating trigger becomes an infinite loop,
 * so the depth is bounded rather than run to a fixed point. Four is past any chain
 * worth writing and cheap enough to pay on every command.
 */
export const MAX_TRIGGER_PASSES = 4;

/**
 * Which triggers want to fire against this state, in author order.
 *
 * Returns the effects to apply plus the flag that marks each one fired. The flag is
 * emitted as an effect rather than being written here so that the whole thing goes
 * through `applyEffects` — a trigger is then exactly as idempotent as a beat, and
 * for the same reason.
 *
 * Author order rather than sorted, because two triggers that fire on the same state
 * are almost always a deliberate sequence — grant the item, then show the card that
 * mentions it — and an author has no other way to say which comes first.
 */
export function pendingTriggers(
	triggers: readonly Trigger[] | undefined,
	state: GameState,
): DomainEffect[] {
	if (!triggers || triggers.length === 0) return [];
	const effects: DomainEffect[] = [];
	for (const trigger of triggers) {
		const once = trigger.once ?? true;
		if (once && triggerFired(state, trigger)) continue;
		if (!evaluate(trigger.when, state)) continue;
		// A conversation owns the screen until it ends; see {@link takesTheScreen}.
		if (state.dialogue && takesTheScreen(trigger.effects)) continue;
		effects.push(...trigger.effects);
		// Set last, so a partially-applied trigger is retried rather than skipped —
		// the rule `beatEffects` follows, and for the same failure.
		//
		// A trigger that plays a scene is the exception, and the flag is written by the scene
		// player instead. See {@link playsAScene}.
		if (once && !playsAScene(trigger.effects))
			effects.push({ t: "SetFlag", key: triggerKey(trigger.id), value: true });
	}
	return effects;
}
