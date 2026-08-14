import type { DomainEffect } from "./effects.js";
import type { Scene, SceneAction } from "./scene.js";

/**
 * Effects that must not happen twice.
 *
 * A save is never written while a scene is playing, so an interrupted scene replays from
 * its first step — which means every effect before the last step may be applied more than
 * once over the life of one save. Most of `DomainEffect` is idempotent by construction:
 * `SetFlag` writes a value, `ShowCard` is ignored once the card has been read,
 * `OpenBarrier` checks the flag first. These are the ones that accumulate, and a scene
 * granting the ledger in its third step of five hands out a second one to any player who
 * quits at the wrong moment.
 *
 * The last step is exempt because reaching it is what writes the trigger's fired flag, so
 * a scene that got that far never runs again.
 *
 * Checked here as a pure function rather than at the point of use, because the two places
 * that need it are the loader and the authoring CLI, and a rule enforced in one of those
 * but not the other is a rule an author will find out about from a player.
 */
export const REPEATABLE_EFFECTS: ReadonlySet<DomainEffect["t"]> = new Set([
	"GrantItem",
	"TakeItem",
	"AdjustGold",
	"Damage",
	"Heal",
	"AdjustDisposition",
	"AdjustReputation",
]);

/** How an effect should be named in a complaint about it. */
function subject(effect: DomainEffect): string {
	switch (effect.t) {
		case "GrantItem":
		case "TakeItem":
			return `"${effect.name}"`;
		case "AdjustDisposition":
			return `"${effect.npcId}"`;
		case "AdjustReputation":
			return `"${effect.faction}"`;
		default:
			return effect.t;
	}
}

const VERBS: Readonly<Record<string, string>> = {
	GrantItem: "grants",
	TakeItem: "takes",
	AdjustGold: "adjusts gold in",
	Damage: "damages the player in",
	Heal: "heals the player in",
	AdjustDisposition: "adjusts disposition toward",
	AdjustReputation: "adjusts reputation with",
};

/**
 * The fewest frames a step may hold and still be seen.
 *
 * A scene frame is ninety milliseconds, so five frames is a little under half a second —
 * about as short as a thing can appear on screen and still register as having happened.
 *
 * This exists because of a scene that passed every other check and was unwatchable. It
 * panned, spawned a rider and held each of those for three frames: a quarter of a second
 * each, so by the time the player had noticed the camera had moved, the rider was already
 * at the well. "It executed too quickly and it was hard to tell what happened" is not
 * something a validator can normally say, but this much of it can be checked.
 */
export const MIN_VISIBLE_HOLD = 5;

/** Actions that change what is on screen the instant they run and are over at once. */
const INSTANT: ReadonlySet<SceneAction["t"]> = new Set(["Spawn", "Despawn", "Face"]);

/**
 * Whether anything in this step keeps the frame on screen by itself.
 *
 * A walk takes as many frames as it has tiles, a wait says how long it is, a line stops
 * the scene until the player presses on, and a pan runs until the camera arrives. Any of
 * those gives an instantaneous change beside it time to be looked at; a step made only of
 * instantaneous changes has exactly one frame unless it asks for more.
 */
function lingers(action: SceneAction): boolean {
	if (action.t === "WalkTo" || action.t === "Wait" || action.t === "Say" || action.t === "Card")
		return true;
	return action.t === "Camera" && action.pan !== undefined && action.pan !== "cut";
}

export function scenePacingProblems(scene: Scene): string[] {
	const problems: string[] = [];

	scene.steps.forEach((step, index) => {
		const seen = step.do.filter(
			(action) =>
				INSTANT.has(action.t) || (action.t === "Camera" && (action.pan ?? "cut") === "cut"),
		);
		if (seen.length === 0) return;
		if (step.do.some(lingers)) return;
		if ((step.hold ?? 0) >= MIN_VISIBLE_HOLD) return;

		const what = seen.map((action) =>
			"actor" in action ? `${action.t} ${action.actor}` : action.t,
		);
		problems.push(
			`scene ${scene.id} step ${index + 1} of ${scene.steps.length} ${what.join(" and ")}, then moves ` +
				`straight on: at ${step.hold ?? 0} frame(s) that is on screen for under half a second. ` +
				`Give the step "hold": ${MIN_VISIBLE_HOLD} or more, or something that takes time of its own`,
		);
	});

	return problems;
}

export function sceneEffectProblems(scene: Scene): string[] {
	const problems: string[] = [];
	const last = scene.steps.length - 1;

	scene.steps.forEach((step, index) => {
		if (index === last) return;
		for (const action of step.do) {
			if (action.t !== "Effects") continue;
			for (const effect of action.effects) {
				if (!REPEATABLE_EFFECTS.has(effect.t)) continue;
				problems.push(
					`scene ${scene.id} ${VERBS[effect.t] ?? "applies"} ${subject(effect)} in step ${index + 1} ` +
						`of ${scene.steps.length}; an interrupted scene replays, so ${effect.t} may only appear ` +
						"in the last step",
				);
			}
		}
	});

	return problems;
}
