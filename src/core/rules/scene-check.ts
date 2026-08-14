import type { DomainEffect } from "./effects.js";
import type { Scene } from "./scene.js";

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
