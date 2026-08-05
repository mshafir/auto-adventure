import { hashString } from "../../core/rand/hash.js";
import type { ScenarioBrief } from "../../core/world/brief.js";
import type { SaveSummary } from "../../persist/save-repo.js";
import type { ScenarioSummary } from "../../scenario/repo.js";
import type { Flavour, LaunchChoice } from "../../scenario/scenario.js";

/**
 * What picking something on the launcher means.
 *
 * Kept apart from the pages that draw it, because these are decisions rather than
 * layout: which seed a new world gets, whether a resumed one runs a model, and how
 * a new world is given a slot that is not already taken. The pages moved from one
 * list to four screens without any of this changing, which is the point of the
 * split.
 */

export type Pick =
	| { readonly kind: "save"; readonly save: SaveSummary }
	| { readonly kind: "scenario"; readonly scenario: ScenarioSummary }
	| { readonly kind: "new"; readonly flavour: Flavour };

export interface ChoiceContext {
	readonly saves: readonly SaveSummary[];
	/** Slot name for a brand-new world, before uniquifying. */
	readonly baseWorldId: string;
	/** Seed for a brand-new world, when the environment named one. */
	readonly configuredSeed?: number;
	readonly noAi: boolean;
}

/**
 * A save slot nobody is using.
 *
 * A new world must never land on top of an existing one. The launcher offers no way
 * to type a name, so the name is derived and then made unique — silently
 * overwriting somebody's world would be the single worst thing this screen could
 * do.
 */
export function freeWorldId(base: string, taken: readonly string[]): string {
	const used = new Set(taken);
	if (!used.has(base)) return base;
	for (let n = 2; n < 1000; n++) {
		const candidate = `${base}-${n}`;
		if (!used.has(candidate)) return candidate;
	}
	// A thousand worlds of the same name is not a case worth handling gracefully,
	// but it must still not collide.
	return `${base}-${Date.now()}`;
}

/**
 * Turn a pick into a launch.
 *
 * Resuming does not record a flavour, because whether a model runs is a property of
 * *this run* rather than of the world — the same reason `NO_AI=1` has always been
 * per-invocation. The exception is a scenario world, which is prebuilt inherently:
 * its content is already written, so there is nothing for a model to do even if one
 * is available.
 */
export function choiceFor(pick: Pick, context: ChoiceContext): LaunchChoice {
	const taken = context.saves.map((save) => save.worldId);

	switch (pick.kind) {
		case "save":
			return {
				worldId: pick.save.worldId,
				seed: pick.save.seed,
				flavour: pick.save.scenarioId ? "prebuilt" : context.noAi ? "procedural" : "live",
				mustExist: true,
			};

		case "scenario":
			return {
				worldId: freeWorldId(pick.scenario.id, taken),
				// Replaced by the artifact's own seed once it is read; the artifact is the
				// only authority on that.
				seed: 0,
				flavour: "prebuilt",
			};

		case "new": {
			const worldId = freeWorldId(context.baseWorldId, taken);
			return {
				worldId,
				// A configured seed wins so `WORLD_SEED=hollowmoor` still means something;
				// otherwise it comes from the slot name, so two new worlds are two different
				// worlds rather than the same one twice.
				seed: context.configuredSeed ?? hashString(worldId),
				flavour: pick.flavour,
			};
		}
	}
}

/** Attach a brief to a choice, for the briefed path. */
export function withBrief(choice: LaunchChoice, brief: ScenarioBrief | undefined): LaunchChoice {
	return brief ? { ...choice, brief } : choice;
}
